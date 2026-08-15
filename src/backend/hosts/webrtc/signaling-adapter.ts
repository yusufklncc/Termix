/**
 * Termix speaks one normalized signaling protocol to the browser; each
 * publisher speaks its own. An adapter translates between the two.
 *
 * Media never crosses this boundary. Only SDP, ICE and the publisher's own
 * control events pass through, so the gateway stays cheap no matter how many
 * frames per second the peer connection is carrying.
 */

export type StreamPublisher = "neko" | "selkies";

/** Browser → Termix. */
export type ClientMessage =
  | { type: "start" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateLike }
  | { type: "restart" }
  /** Publisher-specific event the browser wants forwarded verbatim. */
  | { type: "publisher"; event: string; payload?: unknown };

/** Termix → browser. */
export type GatewayMessage =
  | { type: "ready"; publisher: StreamPublisher }
  | { type: "offer"; sdp: string; iceServers?: IceServerConfig[] }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateLike }
  | { type: "publisher"; event: string; payload?: unknown }
  | { type: "error"; message: string };

export interface RTCIceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/** What the adapter needs to reach the publisher. Secrets stay on this side. */
export interface PublisherTarget {
  /** Base URL of the publisher, e.g. https://desktop.example.com:8080 */
  baseUrl: string;
  /** Optional extra path below the base URL. */
  path?: string | null;
  username?: string | null;
  password?: string | null;
}

export interface AdapterCallbacks {
  /** A message to hand to the browser. */
  onMessage(message: GatewayMessage): void;
  /** The publisher side went away; the gateway closes the browser socket. */
  onClose(reason: string): void;
}

export interface SignalingAdapter {
  readonly publisher: StreamPublisher;
  /** Authenticate against the publisher and open its signaling channel. */
  connect(): Promise<void>;
  /** Translate and forward a browser message. */
  send(message: ClientMessage): void;
  close(): void;
}

/**
 * Joins a publisher base URL with a path, keeping the result on the same
 * origin. Mirrors the front-end's buildStreamUrl so a host configured for the
 * Phase 1 embed path resolves to the same place here.
 */
export function resolvePublisherUrl(
  target: PublisherTarget,
  suffix: string,
): URL {
  const base = target.baseUrl.trim();
  const url = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base) ? base : `https://${base}`,
  );
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported stream URL scheme: ${url.protocol}`);
  }

  const extra = target.path?.trim();
  const basePath = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  const middle = extra
    ? extra.startsWith("/")
      ? extra
      : `${basePath}${extra}`
    : basePath;

  return new URL(
    `${middle.endsWith("/") ? middle : `${middle}/`}${suffix.replace(/^\//, "")}`,
    url,
  );
}

/** http(s) → ws(s), preserving everything else. */
export function toWebSocketUrl(url: URL): string {
  const ws = new URL(url.toString());
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return ws.toString();
}
