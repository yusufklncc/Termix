import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sshLogger } from "../../utils/logger.js";
import { createCurrentSessionRecordingRepository } from "../../database/repositories/factory.js";

/**
 * Recording a direct RDP session.
 *
 * guacd records by re-serialising the Guacamole protocol, which it can do
 * because that protocol is what it speaks. This path has the same property for
 * free: what the bridge sends the browser is already a complete, ordered
 * description of the session -- H.264 frames, painted regions, cursors -- so
 * recording it is writing that stream down, and playing it back is handing the
 * same bytes to the same decoder.
 *
 * What the stream does not carry is time. The bytes say what happened but not
 * when, and a recording replayed as fast as it reads is not a recording of
 * anything. So each chunk is stored behind the moment it arrived.
 *
 * Chunks are TCP-shaped, not frame-shaped: a chunk may hold half a frame or
 * several. That is fine and deliberate -- playback feeds the bytes to the same
 * reader the live path uses, which is what reassembles frames either way.
 */

const DATA_DIR = process.env.DATA_DIR || "./db/data";

export const RECORDING_DIR = path.join(
  DATA_DIR,
  "session_recordings",
  "rdp-direct",
);

/** "TXRD", then a version, so a player can refuse a file it does not know. */
export const RECORDING_MAGIC = "TXRD";
export const RECORDING_VERSION = 1;
export const RECORDING_HEADER_BYTES = 8;
export const RECORD_HEADER_BYTES = 8;

export function encodeRecordingHeader(): Buffer {
  const header = Buffer.alloc(RECORDING_HEADER_BYTES);
  header.write(RECORDING_MAGIC, 0, 4, "ascii");
  header.writeUInt32LE(RECORDING_VERSION, 4);
  return header;
}

/**
 * One chunk, behind the milliseconds since the session opened.
 *
 * The clock is relative rather than absolute so a recording is independent of
 * when it was taken, and 32 bits of milliseconds is 49 days of session.
 */
export function encodeRecord(millis: number, chunk: Buffer): Buffer {
  const header = Buffer.alloc(RECORD_HEADER_BYTES);
  header.writeUInt32LE(Math.max(0, Math.min(millis, 0xffffffff)), 0);
  header.writeUInt32LE(chunk.length, 4);
  return Buffer.concat([header, chunk]);
}

export interface RdpRecorder {
  write(chunk: Buffer): void;
  close(): Promise<void>;
}

/**
 * Starts recording, or returns null when the host has it switched off.
 *
 * A recording that cannot be opened is not a reason to refuse the session:
 * the viewer asked to connect, not to record, and failing the connection
 * because a disk is full would be the wrong trade. It is logged and the
 * session continues without one.
 */
export function startRecording({
  hostId,
  userId,
}: {
  hostId: number;
  userId: string;
}): RdpRecorder | null {
  let stream: fs.WriteStream;
  const file = path.resolve(RECORDING_DIR, `${crypto.randomUUID()}.txrd`);

  try {
    fs.mkdirSync(RECORDING_DIR, { recursive: true });
    stream = fs.createWriteStream(file);
    stream.write(encodeRecordingHeader());
  } catch (error) {
    sshLogger.error("Could not start a direct RDP recording", error, {
      operation: "rdp_direct_recording_start_error",
      hostId,
      userId,
    });
    return null;
  }

  // A write that fails mid-session should not take the session with it.
  stream.on("error", (error) => {
    sshLogger.error("Direct RDP recording failed", error, {
      operation: "rdp_direct_recording_write_error",
      hostId,
    });
  });

  const startedAt = new Date();
  let closed = false;

  return {
    write(chunk: Buffer) {
      if (closed || stream.destroyed) return;
      stream.write(encodeRecord(Date.now() - startedAt.getTime(), chunk));
    },

    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => stream.end(resolve));

      const endedAt = new Date();
      try {
        await createCurrentSessionRecordingRepository().create({
          hostId,
          userId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          duration: Math.max(
            0,
            Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
          ),
          recordingPath: file,
          protocol: "rdp",
          format: "rdp-direct",
        });
      } catch (error) {
        sshLogger.error("Could not register a direct RDP recording", error, {
          operation: "rdp_direct_recording_register_error",
          hostId,
        });
      }
    },
  };
}
