import net from "node:net";
import type { PluginContext, PluginSshHost } from "@termix/plugin-sdk/backend";
import { resolveRdpBridgeOptions } from "./bridge-config.js";
import { resolveDisplaySize } from "./display-size.js";
import { readHostSettings } from "./host-settings.js";
import {
  startRecording,
  type RdpRecorder,
  type RecordingsWriter,
} from "./recording.js";
import { openBridgeTunnel, type BridgeTunnel } from "./tunnel.js";

/** Wire frame: 4-byte ASCII magic, u32 little-endian length, payload. */
export function encodeFrame(magic: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(magic, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface Socketish {
  readyState: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

const OPEN = 1;

/**
 * One viewer, one bridge session.
 *
 * Core has already said who is connecting and that they may reach this host.
 * What is left is to open a TCP session to the bridge and relay its frames
 * verbatim: nothing here parses or transcodes one, because the format the
 * bridge emits is the one the browser's decoder consumes. That is the whole
 * point -- the server stays off the video path.
 */
export async function runSession({
  ctx,
  ws,
  userId,
  url,
}: {
  ctx: PluginContext;
  ws: Socketish;
  userId: string;
  url: URL;
}): Promise<void> {
  let bridge: net.Socket | null = null;
  let tunnel: BridgeTunnel | null = null;
  let recorder: RdpRecorder | null = null;

  const fail = (code: number, message: string) => {
    try {
      ws.send(encodeFrame("ERRR", Buffer.from(message, "utf8")));
    } catch {
      // socket already gone
    }
    ws.close(code, message.slice(0, 120));
  };

  const hostId = Number.parseInt(url.searchParams.get("hostId") ?? "", 10);
  if (!Number.isInteger(hostId)) {
    fail(1008, "hostId is required");
    return;
  }

  // One call: the host exists, this user may connect to it, and these are the
  // credentials for the protocol. Null covers all three, and core audits it.
  const target = await ctx.credentials.resolveHostProtocol(
    hostId,
    "rdp-direct" as never,
  );
  if (!target) {
    fail(1008, "Host not found");
    return;
  }

  const settings = await readHostSettings(ctx, hostId);
  if (!settings.enabled) {
    fail(1008, "Direct RDP is not enabled for this host");
    return;
  }

  const { width, height } = resolveDisplaySize({
    requestedWidth: url.searchParams.get("width"),
    requestedHeight: url.searchParams.get("height"),
  });

  const connectRequest = {
    host: target.host.ip,
    port: settings.port,
    username: target.auth.username,
    password: target.auth.password,
    domain: target.auth.fields.domain ?? "",
    width,
    height,
    ignoreCert: true,
    printer: settings.printing,
  };

  const bridgeUrl = (await ctx.settings.get<string>("bridgeUrl")) ?? "";
  const { host: bridgeHost, port: bridgePort } = resolveRdpBridgeOptions(
    bridgeUrl || undefined,
  );

  const host = {
    ...target.host,
    username: target.auth.username,
    userId: target.host.ownerUserId,
  } as unknown as PluginSshHost;

  try {
    tunnel = await openBridgeTunnel({
      ctx,
      host,
      target: { host: connectRequest.host, port: connectRequest.port },
      bridgeHost,
    });
    connectRequest.host = tunnel.host;
    connectRequest.port = tunnel.port;
  } catch (error) {
    fail(
      1011,
      `Failed to reach the host the way it is configured to be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  /*
   * Recording is the same bytes written down, not a second description of
   * the session assembled here: what the bridge sends is already complete
   * and ordered, and playback hands it to the same decoder.
   *
   * Optional, in both senses -- without the session-recording plugin there
   * is no writer, and a host can have it switched off.
   */
  const writer =
    ctx.services.get<Partial<RecordingsWriter>>("recordings.writer");
  if (
    typeof writer.enabledFor === "function" &&
    typeof writer.createFinished === "function" &&
    (await writer.enabledFor(hostId))
  ) {
    recorder = startRecording({
      ctx,
      recordings: writer as RecordingsWriter,
      hostId,
      userId,
    });
  }

  bridge = net.createConnection({ host: bridgeHost, port: bridgePort });
  bridge.setNoDelay(true);

  bridge.on("connect", () => {
    bridge?.write(
      encodeFrame("CONN", Buffer.from(JSON.stringify(connectRequest), "utf8")),
    );
  });

  bridge.on("data", (chunk: Buffer) => {
    recorder?.write(chunk);
    if (ws.readyState === OPEN) ws.send(chunk);
  });

  bridge.on("error", (error: Error) => {
    ctx.log.error(`RDP bridge socket error: ${error.message}`);
    fail(1011, "Failed to reach the RDP bridge");
  });

  const teardown = () => {
    bridge?.destroy();
    bridge = null;
    tunnel?.close();
    tunnel = null;
    void recorder?.close();
    recorder = null;
  };

  bridge.on("close", () => {
    teardown();
    if (ws.readyState === OPEN) ws.close(1000, "Session ended");
  });

  ws.on("message", (raw: unknown) => {
    if (!bridge || bridge.destroyed) return;
    // Input frames are framed by the browser already; pass them through.
    const buffer = Array.isArray(raw)
      ? Buffer.concat(raw as Buffer[])
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw as ArrayBuffer);
    bridge.write(buffer);
  });

  ws.on("close", teardown);
  ws.on("error", teardown);

  ctx.hosts.trackSession(hostId);
  ctx.log.info(`Direct RDP session started for host ${hostId} (${userId})`);
}
