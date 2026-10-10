import type { PluginContext } from "@termix/plugin-sdk/backend";
import { runSession } from "./session.js";

/**
 * A desktop someone else is already publishing, opened as a host.
 *
 * Two ways, per host. Embed renders the publisher's own page and needs
 * nothing of this server. WebRTC relays the signaling and nothing else: the
 * video and input go straight between the browser and the publisher, so a
 * stream costs this server close to nothing however many pixels it carries.
 */
export async function activate(ctx: PluginContext) {
  ctx.ws.route("/signaling", async (connection) => {
    const ws = connection.socket as Parameters<typeof runSession>[0]["ws"];
    // The publisher's credentials are decrypted under the owner's key; a
    // socket can outlive the session that opened it.
    if (!connection.isDataUnlocked()) {
      ws.close(1008, "Data locked - re-authenticate with your password");
      return;
    }

    const request = connection.request as { url?: string };
    await runSession({
      ctx,
      ws,
      url: new URL(request.url ?? "", "http://localhost"),
    });
  });

  ctx.log.info("Stream signaling mounted at /plugin-ws/stream/signaling");
}

export async function deactivate() {
  // Everything is registered through ctx, which core disposes.
}
