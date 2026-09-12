import { useTranslation } from "react-i18next";
import { Input } from "@/components/input";
import { PasswordInput } from "@/components/password-input";
import { SectionCard } from "@/components/section-card";
import { Globe, MonitorPlay, Shield } from "lucide-react";
import type { Host } from "@/types/ui-types";
import type { HostEditorForm } from "./HostEditorData";
import { buildStreamUrl } from "@/features/stream/stream-url";

type HostEditorSetField = <K extends keyof HostEditorForm>(
  key: K,
  value: HostEditorForm[K],
) => void;

export function HostEditorStreamTab({
  form,
  setField,
  credentials,
}: {
  form: HostEditorForm;
  setField: HostEditorSetField;
  host?: Host | null;
  credentials?: { id: string; name: string; username: string }[];
}) {
  const { t } = useTranslation();

  const previewUrl = buildStreamUrl(form.streamUrl, form.streamPath);
  const urlIsInvalid = !!form.streamUrl.trim() && !previewUrl;

  return (
    <>
      <SectionCard
        title={t("hosts.stream.renderMode")}
        icon={<MonitorPlay className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              {(["embed", "webrtc"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setField("streamMode", m)}
                  className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                    form.streamMode === m
                      ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(
                    `hosts.stream.mode${m.charAt(0).toUpperCase() + m.slice(1)}`,
                  )}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {form.streamMode === "webrtc"
                ? t("hosts.stream.modeWebrtcDesc")
                : t("hosts.stream.modeEmbedDesc")}
            </p>
          </div>

          {form.streamMode === "webrtc" && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t("hosts.stream.publisher")}
              </label>
              <div className="flex gap-2">
                {(["neko", "selkies"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setField("streamPublisher", p)}
                    className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                      form.streamPublisher === p
                        ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p === "neko" ? "neko" : "Selkies"}
                  </button>
                ))}
              </div>
              {form.streamPublisher === "selkies" && (
                <p className="text-[10px] text-muted-foreground">
                  {t("hosts.stream.selkiesWebrtcNote")}
                </p>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("hosts.stream.connection")}
        icon={<Globe className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          {/* A stream host is the odd one out -- Termix speaks no protocol here
              and only embeds someone else's. Saying so where the fields are is
              what keeps it from looking like a broken RDP. */}
          <div className="flex flex-col gap-2 border border-border bg-muted/10 p-3">
            <p className="text-[10px] text-muted-foreground">
              {t("hosts.stream.whatItIs")}
            </p>
            <p className="text-[10px] text-muted-foreground/70">
              {t("hosts.stream.notAProtocol")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {t("hosts.stream.url")}
            </label>
            <Input
              placeholder={t("hosts.stream.urlPlaceholder")}
              value={form.streamUrl}
              onChange={(e) => setField("streamUrl", e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              {t("hosts.stream.urlDescription")}
            </p>
            {urlIsInvalid && (
              <p className="text-[10px] text-destructive">
                {t("hosts.stream.invalidUrl")}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {t("hosts.stream.path")}
            </label>
            <Input
              placeholder={t("hosts.stream.pathPlaceholder")}
              value={form.streamPath}
              onChange={(e) => setField("streamPath", e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              {t("hosts.stream.pathDescription")}
            </p>
          </div>
          {previewUrl && (
            <p className="text-[10px] text-muted-foreground break-all">
              {previewUrl}
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("hosts.stream.authentication")}
        icon={<Shield className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {t("hosts.stream.authMethod")}
            </label>
            <div className="flex gap-2">
              {(["none", "direct", "credential"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setField("streamAuthType", m)}
                  className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                    form.streamAuthType === m
                      ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(
                    `hosts.stream.authType${m.charAt(0).toUpperCase() + m.slice(1)}`,
                  )}
                </button>
              ))}
            </div>
          </div>

          {form.streamAuthType === "none" && (
            <p className="text-[10px] text-muted-foreground">
              {t("hosts.stream.authTypeNoneDesc")}
            </p>
          )}

          {form.streamAuthType === "credential" && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t("hosts.stream.storedCredential")}
              </label>
              <select
                value={form.streamCredentialId}
                onChange={(e) => setField("streamCredentialId", e.target.value)}
                className="flex h-9 w-full border border-border bg-background px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">{t("hosts.stream.selectCredential")}</option>
                {(credentials ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.username ? `${c.name} (${c.username})` : c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {form.streamAuthType === "direct" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {t("hosts.stream.username")}
                </label>
                <Input
                  placeholder="admin"
                  value={form.streamUser}
                  onChange={(e) => setField("streamUser", e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {t("hosts.stream.password")}
                </label>
                <PasswordInput
                  className="h-8 text-xs pr-8"
                  placeholder={
                    form.streamPassword === "existing_stream_password"
                      ? t("hosts.stream.passwordSaved")
                      : "••••••••"
                  }
                  value={
                    form.streamPassword === "existing_stream_password"
                      ? ""
                      : form.streamPassword
                  }
                  onFocus={() => {
                    if (form.streamPassword === "existing_stream_password")
                      setField("streamPassword", "");
                  }}
                  onChange={(e) => setField("streamPassword", e.target.value)}
                />
              </div>
            </div>
          )}

          {form.streamAuthType !== "none" && (
            <p className="text-[10px] text-muted-foreground">
              {t("hosts.stream.credentialsNotInjected")}
            </p>
          )}
        </div>
      </SectionCard>
    </>
  );
}
