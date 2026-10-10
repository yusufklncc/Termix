/**
 * How the bytes get to a host: port knocking, a jump host chain or a SOCKS5
 * proxy, in that order. Sets config.sock and
 * returns the jump client so the caller can close it with the connection.
 *
 * The proxy step asks one question -- "what should this host leave through?"
 * -- and the answer may be the host's own proxy or a VPN Termix raises for
 * it. Both arrive as the same config, so there is one path and one place that
 * decides, which is what keeps a host marked "reach this through somewhere
 * else" from quietly leaving by the server's own route.
 */

import type { Client } from "ssh2";
import { logger } from "../../utils/logger.js";
import { createSocks5Connection } from "../../utils/socks5-helper.js";
import { resolveHostGateway } from "./host-gateway.js";
import { createJumpHostChain } from "../jump-host-chain.js";
import { resolveSshConnectConfigHost } from "../ssh-dns.js";
import { performPortKnocking } from "../terminal-auth-helpers.js";
import type {
  MutableConnectConfig,
  SshAuthLog,
  SshConnectHost,
  SshPromptChannel,
} from "./types.js";

class SshTransportError extends Error {
  constructor(
    message: string,
    readonly stage: "jump-host" | "jump-forward" | "proxy",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SshTransportError";
  }
}

export interface OpenTransportOptions {
  prompt?: SshPromptChannel;
  /** Knock before connecting when the host has a sequence. Default true. */
  portKnock?: boolean;
  /** Resolve DNS up front for a direct connection. Default true. */
  resolveDns?: boolean;
  log?: SshAuthLog;
}

export interface OpenedTransport {
  jumpClient: Client | null;
  via: "direct" | "proxy" | "jump";
}

function forwardThrough(
  jumpClient: Client,
  host: SshConnectHost,
): Promise<NonNullable<MutableConnectConfig["sock"]>> {
  return new Promise((resolve, reject) => {
    jumpClient.forwardOut(
      "127.0.0.1",
      0,
      host.ip,
      host.port || 22,
      (err, stream) => {
        if (err) {
          reject(
            new SshTransportError(
              "Failed to forward through jump host: " + err.message,
              "jump-forward",
              { cause: err },
            ),
          );
          return;
        }
        resolve(stream);
      },
    );
  });
}

export async function openSshTransport(
  host: SshConnectHost,
  config: MutableConnectConfig,
  options: OpenTransportOptions = {},
): Promise<OpenedTransport> {
  if (
    options.portKnock !== false &&
    Array.isArray(host.portKnockSequence) &&
    host.portKnockSequence.length > 0
  ) {
    try {
      await performPortKnocking(host.ip, host.portKnockSequence);
    } catch {
      logger.warn("Port knocking failed, attempting connection anyway", {
        operation: "port_knock",
        hostId: host.id,
      });
    }
  }

  let via: OpenedTransport["via"] = "direct";

  const jumpUserId = host.userId || "";
  if (host.jumpHosts && host.jumpHosts.length > 0 && jumpUserId) {
    const jumpClient = await createJumpHostChain(
      host.jumpHosts,
      jumpUserId,
      options.prompt,
    );
    if (!jumpClient) {
      throw new SshTransportError(
        "Failed to connect through jump hosts",
        "jump-host",
      );
    }
    try {
      config.sock = await forwardThrough(jumpClient, host);
    } catch (error) {
      jumpClient.end();
      throw error;
    }
    return { jumpClient, via: "jump" };
  }

  /*
   * Resolving can refuse: a VPN switched off, or a profile that is gone.
   * Those refusals are the point of the field, so they are reported rather
   * than stepped over -- carrying on would connect by exactly the route the
   * host was configured to avoid.
   */
  let gateway;
  try {
    gateway = await resolveHostGateway(host);
  } catch (error) {
    throw new SshTransportError(
      error instanceof Error ? error.message : String(error),
      "proxy",
      { cause: error },
    );
  }

  if (gateway && via === "direct") {
    try {
      const proxySocket = await createSocks5Connection(
        host.ip,
        host.port || 22,
        gateway.config,
      );
      if (proxySocket) {
        config.sock = proxySocket;
        via = "proxy";
      }
    } catch (error) {
      throw new SshTransportError(gateway.describeFailure(error), "proxy", {
        cause: error,
      });
    }
  }

  if (via === "direct" && options.resolveDns !== false) {
    await resolveSshConnectConfigHost(config);
  }

  return { jumpClient: null, via };
}
