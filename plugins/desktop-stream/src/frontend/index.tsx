import { type Ref } from "react";
import { Cast } from "lucide-react";
import type {
  TermixApp,
  TabProps,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import StreamApp, {
  type StreamAppHandle,
  type StreamSettings,
} from "./StreamApp.js";

const PLUGIN_ID = "desktop-stream";
const ENABLE_KEY = "enableStream";

function settingsOf(host: PluginHostRecord | null | undefined) {
  const bag = host?.pluginSettings as
    Record<string, Record<string, unknown>> | undefined;
  return bag?.[PLUGIN_ID] ?? {};
}

function enabledFor(host: PluginHostRecord | null | undefined): boolean {
  return settingsOf(host)[ENABLE_KEY] === true;
}

/**
 * What the host's Stream settings say, in the shape the view wants.
 *
 * Read here rather than fetched: the host already carries its plugin
 * settings, so the tab never has a moment where it knows the host's id but
 * not where the stream lives.
 */
function streamSettingsOf(
  host: PluginHostRecord | null | undefined,
): StreamSettings {
  const values = settingsOf(host);
  const path = typeof values.path === "string" ? values.path.trim() : "";
  return {
    url: typeof values.url === "string" ? values.url.trim() : "",
    path: path || null,
    // Embed unless asked otherwise: it needs nothing of the server, so a host
    // saved before the gateway existed keeps working.
    mode: values.mode === "webrtc" ? "webrtc" : "embed",
  };
}

export function activate(app: TermixApp): void {
  function StreamTab({ tab, host, handleRef }: TabProps) {
    return (
      <StreamApp
        ref={handleRef as Ref<StreamAppHandle>}
        hostId={String(host?.id ?? "")}
        hostName={host?.name || host?.ip || String(host?.id ?? "")}
        tabId={tab.id}
        settings={streamSettingsOf(host)}
        getWsTarget={() => app.wsUrl("/signaling")}
      />
    );
  }

  app.registerHostProtocol({
    id: PLUGIN_ID,
    settingKey: ENABLE_KEY,
    defaultPort: 443,
    titleKey: "protocol.title",
    descriptionKey: "protocol.description",
    icon: Cast,
    order: 60,
  });

  app.registerHostAction({
    id: PLUGIN_ID,
    titleKey: "protocol.title",
    icon: Cast,
    kind: "connect",
    order: 60,
    tabType: PLUGIN_ID,
    when: enabledFor,
  });

  app.registerTab(PLUGIN_ID, StreamTab, {
    icon: Cast,
    titleKey: "tabs.stream",
    requiresHost: true,
    persistent: true,
    session: true,
    activityTypes: [PLUGIN_ID],
    restore: enabledFor,
    preload: () => import("./StreamApp.js"),
  });
}
