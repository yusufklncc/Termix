import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";

import type { VpnApi, VpnProfile } from "./api.js";
import { VpnProfileManager } from "./VpnProfileManager.js";

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
export function VpnsPanel({ api }: { api: VpnApi }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);

  const load = useCallback(() => {
    // A failure leaves the list empty rather than taking the panel down: a
    // manager that is briefly unreachable is not a reason to show nothing but
    // an error.
    api
      .list()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [api]);

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
          {t("nav.vpns")}
        </h2>
      </div>
      <VpnProfileManager api={api} profiles={profiles} onChanged={load} />
    </div>
  );
}
