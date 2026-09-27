import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { getErrorMessage } from "../lib/error-message.js";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import {
  createVpnProfile,
  updateVpnProfile,
  deleteVpnProfile,
  type VpnProfilePayload,
} from "@/main-axios";
import type { VpnProfile } from "@/types/ui-types";

/**
 * Network profiles: the tunnels hosts are reached through.
 *
 * A profile records where an operator-run tunnel's doorway is -- Termix does
 * not run the tunnel itself, which is why there is an address here and no
 * VPN credentials.
 */

type FormState = VpnProfilePayload & { id?: string };

const emptyForm: FormState = {
  name: "",
  gatewayType: "socks5",
  gatewayHost: "",
  gatewayPort: 1080,
  gatewayUsername: "",
  gatewayPassword: "",
};

function toForm(profile: VpnProfile): FormState {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "",
    gatewayType: profile.gatewayType,
    gatewayHost: profile.gatewayHost,
    gatewayPort: profile.gatewayPort,
    gatewayUsername: profile.gatewayUsername ?? "",
    // Left out on purpose: an unchanged field keeps the stored secret.
    gatewayPassword: undefined,
  };
}

export function VpnProfileManager({
  profiles,
  onChanged,
  onClose,
}: {
  profiles: VpnProfile[];
  onChanged: () => void;
  onClose: () => void;
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
      const payload: VpnProfilePayload = {
        ...form,
        gatewayPort: Number(form.gatewayPort),
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
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
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
                {profile.gatewayType} · {profile.gatewayHost}:
                {profile.gatewayPort}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
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
          {field(t("hosts.vpn.name"), "name", "Company X")}
          {field(t("hosts.vpn.gatewayHost"), "gatewayHost", "vpn-company-x")}
          {field(t("hosts.vpn.gatewayPort"), "gatewayPort", "1080", "number")}
          {field(t("hosts.vpn.gatewayUsername"), "gatewayUsername")}
          {field(
            t("hosts.vpn.gatewayPassword"),
            "gatewayPassword",
            form.id ? t("hosts.vpn.passwordUnchanged") : undefined,
            "password",
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
          onClick={() => setForm({ ...emptyForm })}
        >
          <Plus className="size-3 mr-1" />
          {t("hosts.vpn.add")}
        </Button>
      )}
    </div>
  );
}
