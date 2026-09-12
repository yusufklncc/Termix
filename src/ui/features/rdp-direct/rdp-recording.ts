/**
 * Reading back a recorded direct RDP session.
 *
 * The file is the session's own wire stream with a clock attached: an eight
 * byte header, then each chunk behind the moment it arrived. Playback is
 * therefore not a second implementation of anything -- the bytes go to the
 * same frame reader and the same decoder the live path uses, which is the
 * whole reason this format is the format.
 *
 * Written by the backend; see src/backend/hosts/rdp-direct/recording.ts.
 */

export const RECORDING_MAGIC = "TXRD";
export const RECORDING_VERSION = 1;
export const RECORDING_HEADER_BYTES = 8;
export const RECORD_HEADER_BYTES = 8;

export interface RdpRecord {
  /** Milliseconds between the session opening and this chunk arriving. */
  millis: number;
  bytes: Uint8Array;
}

/**
 * Checks the file is one of ours and returns where the records start.
 *
 * Returns null for anything else, so a player can say "not a recording of this
 * kind" rather than rendering noise.
 */
export function readRecordingHeader(data: Uint8Array): number | null {
  if (data.length < RECORDING_HEADER_BYTES) return null;

  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== RECORDING_MAGIC) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(4, true) !== RECORDING_VERSION) return null;

  return RECORDING_HEADER_BYTES;
}

/**
 * Splits a recording into its records.
 *
 * A truncated tail is where the records stop rather than an error: a session
 * that ended when the process did leaves a partial last write, and everything
 * before it is still a recording.
 */
export function parseRecording(data: Uint8Array): RdpRecord[] | null {
  const start = readRecordingHeader(data);
  if (start === null) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: RdpRecord[] = [];

  let at = start;
  while (at + RECORD_HEADER_BYTES <= data.length) {
    const millis = view.getUint32(at, true);
    const length = view.getUint32(at + 4, true);
    const from = at + RECORD_HEADER_BYTES;
    if (from + length > data.length) break;

    records.push({ millis, bytes: data.subarray(from, from + length) });
    at = from + length;
  }

  return records;
}

/** How long the recording runs, which is when its last chunk arrived. */
export function recordingDuration(records: RdpRecord[]): number {
  return records.length === 0 ? 0 : records[records.length - 1].millis;
}

/**
 * The records that fall in a half-open window of the timeline.
 *
 * Playback advances by asking for what is newly due, and seeking asks for
 * everything up to a point -- both are this, with different bounds.
 */
export function recordsBetween(
  records: RdpRecord[],
  fromMillis: number,
  toMillis: number,
): RdpRecord[] {
  return records.filter(
    (record) => record.millis >= fromMillis && record.millis < toMillis,
  );
}
