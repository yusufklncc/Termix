/**
 * Fork: Direct RDP and desktop stream stay in the page when they came with
 * the image. A frame has no fullscreen, no clipboard reads, blob: workers
 * only and no pages from other sites -- the decoder, the keyboard capture
 * and the streamer's page all depend on one of those.
 */
import { describe, expect, it } from "vitest";
import { frontendIsolation } from "../../plugins/frontend-isolation.js";
import rdpDirect from "../../../../plugins/rdp-direct/manifest.json";
import desktopStream from "../../../../plugins/desktop-stream/manifest.json";

const manifest = (id: string, pageFrontend?: boolean) =>
  ({
    id,
    engine: { termix: ">=26.11.2-0", api: "^2.7.0" },
    capabilities: ["ui:surface"],
    ...(pageFrontend === undefined ? {} : { pageFrontend }),
  }) as never;

describe("plugins of this fork that a frame breaks", () => {
  it("ask for the page in their manifests", () => {
    expect(rdpDirect.pageFrontend).toBe(true);
    expect(desktopStream.pageFrontend).toBe(true);
  });

  it("run in the page when bundled", () => {
    for (const real of [rdpDirect, desktopStream]) {
      expect(
        frontendIsolation({ manifest: real as never, source: "bundled" }),
        real.id,
      ).toBe("page");
    }
  });

  it("are framed when someone installed a plugin that asks the same", () => {
    expect(
      frontendIsolation({
        manifest: manifest("rdp-direct", true),
        source: "user",
      }),
    ).toBe("frame");
    expect(
      frontendIsolation({
        manifest: manifest("anything", true),
        source: "user",
        signedTier: "official",
      }),
    ).toBe("frame");
  });

  it("leave every bundled plugin that does not ask framed", () => {
    for (const id of ["vpn", "session-recording", "remote-desktop"]) {
      expect(
        frontendIsolation({ manifest: manifest(id), source: "bundled" }),
        id,
      ).toBe("frame");
    }
  });
});
