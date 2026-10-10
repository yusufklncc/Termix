import { Waypoints } from "lucide-react";
import type { TermixApp, PanelProps } from "@termix/plugin-sdk/frontend";
import { createVpnApi } from "./api.js";
import { VpnsPanel } from "./VpnsPanel.js";

const PLUGIN_ID = "vpn";

export function activate(app: TermixApp): void {
  const api = createVpnApi(app);

  /*
   * A destination of its own rather than a corner of the host editor.
   *
   * A network is shared by every host on it, so bringing one up or taking it
   * down affects all of them. Editing it from inside one host's form made
   * that look like a per-host setting, and switching it off in one host
   * silently changed every other host on the same network.
   */
  app.registerRailItem({
    id: PLUGIN_ID,
    icon: Waypoints,
    titleKey: "nav.vpns",
  });

  app.registerPanel(PLUGIN_ID, (_props: PanelProps) => <VpnsPanel api={api} />);
}
