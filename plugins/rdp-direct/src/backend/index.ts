import type { PluginContext } from "@termix/plugin-sdk/backend";
import { readHostSettings } from "./host-settings.js";
import { runSession } from "./session.js";

/**
 * Direct RDP: the server's own H.264, passed through rather than re-encoded.
 *
 * guacd decodes what the RDP server sends and re-encodes it as image tiles,
 * which is what makes 1080p60 expensive. The bridge container takes the
 * frames as they arrive and this plugin hands them to the browser untouched;
 * the decoding happens there, on a worker thread.
 *
 * A protocol of its own rather than an option on the RDP tab, so upstream's
 * remote-desktop plugin is left alone and keeps its own path. Both can be
 * enabled on one host, and each opens its own tab.
 */
export async function activate(ctx: PluginContext) {
  /*
   * Core authenticates the upgrade, so there is no token to mint and no
   * session to verify here. The viewer's data key has to still be unlocked,
   * though: the host's password is decrypted with it, and a socket can
   * outlive the session that opened it.
   */
  ctx.ws.route("/session", async (connection) => {
    const ws = connection.socket as Parameters<typeof runSession>[0]["ws"];
    if (!connection.isDataUnlocked()) {
      ws.close(1008, "Data locked - re-authenticate with your password");
      return;
    }

    const request = connection.request as { url?: string };
    await runSession({
      ctx,
      ws,
      userId: connection.userId,
      url: new URL(request.url ?? "", "http://localhost"),
    });
  });

  // Core's status dot pings this host on the port Direct RDP would use.
  ctx.hosts.status.registerPort("rdp-direct" as never, async (hostId) => {
    const settings = await readHostSettings(ctx, hostId);
    return settings.port;
  });

  ctx.log.info("Direct RDP mounted at /plugin-ws/rdp-direct/session");
}

export async function deactivate() {
  // Everything is registered through ctx, which core disposes.
}
