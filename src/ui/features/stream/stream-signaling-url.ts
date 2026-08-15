/**
 * Base URL of Termix's WebRTC signaling gateway.
 *
 * Mirrors buildGuacamoleWebSocketBaseUrl: direct to the module's own port in
 * dev and in the desktop app, through nginx everywhere else.
 */
export function buildStreamSignalingBaseUrl({
  isDev,
  isElectronApp,
  isEmbeddedApp,
  configuredServerUrl,
  basePath,
  location,
}: {
  isDev: boolean;
  isElectronApp: boolean;
  isEmbeddedApp: boolean;
  configuredServerUrl?: string;
  basePath: string;
  location: Pick<Location, "protocol" | "host">;
}) {
  if (isDev) return "ws://localhost:30013";
  if (isElectronApp) {
    if (isEmbeddedApp || !configuredServerUrl) return "ws://127.0.0.1:30013";

    const wsProtocol = configuredServerUrl.startsWith("https://")
      ? "wss://"
      : "ws://";
    const wsHost = configuredServerUrl
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    return `${wsProtocol}${wsHost}/webrtc/signaling/`;
  }

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  return `${wsProtocol}://${location.host}${basePath}/webrtc/signaling/`;
}
