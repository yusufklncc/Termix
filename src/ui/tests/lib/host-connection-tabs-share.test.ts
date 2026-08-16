import { describe, expect, it } from "vitest";
import { isTabShareable } from "../../lib/host-connection-tabs";

describe("isTabShareable", () => {
  it("allows the session types guacd or the terminal can hand over", () => {
    expect(isTabShareable("terminal")).toBe(true);
    expect(isTabShareable("rdp")).toBe(true);
    expect(isTabShareable("vnc")).toBe(true);
    expect(isTabShareable("telnet")).toBe(true);
  });

  it("refuses a stream tab, which embeds a page Termix does not serve", () => {
    expect(isTabShareable("stream")).toBe(false);
  });

  it("refuses tab types that are not sessions at all", () => {
    expect(isTabShareable("file_manager")).toBe(false);
    expect(isTabShareable("docker")).toBe(false);
  });

  it("refuses an RDP tab on the direct renderer", () => {
    // Sharing is guacd's join, and the direct path has no guacd connection to
    // join. Offering the button would produce a link resolving to "session is
    // no longer active", which reads as a bug rather than a missing feature.
    expect(isTabShareable("rdp", { rdpRenderEngine: "direct" })).toBe(false);
  });

  it("still allows an RDP tab on Guacamole, explicit or default", () => {
    expect(isTabShareable("rdp", { rdpRenderEngine: "guacamole" })).toBe(true);
    expect(isTabShareable("rdp", {})).toBe(true);
    expect(isTabShareable("rdp", undefined)).toBe(true);
  });

  it("does not let the render engine affect other protocols", () => {
    // A host can have both RDP and VNC; the engine only governs RDP.
    expect(isTabShareable("vnc", { rdpRenderEngine: "direct" })).toBe(true);
    expect(isTabShareable("terminal", { rdpRenderEngine: "direct" })).toBe(true);
  });
});
