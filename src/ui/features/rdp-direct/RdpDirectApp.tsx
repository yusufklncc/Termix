import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/button.tsx";
import { SimpleLoader } from "@/lib/SimpleLoader.tsx";
import { logActivity } from "@/main-axios.ts";
import { statsLogger } from "@/lib/frontend-logger";
import {
  connectRdpDirect,
  type RdpDirectHandle,
  type RdpDirectState,
} from "@/features/rdp-direct/rdp-direct-client.ts";

interface RdpDirectAppProps {
  hostId?: string;
  hostName?: string;
  tabId?: string;
  isVisible?: boolean;
}

export interface RdpDirectAppHandle {
  disconnect: () => void;
  isConnected: () => boolean;
  reconnect: () => void;
}

/**
 * Experimental direct RDP renderer: H.264 from FreeRDP straight into a
 * WebCodecs decoder, painted on an OffscreenCanvas in a worker. guacd is not
 * involved, and neither is guacamole-common-js.
 */
const RdpDirectApp = React.forwardRef<RdpDirectAppHandle, RdpDirectAppProps>(
  function RdpDirectApp({ hostId, hostName }, ref) {
    const { t } = useTranslation();
    const surfaceRef = useRef<HTMLDivElement>(null);
    const sessionRef = useRef<RdpDirectHandle | null>(null);
    const [state, setState] = useState<RdpDirectState>("connecting");
    const [detail, setDetail] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    // Only browsers that grant the keyboard lock can hand over reserved
    // shortcuts. Dismissed by the viewer, not on a timer: it explains why
    // Ctrl+W just closed a tab, which is worth reading at leisure.
    const [shortcutsEscape, setShortcutsEscape] = useState(false);
    const [noticeCode, setNoticeCode] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    const dismiss = useCallback(
      (key: string) => setDismissed((prev) => new Set(prev).add(key)),
      [],
    );

    const numericHostId = hostId ? parseInt(hostId, 10) : NaN;

    useEffect(() => {
      const surface = surfaceRef.current;
      if (!surface || !Number.isInteger(numericHostId)) return;

      setState("connecting");
      setDetail(null);

      // This renderer is experimental and sits inside the same React tree as
      // everything else. An exception escaping here would unmount the whole
      // app, so a failure to even start is reported as a failed session.
      let session: RdpDirectHandle;
      try {
        session = connectRdpDirect({
          hostId: numericHostId,
          surface,
          token: localStorage.getItem("jwt"),
          onState: (next, message) => {
            setState(next);
            if (message) setDetail(message);
          },
          // The bridge logs the rate the server produced; this is the rate that
          // reached the canvas. Comparing the two is how a decoder falling
          // behind is told apart from a server that is simply slow.
          //
          // The numbers go in the message rather than the context: the logger
          // only renders a fixed set of context keys, so anything else is
          // silently dropped. Level is info because console.debug is hidden
          // unless the console is switched to verbose.
          onKeyboardLock: (lockState) => {
            setShortcutsEscape(
              lockState === "unsupported" || lockState === "refused",
            );
          },
          onNotice: setNoticeCode,
          onStats: (stats) => {
            statsLogger.info(
              `Direct RDP painted ${stats.fps.toFixed(1)} fps ` +
                `(${stats.painted} frames in ${Math.round(stats.elapsedMs)}ms, ` +
                `${stats.decoded} total) ` +
                `decoder=${stats.decoderState} drops=` +
                `unconfigured:${stats.drops.unconfigured} ` +
                `unparsed:${stats.drops.unparsed} ` +
                `noKey:${stats.drops.noKey} ` +
                `decodeError:${stats.drops.decodeError}`,
              { operation: "rdp_direct_stats", hostId: numericHostId },
            );
          },
        });
      } catch (error) {
        setState("failed");
        setDetail(error instanceof Error ? error.message : String(error));
        return;
      }
      sessionRef.current = session;

      if (hostName) {
        logActivity("rdp", numericHostId, hostName).catch(() => {});
      }
      surface.focus();

      return () => {
        try {
          session.close();
        } catch {
          // Tearing down must not throw either.
        }
        sessionRef.current = null;
      };
    }, [numericHostId, hostName, attempt]);

    const reconnect = useCallback(() => setAttempt((a) => a + 1), []);

    useImperativeHandle(ref, () => ({
      disconnect: () => {
        sessionRef.current?.close();
        sessionRef.current = null;
        setState("closed");
      },
      isConnected: () => state === "connected",
      reconnect,
    }));

    const failed = state === "failed" || state === "closed";

    const notices = [
      shortcutsEscape
        ? { key: "shortcuts", text: t("rdpDirect.shortcutsEscapeNotice") }
        : null,
      noticeCode === "no-h264"
        ? { key: "no-h264", text: t("rdpDirect.noH264") }
        : null,
      noticeCode === "server-decode"
        ? { key: "server-decode", text: t("rdpDirect.serverDecode") }
        : null,
    ].filter(
      (n): n is { key: string; text: string } =>
        n !== null && !dismissed.has(n.key),
    );

    return (
      <div
        ref={surfaceRef}
        tabIndex={0}
        className="relative w-full h-full outline-none"
        style={{ backgroundColor: "var(--bg-base)" }}
      >
        {/* Conditions the session survives. Both are dismissed by the viewer
            rather than on a timer: each explains something that already
            happened, or is about to, and is worth reading at leisure. */}
        {state === "connected" && notices.length > 0 && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex flex-col gap-2 max-w-lg">
            {notices.map(({ key, text }) => (
              <div
                key={key}
                className="flex items-start gap-2 rounded-md border px-3 py-2 shadow-md"
                style={{
                  backgroundColor: "var(--bg-elevated, var(--bg-base))",
                  borderColor: "var(--border)",
                }}
              >
                <AlertCircle
                  className="size-4 shrink-0 mt-0.5"
                  style={{ color: "var(--foreground-secondary)" }}
                />
                <p
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--foreground-secondary)" }}
                >
                  {text}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 -mt-0.5 shrink-0"
                  onClick={() => dismiss(key)}
                >
                  {t("rdpDirect.dismiss")}
                </Button>
              </div>
            ))}
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
                  {t("rdpDirect.connectionFailed")}
                </p>
                {detail && (
                  <p
                    className="text-xs max-w-md text-center"
                    style={{ color: "var(--foreground-secondary)" }}
                  >
                    {detail}
                  </p>
                )}
                <Button variant="outline" size="sm" onClick={reconnect}>
                  <RefreshCw className="size-4 mr-2" />
                  {t("rdpDirect.reconnect")}
                </Button>
              </>
            ) : (
              <SimpleLoader
                visible={true}
                message={t("rdpDirect.connecting")}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);

export default RdpDirectApp;
