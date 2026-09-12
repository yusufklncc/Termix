import { describe, expect, it } from "vitest";
import {
  createPrintCollector,
  PRINT_BEGIN,
  PRINT_DATA,
  PRINT_END,
} from "@/features/rdp-direct/rdp-print.ts";

function frame(
  id: number,
  flag: number,
  body: Uint8Array | string = new Uint8Array(),
) {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(8 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, id, true);
  view.setUint32(4, flag, true);
  out.set(bytes, 8);
  return out;
}

describe("createPrintCollector", () => {
  it("hands over a document only once it has closed", () => {
    // Half a PDF is not a smaller PDF: its cross-reference table is at the
    // end, so there is nothing useful to do with a partial one.
    const collector = createPrintCollector();
    expect(collector.handle(frame(1, PRINT_BEGIN, "report.pdf"))).toBeNull();
    expect(
      collector.handle(frame(1, PRINT_DATA, new Uint8Array([1, 2]))),
    ).toBeNull();

    const document = collector.handle(frame(1, PRINT_END));
    expect(document?.name).toBe("report.pdf");
    expect(Array.from(document!.bytes)).toEqual([1, 2]);
  });

  it("reassembles pieces in order", () => {
    const collector = createPrintCollector();
    collector.handle(frame(7, PRINT_BEGIN, "a.pdf"));
    collector.handle(frame(7, PRINT_DATA, new Uint8Array([1, 2])));
    collector.handle(frame(7, PRINT_DATA, new Uint8Array([3])));
    collector.handle(frame(7, PRINT_DATA, new Uint8Array([4, 5])));
    expect(Array.from(collector.handle(frame(7, PRINT_END))!.bytes)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("keeps two jobs apart", () => {
    // Splicing two documents into one would be worse than losing either.
    const collector = createPrintCollector();
    collector.handle(frame(1, PRINT_BEGIN, "one.pdf"));
    collector.handle(frame(2, PRINT_BEGIN, "two.pdf"));
    collector.handle(frame(1, PRINT_DATA, new Uint8Array([1])));
    collector.handle(frame(2, PRINT_DATA, new Uint8Array([2])));

    expect(Array.from(collector.handle(frame(2, PRINT_END))!.bytes)).toEqual([
      2,
    ]);
    expect(Array.from(collector.handle(frame(1, PRINT_END))!.bytes)).toEqual([
      1,
    ]);
  });

  it("ignores data for a job that never began", () => {
    const collector = createPrintCollector();
    expect(
      collector.handle(frame(3, PRINT_DATA, new Uint8Array([1]))),
    ).toBeNull();
    expect(collector.handle(frame(3, PRINT_END))).toBeNull();
  });

  it("hands over nothing for an empty job", () => {
    const collector = createPrintCollector();
    collector.handle(frame(4, PRINT_BEGIN, "empty.pdf"));
    expect(collector.handle(frame(4, PRINT_END))).toBeNull();
  });

  it("names a job the bridge did not name", () => {
    const collector = createPrintCollector();
    collector.handle(frame(9, PRINT_BEGIN));
    collector.handle(frame(9, PRINT_DATA, new Uint8Array([1])));
    expect(collector.handle(frame(9, PRINT_END))?.name).toBe("print-9.pdf");
  });

  it("ignores a frame too short to hold a header", () => {
    expect(createPrintCollector().handle(new Uint8Array(4))).toBeNull();
  });
});
