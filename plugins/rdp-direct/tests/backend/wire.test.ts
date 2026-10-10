import { describe, expect, it } from "vitest";
import { encodeFrame } from "../../src/backend/session";

/**
 * The one piece of the wire format this side writes.
 *
 * Everything the bridge sends is relayed untouched -- that is what keeps the
 * server off the video path -- so the only frames built here are the ones
 * that start a session and the one that reports a refusal. Both have to agree
 * with the browser's reader, and nothing but this says so.
 */
describe("encodeFrame", () => {
  it("writes a 4-byte magic and a little-endian length", () => {
    const frame = encodeFrame("CONN", Buffer.from("hi", "utf8"));
    expect(frame.subarray(0, 4).toString("ascii")).toBe("CONN");
    expect(frame.readUInt32LE(4)).toBe(2);
    expect(frame.subarray(8).toString("utf8")).toBe("hi");
  });

  it("carries an empty payload", () => {
    const frame = encodeFrame("ERRR", Buffer.alloc(0));
    expect(frame).toHaveLength(8);
    expect(frame.readUInt32LE(4)).toBe(0);
  });

  it("counts bytes, not characters", () => {
    // A length in characters would truncate the payload on the reader's side.
    const frame = encodeFrame("ERRR", Buffer.from("ğüş", "utf8"));
    expect(frame.readUInt32LE(4)).toBe(6);
    expect(frame.subarray(8).toString("utf8")).toBe("ğüş");
  });
});
