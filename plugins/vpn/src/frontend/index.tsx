import { Waypoints } from "lucide-react";
import type { TermixApp, PanelProps } from "@termix/plugin-sdk/frontend";
import { createVpnApi } from "./api.js";
import { createHostVpnSection } from "./HostVpnSection.js";
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
    // Where it sat before it moved here, rather than at the end of the rail,
    // which is where a plugin item goes by default.
    after: "credentials",
    /*
     * Kept in the Simple preset, which otherwise hides every plugin item.
     *
     * This is not a power-user extra: a host on a VPN is unreachable without
     * it, and it was a core destination before it moved here -- so hiding it
     * by default would take away the only way to manage the thing those
     * hosts depend on.
     */
    simplePreset: true,
  });

  app.registerPanel(PLUGIN_ID, (_props: PanelProps) => <VpnsPanel api={api} />);

  /*
   * The host editor keeps only the choice of which network a host uses.
   *
   * Beside General and SSH rather than inside the SSH strip: which network a
   * host is reached through is not an SSH setting, and an RDP host uses it
   * too.
   */
  app.registerHostEditorSection({
    id: PLUGIN_ID,
    group: "top",
    titleKey: "nav.vpns",
    icon: Waypoints,
    order: 50,
    component: createHostVpnSection(api),
  });
}
