import type { PluginContext } from "@termix/plugin-sdk/backend";

/**
 * Direct RDP: the server's own H.264, passed through rather than re-encoded.
 *
 * guacd decodes what the RDP server sends and re-encodes it as image tiles,
 * which is what makes 1080p60 expensive. The bridge container takes the
 * frames as they arrive and this plugin hands them to the browser untouched;
 * the decoding happens there, on a worker thread.
 *
 * A protocol of its own rather than an option on the RDP tab, so upstream's
 * remote-desktop plugin is left alone and keeps its own path. The two can be
 * enabled on the same host, and each opens its own tab.
 */
export async function activate(ctx: PluginContext) {
  ctx.log.info("Direct RDP loaded");
}

export async function deactivate() {
  // Everything is registered through ctx, which core disposes.
}
