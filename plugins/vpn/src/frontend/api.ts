import type { TermixApp } from "@termix/plugin-sdk/frontend";

export interface VpnProfile {
  id: string;
  name: string;
  description?: string;
  folder?: string;
  tags?: string;
  kind: string;
  gatewayType: string;
  gatewayHost: string;
  gatewayPort: number;
  gatewayUsername?: string;
  hasGatewayPassword: boolean;
  /** Managed profiles only: what Termix dials, and how it last went. */
  provider?: string | null;
  serverHost?: string | null;
  serverPort?: number | null;
  authUsername?: string | null;
  trustedFingerprint?: string | null;
  hasAuthPassword?: boolean;
  /** Switched off by the operator, rather than failed. */
  enabled?: boolean;
  lastState?: string | null;
  lastError?: string | null;
}

export type VpnProfilePayload = Partial<VpnProfile> & {
  gatewayPassword?: string;
  authPassword?: string;
  extraConfig?: string;
};

/**
 * The plugin's own API, through the host's fetch.
 *
 * A path core does not route falls through to the SPA and answers 200 with
 * HTML, which resolves rather than throws -- so every reader here checks what
 * came back rather than trusting it to be what it asked for.
 */
export function createVpnApi(app: TermixApp) {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await app.fetch(path, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return (await response.json()) as T;
  };

  const send = (path: string, method: string, body?: unknown) =>
    json<VpnProfile>(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    async list(): Promise<VpnProfile[]> {
      const rows = await json<unknown>("/profiles");
      return Array.isArray(rows) ? (rows as VpnProfile[]) : [];
    },
    create: (payload: VpnProfilePayload) => send("/profiles", "POST", payload),
    update: (id: number, payload: VpnProfilePayload) =>
      send(`/profiles/${id}`, "PUT", payload),
    remove: (id: number) =>
      json<unknown>(`/profiles/${id}`, { method: "DELETE" }),
    setEnabled: (id: number, enabled: boolean) =>
      send(`/profiles/${id}/enabled`, "PUT", { enabled }),
    disconnect: (id: number) => send(`/profiles/${id}/disconnect`, "POST"),
  };
}

export type VpnApi = ReturnType<typeof createVpnApi>;
