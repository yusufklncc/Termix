import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * nginx has to be able to parse what ships.
 *
 * A broken config is caught by nothing else here: type-check and the rest of
 * the suite never read it, so the first thing that notices is the container
 * failing to start, which it does in a restart loop with the site down. This
 * fork put 790 lines of an older config into this file once and published
 * it, so the two things that went wrong are checked by name.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const CONFIGS = ["docker/nginx.conf", "docker/nginx-https.conf"];

function braceDepth(text: string): {
  final: number;
  firstNegative: number | null;
} {
  let depth = 0;
  let firstNegative: number | null = null;
  text.split("\n").forEach((line, index) => {
    // A brace inside a comment is not a brace.
    const code = line.split("#")[0];
    depth += (code.match(/\{/g) ?? []).length;
    depth -= (code.match(/\}/g) ?? []).length;
    if (depth < 0 && firstNegative === null) firstNegative = index + 1;
  });
  return { final: depth, firstNegative };
}

describe.each(CONFIGS)("%s", (file) => {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");

  it("closes every block it opens", () => {
    expect(braceDepth(text)).toEqual({ final: 0, firstNegative: null });
  });

  it("keeps every location inside a server block", () => {
    // What produced "location directive is not allowed here": the server
    // block closed early and the rest of its locations were left at the top
    // level, where nginx refuses them.
    let depth = 0;
    const stray: number[] = [];
    text.split("\n").forEach((line, index) => {
      const code = line.split("#")[0];
      if (/^\s*location\b/.test(code) && depth < 2) stray.push(index + 1);
      depth += (code.match(/\{/g) ?? []).length;
      depth -= (code.match(/\}/g) ?? []).length;
    });
    expect(stray).toEqual([]);
  });

  /**
   * The VPN routes are this fork's, so nothing upstream would notice them
   * going missing -- and a prefix nginx does not proxy answers with the SPA's
   * HTML, which resolves rather than throws and took the whole editor down
   * the first time.
   */
  it("proxies this fork's own API prefix, once", () => {
    expect(text).toContain("location ~ ^/vpn(/.*)?$");
    expect(text.match(/location ~ \^\/vpn\(/g)).toHaveLength(1);
  });
});
