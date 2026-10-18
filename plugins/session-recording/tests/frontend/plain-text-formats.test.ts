/**
 * Which recordings may be read as text.
 *
 * Upstream excludes one format by name -- guacamole -- and reads everything
 * else with blob.text(). Direct RDP writes H.264 frames, which are not
 * guacamole and are not text either, so that produced a panel full of
 * replacement characters instead of the honest "this one has no text".
 *
 * It is a whitelist here. Upstream still had the exclusion in 1.0.2, so this
 * patch is carried across every time the plugin is taken from upstream, and
 * nothing but this test would notice it being dropped: the panel renders
 * either way, and the nonsense only appears for a format the fork added.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(import.meta.dirname, "../../src/frontend/SessionLogsPanel.tsx"),
  "utf8",
);

function extractPlainTextBody(): string {
  const start = source.indexOf("async function extractPlainText");
  expect(start, "extractPlainText has been renamed or removed").toBeGreaterThan(
    -1,
  );
  const body = source.slice(start);
  return body.slice(0, body.indexOf("\n}"));
}

describe("extractPlainText", () => {
  it("names the formats it can read instead of the one it cannot", () => {
    const body = extractPlainTextBody();
    expect(body).toContain('log.format !== "text"');
    expect(body).toContain('log.format !== "asciicast"');
  });

  it("no longer decides by excluding guacamole alone", () => {
    // Upstream's line. Its return is what this fork replaced.
    expect(extractPlainTextBody()).not.toContain('log.format === "guacamole"');
  });

  it("still reads the two it knows", () => {
    const body = extractPlainTextBody();
    expect(body).toContain("blob.text()");
    expect(body).toContain("asciicastToPlainText");
  });
});
