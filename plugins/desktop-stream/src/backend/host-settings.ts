import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { StreamPublisher } from "./signaling-adapter.js";

export interface StreamHostSettings {
  enabled: boolean;
  url: string;
  path: string | null;
  mode: "embed" | "webrtc";
  publisher: StreamPublisher;
}

/** This host's stream settings, as the editor wrote them. */
export async function readHostSettings(
  ctx: PluginContext,
  hostId: number,
): Promise<StreamHostSettings> {
  const values = await ctx.settings.getAll("host", hostId);
  const path = typeof values.path === "string" ? values.path.trim() : "";
  return {
    enabled: values.enableStream === true,
    url: typeof values.url === "string" ? values.url.trim() : "",
    path: path || null,
    // Embed unless asked otherwise: it needs nothing of this server, so a
    // host saved before the gateway existed keeps working.
    mode: values.mode === "webrtc" ? "webrtc" : "embed",
    publisher: values.publisher === "neko" ? "neko" : "selkies",
  };
}
