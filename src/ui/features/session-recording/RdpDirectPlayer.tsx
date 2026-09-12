import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize, Minimize, Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RdpFrameReader } from "@/features/rdp-direct/rdp-wire.ts";
import { createRdpRenderer } from "@/features/rdp-direct/rdp-render.ts";
import {
  parseRecording,
  recordingDuration,
  recordsBetween,
  type RdpRecord,
} from "@/features/rdp-direct/rdp-recording.ts";

/**
 * Plays back a recorded direct RDP session.
 *
 * The recording is the session's own wire stream, so this decodes it exactly
 * the way the live path does -- same frame reader, same renderer, same worker.
 * Nothing here knows what an H.264 frame is.
 *
 * Seeking backwards means starting over. The stream is a sequence of changes
 * to a picture, not a sequence of pictures, so the only way to know what the
 * screen held at a moment is to replay everything up to it. That is cheap
 * enough to do plainly: the decode is the same one that kept up live.
 */
export function RdpDirectPlayer({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Fullscreen takes the frame rather than the canvas, so the controls go
  // with it -- a full screen you cannot pause is worse than a small one.
  const frameRef = useRef<HTMLDivElement | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const rendererRef = useRef<ReturnType<typeof createRdpRenderer> | null>(null);
  const readerRef = useRef(new RdpFrameReader());
  const recordsRef = useRef<RdpRecord[]>([]);
  /** How far into the recording the screen currently reflects. */
  const playedToRef = useRef(0);

  const [records, setRecords] = useState<RdpRecord[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  const duration = records ? recordingDuration(records) : 0;

  useEffect(() => {
    let cancelled = false;
    blob.arrayBuffer().then((buffer) => {
      if (cancelled) return;
      const parsed = parseRecording(new Uint8Array(buffer));
      if (!parsed) {
        setUnreadable(true);
        return;
      }
      recordsRef.current = parsed;
      setRecords(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [blob]);

  // The canvas is created here rather than taken from React for the same
  // reason the live client does it: a canvas can only be transferred to a
  // worker once, and StrictMode runs this effect twice.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !records) return;

    const worker = new Worker(
      new URL("@/features/rdp-direct/rdp-decoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 w-full h-full object-contain";
    surface.appendChild(canvas);

    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);

    workerRef.current = worker;
    rendererRef.current = createRdpRenderer({ worker, surface });

    return () => {
      worker.postMessage({ type: "close" });
      worker.terminate();
      canvas.remove();
      workerRef.current = null;
      rendererRef.current = null;
    };
  }, [records]);

  /** Feeds every chunk in a window to the decoder, in order. */
  const feed = useCallback((from: number, to: number) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    for (const record of recordsBetween(recordsRef.current, from, to)) {
      for (const frame of readerRef.current.push(record.bytes)) {
        renderer.handle(frame);
      }
    }
    playedToRef.current = to;
  }, []);

  const seek = useCallback(
    (to: number) => {
      // Backwards is a restart: a later picture cannot be reconstructed from
      // an earlier one by running the changes in reverse.
      if (to < playedToRef.current) {
        readerRef.current = new RdpFrameReader();
        workerRef.current?.postMessage({ type: "reset" });
        playedToRef.current = 0;
      }
      feed(playedToRef.current, to);
      setPosition(to);
    },
    [feed],
  );

  useEffect(() => {
    if (!playing || !records) return;

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = playedToRef.current + (now - last);
      last = now;

      if (next >= duration) {
        feed(playedToRef.current, duration + 1);
        setPosition(duration);
        setPlaying(false);
        return;
      }

      feed(playedToRef.current, next);
      setPosition(next);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, records, duration, feed]);

  // The browser owns this state: Escape and the window chrome both leave
  // fullscreen without going through the button.
  useEffect(() => {
    const sync = () =>
      setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frameRef.current?.requestFullscreen().catch(() => {});
  };

  if (unreadable) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        {t("sessionRecording.unreadable")}
      </div>
    );
  }

  const seconds = (millis: number) => {
    const total = Math.floor(millis / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
      total % 60,
    ).padStart(2, "0")}`;
  };

  return (
    <div
      ref={frameRef}
      className="flex flex-col gap-2 bg-background data-[fullscreen=true]:justify-center data-[fullscreen=true]:h-full data-[fullscreen=true]:p-3"
      data-fullscreen={fullscreen}
    >
      <div
        ref={surfaceRef}
        className={`relative w-full bg-black overflow-hidden ${
          fullscreen ? "flex-1 min-h-0" : "aspect-video"
        }`}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPlaying((was) => !was)}
          disabled={!records}
          className="size-7 flex items-center justify-center border border-border text-foreground disabled:opacity-40"
          aria-label={t(playing ? "common.pause" : "common.play")}
        >
          {playing ? (
            <Pause className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 1}
          value={position}
          onChange={(event) => seek(Number(event.target.value))}
          className="flex-1"
          aria-label={t("sessionRecording.position")}
        />
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {seconds(position)} / {seconds(duration)}
        </span>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="size-7 flex items-center justify-center border border-border text-foreground"
          aria-label={t(
            fullscreen ? "common.exitFullscreen" : "common.fullscreen",
          )}
        >
          {fullscreen ? (
            <Minimize className="size-3.5" />
          ) : (
            <Maximize className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
