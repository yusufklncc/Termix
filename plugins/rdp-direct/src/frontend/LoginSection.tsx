import { KeyRound, MonitorPlay } from "lucide-react";
import {
  HOST_PROTOCOL_SECRET_KEPT,
  useTranslation,
  type HostEditorSectionProps,
  type HostProtocolAuthForm,
  type HostProtocolAuthType,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  FakeSwitch,
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

/** This plugin's id, and its switch in the protocol list. */
export const PLUGIN_ID = "rdp-direct";
export const ENABLE_KEY = "enableRdpDirect";
export const DEFAULT_PORT = 3389;

/**
 * The host editor section, offered while Direct RDP is on.
 *
 * Since Termix 26.11 core no longer draws a plugin's manifest host fields on
 * a host when the plugin has an editor section of its own -- only in the
 * defaults editor. The login section made Direct RDP such a plugin, so its
 * port and printing switch vanished from the host editor. Upstream's RDP
 * draws everything in one section named after its protocol; so does this.
 */
export function sectionVisible(protocols: Record<string, boolean>) {
  return !!protocols[ENABLE_KEY];
}

/** This plugin's host settings as the form holds them. */
export function settingsOf(form: Record<string, unknown> | undefined) {
  const bag = (form?.pluginSettings ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return bag[PLUGIN_ID] ?? {};
}

/** The form patch that changes one of this plugin's host settings. */
export function patchSetting(
  form: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const bag = (form.pluginSettings ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return {
    pluginSettings: {
      ...bag,
      [PLUGIN_ID]: { ...(bag[PLUGIN_ID] ?? {}), [key]: value },
    },
  };
}

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

/** Direct RDP's own protocol id, which the editor saves while it is on. */
export const OWN_PROTOCOL = "rdp-direct";

/**
 * The form patch that changes part of the shared RDP login.
 *
 * Written to protocolAuth.rdp, the login the server reads for Direct RDP and
 * the one RDP's own form edits, so the two never drift apart -- and the same
 * login under Direct RDP's own id too. The host editors of Termix 26.11
 * send null for every protocol whose switch is off, RDP's included, so that
 * copy is what reaches the server while RDP is off. The server writes it to
 * the RDP login (foldBorrowedLogins in core); it is never stored as one of
 * its own.
 */
export function patchRdpLogin(
  form: Record<string, unknown>,
  patch: Partial<HostProtocolAuthForm>,
): Record<string, unknown> {
  const all = (form.protocolAuth ?? {}) as Record<string, unknown>;
  const next = { ...loginOf(all[LOGIN_PROTOCOL]), ...patch };
  return {
    protocolAuth: { ...all, [LOGIN_PROTOCOL]: next, [OWN_PROTOCOL]: next },
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

export function RdpDirectSection(props: HostEditorSectionProps) {
  const { t } = useTranslation();
  const { form, updateForm, protocols } = props;
  const settings = settingsOf(form);
  const port = settings.port ?? DEFAULT_PORT;
  const set = (key: string, value: unknown) =>
    updateForm((current) => patchSetting(current, key, value));

  return (
    <>
      <SectionCard
        title={t("section.connection")}
        icon={<MonitorPlay className="size-3.5" />}
      >
        <SettingRow
          label={t("settings.host.port.label")}
          description={t("settings.host.port.description")}
        >
          <Input
            type="number"
            min={1}
            max={65535}
            value={String(port)}
            placeholder={String(DEFAULT_PORT)}
            aria-label={t("settings.host.port.label")}
            onChange={(event) => {
              const next = Number(event.target.value);
              set("port", Number.isInteger(next) && next > 0 ? next : "");
            }}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.host.enablePrinting.label")}
          description={t("settings.host.enablePrinting.description")}
        >
          <FakeSwitch
            checked={settings.enablePrinting === true}
            onChange={(value: boolean) => set("enablePrinting", value)}
          />
        </SettingRow>
      </SectionCard>

      {loginSectionVisible(protocols ?? {}) ? (
        <RdpDirectLoginSection {...props} />
      ) : (
        <p className="pt-3 text-xs text-muted-foreground">
          {t("login.usesRdp")}
        </p>
      )}
    </>
  );
}
