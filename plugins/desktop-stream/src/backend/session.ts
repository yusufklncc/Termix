import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { readHostSettings } from "./host-settings.js";
import { NekoAdapter } from "./neko-adapter.js";
import { SelkiesAdapter } from "./selkies-adapter.js";
import type {
  ClientMessage,
  GatewayMessage,
  PublisherTarget,
  SignalingAdapter,
  StreamPublisher,
} from "./signaling-adapter.js";

interface Socketish {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, handler: (...args: never[]) => void): void;
}

const OPEN = 1;

function createAdapter(
  publisher: StreamPublisher,
  target: PublisherTarget,
  callbacks: {
    onMessage(message: GatewayMessage): void;
    onClose(reason: string): void;
    log(message: string): void;
  },
): SignalingAdapter {
  return publisher === "selkies"
    ? new SelkiesAdapter(target, callbacks)
    : new NekoAdapter(target, callbacks);
}

/**
 * Signaling, and only signaling.
 *
 * The browser and the publisher negotiate through here and then talk to each
 * other directly, or through a TURN server. The video never passes through
 * this process -- that is the whole point, and why a stream costs this server
 * close to nothing however many pixels it carries.
 */
export async function runSession({
  ctx,
  ws,
  url,
}: {
  ctx: PluginContext;
  ws: Socketish;
  url: URL;
}): Promise<void> {
  let adapter: SignalingAdapter | null = null;

  const send = (message: GatewayMessage) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
  };

  const fail = (code: number, message: string) => {
    send({ type: "error", message });
    ws.close(code, message.slice(0, 120));
  };

  const hostId = Number.parseInt(url.searchParams.get("hostId") ?? "", 10);
  if (!Number.isInteger(hostId)) {
    fail(1008, "hostId is required");
    return;
  }

  // The host exists, this user may connect to it, and these are its
  // credentials -- in one call, which core audits.
  const target = await ctx.credentials.resolveHostProtocol(
    hostId,
    "desktop-stream" as never,
  );
  if (!target) {
    fail(1008, "Host not found");
    return;
  }

  const settings = await readHostSettings(ctx, hostId);
  if (!settings.enabled) {
    fail(1008, "Stream is not enabled for this host");
    return;
  }
  if (settings.mode !== "webrtc") {
    fail(1008, "This host is not configured for the WebRTC stream mode");
    return;
  }
  if (!settings.url) {
    fail(1008, "This host has no publisher address configured");
    return;
  }

  /*
   * A recipient never gets the owner's credentials; it reaches the publisher
   * unauthenticated unless the publisher itself is open. The same rule the
   * host list applies, for the same reason.
   */
  const publisherTarget: PublisherTarget = {
    baseUrl: settings.url,
    path: settings.path,
    username: target.shared ? null : target.auth.username || null,
    password: target.shared ? null : target.auth.password || null,
  };

  try {
    adapter = createAdapter(settings.publisher, publisherTarget, {
      onMessage: send,
      onClose: (reason) => {
        send({ type: "error", message: reason });
        ws.close(1011, reason.slice(0, 120));
      },
      log: (message) => ctx.log.warn(message),
    });

    await adapter.connect();
    send({ type: "ready", publisher: settings.publisher });
  } catch (error) {
    ctx.log.error(
      `Could not reach the stream publisher for host ${hostId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    adapter?.close();
    adapter = null;
    fail(1011, "Failed to reach the stream publisher");
    return;
  }

  ws.on("message", ((raw: { toString(): string }) => {
    if (!adapter) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    try {
      adapter.send(message);
    } catch (error) {
      ctx.log.warn(
        `Could not forward a signaling message for host ${hostId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }) as never);

  ws.on("close", (() => {
    adapter?.close();
    adapter = null;
  }) as never);

  ctx.hosts.trackSession(hostId);
}
