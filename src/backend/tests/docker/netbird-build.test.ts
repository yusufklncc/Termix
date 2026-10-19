import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The VPN manager's netbird client is built here, not copied from an image.
 *
 * A release is built once and the Go it was built with ages from that day,
 * so every stdlib CVE published afterwards waits for upstream to cut a new
 * release. 0.81.2's own binary carries go1.26.7 and half the manager's
 * findings with it.
 *
 * Only the toolchain moves. This is the VPN data path -- x/net, grpc,
 * gopacket and pion/dtls are the packet handling itself -- so the module
 * versions stay exactly as the tag pins them. opkssh is an auth helper and
 * had its modules moved; the difference is deliberate and is asserted here,
 * because the obvious tidy-up is to make the two stages look alike.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const DOCKERFILE = fs.readFileSync(
  path.join(ROOT, "docker/net-manager/Dockerfile"),
  "utf8",
);

function netbirdStage(): string {
  const start = DOCKERFILE.indexOf("FROM golang:");
  expect(start, "the netbird builder stage is gone").toBeGreaterThan(-1);
  const rest = DOCKERFILE.slice(start);
  const next = rest.indexOf("\nFROM ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the netbird stage", () => {
  it("builds from source instead of copying their image", () => {
    expect(DOCKERFILE).toContain("github.com/netbirdio/netbird.git");
    expect(DOCKERFILE).not.toContain("FROM netbirdio/netbird:");
  });

  it("pins the toolchain and the source", () => {
    expect(netbirdStage()).toMatch(/FROM golang:\d+\.\d+\.\d+ AS netbird/);
    expect(netbirdStage()).toMatch(/ARG NETBIRD_VERSION=\d+\.\d+\.\d+/);
  });

  it("overrides the toolchain go.mod asks for", () => {
    // Without this, go.mod's own toolchain directive fetches the older Go and
    // builds with it, and the stage achieves nothing at all.
    expect(netbirdStage()).toContain("GOTOOLCHAIN=local");
  });

  it("builds the way upstream does", () => {
    const stage = netbirdStage();
    expect(stage).toContain("CGO_ENABLED=0");
    expect(stage).toContain("./client");
    // goreleaser's build tag and version ldflag, or the binary reports
    // "development" and the manager's logs name no version.
    expect(stage).toContain("load_wgnt_from_rsrc");
    expect(stage).toContain("version.version=$NETBIRD_VERSION");
  });

  it("leaves the dependencies where the tag pins them", () => {
    // The packet path is not ours to re-resolve. If this ever changes, it
    // should be a decision rather than a copy of the opkssh stage.
    expect(netbirdStage()).not.toContain("go get ");
    expect(netbirdStage()).not.toContain("go mod tidy");
  });

  it("still hands the binary to the stage that ships it", () => {
    expect(DOCKERFILE).toContain(
      "COPY --from=netbird /usr/local/bin/netbird /usr/local/bin/netbird",
    );
  });
});
