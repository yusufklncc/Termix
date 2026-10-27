import { KeyRound } from "lucide-react";
import {
  HOST_PROTOCOL_SECRET_KEPT,
  useTranslation,
  type HostEditorSectionProps,
  type HostProtocolAuthForm,
  type HostProtocolAuthType,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Input,
  PasswordInput,
  SectionCard,
  Select2,
  SettingRow,
} from "@termix-ssh/plugin-sdk/ui";

/**
 * The protocol whose login Direct RDP uses -- upstream's RDP. One Windows
 * account, entered once, whichever renderer opens the session. The manifest
 * says the same thing to the server as loginFrom.
 */
export const LOGIN_PROTOCOL = "rdp";

/** Upstream's switch for RDP, which shows its own login form while on. */
export const RDP_ENABLE_KEY = "enableRdp";

/** A login as the editor form holds it, with nothing missing. */
export function loginOf(login: unknown): HostProtocolAuthForm {
  const value = (login ?? {}) as Partial<HostProtocolAuthForm>;
  return {
    authType: value.authType ?? "direct",
    credentialId: value.credentialId ?? "",
    username: value.username ?? "",
    password: value.password ?? "",
    fields: { ...(value.fields ?? {}) },
  };
}

/**
 * The form patch that changes part of the shared RDP login.
 *
 * Written to protocolAuth.rdp rather than to a login of Direct RDP's own,
 * because that is the one the server reads for it and the one RDP's own form
 * edits: the two can never drift apart.
 */
export function patchRdpLogin(
  form: Record<string, unknown>,
  patch: Partial<HostProtocolAuthForm>,
): Record<string, unknown> {
  const all = (form.protocolAuth ?? {}) as Record<string, unknown>;
  const current = loginOf(all[LOGIN_PROTOCOL]);
  return {
    protocolAuth: { ...all, [LOGIN_PROTOCOL]: { ...current, ...patch } },
  };
}

/**
 * Offered while Direct RDP is on and RDP is not.
 *
 * With RDP on, RDP's own section shows this same login and a second form for
 * it would only be the same fields twice. With RDP off there was nowhere at
 * all to enter it -- which is how a host ended up connecting with the SSH
 * user and no password.
 */
export function loginSectionVisible(protocols: Record<string, boolean>) {
  return !!protocols.enableRdpDirect && !protocols[RDP_ENABLE_KEY];
}

interface CredentialOption {
  id: number | string;
  name?: string | null;
  username?: string | null;
}

export function RdpDirectLoginSection({
  form,
  updateForm,
  credentials,
}: HostEditorSectionProps) {
  const { t } = useTranslation();
  const login = loginOf(form?.protocolAuth?.[LOGIN_PROTOCOL]);
  const set = (patch: Partial<HostProtocolAuthForm>) =>
    updateForm((current) => patchRdpLogin(current, patch));
  const options = (credentials ?? []) as CredentialOption[];
  const kept = login.password === HOST_PROTOCOL_SECRET_KEPT;

  return (
    <SectionCard
      title={t("login.title")}
      icon={<KeyRound className="size-3.5" />}
    >
      <p className="pt-3 text-xs text-muted-foreground">{t("login.shared")}</p>

      <SettingRow label={t("login.authType")}>
        <Select2
          value={login.authType}
          aria-label={t("login.authType")}
          onChange={(event) =>
            set({ authType: event.target.value as HostProtocolAuthType })
          }
        >
          <option value="direct">{t("login.direct")}</option>
          <option value="credential">{t("login.credential")}</option>
        </Select2>
      </SettingRow>

      {login.authType === "credential" ? (
        <SettingRow label={t("login.credentialPick")}>
          <Select2
            value={login.credentialId}
            aria-label={t("login.credentialPick")}
            onChange={(event) => set({ credentialId: event.target.value })}
          >
            <option value="">{t("login.credentialNone")}</option>
            {options.map((credential) => (
              <option key={credential.id} value={String(credential.id)}>
                {credential.name ||
                  credential.username ||
                  String(credential.id)}
              </option>
            ))}
          </Select2>
        </SettingRow>
      ) : (
        <>
          <SettingRow label={t("login.username")}>
            <Input
              value={login.username}
              aria-label={t("login.username")}
              onChange={(event) => set({ username: event.target.value })}
            />
          </SettingRow>
          <SettingRow label={t("login.password")}>
            <PasswordInput
              // A saved password stays saved until something is typed: the
              // placeholder says so, and an untouched field sends nothing.
              value={kept ? "" : login.password}
              placeholder={kept ? t("login.passwordKept") : ""}
              aria-label={t("login.password")}
              onChange={(event) => set({ password: event.target.value })}
            />
          </SettingRow>
        </>
      )}

      <SettingRow label={t("login.domain")}>
        <Input
          value={login.fields.domain ?? ""}
          aria-label={t("login.domain")}
          onChange={(event) =>
            set({ fields: { ...login.fields, domain: event.target.value } })
          }
        />
      </SettingRow>
    </SectionCard>
  );
}
