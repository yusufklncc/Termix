/**
 * Documents printed on the remote desktop.
 *
 * The bridge announces a printer to Windows, collects what it renders, and
 * converts it to PDF. That PDF arrives in pieces, because a document is
 * routinely larger than one wire frame, so this reassembles it and hands the
 * finished file over.
 *
 * A job is only ever handed over once it has closed. Half a PDF is not a
 * smaller PDF -- its cross-reference table is at the end -- so there is
 * nothing useful to do with a partial one.
 */

export const PRINT_BEGIN = 0;
export const PRINT_DATA = 1;
export const PRINT_END = 2;

const PRINT_HEADER_BYTES = 8;

/** Guards against a job that never closes filling the tab's memory. */
const MAX_JOB_BYTES = 256 * 1024 * 1024;

export interface PrintedDocument {
  name: string;
  bytes: Uint8Array;
}

export interface RdpPrintCollector {
  /** Returns a document when this frame completed one. */
  handle(payload: Uint8Array): PrintedDocument | null;
}

export function createPrintCollector(): RdpPrintCollector {
  const jobs = new Map<
    number,
    { name: string; pieces: Uint8Array[]; size: number }
  >();

  return {
    handle(payload: Uint8Array): PrintedDocument | null {
      if (payload.length < PRINT_HEADER_BYTES) return null;

      const view = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.length,
      );
      const id = view.getUint32(0, true);
      const flag = view.getUint32(4, true);
      const body = payload.subarray(PRINT_HEADER_BYTES);

      if (flag === PRINT_BEGIN) {
        jobs.set(id, {
          name: new TextDecoder().decode(body) || `print-${id}.pdf`,
          pieces: [],
          size: 0,
        });
        return null;
      }

      const job = jobs.get(id);
      if (!job) return null;

      if (flag === PRINT_DATA) {
        if (job.size + body.length > MAX_JOB_BYTES) {
          jobs.delete(id);
          return null;
        }
        // Copied because the frame's buffer is reused by the reader.
        job.pieces.push(body.slice());
        job.size += body.length;
        return null;
      }

      if (flag !== PRINT_END) return null;
      jobs.delete(id);
      if (job.size === 0) return null;

      const bytes = new Uint8Array(job.size);
      let at = 0;
      for (const piece of job.pieces) {
        bytes.set(piece, at);
        at += piece.length;
      }
      return { name: job.name, bytes };
    },
  };
}
