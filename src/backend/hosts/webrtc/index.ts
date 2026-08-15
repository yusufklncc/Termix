import { WebSocketServer, WebSocket, type RawData } from "ws";
import { AuthManager } from "../../utils/auth-manager.js";
import { DataCrypto } from "../../utils/data-crypto.js";
import { PermissionManager } from "../../utils/permission-manager.js";
import { sshLogger } from "../../utils/logger.js";
import { createCurrentHostResolutionRepository } from "../../database/repositories/factory.js";
import { logAudit, getAuditUsername } from "../../utils/audit-logger.js";
import { NekoAdapter } from "./neko-adapter.js";
import { SelkiesAdapter } from "./selkies-adapter.js";
import type {
  ClientMessage,
  GatewayMessage,
  PublisherTarget,
  SignalingAdapter,
  StreamPublisher,
} from "./signaling-adapter.js";

/**
 * WebRTC signaling gateway.
 *
 * Termix authenticates the viewer, checks it may reach the host, then relays
 * SDP and ICE between the browser and the publisher. Media never touches this
 * process: the peer connection is browser ↔ publisher, so the cost here stays
 * flat no matter the frame rate.
 *
 * Auth follows the terminal module rather than Guacamole's: Guacamole's socket
 * trusts an encrypted token alone, which is not a pattern to spread to a new
 * endpoint.
 */

const PORT = 30013;

const authManager = AuthManager.getInstance();

const wss = new WebSocketServer({ port: PORT });

wss.on("error", (error) => {
  sshLogger.error("WebRTC signaling server error", error, {
    operation: "webrtc_wss_error",
  });
});

function extractToken(req: {
  headers: Record<string, unknown>;
  url?: string;
}): string | undefined {
  const cookieHeader = req.headers.cookie as string | undefined;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)jwt=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  const authHeader = req.headers.authorization as string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  const urlObj = new URL(req.url || "", "http://localhost");
  return urlObj.searchParams.get("token") ?? undefined;
}

function resolvePublisher(host: Record<string, unknown>): StreamPublisher {
  const configured = host.streamPublisher as string | undefined;
  return configured === "selkies" ? "selkies" : "neko";
}

function createAdapter(
  publisher: StreamPublisher,
  target: PublisherTarget,
  onMessage: (message: GatewayMessage) => void,
  onClose: (reason: string) => void,
): SignalingAdapter {
  const callbacks = { onMessage, onClose };
  return publisher === "selkies"
    ? new SelkiesAdapter(target, callbacks)
    : new NekoAdapter(target, callbacks);
}

wss.on("connection", async (ws: WebSocket, req) => {
  let userId: string | undefined;
  let adapter: SignalingAdapter | null = null;

  const send = (message: GatewayMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const fail = (code: number, message: string) => {
    send({ type: "error", message });
    ws.close(code, message);
  };

  ws.on("error", (error) => {
    sshLogger.error("WebRTC signaling connection error", error, {
      operation: "webrtc_ws_error",
    });
  });

  try {
    const token = extractToken(
      req as unknown as { headers: Record<string, unknown>; url?: string },
    );
    if (!token) {
      ws.close(1008, "Authentication required");
      return;
    }

    const payload = await authManager.verifyJWTToken(token);
    if (!payload?.userId || payload.pendingTOTP) {
      ws.close(1008, "Authentication required");
      return;
    }
    userId = payload.userId;
  } catch (error) {
    sshLogger.error("WebRTC signaling JWT verification failed", error, {
      operation: "webrtc_auth_error",
      ip: req.socket.remoteAddress,
    });
    ws.close(1008, "Authentication required");
    return;
  }

  // Host secrets are decrypted under the owner's key; without an unlocked DEK
  // there is nothing to hand the adapter.
  if (!DataCrypto.getUserDataKey(userId)) {
    fail(1008, "Data locked - re-authenticate with password");
    return;
  }

  const urlObj = new URL(req.url || "", "http://localhost");
  const hostId = Number.parseInt(urlObj.searchParams.get("hostId") ?? "", 10);
  if (!Number.isInteger(hostId)) {
    fail(1008, "hostId is required");
    return;
  }

  try {
    const hostRepository = createCurrentHostResolutionRepository();
    const ownerId = await hostRepository.findHostOwnerId(hostId);
    const host = ownerId
      ? await hostRepository.findHostById(hostId, ownerId)
      : null;

    if (!host) {
      fail(1008, "Host not found");
      return;
    }

    if (host.userId !== userId) {
      const access = await PermissionManager.getInstance().canAccessHost(
        userId,
        hostId,
        "connect",
      );
      if (!access.hasAccess) {
        sshLogger.warn("WebRTC access denied", {
          operation: "webrtc_access_denied",
          userId,
          hostId,
        });
        fail(1008, "Access denied to this host");
        return;
      }
    }

    const record = host as unknown as Record<string, unknown>;
    if (!record.enableStream) {
      fail(1008, "Stream is not enabled for this host");
      return;
    }
    if (record.streamMode !== "webrtc") {
      fail(1008, "This host is not configured for the WebRTC stream mode");
      return;
    }
    if (!record.streamUrl) {
      fail(1008, "This host has no stream URL configured");
      return;
    }

    // A recipient never gets the owner's credentials; it connects unauthenticated
    // unless the publisher itself is open. Owner-private by the same rule the
    // host list applies.
    const isOwner = host.userId === userId;
    const target: PublisherTarget = {
      baseUrl: String(record.streamUrl),
      path: (record.streamPath as string | null) ?? null,
      username: isOwner ? ((record.streamUser as string | null) ?? null) : null,
      password: isOwner
        ? ((record.streamPassword as string | null) ?? null)
        : null,
    };

    const publisher = resolvePublisher(record);
    adapter = createAdapter(
      publisher,
      target,
      (message) => send(message),
      (reason) => {
        send({ type: "error", message: reason });
        ws.close(1011, reason.slice(0, 120));
      },
    );

    await adapter.connect();
    send({ type: "ready", publisher });

    await logAudit({
      userId,
      username: await getAuditUsername(userId),
      action: "stream_connect",
      resourceType: "host",
      resourceId: String(hostId),
      resourceName: String(record.name ?? record.streamUrl),
      success: true,
    });

    sshLogger.info("WebRTC signaling session started", {
      operation: "webrtc_session_start",
      userId,
      hostId,
      publisher,
    });
  } catch (error) {
    sshLogger.error("Failed to start WebRTC signaling session", error, {
      operation: "webrtc_session_error",
      userId,
      hostId,
    });
    adapter?.close();
    adapter = null;
    fail(1011, "Failed to reach the stream publisher");
    return;
  }

  ws.on("message", (raw: RawData) => {
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
      sshLogger.error("Failed to forward WebRTC signaling message", error, {
        operation: "webrtc_forward_error",
        hostId,
      });
    }
  });

  ws.on("close", () => {
    adapter?.close();
    adapter = null;
    sshLogger.info("WebRTC signaling session ended", {
      operation: "webrtc_session_end",
      userId,
      hostId,
    });
  });
});

sshLogger.success("WebRTC signaling gateway started", {
  operation: "webrtc_init",
  port: PORT,
});

export { wss };
