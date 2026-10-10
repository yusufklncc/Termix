export type RdpBridgeOptions = {
  host: string;
  port: number;
};

const DEFAULT_RDP_BRIDGE_OPTIONS: RdpBridgeOptions = {
  host: "localhost",
  port: 3390,
};

function parsePort(value: string | undefined, fallback: number) {
  const port = parseInt(value || "", 10);
  return Number.isFinite(port) ? port : fallback;
}

/**
 * Mirrors resolveGuacdOptions: the direct RDP bridge is an optional sidecar in
 * the same position guacd occupies, so it is configured the same way.
 */
export function parseRdpBridgeUrl(
  value: string,
  fallback: RdpBridgeOptions = DEFAULT_RDP_BRIDGE_OPTIONS,
): RdpBridgeOptions {
  const raw = value.trim();
  if (!raw) {
    return fallback;
  }

  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      return {
        host: url.hostname || fallback.host,
        port: parsePort(url.port, fallback.port),
      };
    } catch {
      return fallback;
    }
  }

  const bracketedIpv6 = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketedIpv6) {
    return {
      host: bracketedIpv6[1],
      port: parsePort(bracketedIpv6[2], fallback.port),
    };
  }

  const [host, port] = raw.split(":");
  return {
    host: host || fallback.host,
    port: parsePort(port, fallback.port),
  };
}

export function getRdpBridgeEnvOptions(): RdpBridgeOptions | null {
  if (process.env.RDP_BRIDGE_URL) {
    return parseRdpBridgeUrl(process.env.RDP_BRIDGE_URL);
  }

  if (!process.env.RDP_BRIDGE_HOST && !process.env.RDP_BRIDGE_PORT) {
    return null;
  }

  return {
    host: process.env.RDP_BRIDGE_HOST || DEFAULT_RDP_BRIDGE_OPTIONS.host,
    port: parsePort(
      process.env.RDP_BRIDGE_PORT,
      DEFAULT_RDP_BRIDGE_OPTIONS.port,
    ),
  };
}

export function resolveRdpBridgeOptions(
  dbUrl?: string | null,
): RdpBridgeOptions {
  const envOptions = getRdpBridgeEnvOptions();
  if (envOptions) {
    return envOptions;
  }

  if (dbUrl) {
    return parseRdpBridgeUrl(dbUrl);
  }

  return DEFAULT_RDP_BRIDGE_OPTIONS;
}
