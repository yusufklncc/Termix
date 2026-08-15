import { WebSocket, type RawData } from "ws";
import { sshLogger } from "../../utils/logger.js";
import {
  resolvePublisherUrl,
  toWebSocketUrl,
  type AdapterCallbacks,
  type ClientMessage,
  type PublisherTarget,
  type RTCIceCandidateLike,
  type SignalingAdapter,
} from "./signaling-adapter.js";

/**
 * Selkies (selkies-project/selkies), WebRTC transport.
 *
 * Selkies streams over plain WebSockets by default; this adapter targets its
 * opt-in WebRTC mode, where the desktop registers with a signalling server as
 * "server" and a viewer joins as "client". Termix plays the viewer's signalling
 * role only — the peer connection itself is browser ↔ desktop.
 *
 * Wire format (addons/selkies-web-core/lib/signaling.js):
 *   → HELLO client {"client_type":...,"client_token":...}
 *   ← HELLO
 *   → SESSION server
 *   ← SESSION_OK <server_peer_id>          (or: ERROR peer server not found)
 *   → <server_peer_id> {"sdp":{...}} | {"ice":{...}}
 *   ← {"sdp":{...}} | {"ice":{...}}
 */

const PEER_TYPE = "client";
const SESSION_RETRY_MS = 1000;

interface SelkiesSdp {
  type: string;
  sdp: string;
}

export class SelkiesAdapter implements SignalingAdapter {
  readonly publisher = "selkies" as const;

  private socket: WebSocket | null = null;
  private serverPeerId: string | null = null;
  private closed = false;
  private sessionRetry: NodeJS.Timeout | null = null;
  /** SDP/ICE the browser produced before SESSION_OK arrived. */
  private pending: string[] = [];

  constructor(
    private readonly target: PublisherTarget,
    private readonly callbacks: AdapterCallbacks,
  ) {}

  async connect(): Promise<void> {
    const wsUrl = toWebSocketUrl(resolvePublisherUrl(this.target, "ws"));

    // Selkies accepts HTTP Basic Auth on the signalling handshake; the token
    // form travels in the HELLO metadata instead. Both stay on this side.
    const headers: Record<string, string> = {};
    if (this.target.username || this.target.password) {
      const credentials = Buffer.from(
        `${this.target.username ?? ""}:${this.target.password ?? ""}`,
      ).toString("base64");
      headers.Authorization = `Basic ${credentials}`;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers });
      this.socket = socket;

      const failFast = (error: Error) => {
        socket.removeListener("open", onOpen);
        reject(error);
      };
      const onOpen = () => {
        socket.removeListener("error", failFast);
        this.sendHello();
        resolve();
      };

      socket.once("open", onOpen);
      socket.once("error", failFast);

      socket.on("message", (raw: RawData) => this.onPublisherMessage(raw));
      socket.on("close", (code, reason) => {
        if (this.closed) return;
        this.callbacks.onClose(
          reason.toString() || `selkies signalling closed (${code})`,
        );
      });
      socket.on("error", (error) => {
        if (this.closed) return;
        sshLogger.error("selkies signalling socket error", error, {
          operation: "webrtc_selkies_socket_error",
        });
      });
    });
  }

  send(message: ClientMessage): void {
    switch (message.type) {
      case "start":
        // The session is opened on HELLO; nothing to do until SESSION_OK.
        break;
      case "offer":
      case "answer":
        this.sendToPeer({
          sdp: { type: message.type, sdp: message.sdp },
        });
        break;
      case "candidate":
        this.sendToPeer({ ice: message.candidate });
        break;
      case "restart":
        // Selkies has no restart verb; renegotiation happens through a fresh
        // offer, which the browser sends as a normal "offer" message.
        break;
      case "publisher":
        // Selkies carries input on the data channel, not this socket, so there
        // is no publisher-event passthrough to translate.
        break;
    }
  }

  close(): void {
    this.closed = true;
    if (this.sessionRetry) clearTimeout(this.sessionRetry);
    this.sessionRetry = null;
    try {
      this.socket?.close();
    } catch {
      // already gone
    }
    this.socket = null;
  }

  private sendHello(): void {
    const meta = {
      client_type: "termix",
      client_token: this.target.password ?? "",
    };
    this.raw(`HELLO ${PEER_TYPE} ${JSON.stringify(meta)}`);
  }

  private startSession(): void {
    this.raw("SESSION server");
  }

  private sendToPeer(body: Record<string, unknown>): void {
    const message = JSON.stringify(body);
    if (!this.serverPeerId) {
      this.pending.push(message);
      return;
    }
    this.raw(`${this.serverPeerId} ${message}`);
  }

  private raw(line: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(line);
  }

  private flushPending(): void {
    if (!this.serverPeerId) return;
    for (const message of this.pending) {
      this.raw(`${this.serverPeerId} ${message}`);
    }
    this.pending = [];
  }

  private onPublisherMessage(raw: RawData): void {
    const data = raw.toString();

    if (data === "HELLO") {
      this.startSession();
      return;
    }

    if (data.startsWith("SESSION_OK")) {
      this.serverPeerId = data.split(" ")[1] ?? null;
      this.flushPending();
      return;
    }

    if (data.startsWith("ERROR")) {
      if (data === "ERROR peer server not found") {
        // The desktop has not registered yet; the reference client retries.
        this.sessionRetry = setTimeout(() => {
          if (!this.closed) this.startSession();
        }, SESSION_RETRY_MS);
        return;
      }
      this.callbacks.onMessage({ type: "error", message: data });
      return;
    }

    let parsed: { sdp?: SelkiesSdp; ice?: RTCIceCandidateLike };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed.sdp?.sdp) {
      this.callbacks.onMessage({
        type: parsed.sdp.type === "answer" ? "answer" : "offer",
        sdp: parsed.sdp.sdp,
      });
      return;
    }

    if (parsed.ice) {
      this.callbacks.onMessage({ type: "candidate", candidate: parsed.ice });
    }
  }
}
