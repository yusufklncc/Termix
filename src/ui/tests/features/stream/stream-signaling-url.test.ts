import { describe, expect, it } from "vitest";
import { buildStreamSignalingBaseUrl } from "../../../features/stream/stream-signaling-url";

const location = { protocol: "https:", host: "termix.example.com" };

describe("buildStreamSignalingBaseUrl", () => {
  it("talks to the module port directly in dev", () => {
    expect(
      buildStreamSignalingBaseUrl({
        isDev: true,
        isElectronApp: false,
        isEmbeddedApp: false,
        basePath: "",
        location,
      }),
    ).toBe("ws://localhost:30013");
  });

  it("goes through nginx in the browser, honouring the base path", () => {
    expect(
      buildStreamSignalingBaseUrl({
        isDev: false,
        isElectronApp: false,
        isEmbeddedApp: false,
        basePath: "/termix",
        location,
      }),
    ).toBe("wss://termix.example.com/termix/webrtc/signaling/");
  });

  it("downgrades to ws when the page is plain http", () => {
    expect(
      buildStreamSignalingBaseUrl({
        isDev: false,
        isElectronApp: false,
        isEmbeddedApp: false,
        basePath: "",
        location: { protocol: "http:", host: "10.0.0.5:8080" },
      }),
    ).toBe("ws://10.0.0.5:8080/webrtc/signaling/");
  });

  it("uses the embedded backend when the desktop app has no remote server", () => {
    expect(
      buildStreamSignalingBaseUrl({
        isDev: false,
        isElectronApp: true,
        isEmbeddedApp: true,
        basePath: "",
        location,
      }),
    ).toBe("ws://127.0.0.1:30013");
  });

  it("follows the configured remote server from the desktop app", () => {
    expect(
      buildStreamSignalingBaseUrl({
        isDev: false,
        isElectronApp: true,
        isEmbeddedApp: false,
        configuredServerUrl: "https://termix.example.com/",
        basePath: "",
        location,
      }),
    ).toBe("wss://termix.example.com/webrtc/signaling/");
  });
});
