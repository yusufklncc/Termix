import { describe, it, expect } from "vitest";
import {
  resolvePublisherUrl,
  toWebSocketUrl,
} from "../../../hosts/webrtc/signaling-adapter.js";

describe("resolvePublisherUrl", () => {
  it("appends the suffix to a bare base URL", () => {
    expect(
      resolvePublisherUrl(
        { baseUrl: "https://desktop.example.com:8080" },
        "api/ws",
      ).toString(),
    ).toBe("https://desktop.example.com:8080/api/ws");
  });

  it("assumes https for a scheme-less base URL", () => {
    expect(
      resolvePublisherUrl({ baseUrl: "desktop.example.com" }, "ws").toString(),
    ).toBe("https://desktop.example.com/ws");
  });

  it("nests the suffix under a relative host path", () => {
    expect(
      resolvePublisherUrl(
        { baseUrl: "https://example.com/desktop", path: "room" },
        "api/ws",
      ).toString(),
    ).toBe("https://example.com/desktop/room/api/ws");
  });

  it("resolves an absolute host path from the root", () => {
    expect(
      resolvePublisherUrl(
        { baseUrl: "https://example.com/desktop", path: "/room" },
        "api/ws",
      ).toString(),
    ).toBe("https://example.com/room/api/ws");
  });

  it("refuses schemes that are not http(s)", () => {
    expect(() =>
      resolvePublisherUrl({ baseUrl: "ftp://example.com" }, "ws"),
    ).toThrow(/Unsupported stream URL scheme/);
  });
});

describe("toWebSocketUrl", () => {
  it("maps https to wss and http to ws", () => {
    expect(toWebSocketUrl(new URL("https://example.com/api/ws"))).toBe(
      "wss://example.com/api/ws",
    );
    expect(toWebSocketUrl(new URL("http://example.com:8080/ws"))).toBe(
      "ws://example.com:8080/ws",
    );
  });
});
