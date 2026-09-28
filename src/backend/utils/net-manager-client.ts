import net from "net";
import crypto from "crypto";
import { sshLogger } from "./logger.js";
import { getErrorMessage } from "./error-message.js";

/**
 * Termix's side of the network manager.
 *
 * The manager raises a network in a namespace of its own and answers with the
 * address traffic for it should be handed to. This speaks the same framing the
 * RDP bridge does, for the same reason: it is already here.
 */

export interface NetManagerOptions {
  host: string;
  port: number;
  token: string;
}

export interface ManagedNetworkState {
  id: number;
  state: "up" | "connecting" | "down" | "error";
  error: string | null;
  port: number;
}

const DEFAULT_HOST = "termix-netmgr";
const DEFAULT_PORT = 3392;

/** A profile's doorway, computed rather than remembered, so a manager restart
 * does not have to be announced. Mirrors NET_MANAGER_DOOR_BASE. */
export function managedDoorPort(profileId: number): number {
  return Number(process.env.NET_MANAGER_DOOR_BASE ?? 20000) + profileId;
}

export function resolveNetManagerOptions(): NetManagerOptions | null {
  const token = process.env.NET_MANAGER_TOKEN?.trim();
  // Without a secret there is no manager to speak to. Managed profiles then
  // fail to resolve, which is the honest outcome: nothing is raising them.
  if (!token) return null;

  const raw = process.env.NET_MANAGER_URL?.trim();
  if (!raw) return { host: DEFAULT_HOST, port: DEFAULT_PORT, token };

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`tcp://${raw}`);
    return {
      host: url.hostname || DEFAULT_HOST,
      port: Number(url.port) || DEFAULT_PORT,
      token,
    };
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT, token };
  }
}

function sealKey(token: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(token, "utf8"),
      Buffer.from("termix-net-manager", "utf8"),
      Buffer.from("credentials", "utf8"),
      32,
    ),
  );
}

/**
 * The token is proof of who is speaking and the key the credentials travel
 * under. A Docker bridge network keeps containers apart, but one with NET_RAW
 * on the same network can listen, and a VPN password is not something to hand
 * it.
 */
export function sealCredentials(
  token: string,
  credentials: Record<string, unknown>,
): { iv: string; tag: string; data: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(token), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function encodeFrame(magic: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(magic.padEnd(4, " "), 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function ask(
  options: NetManagerOptions,
  magic: string,
  body: Record<string, unknown>,
  timeoutMs = 90000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options.port, options.host);
    let buffer = Buffer.alloc(0);
    const settle = (error?: Error, value?: Record<string, unknown>) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };

    socket.setTimeout(timeoutMs, () =>
      settle(new Error("the network manager did not answer")),
    );
    socket.once("error", (error) => settle(error));
    socket.once("connect", () => {
      const payload = Buffer.from(
        JSON.stringify({ ...body, token: options.token }),
        "utf8",
      );
      socket.write(encodeFrame(magic, payload));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;
      const length = buffer.readUInt32LE(4);
      if (buffer.length < 8 + length) return;
      try {
        settle(
          undefined,
          JSON.parse(buffer.subarray(8, 8 + length).toString("utf8")),
        );
      } catch (error) {
        settle(error as Error);
      }
    });
  });
}

export async function raiseManagedNetwork(
  profile: Record<string, unknown>,
  credentials: Record<string, unknown>,
  options = resolveNetManagerOptions(),
): Promise<{ state: string; error?: string }> {
  if (!options) {
    return {
      state: "error",
      error:
        "No network manager is configured, so this network cannot be raised",
    };
  }
  try {
    const answer = await ask(options, "NUP", {
      profile,
      credentials: sealCredentials(options.token, credentials),
    });
    return {
      state: String(answer.state ?? (answer.ok ? "up" : "error")),
      error: answer.error ? String(answer.error) : undefined,
    };
  } catch (error) {
    sshLogger.error("Failed to raise a managed network", error, {
      operation: "net_manager_up",
      profileId: profile.id,
    });
    return { state: "error", error: getErrorMessage(error) };
  }
}

export async function dropManagedNetwork(
  profileId: number,
  options = resolveNetManagerOptions(),
): Promise<void> {
  if (!options) return;
  try {
    await ask(options, "NDWN", { id: profileId }, 15000);
  } catch (error) {
    // Nothing to do about it here: the profile is going away either way, and
    // a manager that cannot be reached will not be holding the network up.
    sshLogger.warn("Failed to drop a managed network", {
      operation: "net_manager_down",
      profileId,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Take a VPN's tunnel down without forgetting it.
 *
 * The doorway stays, so the next session raises it again. This is "I am done
 * with this for now", not "do not use this" -- which is what disabling a
 * profile means.
 */
export async function disconnectManagedNetwork(
  profileId: number,
  options = resolveNetManagerOptions(),
): Promise<{ state: string }> {
  if (!options) return { state: "unknown" };
  try {
    const answer = await ask(options, "NDRP", { id: profileId }, 15000);
    return { state: String(answer.state ?? "idle") };
  } catch (error) {
    sshLogger.warn("Failed to take a VPN's tunnel down", {
      operation: "net_manager_drop",
      profileId,
      error: getErrorMessage(error),
    });
    return { state: "unknown" };
  }
}

export async function listManagedNetworks(
  options = resolveNetManagerOptions(),
): Promise<ManagedNetworkState[] | null> {
  if (!options) return null;
  try {
    const answer = await ask(options, "NSTA", {}, 15000);
    return Array.isArray(answer.networks)
      ? (answer.networks as ManagedNetworkState[])
      : [];
  } catch {
    return null;
  }
}
