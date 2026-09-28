import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Play, Plug, Plus, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { getErrorMessage } from "../lib/error-message.js";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/select";
import {
  createVpnProfile,
  updateVpnProfile,
  deleteVpnProfile,
  setVpnProfileEnabled,
  disconnectVpnProfile,
  type VpnProfilePayload,
} from "@/main-axios";
import type { VpnProfile } from "@/types/ui-types";

/**
 * Network profiles: the tunnels hosts are reached through.
 *
 * Two kinds. A declared profile records where a tunnel the operator runs has
 * its doorway; Termix only knows the address. A managed one is raised by
 * Termix through the network manager, so it carries what to dial and as whom,
 * and the address is worked out rather than typed.
 *
 * The kind is fixed at creation: the two have different fields and a
 * different thing holding the tunnel up, so changing it is making a new
 * profile, not editing one.
 */

type FormState = VpnProfilePayload & { id?: string };

const emptyForm: FormState = {
  name: "",
  kind: "declared",
  gatewayType: "socks5",
  gatewayHost: "",
  gatewayPort: 1080,
  gatewayUsername: "",
  gatewayPassword: "",
};

const emptyManagedForm: FormState = {
  name: "",
  kind: "managed",
  provider: "fortinet",
  serverHost: "",
  serverPort: 443,
  authUsername: "",
  authPassword: "",
  trustedFingerprint: "",
  // A managed profile has no address to give; the manager answers with one.
  gatewayHost: "",
  gatewayPort: 0,
};

function toForm(profile: VpnProfile): FormState {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "",
    kind: profile.kind,
    gatewayType: profile.gatewayType,
    gatewayHost: profile.gatewayHost,
    gatewayPort: profile.gatewayPort,
    gatewayUsername: profile.gatewayUsername ?? "",
    // Left out on purpose: an unchanged field keeps the stored secret.
    gatewayPassword: undefined,
    provider: profile.provider ?? undefined,
    serverHost: profile.serverHost ?? "",
    serverPort: profile.serverPort ?? 443,
    authUsername: profile.authUsername ?? "",
    authPassword: undefined,
    trustedFingerprint: profile.trustedFingerprint ?? "",
  };
}

/** What the manager last said about a managed profile. A declared one has
 * nobody to report, which is why it shows nothing rather than "unknown". */
function StateBadge({ profile }: { profile: VpnProfile }) {
  const { t } = useTranslation();
  if (profile.kind !== "managed") return null;
  if (profile.enabled !== false && !profile.lastState) return null;

  if (profile.enabled === false) {
    return (
      <span className="text-[10px] text-muted-foreground">
        {t("hosts.vpn.stateOff")}
      </span>
    );
  }

  const labels: Record<string, string> = {
    // "Ready" rather than "down": the tunnel comes up when a session needs it
    // and goes when none do, so not being connected is the resting state.
    idle: t("hosts.vpn.stateIdle"),
    up: t("hosts.vpn.stateUp"),
    connecting: t("hosts.vpn.stateConnecting"),
    down: t("hosts.vpn.stateDown"),
    error: t("hosts.vpn.stateError"),
  };
  const tone =
    profile.lastState === "up"
      ? "text-green-500"
      : profile.lastState === "error" || profile.lastState === "refused"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <span className={`text-[10px] ${tone}`} title={profile.lastError ?? ""}>
      {labels[profile.lastState] ?? profile.lastState}
    </span>
  );
}

