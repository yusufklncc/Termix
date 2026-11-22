import { type Ref } from "react";
import { MonitorPlay } from "lucide-react";
import type {
  TermixApp,
  TabProps,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import RdpDirectApp, { type RdpDirectAppHandle } from "./RdpDirectApp.js";
import { RdpDirectSection, sectionVisible } from "./LoginSection.js";

const PLUGIN_ID = "rdp-direct";
const ENABLE_KEY = "enableRdpDirect";

/**
 * Is Direct RDP switched on for this host?
 *
 * The switch lives in the editor's protocol list, beside SSH and RDP, so it
 * is stored as this plugin's own host setting rather than a column.
 */
function enabledFor(host: PluginHostRecord | null | undefined): boolean {
  const settings = host?.pluginSettings as
    Record<string, Record<string, unknown>> | undefined;
  return settings?.[PLUGIN_ID]?.[ENABLE_KEY] === true;
}

export function activate(app: TermixApp): void {
  function RdpDirectTab({ tab, host, handleRef }: TabProps) {
    return (
      <RdpDirectApp
        ref={handleRef as Ref<RdpDirectAppHandle>}
        hostId={String(host?.id ?? "")}
        tabId={tab.id}
        /*
         * Asked for per session rather than held: core mints the address with
         * the subprotocols that carry it, and one minted at mount would be
         * stale by the time someone reconnects an hour later.
         */
        getWsTarget={() => app.wsUrl("/session")}
      />
    );
  }

  /*
   * Listed with the other protocols rather than tucked into a tab of its own.
   * Direct RDP is a way of reaching a host, which is the question that card
   * answers, and a host can have both it and guacd's RDP switched on -- they
   * are separate protocols here, so each opens its own tab.
   */
  app.registerHostProtocol({
    id: PLUGIN_ID,
    settingKey: ENABLE_KEY,
    portKey: "port",
    defaultPort: 3389,
    // The same Windows account RDP signs in with. Kept alive on save while
    // this is on, even with RDP itself switched off.
    loginFrom: "rdp",
    titleKey: "protocol.title",
    descriptionKey: "protocol.description",
    icon: MonitorPlay,
    order: 25,
  });

  /*
   * Everything Direct RDP asks of a host, in one section named after the
   * protocol the way upstream's RDP does it: the port, printing, and the
   * Windows login while RDP is off. See LoginSection.tsx for why the login
   * is RDP's own and why the port lives here rather than in the manifest.
   */
  app.registerHostEditorSection({
    id: PLUGIN_ID,
    group: "top",
    titleKey: "protocol.title",
    icon: MonitorPlay,
    order: 26,
    visible: sectionVisible,
    // Shown in the simple host editor too: a host can't connect without it.
    ...{ simple: true },
    component: RdpDirectSection,
  });

  app.registerHostAction({
    id: PLUGIN_ID,
    titleKey: "protocol.title",
    icon: MonitorPlay,
    kind: "connect",
    order: 25,
    tabType: PLUGIN_ID,
    when: enabledFor,
  });

  app.registerTab(PLUGIN_ID, RdpDirectTab, {
    icon: MonitorPlay,
    titleKey: "tabs.rdpDirect",
    requiresHost: true,
    persistent: true,
    session: true,
    activityTypes: [PLUGIN_ID],
    // A saved tab for a host that has since been switched off is not reopened.
    restore: enabledFor,
    preload: () => import("./RdpDirectApp.js"),
  });
}
