import { WebSocket, type RawData } from "ws";
import { sshLogger } from "../../utils/logger.js";
import {
  resolvePublisherUrl,
  toWebSocketUrl,
  type AdapterCallbacks,
  type ClientMessage,
  type IceServerConfig,
  type PublisherTarget,
  type RTCIceCandidateLike,
  type SignalingAdapter,
} from "./signaling-adapter.js";

/**
 * neko (m1k1o/neko).
 *
 * Wire format is `{"event": "<name>", "payload": {...}}` over a single socket
 * (server/pkg/types/websocket.go). A token from POST /api/login authorizes it,
 * passed as ?token= (server/internal/session/auth.go).
 *
 * neko offers first: the client asks with signal/request and the server answers
 * with signal/provide carrying the SDP offer and its own ICE servers.
 */

const NEKO_EVENTS = {
  signalRequest: "signal/request",
  signalRestart: "signal/restart",
  signalOffer: "signal/offer",
  signalAnswer: "signal/answer",
  signalProvide: "signal/provide",
  signalCandidate: "signal/candidate",
} as const;

interface NekoEnvelope {
  event: string;
  payload?: unknown;
}

interface NekoSignalProvide {
  sdp: string;
  iceservers?: IceServerConfig[];
}

export class NekoAdapter implements SignalingAdapter {
  readonly publisher = "neko" as const;

  private socket: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly target: PublisherTarget,
    private readonly callbacks: AdapterCallbacks,
  ) {}

  async connect(): Promise<void> {
    const token = await this.login();
    const wsUrl = new URL(
      toWebSocketUrl(resolvePublisherUrl(this.target, "api/ws")),
    );
    if (token) wsUrl.searchParams.set("token", token);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl.toString());
      this.socket = socket;

      const failFast = (error: Error) => {
        socket.removeListener("open", onOpen);
        reject(error);
      };
      const onOpen = () => {
        socket.removeListener("error", failFast);
        resolve();
      };

      socket.once("open", onOpen);
      socket.once("error", failFast);

      socket.on("message", (raw: RawData) => this.onPublisherMessage(raw));
      socket.on("close", (code, reason) => {
        if (this.closed) return;
        this.callbacks.onClose(
          reason.toString() || `neko socket closed (${code})`,
        );
      });
      socket.on("error", (error) => {
        if (this.closed) return;
        sshLogger.error("neko signaling socket error", error, {
          operation: "webrtc_neko_socket_error",
        });
      });
    });
  }

  send(message: ClientMessage): void {
    switch (message.type) {
      case "start":
        // neko decides the media direction; an empty request takes its defaults.
        this.emit(NEKO_EVENTS.signalRequest, { video: {}, audio: {} });
        break;
      case "answer":
        this.emit(NEKO_EVENTS.signalAnswer, { sdp: message.sdp });
        break;
      case "offer":
        this.emit(NEKO_EVENTS.signalOffer, { sdp: message.sdp });
        break;
      case "candidate":
        this.emit(NEKO_EVENTS.signalCandidate, message.candidate);
        break;
      case "restart":
        this.emit(NEKO_EVENTS.signalRestart, {});
        break;
      case "publisher":
        // control/*, clipboard/*, screen/* - input and session events neko
        // carries on this same socket rather than the data channel.
        this.emit(message.event, message.payload);
        break;
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // already gone
    }
    this.socket = null;
  }

  /**
   * neko returns the token in the response body only when cookies are off;
   * otherwise it arrives as a Set-Cookie. Both are accepted here so the host
   * works whichever way the target is configured.
   *
   * Deliberately plain fetch, not safeOutboundFetch: that helper blocks
   * private ranges, and a stream host is an administrator-configured target
   * that normally lives on the LAN — the same place RDP and SSH hosts live.
   */
  private async login(): Promise<string | null> {
    if (!this.target.username && !this.target.password) return null;

    const loginUrl = resolvePublisherUrl(this.target, "api/login");
    const response = await fetch(loginUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.target.username ?? "",
        password: this.target.password ?? "",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `neko login failed with ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      token?: string;
    } | null;
    if (body?.token) return body.token;

    const setCookie = response.headers.get("set-cookie");
    const match = setCookie?.match(/(?:^|;\s*)NEKO_SESSION=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private emit(event: string, payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ event, payload }));
  }

  private onPublisherMessage(raw: RawData): void {
    let envelope: NekoEnvelope;
    try {
      envelope = JSON.parse(raw.toString()) as NekoEnvelope;
    } catch {
      return;
    }

    switch (envelope.event) {
      case NEKO_EVENTS.signalProvide: {
        const payload = envelope.payload as NekoSignalProvide | undefined;
        if (!payload?.sdp) return;
        this.callbacks.onMessage({
          type: "offer",
          sdp: payload.sdp,
          iceServers: payload.iceservers,
        });
        break;
      }
      case NEKO_EVENTS.signalOffer: {
        const payload = envelope.payload as { sdp?: string } | undefined;
        if (payload?.sdp) {
          this.callbacks.onMessage({ type: "offer", sdp: payload.sdp });
        }
        break;
      }
      case NEKO_EVENTS.signalAnswer: {
        const payload = envelope.payload as { sdp?: string } | undefined;
        if (payload?.sdp) {
          this.callbacks.onMessage({ type: "answer", sdp: payload.sdp });
        }
        break;
      }
      case NEKO_EVENTS.signalCandidate: {
        this.callbacks.onMessage({
          type: "candidate",
          candidate: envelope.payload as RTCIceCandidateLike,
        });
        break;
      }
      default:
        this.callbacks.onMessage({
          type: "publisher",
          event: envelope.event,
          payload: envelope.payload,
        });
    }
  }
}
