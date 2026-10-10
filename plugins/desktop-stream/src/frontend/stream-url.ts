/**
 * Splits a stream base URL into the host/port pair stored on the host row.
 *
 * ssh_data.ip and ssh_data.port are NOT NULL and every host list, search and
 * sort path reads them, so a stream host fills them from its URL rather than
 * introducing a second shape of host.
 */
export function parseStreamEndpoint(baseUrl: string | undefined | null): {
  host: string;
  port: number;
} {
  const normalized = normalizeStreamUrl(baseUrl);
  if (!normalized) return { host: "", port: 443 };

  const defaultPort = normalized.protocol === "http:" ? 80 : 443;
  return {
    host: normalized.hostname,
    port: normalized.port ? Number(normalized.port) : defaultPort,
  };
}

function normalizeStreamUrl(baseUrl: string | undefined | null): URL | null {
  const base = baseUrl?.trim();
  if (!base) return null;

  let url: URL;
  try {
    url = new URL(
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base) ? base : `https://${base}`,
    );
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

/**
 * Builds the URL a stream tab embeds, from the host's base URL and optional
 * path. Returns null when the host has nothing usable configured.
 *
 * Only http/https survive: the value reaches an iframe src, so a stored
 * "javascript:" or "data:" URL would otherwise execute in the app's origin.
 */
export function buildStreamUrl(
  baseUrl: string | undefined | null,
  path?: string | null,
): string | null {
  const url = normalizeStreamUrl(baseUrl);
  if (!url) return null;

  const extraPath = path?.trim();
  if (extraPath) {
    // A leading slash means "from the root", matching how a browser resolves it.
    if (extraPath.startsWith("/")) {
      const resolved = new URL(extraPath, url);
      url.pathname = resolved.pathname;
      url.search = resolved.search;
      url.hash = resolved.hash;
    } else {
      const basePath = url.pathname.endsWith("/")
        ? url.pathname
        : `${url.pathname}/`;
      const resolved = new URL(`${basePath}${extraPath}`, url);
      url.pathname = resolved.pathname;
      url.search = resolved.search;
      url.hash = resolved.hash;
    }
  }

  return url.toString();
}
