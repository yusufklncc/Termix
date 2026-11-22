/**
 * AVC444's auxiliary (chroma) view is decoded and never painted.
 *
 * Reported on 26.11.3 against a Windows host with "Prioritize H.264/AVC 444"
 * on: stale windows, blocks and darkened colours. The two views of an AVC444
 * update are one H.264 sequence -- FreeRDP feeds both to a single decoder,
 * luma then chroma -- and the bridge dropped the chroma ones, so later luma
 * pictures decoded against references the browser never had. The bridge now
 * sends them as AVCX; the worker must feed them to the same decoder, in
 * order, and must not draw them.
 */
import { describe, expect, it, vi } from "vitest";
import { createRdpRenderer } from "../../src/frontend/rdp-render";

/** Annex B bitstream from NAL bodies. */
function annexB(...nals: number[][]): number[] {
  return nals.flatMap((nal) => [0, 0, 0, 1, ...nal]);
}

/** An AVCF/AVCX payload: surface, dest, rects, then the bitstream. */
function avcPayload(rects: number[][], bitstream: number[]): ArrayBuffer {
  const header = new DataView(new ArrayBuffer(12 + rects.length * 8));
  header.setUint16(0, 0, true);
  header.setUint16(2, 0, true);
  header.setUint16(4, 0, true);
  header.setUint16(6, 64, true);
  header.setUint16(8, 64, true);
  header.setUint16(10, rects.length, true);
  rects.forEach((rect, i) =>
    rect.forEach((value, j) =>
      header.setUint16(12 + i * 8 + j * 2, value, true),
    ),
  );
  const out = new Uint8Array(header.byteLength + bitstream.length);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(bitstream, header.byteLength);
  return out.buffer;
}

describe("the renderer", () => {
  it("hands AVCX to the worker as a decode-only frame", () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    const renderer = createRdpRenderer({
      worker,
      surface: { style: { cursor: "" } },
    });
    const payload = new Uint8Array([1, 2, 3]);
    renderer.handle({ magic: "AVCX", payload } as never);
    renderer.handle({ magic: "AVCF", payload } as never);
    const types = (
      worker.postMessage as ReturnType<typeof vi.fn>
    ).mock.calls.map(([message]) => (message as { type: string }).type);
    expect(types).toEqual(["avcx", "avc"]);
  });
});

describe("the decoder worker", () => {
  it("decodes the chroma view in order and paints only the luma ones", async () => {
    const decoded: { type: string }[] = [];
    let output: (frame: unknown) => void = () => {};
    class FakeDecoder {
      state = "unconfigured";
      constructor(init: { output: (frame: unknown) => void }) {
        output = init.output;
      }
      configure() {
        this.state = "configured";
      }
      decode(chunk: { type: string }) {
        decoded.push(chunk);
      }
      flush() {
        return Promise.resolve();
      }
    }
    class FakeChunk {
      type: string;
      constructor(init: { type: string }) {
        this.type = init.type;
      }
    }
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", FakeChunk);
    vi.spyOn(self, "postMessage").mockImplementation(() => {});

    await import("../../src/frontend/rdp-decoder.worker");
    const send = (data: unknown) =>
      (self.onmessage as (event: { data: unknown }) => unknown)({ data });

    const drawImage = vi.fn();
    const canvas = { width: 64, height: 64, getContext: () => ({ drawImage }) };
    await send({ type: "init", canvas });

    // Key luma picture (SPS + IDR), a chroma view, then a luma delta.
    await send({
      type: "avc",
      payload: avcPayload(
        [[0, 0, 16, 16]],
        annexB([0x67, 0x4d, 0x40, 0x20], [0x65, 0x88]),
      ),
    });
    await send({
      type: "avcx",
      payload: avcPayload([[0, 0, 8, 8]], annexB([0x41, 0x9a])),
    });
    await send({
      type: "avc",
      payload: avcPayload([[0, 0, 4, 4]], annexB([0x41, 0x9b])),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // All of them reach the one decoder, the chroma view between the two
    // luma pictures. (The first key frame is decoded twice: configuring
    // replays it, which predates this and is harmless.)
    const types = decoded.map((chunk) => chunk.type);
    expect(types.slice(-2)).toEqual(["delta", "delta"]);
    expect(types.slice(0, -2).every((type) => type === "key")).toBe(true);

    const frames = decoded.map(() => ({
      displayWidth: 64,
      displayHeight: 64,
      close: vi.fn(),
    }));
    frames.forEach((frame) => output(frame));

    // Every picture is painted except the chroma view, the second to last.
    const chroma = frames[frames.length - 2];
    const sources = drawImage.mock.calls.map(([source]) => source);
    expect(sources).toEqual(frames.filter((frame) => frame !== chroma));
    frames.forEach((frame) => expect(frame.close).toHaveBeenCalled());
  });
});
