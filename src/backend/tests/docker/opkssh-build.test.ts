import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * OPKSSH is built in this image rather than downloaded.
 *
 * Upstream builds a release once, and the Go it was built with ages from that
 * day: every stdlib CVE published afterwards sits in the published binary
 * until upstream happens to cut a new release. Those were every Go finding
 * this image had. Building the same tag here with a current toolchain settles
 * it without waiting for anyone.
 *
 * Two things have to hold for that to be worth anything, and neither is
 * visible from the running container. The build has to be pinned, or the
 * binary changes under us and its checksum with it. And the checksum has to
 * reach the plugin, which otherwise downloads upstream's release -- the older
 * build this stage exists to avoid -- without a word.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const DOCKERFILE = fs.readFileSync(
  path.join(ROOT, "docker/Dockerfile"),
  "utf8",
);
const ENTRYPOINT = fs.readFileSync(
  path.join(ROOT, "docker/entrypoint.sh"),
  "utf8",
);

describe("the opkssh stage", () => {
  it("builds from source instead of fetching the release", () => {
    expect(DOCKERFILE).toContain("AS opkssh-builder");
    expect(DOCKERFILE).toContain("github.com/openpubkey/opkssh.git");
    // The release asset is the thing being replaced.
    expect(DOCKERFILE).not.toContain(
      "github.com/openpubkey/opkssh/releases/download",
    );
  });

  it("pins everything the output depends on", () => {
    // A floating toolchain or module makes the binary -- and the checksum the
    // plugin trusts -- different from one build to the next.
    expect(DOCKERFILE).toMatch(/FROM golang:\d+\.\d+\.\d+ AS opkssh-builder/);
    expect(DOCKERFILE).toMatch(/ARG OPKSSH_VERSION=v\d+\.\d+\.\d+/);
    for (const module of ["CRYPTO", "MOD", "TEXT"]) {
      expect(DOCKERFILE, module).toMatch(
        new RegExp(`ARG OPKSSH_X_${module}=v\\d+\\.\\d+\\.\\d+`),
      );
    }
    expect(DOCKERFILE).not.toContain("@latest");
  });

  it("builds the way upstream's goreleaser does", () => {
    expect(DOCKERFILE).toContain("CGO_ENABLED=0");
    expect(DOCKERFILE).toContain("-X main.Version=$OPKSSH_VERSION");
    // Or the binary carries this builder's paths.
    expect(DOCKERFILE).toContain("-trimpath");
  });

  it("writes the checksum of what it built", () => {
    expect(DOCKERFILE).toContain("sha256.txt");
    expect(DOCKERFILE).toContain("sha256sum");
  });

  it("no longer pins a checksum that would be a release's", () => {
    // Left behind, it would be the sum of a binary this image stopped
    // shipping, and the plugin would refuse the one it has.
    expect(DOCKERFILE).not.toContain("OPKSSH_SHA256_AMD64");
    expect(DOCKERFILE).not.toContain("OPKSSH_SHA256_ARM64");
  });
});

describe("the entrypoint", () => {
  it("hands the built binary's checksum to the plugin", () => {
    expect(ENTRYPOINT).toContain("/app/opkssh-bundled/sha256.txt");
    expect(ENTRYPOINT).toContain("export OPKSSH_SHA256");
  });

  it("keeps a checksum the operator set themselves", () => {
    // Read before the file, so someone pinning their own build is not
    // overwritten by whatever this image happens to carry.
    expect(ENTRYPOINT).toContain('[ -z "${OPKSSH_SHA256:-}" ]');
  });
});
