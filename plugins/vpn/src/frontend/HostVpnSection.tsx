import { useEffect, useState } from "react";
import {
  useTranslation,
  type HostEditorSectionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { SettingRow } from "@termix-ssh/plugin-sdk/ui";
import type { VpnApi, VpnProfile } from "./api.js";

/**
 * Which network this host is reached through -- a choice among the ones that
 * exist, and nothing more.
 *
 * A network is shared by every host on it, so making, switching and deleting
 * them lives in the VPNs panel rather than in one host's form. Doing it here
 * made a shared thing look like a per-host setting, and switching one off in
 * one host silently changed every other host on the same network.
 */
type PluginSettingsBag = Record<string, Record<string, unknown>>;

const PLUGIN_ID = "vpn";

export function createHostVpnSection(api: VpnApi) {
  return function HostVpnSection({ form, updateForm }: HostEditorSectionProps) {
    const { t } = useTranslation();
    const [profiles, setProfiles] = useState<VpnProfile[]>([]);

    useEffect(() => {
      // A host can still be edited without them; the selector simply stays
      // empty rather than blocking the form.
      api
        .list()
        .then(setProfiles)
        .catch(() => setProfiles([]));
    }, []);

    /*
     * This plugin's host settings travel on form.pluginSettings under its own
     * id, not on the form itself. Reading the wrong one is quiet: the field
     * is simply always empty, so the editor says "direct" for a host that has
     * a network -- and saving from that form writes the emptiness back.
     */
    const bag = (form.pluginSettings as PluginSettingsBag | undefined)?.[
      PLUGIN_ID
    ];
    const current = bag?.profileId;
    const value = current == null ? "" : String(current);

    /*
     * The name travels beside the id.
     *
     * An id means "the seventh profile belonging to this user", which is not
     * something an export can carry: imported elsewhere it would point at
     * whatever happens to be seventh there, and the host would quietly leave
     * through the wrong network. The name is what survives the trip, and the
     * gateway prefers it whenever the id does not agree with it.
     */
    const setProfile = (profileId: number | null) =>
      updateForm((previous) => {
        const all =
          (previous.pluginSettings as PluginSettingsBag | undefined) ?? {};
        const profileName =
          profiles.find((profile) => Number(profile.id) === profileId)?.name ??
          null;
        return {
          pluginSettings: {
            ...all,
            [PLUGIN_ID]: { ...(all[PLUGIN_ID] ?? {}), profileId, profileName },
          },
        };
      });

    return (
      <SettingRow
        label={t("hosts.vpn.profile")}
        description={t("hosts.vpn.profileDesc")}
      >
        <select
          className="h-8 min-w-48 border border-border bg-background px-2 text-xs"
          value={value}
          onChange={(event) =>
            setProfile(event.target.value ? Number(event.target.value) : null)
          }
        >
          <option value="">{t("hosts.vpn.direct")}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </SettingRow>
    );
  };
}
