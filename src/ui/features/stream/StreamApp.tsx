import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import { getSSHHosts, logActivity } from "@/main-axios.ts";
import { Button } from "@/components/button.tsx";
import { SimpleLoader } from "@/lib/SimpleLoader.tsx";
import { buildStreamUrl } from "@/features/stream/stream-url.ts";
import { attachNekoInput } from "@/features/stream/stream-input.ts";
import {
  connectStreamWebRTC,
  type StreamConnectionState,
  type StreamWebRTCHandle,
} from "@/features/stream/stream-webrtc.ts";
import type { SSHHost } from "@/types";

interface StreamAppProps {
  hostId?: string;
  tabId?: string;
  isVisible?: boolean;
}

export interface StreamAppHandle {
  disconnect: () => void;
  isConnected: () => boolean;
  reconnect: () => void;
}

const StreamApp = React.forwardRef<StreamAppHandle, StreamAppProps>(
  function StreamApp({ hostId }, ref) {
    const { t } = useTranslation();
    const [hostConfig, setHostConfig] = useState<SSHHost | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      if (!hostId) {
        setLoading(false);
        return;
      }
      getSSHHosts()
        .then((hosts) => {
          const host = hosts.find((h) => h.id === parseInt(hostId, 10));
          setHostConfig(host ?? null);
        })
        .catch(() => setHostConfig(null))
        .finally(() => setLoading(false));
    }, [hostId]);

    if (loading) {
      return (
        <div className="relative w-full h-full">
          <SimpleLoader visible={true} message={t("common.loading")} />
        </div>
      );
    }

    if (!hostConfig || !hostId) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-4"
          style={{ backgroundColor: "var(--bg-base)" }}
        >
          <AlertCircle
            className="size-10"
            style={{ color: "var(--foreground)" }}
          />
          <span
            className="text-sm font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            {t("stream.hostNotFound")}
          </span>
        </div>
      );
    }

    const hostName = hostConfig.name || hostConfig.ip || String(hostId);

    if (hostConfig.streamMode === "webrtc") {
      return (
        <StreamWebRTCView
          hostId={parseInt(hostId, 10)}
          hostName={hostName}
          ref={ref}
        />
      );
    }

    return (
      <StreamAppInner
        hostId={parseInt(hostId, 10)}
        hostConfig={hostConfig}
        hostName={hostName}
        ref={ref}
      />
    );
  },
);

/**
 * WebRTC mode: Termix relays signaling, the peer connection is direct. No
 * iframe and no guacamole-common-js on this path.
 */
const StreamWebRTCView = React.forwardRef<
  StreamAppHandle,
  { hostId: number; hostName: string }
>(function StreamWebRTCView({ hostId, hostName }, ref) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<StreamWebRTCHandle | null>(null);
  const detachInputRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<StreamConnectionState>("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const [inputPublisher, setInputPublisher] = useState<
    "neko" | "selkies" | null
  >(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    const surface = surfaceRef.current;
    if (!video || !surface) return;

    setState("connecting");
    setDetail(null);
    setInputPublisher(null);
    const session = connectStreamWebRTC({
      hostId,
      video,
      token: localStorage.getItem("jwt"),
      onState: (next, message) => {
        setState(next);
        if (message) setDetail(message);
      },
      onReady: (publisher) => {
        setInputPublisher(publisher);
        // Only neko carries input on the signaling socket; Selkies uses a
        // binary data-channel format that is not wired up yet.
        if (publisher !== "neko") return;
        detachInputRef.current?.();
        detachInputRef.current = attachNekoInput({
          surface,
          video,
          send: (event, payload) => session.sendPublisherEvent(event, payload),
        });
        surface.focus();
      },
    });
    sessionRef.current = session;

    logActivity("stream", hostId, hostName).catch(() => {});

    return () => {
      detachInputRef.current?.();
      detachInputRef.current = null;
      session.close();
      sessionRef.current = null;
    };
  }, [hostId, hostName, attempt]);

  useImperativeHandle(ref, () => ({
    disconnect: () => {
      sessionRef.current?.close();
      sessionRef.current = null;
      setState("closed");
    },
    isConnected: () => state === "connected",
    reconnect: () => setAttempt((a) => a + 1),
  }));

  const failed = state === "failed" || state === "closed";

  return (
    <div
      ref={surfaceRef}
      tabIndex={0}
      className="relative w-full h-full outline-none"
      style={{ backgroundColor: "var(--bg-base)" }}
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain pointer-events-none"
        autoPlay
        playsInline
        muted={false}
      />

      {state === "connected" && inputPublisher === "selkies" && (
        <div className="absolute bottom-2 left-2 px-2 py-1 text-[10px] bg-background/80 border border-border text-muted-foreground">
          {t("stream.inputUnsupported")}
        </div>
      )}

      {state !== "connected" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ backgroundColor: "var(--bg-base)" }}
        >
          {failed ? (
            <>
              <AlertCircle
                className="size-10"
                style={{ color: "var(--foreground)" }}
              />
              <p
                className="text-sm font-semibold"
                style={{ color: "var(--foreground)" }}
              >
                {t("stream.negotiationFailed")}
              </p>
              {detail && (
                <p
                  className="text-xs max-w-xs text-center"
                  style={{ color: "var(--foreground-secondary)" }}
                >
                  {detail}
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttempt((a) => a + 1)}
              >
                <RefreshCw className="size-4 mr-2" />
                {t("stream.reconnect")}
              </Button>
            </>
          ) : (
            <SimpleLoader visible={true} message={t("stream.connecting")} />
          )}
        </div>
      )}
    </div>
  );
});

