import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getVpnProfiles } from "@/main-axios";
import type { VpnProfile } from "@/types/ui-types";
import { VpnProfileManager } from "@/sidebar/VpnProfileManager";

/**
 * Networks, where they belong.
 *
 * A network is shared: several hosts are reached through one, and bringing it
 * up or taking it down affects all of them. Managing it from inside a host's
 * editor made that look like a per-host setting, so switching one off in one
 * host's form silently changed every other host on the same network.
 *
 * The host editor keeps only the choice of which network a host uses.
 */
export function NetworksPanel() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);

  const load = useCallback(() => {
    getVpnProfiles()
      .then((rows) =>
        setProfiles(
          Array.isArray(rows) ? (rows as unknown as VpnProfile[]) : [],
        ),
      )
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    load();
    /*
     * A VPN comes up when a session needs it and goes when none do, without
     * anyone pressing anything here. A list that only loaded once would sit
     * saying "ready" while one is carrying traffic.
     */
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto p-2">
      <div className="mb-2 px-1">
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {t("nav.networks")}
        </h2>
      </div>
      <VpnProfileManager profiles={profiles} onChanged={load} />
    </div>
  );
}
