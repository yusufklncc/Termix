import { describe, expect, it } from "vitest";
import {
  buildStreamUrl,
  parseStreamEndpoint,
} from "../../../features/stream/stream-url";

describe("buildStreamUrl", () => {
  it("returns the base URL untouched when no path is given", () => {
    expect(buildStreamUrl("https://desktop.example.com:8080")).toBe(
      "https://desktop.example.com:8080/",
    );
  });

  it("assumes https for a bare host", () => {
    expect(buildStreamUrl("desktop.example.com")).toBe(
      "https://desktop.example.com/",
    );
  });

  it("appends a relative path below the base path", () => {
    expect(buildStreamUrl("https://example.com/desktop", "session")).toBe(
      "https://example.com/desktop/session",
    );
  });

  it("resolves an absolute path from the root", () => {
    expect(buildStreamUrl("https://example.com/desktop", "/session")).toBe(
      "https://example.com/session",
    );
  });

  it("keeps the query string carried by the path", () => {
    expect(buildStreamUrl("https://example.com", "/app?token=abc")).toBe(
      "https://example.com/app?token=abc",
    );
  });

  it("returns null for a missing or blank base URL", () => {
    expect(buildStreamUrl(undefined)).toBeNull();
    expect(buildStreamUrl("")).toBeNull();
    expect(buildStreamUrl("   ")).toBeNull();
  });

  it("rejects schemes that would execute in the app origin", () => {
    expect(buildStreamUrl("javascript:alert(1)")).toBeNull();
    expect(buildStreamUrl("data:text/html,<script></script>")).toBeNull();
    expect(buildStreamUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("parseStreamEndpoint", () => {
  it("splits host and explicit port", () => {
    expect(parseStreamEndpoint("https://desktop.example.com:8080")).toEqual({
      host: "desktop.example.com",
      port: 8080,
    });
  });

  it("defaults to 443 for https and 80 for http", () => {
    expect(parseStreamEndpoint("https://a.example")).toEqual({
      host: "a.example",
      port: 443,
    });
    expect(parseStreamEndpoint("http://a.example")).toEqual({
      host: "a.example",
      port: 80,
    });
  });

  it("falls back to an empty host and 443 when unparseable", () => {
    expect(parseStreamEndpoint("javascript:alert(1)")).toEqual({
      host: "",
      port: 443,
    });
    expect(parseStreamEndpoint("")).toEqual({ host: "", port: 443 });
  });
});