interface StreamAppInnerProps {
  hostId: number;
  hostConfig: Pick<SSHHost, "streamUrl" | "streamPath">;
  hostName: string;
}

const StreamAppInner = React.forwardRef<StreamAppHandle, StreamAppInnerProps>(
  function StreamAppInner({ hostId, hostConfig, hostName }, ref) {
    const { t } = useTranslation();
    const [reloadCount, setReloadCount] = useState(0);
    const [disconnected, setDisconnected] = useState(false);
    const frameRef = useRef<HTMLIFrameElement>(null);

    const streamUrl = buildStreamUrl(
      hostConfig.streamUrl,
      hostConfig.streamPath,
    );

    const handleReload = useCallback(() => {
      setDisconnected(false);
      setReloadCount((c) => c + 1);
    }, []);

    useImperativeHandle(ref, () => ({
      disconnect: () => setDisconnected(true),
      isConnected: () => !disconnected && !!streamUrl,
      reconnect: handleReload,
    }));

    useEffect(() => {
      if (!streamUrl || disconnected) return;
      logActivity("stream", hostId, hostName).catch(() => {});
    }, [streamUrl, disconnected, hostId, hostName]);

    if (!streamUrl) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-4"
          style={{ backgroundColor: "var(--bg-base)" }}
        >
          <AlertCircle
            className="size-10"
            style={{ color: "var(--foreground)" }}
          />
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            {t("stream.missingUrlTitle")}
          </p>
          <p
            className="text-xs max-w-xs text-center"
            style={{ color: "var(--foreground-secondary)" }}
          >
            {t("stream.missingUrlDescription")}
          </p>
        </div>
      );
    }

    if (disconnected) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-4"
          style={{ backgroundColor: "var(--bg-base)" }}
        >
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            {t("stream.disconnected")}
          </p>
          <Button variant="outline" size="sm" onClick={handleReload}>
            <RefreshCw className="size-4 mr-2" />
            {t("stream.reconnect")}
          </Button>
        </div>
      );
    }

    return (
      <div
        className="relative w-full h-full"
        style={{ backgroundColor: "var(--bg-base)" }}
      >
        <iframe
          key={`${streamUrl}-${reloadCount}`}
          ref={frameRef}
          src={streamUrl}
          title={hostName}
          className="w-full h-full border-0"
          allow="autoplay; fullscreen; clipboard-read; clipboard-write; microphone; camera; display-capture"
          allowFullScreen
        />
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={t("stream.reload")}
            onClick={handleReload}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            title={t("stream.openInBrowser")}
            onClick={() => window.open(streamUrl, "_blank", "noopener")}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  },
);

export default StreamApp;
