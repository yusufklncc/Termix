import { getBasePath } from "@/lib/base-path.ts";
import { buildStreamSignalingBaseUrl } from "./stream-signaling-url.ts";

/**
 * Browser half of the WebRTC stream path.
 *
 * The signaling socket goes to Termix, which authenticates and relays SDP/ICE
 * to the publisher. The media itself never passes through Termix — once ICE
 * completes, frames flow browser ↔ publisher.
 */

export type StreamConnectionState =
  | "connecting"
  | "negotiating"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";

interface GatewayMessage {
  type: "ready" | "offer" | "answer" | "candidate" | "publisher" | "error";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  iceServers?: RTCIceServer[];
  message?: string;
  event?: string;
  payload?: unknown;
  publisher?: string;
}

export interface StreamWebRTCOptions {
  hostId: number;
  video: HTMLVideoElement;
  token?: string | null;
  onState(state: StreamConnectionState, detail?: string): void;
  /** Fired once the gateway reports which publisher is on the other end. */
  onReady?(publisher: "neko" | "selkies"): void;
}

export interface StreamWebRTCHandle {
  close(): void;
  /** Force an ICE restart; also triggered automatically on ICE failure. */
  restart(): void;
  /** Forward a publisher-native event (neko control/*) through the gateway. */
  sendPublisherEvent(event: string, payload: unknown): void;
}

export function connectStreamWebRTC({
  hostId,
  video,
  token,
  onState,
  onReady,
}: StreamWebRTCOptions): StreamWebRTCHandle {
  const base = buildStreamSignalingBaseUrl({
    isDev: import.meta.env.DEV,
    isElectronApp: false,
    isEmbeddedApp: false,
    basePath: getBasePath(),
    location: window.location,
  });

  const url = new URL(base.replace(/\/$/, "") + "/");
  url.searchParams.set("hostId", String(hostId));
  if (token) url.searchParams.set("token", token);

  let pc: RTCPeerConnection | null = null;
  let closed = false;
  const socket = new WebSocket(url.toString());
  /** Candidates that arrive before the remote description is set. */
  const pendingCandidates: RTCIceCandidateInit[] = [];

  const send = (message: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const createPeer = (iceServers?: RTCIceServer[]) => {
    const peer = new RTCPeerConnection(iceServers ? { iceServers } : undefined);

    peer.addEventListener("track", (event) => {
      const [stream] = event.streams;
      if (stream && video.srcObject !== stream) {
        video.srcObject = stream;
        void video.play().catch(() => {
          // Autoplay can be refused until the user interacts; the element stays
          // bound either way and starts on the first gesture.
        });
      }
    });

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        send({ type: "candidate", candidate: event.candidate.toJSON() });
      }
    });

    peer.addEventListener("connectionstatechange", () => {
      if (closed) return;
      switch (peer.connectionState) {
        case "connected":
          onState("connected");
          break;
        case "disconnected":
          onState("reconnecting");
          break;
        case "failed":
          onState("reconnecting");
          restart();
          break;
        default:
          break;
      }
    });

    return peer;
  };

  const drainCandidates = async () => {
    if (!pc) return;
    while (pendingCandidates.length) {
      const candidate = pendingCandidates.shift();
      if (!candidate) continue;
      await pc.addIceCandidate(candidate).catch(() => {
        // A candidate the browser rejects is not fatal; ICE continues with the rest.
      });
    }
  };

  const restart = () => {
    if (closed) return;
    send({ type: "restart" });
  };

  socket.addEventListener("open", () => onState("connecting"));

  socket.addEventListener("message", async (event) => {
    let message: GatewayMessage;
    try {
      message = JSON.parse(String(event.data)) as GatewayMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case "ready":
        onState("negotiating");
        onReady?.((message.publisher as "neko" | "selkies") ?? "neko");
        send({ type: "start" });
        break;

      case "offer": {
        if (!message.sdp) return;
        onState("negotiating");
        // A second offer is a renegotiation; reuse the peer so the media
        // elements and their tracks survive an ICE restart.
        pc ??= createPeer(message.iceServers);
        await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
        await drainCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "answer", sdp: answer.sdp });
        break;
      }

      case "answer": {
        if (!message.sdp || !pc) return;
        await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        await drainCandidates();
        break;
      }

      case "candidate": {
        if (!message.candidate) return;
        if (!pc?.remoteDescription) {
          pendingCandidates.push(message.candidate);
          return;
        }
        await pc.addIceCandidate(message.candidate).catch(() => {});
        break;
      }

      case "error":
        onState("failed", message.message);
        break;

      default:
        break;
    }
  });

  socket.addEventListener("close", () => {
    if (closed) return;
    onState("closed");
  });

  socket.addEventListener("error", () => {
    if (closed) return;
    onState("failed");
  });

  return {
    close() {
      closed = true;
      try {
        pc?.close();
      } catch {
        // already closed
      }
      pc = null;
      video.srcObject = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
    restart,
    sendPublisherEvent(event, payload) {
      send({ type: "publisher", event, payload });
    },
  };
}
