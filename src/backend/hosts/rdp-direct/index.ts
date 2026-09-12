import net from "net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { AuthManager } from "../../utils/auth-manager.js";
import { DataCrypto } from "../../utils/data-crypto.js";
import { PermissionManager } from "../../utils/permission-manager.js";
import { sshLogger } from "../../utils/logger.js";
import { resolveRdpBridgeOptions } from "../../utils/rdp-bridge-config.js";
import { resolveDisplaySize } from "./display-size.js";
import {
  openJumpTunnel,
  parseJumpHosts,
  type JumpTunnel,
} from "./jump-tunnel.js";
import {
  createCurrentHostResolutionRepository,
  createCurrentSettingsRepository,
} from "../../database/repositories/factory.js";
import { logAudit, getAuditUsername } from "../../utils/audit-logger.js";

/**
 * Direct RDP path: FreeRDP's H.264 bitstream straight to the browser.
 *
 * Termix authenticates the viewer, checks it may reach the host, then opens a
 * TCP session to the bridge sidecar and relays its frames verbatim. Nothing
 * here parses or transcodes a frame -- the wire format the bridge emits is the
 * one the browser's WebCodecs decoder consumes.
 *
 * Auth follows the terminal module, like the WebRTC gateway does.
 */

const PORT = 30014;

const authManager = AuthManager.getInstance();

const wss = new WebSocketServer({ port: PORT });

wss.on("error", (error) => {
  sshLogger.error("Direct RDP server error", error, {
    operation: "rdp_direct_wss_error",
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

/** Wire frame: 4-byte ASCII magic, u32 little-endian length, payload. */
function encodeFrame(magic: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(magic, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function resolveBridge(): Promise<{ host: string; port: number }> {
  let dbUrl: string | undefined;
  try {
    dbUrl =
      (await createCurrentSettingsRepository().get("rdp_bridge_url")) ??
      undefined;
  } catch {
    // Settings unavailable; environment and defaults still apply.
  }
  return resolveRdpBridgeOptions(dbUrl);
}

wss.on("connection", async (ws: WebSocket, req) => {
  let userId: string | undefined;
  let bridge: net.Socket | null = null;
  let tunnel: JumpTunnel | null = null;

  const fail = (code: number, message: string) => {
    try {
      ws.send(encodeFrame("ERRR", Buffer.from(message, "utf8")));
    } catch {
      // socket already gone
    }
    ws.close(code, message.slice(0, 120));
  };

  ws.on("error", (error) => {
    sshLogger.error("Direct RDP connection error", error, {
      operation: "rdp_direct_ws_error",
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
    sshLogger.error("Direct RDP JWT verification failed", error, {
      operation: "rdp_direct_auth_error",
      ip: req.socket.remoteAddress,
    });
    ws.close(1008, "Authentication required");
    return;
  }

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
        sshLogger.warn("Direct RDP access denied", {
          operation: "rdp_direct_access_denied",
          userId,
          hostId,
        });
        fail(1008, "Access denied to this host");
        return;
      }
    }

    const record = host as unknown as Record<string, unknown>;
    if (!record.enableRdp) {
      fail(1008, "RDP is not enabled for this host");
      return;
    }
    if (record.rdpRenderEngine !== "direct") {
      fail(1008, "This host is not configured for the direct RDP renderer");
      return;
    }

    const { width, height, pinned } = resolveDisplaySize({
      hostConfig: record.guacamoleConfig,
      requestedWidth: urlObj.searchParams.get("width"),
      requestedHeight: urlObj.searchParams.get("height"),
    });

    if (pinned) {
      sshLogger.info("Direct RDP using the host's pinned resolution", {
        operation: "rdp_direct_pinned_resolution",
        hostId,
        userId,
      });
    }

    const connectRequest = {
      host: String(record.ip ?? ""),
      port: Number(record.rdpPort ?? 3389) || 3389,
      username: String(record.rdpUser ?? record.username ?? ""),
      password: String(record.rdpPassword ?? record.password ?? ""),
      domain: String(record.rdpDomain ?? record.domain ?? ""),
      width,
      height,
      ignoreCert: record.rdpIgnoreCert !== false,
    };

    const { host: bridgeHost, port: bridgePort } = await resolveBridge();

    /*
     * A host behind jump hosts is dialled through them, not around them. The
     * bridge takes a host and port and knows nothing about the chain, so the
     * hops are opened here and the bridge is handed a local listener instead.
     *
     * A configured chain that cannot be established fails the session: dialling
     * the target directly would quietly ignore the hops the host requires.
     */
    const jumpHosts = parseJumpHosts(record.jumpHosts);
    if (jumpHosts.length > 0) {
      try {
        tunnel = await openJumpTunnel({
          jumpHosts,
          userId,
          target: { host: connectRequest.host, port: connectRequest.port },
          consumerHost: bridgeHost,
        });
        if (tunnel) {
          connectRequest.host = tunnel.host;
          connectRequest.port = tunnel.port;
          sshLogger.info("Direct RDP tunnelled through jump hosts", {
            operation: "rdp_direct_jump_tunnel",
            hostId,
            userId,
            hops: jumpHosts.length,
          });
        }
      } catch (error) {
        sshLogger.error("Failed to open the jump host tunnel", error, {
          operation: "rdp_direct_jump_tunnel_error",
          hostId,
          userId,
        });
        fail(1011, "Failed to reach the host through its jump hosts");
        return;
      }
    }

    bridge = net.createConnection({ host: bridgeHost, port: bridgePort });
    bridge.setNoDelay(true);

    bridge.on("connect", () => {
      bridge?.write(
        encodeFrame(
          "CONN",
          Buffer.from(JSON.stringify(connectRequest), "utf8"),
        ),
      );
    });

    // The bridge's frames are already the browser's wire format; relaying them
    // as-is is what keeps this process off the video path.
    bridge.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });

    bridge.on("error", (error) => {
      sshLogger.error("RDP bridge socket error", error, {
        operation: "rdp_direct_bridge_error",
        hostId,
        bridgeHost,
        bridgePort,
      });
      fail(1011, "Failed to reach the RDP bridge");
    });

    bridge.on("close", () => {
      tunnel?.close();
      tunnel = null;
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Session ended");
    });

    await logAudit({
      userId,
      username: await getAuditUsername(userId),
      action: "rdp_direct_connect",
      resourceType: "host",
      resourceId: String(hostId),
      resourceName: `${connectRequest.host}:${connectRequest.port}`,
      success: true,
    });

    sshLogger.info("Direct RDP session started", {
      operation: "rdp_direct_session_start",
      userId,
      hostId,
    });
  } catch (error) {
    sshLogger.error("Failed to start direct RDP session", error, {
      operation: "rdp_direct_session_error",
      userId,
      hostId,
    });
    bridge?.destroy();
    bridge = null;
    fail(1011, "Failed to start the RDP session");
    return;
  }

  ws.on("message", (raw: RawData) => {
    if (!bridge || bridge.destroyed) return;
    // Input frames are already framed by the browser; pass them through.
    const buffer = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw as ArrayBuffer);
    bridge.write(buffer);
  });

  ws.on("close", () => {
    bridge?.destroy();
    bridge = null;
    tunnel?.close();
    tunnel = null;
    sshLogger.info("Direct RDP session ended", {
      operation: "rdp_direct_session_end",
      userId,
      hostId,
    });
  });
});

sshLogger.success("Direct RDP gateway started", {
  operation: "rdp_direct_init",
  port: PORT,
});

export { wss };
