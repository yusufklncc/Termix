/**
 * The address lookup before connecting is a diagnostic, not the connection.
 *
 * Twice it refused a host whose name only its own network can place -- both
 * times because it decided from a host field saying the host was reached
 * directly, and both times that field moved (out of the host row, then into
 * the VPN plugin's settings) leaving every host looking direct. Nothing in a
 * type-check notices that, so the shape of the block is asserted here: it
 * must not end the connection, and it must not read a host field to decide.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(import.meta.dirname, "../../src/backend/terminal-socket.ts"),
  "utf8",
);

/** The lookup's failure branch, from `catch` to its closing brace. */
function readFailureBranch(): string {
  const lookup = source.indexOf("await resolveHostForSshConnect(ip)");
  expect(lookup, "the pre-flight lookup moved").toBeGreaterThan(-1);

  const start = source.indexOf("} catch (error) {", lookup);
  expect(start, "the lookup no longer handles a failure").toBeGreaterThan(-1);

  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("the failure branch does not close");
}

describe("the address lookup before connecting", () => {
  it("does not end the session when the name cannot be placed here", () => {
    const branch = readFailureBranch();
    expect(branch).not.toMatch(/\breturn\b/);
    expect(branch).not.toMatch(/"error"/);
    expect(branch).not.toMatch(/\bthrow\b/);
  });

  it("is skipped only for a jump chain, never from a host's own fields", () => {
    const guard = source.match(/const connectsViaJumpHosts = !!\(([^;]*)\);/s);
    expect(guard, "the skip condition moved").not.toBeNull();
    expect(guard?.[1]).toContain("jumpHosts");
    // A field naming a network, a proxy or a profile belongs to whoever
    // raises the tunnel, and has twice been read here after moving away.
    expect(guard?.[1]).not.toMatch(/vpn|socks|proxy|profile|gateway/i);
  });
});
