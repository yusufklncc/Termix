import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * The session-recording plugin's service, as ctx.services.get returns it.
 * Optional: without that plugin nothing is recorded, which is not a failure.
 */
export interface RecordingsWriter {
  enabledFor: (hostId: number) => Promise<boolean>;
  createFinished: (input: {
    hostId: number;
    userId: string;
    startedAt: string;
    endedAt: string;
    duration: number | null;
    recordingPath: string;
    protocol: string;
    format: string;
    /**
     * Since Termix 26.11 each plugin runs in its own process and can open
     * only its own folder, so session-recording copies the file through this
     * rather than moving it. Bytes from an offset; an empty chunk at the end.
     */
    read?: (offset: number) => Promise<Uint8Array | null>;
  }) => Promise<{ id: number }>;
}

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

/**
 * Where a recording is written while the session runs: this plugin's own
 * folder, the only one it may write to since plugins run in their own
 * process. session-recording copies it out when the session ends.
 */
export async function recordingDir(ctx: PluginContext): Promise<string> {
  return path.join(
    await ctx.files.dataDir(),
    "session_recordings",
    "rdp-direct",
  );
}

/** How much one read() hands session-recording at a time. */
export const READ_CHUNK_BYTES = 1024 * 1024;

/** A reader over a finished file, in the shape createFinished takes. */
export function fileReader(file: string) {
  return async (offset: number): Promise<Uint8Array | null> => {
    const handle = await fs.promises.open(file, "r");
    try {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
}

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
export async function startRecording({
  ctx,
  recordings,
  hostId,
  userId,
}: {
  ctx: PluginContext;
  recordings: RecordingsWriter;
  hostId: number;
  userId: string;
}): Promise<RdpRecorder | null> {
  let stream: fs.WriteStream;
  let file: string;

  try {
    const dir = await recordingDir(ctx);
    file = path.resolve(dir, `${crypto.randomUUID()}.txrd`);
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(file);
    stream.write(encodeRecordingHeader());
  } catch (error) {
    ctx.log.error(
      `Could not start a Direct RDP recording for host ${hostId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  // A write that fails mid-session should not take the session with it.
  stream.on("error", (error) => {
    ctx.log.error(
      `Direct RDP recording failed for host ${hostId}: ${error.message}`,
    );
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
        await recordings.createFinished({
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
          read: fileReader(file),
        });
        // session-recording has its own copy now; this one was only ever
        // the working file.
        await fs.promises.unlink(file).catch(() => {});
      } catch (error) {
        ctx.log.error(
          `Could not register a Direct RDP recording for host ${hostId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