export function VpnProfileManager({
  profiles,
  onChanged,
  onClose,
}: {
  profiles: VpnProfile[];
  onChanged: () => void;
  /** Absent where this is a panel of its own rather than a card inside a form. */
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      // Spread rather than listed, so a field added to the form reaches the
      // API without being remembered here too. Only the numbers need saying:
      // an <input> hands them back as text.
      const payload: VpnProfilePayload = {
        ...form,
        gatewayPort: Number(form.gatewayPort),
        ...(form.kind === "managed" && form.provider !== "tailscale"
          ? { serverPort: Number(form.serverPort) || 443 }
          : {}),
      };
      if (form.id) {
        await updateVpnProfile(Number(form.id), payload);
      } else {
        await createVpnProfile(payload);
      }
      toast.success(t("hosts.vpn.saved"));
      setForm(null);
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t("hosts.vpn.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleSwitch = async (profile: VpnProfile) => {
    try {
      await setVpnProfileEnabled(Number(profile.id), profile.enabled === false);
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t("hosts.vpn.switchFailed")));
    }
  };

  const handleDisconnect = async (profile: VpnProfile) => {
    try {
      await disconnectVpnProfile(Number(profile.id));
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t("hosts.vpn.disconnectFailed")));
    }
  };

  const handleDelete = async (profile: VpnProfile) => {
    try {
      await deleteVpnProfile(Number(profile.id));
      toast.success(t("hosts.vpn.deleted"));
      onChanged();
    } catch (error) {
      // The API refuses while hosts still use it, and says how many; showing
      // that message is more useful than a generic failure.
      toast.error(getErrorMessage(error, t("hosts.vpn.deleteFailed")));
    }
  };

  const field = (
    label: string,
    key: keyof FormState,
    placeholder?: string,
    type?: string,
  ) => (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      <Input
        className="h-8 text-xs"
        type={type}
        placeholder={placeholder}
        value={(form?.[key] as string | number | undefined) ?? ""}
        onChange={(e) => setField(key, e.target.value as FormState[typeof key])}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-3 col-span-2 border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {t("hosts.vpn.manage")}
        </span>
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        {t("hosts.vpn.managerHint")}
      </p>

      <div className="flex flex-col gap-1">
        {profiles.length === 0 && (
          <span className="text-[10px] text-muted-foreground">
            {t("hosts.vpn.none")}
          </span>
        )}
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="flex items-center justify-between border border-border bg-background px-2 py-1.5"
          >
            <div className="flex flex-col min-w-0">
              <span className="text-xs truncate">{profile.name}</span>
              <span className="text-[10px] text-muted-foreground truncate">
                {profile.kind === "managed"
                  ? `${profile.provider ?? ""} · ${profile.serverHost ?? ""}`
                  : `${profile.gatewayType} · ${profile.gatewayHost}:${profile.gatewayPort}`}
              </span>
              <StateBadge profile={profile} />
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {/* Only while it is up: taking down a tunnel nothing is using
                  would do nothing worth a button. */}
              {profile.kind === "managed" && profile.lastState === "up" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  title={t("hosts.vpn.disconnectNow")}
                  onClick={() => handleDisconnect(profile)}
                >
                  <Plug className="size-3" />
                </Button>
              )}
              {profile.kind === "managed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  title={
                    profile.enabled === false
                      ? t("hosts.vpn.switchOn")
                      : t("hosts.vpn.switchOff")
                  }
                  onClick={() => handleSwitch(profile)}
                >
                  {profile.enabled === false ? (
                    <Play className="size-3" />
                  ) : (
                    <Square className="size-3" />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={() => setForm(toForm(profile))}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-destructive"
                onClick={() => handleDelete(profile)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {form ? (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          {/* Only worth saying for a profile from before Termix raised its own
              tunnels; a new one is always managed. */}
          {form.kind !== "managed" && (
            <p className="text-[10px] text-muted-foreground">
              {t("hosts.vpn.kindDeclaredLegacy")}
            </p>
          )}

          {field(t("hosts.vpn.name"), "name", "Company X")}

          {form.kind === "managed" ? (
            <>
              <p className="text-[10px] text-muted-foreground">
                {t("hosts.vpn.managedHint")}
              </p>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                  {t("hosts.vpn.provider")}
                </label>
                <Select
                  value={form.provider ?? "fortinet"}
                  onValueChange={(value) => setField("provider", value)}
                >
                  <SelectTrigger
                    aria-label={t("hosts.vpn.provider")}
                    size="sm"
                    className="h-8 w-full text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fortinet" className="text-xs">
                      {t("hosts.vpn.providerFortinet")}
                    </SelectItem>
                    <SelectItem value="tailscale" className="text-xs">
                      {t("hosts.vpn.providerTailscale")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* A tailnet is signed in to, not dialled: it has a key and,
                  if self-hosted, a control server. Showing it a gateway
                  address and a username would be asking for what it has no
                  use for. */}
              {form.provider === "tailscale" ? (
                <>
                  {field(
                    t("hosts.vpn.authKey"),
                    "authPassword",
                    form.id ? t("hosts.vpn.passwordUnchanged") : "tskey-auth-",
                    "password",
                  )}
                  {field(
                    t("hosts.vpn.loginServer"),
                    "serverHost",
                    t("hosts.vpn.loginServerHint"),
                  )}
                </>
              ) : (
                <>
                  {field(
                    t("hosts.vpn.serverHost"),
                    "serverHost",
                    "vpn.company.com",
                  )}
                  {field(
                    t("hosts.vpn.serverPort"),
                    "serverPort",
                    "443",
                    "number",
                  )}
                  {field(t("hosts.vpn.authUsername"), "authUsername")}
                  {field(
                    t("hosts.vpn.authPassword"),
                    "authPassword",
                    form.id ? t("hosts.vpn.passwordUnchanged") : undefined,
                    "password",
                  )}
                  {field(
                    t("hosts.vpn.trustedFingerprint"),
                    "trustedFingerprint",
                    t("hosts.vpn.trustedFingerprintHint"),
                  )}
                </>
              )}
            </>
          ) : (
            <>
              {field(
                t("hosts.vpn.gatewayHost"),
                "gatewayHost",
                "vpn-company-x",
              )}
              {field(
                t("hosts.vpn.gatewayPort"),
                "gatewayPort",
                "1080",
                "number",
              )}
              {field(t("hosts.vpn.gatewayUsername"), "gatewayUsername")}
              {field(
                t("hosts.vpn.gatewayPassword"),
                "gatewayPassword",
                form.id ? t("hosts.vpn.passwordUnchanged") : undefined,
                "password",
              )}
            </>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7"
              disabled={saving}
              onClick={handleSave}
            >
              {t("common.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => setForm(null)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 self-start"
          onClick={() => setForm({ ...emptyManagedForm })}
        >
          <Plus className="size-3 mr-1" />
          {t("hosts.vpn.add")}
        </Button>
      )}
    </div>
  );
}
