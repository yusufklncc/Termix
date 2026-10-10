import { type Ref } from "react";
import { MonitorPlay } from "lucide-react";
import type { TermixApp, TabProps } from "@termix/plugin-sdk/frontend";
import RdpDirectApp, { type RdpDirectAppHandle } from "./RdpDirectApp.js";

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

  app.registerTab("rdp-direct", RdpDirectTab, {
    icon: MonitorPlay,
    titleKey: "tabs.rdpDirect",
    requiresHost: true,
    persistent: true,
    session: true,
    activityTypes: ["rdp-direct"],
    preload: () => import("./RdpDirectApp.js"),
  });
}
