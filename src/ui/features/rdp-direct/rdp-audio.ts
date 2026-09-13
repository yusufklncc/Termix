/**
 * Remote sound.
 *
 * The bridge sends 16 bit PCM with the format in front of every chunk, and
 * this plays it. The only real problem is that audio is a clock: the browser
 * consumes samples at exactly the rate its hardware runs, while they arrive in
 * bursts over a network. Too few and it stutters, too many and the sound lags
 * further behind the picture with every second.
 *
 * So playback runs through an AudioWorklet holding a queue, and the queue has
 * a ceiling. Dropping the oldest audio when it grows past that is the right
 * trade for a desktop: hearing a click now beats hearing everything a second
 * late for the rest of the session.
 */

/*
 * The processor is a string because an AudioWorklet module is fetched by URL
 * as a classic script, which is not something the bundler can produce from a
 * TypeScript file in this project's configuration. A blob keeps it here, next
 * to the code that talks to it, rather than in a separate untyped asset.
 */
const PROCESSOR_SOURCE = `
class RdpAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    // Roughly a quarter second. Enough to ride out a burst, short enough that
    // falling behind is corrected before anyone calls it lag.
    this.maxFrames = options.processorOptions.maxFrames;
    this.queue = [];
    this.queued = 0;
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.queue = [];
        this.queued = 0;
        this.offset = 0;
        return;
      }
      const samples = new Int16Array(event.data);
      this.queue.push(samples);
      this.queued += samples.length / this.channels;
      while (this.queued > this.maxFrames && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.queued -= dropped.length / this.channels;
        this.offset = 0;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;

    for (let frame = 0; frame < frames; frame++) {
      if (this.queue.length === 0) {
        // Silence rather than the last sample repeated: a held sample is a
        // tone, and a tone is far more noticeable than a gap.
        for (let c = 0; c < output.length; c++) output[c][frame] = 0;
        continue;
      }

      const chunk = this.queue[0];
      for (let c = 0; c < output.length; c++) {
        const source = Math.min(c, this.channels - 1);
        output[c][frame] = chunk[this.offset + source] / 32768;
      }

      this.offset += this.channels;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.queued -= chunk.length / this.channels;
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("rdp-audio", RdpAudioProcessor);
`;

export interface RdpAudio {
  /** Queues one chunk. The first one starts the audio graph. */
  push(pcm: Uint8Array, rate: number, channels: number): void;
  /** Browsers refuse to start audio without a gesture; this is the gesture. */
  resume(): void;
  close(): void;
}

export function createRdpAudio(): RdpAudio {
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let ready: Promise<void> | null = null;
  let rate = 0;
  let channels = 0;
  let closed = false;

  /*
   * The context is opened at the stream's own sample rate so nothing has to
   * resample. A rate the hardware cannot run is resampled by the browser,
   * which is still better than doing it here.
   */
  const open = (nextRate: number, nextChannels: number) => {
    close();
    closed = false;
    rate = nextRate;
    channels = nextChannels;

    context = new AudioContext({
      sampleRate: nextRate,
      latencyHint: "interactive",
    });
    // AudioWorklet exists only in a secure context. Without it there is no
    // playback to build, and throwing here would escape into the frame loop
    // that called push().
    if (!context.audioWorklet) {
      console.warn(
        "[rdp-direct] no audio: AudioWorklet needs a secure context",
      );
      return;
    }

    const url = URL.createObjectURL(
      new Blob([PROCESSOR_SOURCE], { type: "application/javascript" }),
    );

    ready = context.audioWorklet
      .addModule(url)
      .then(() => {
        if (closed || !context) return;
        node = new AudioWorkletNode(context, "rdp-audio", {
          outputChannelCount: [Math.min(2, nextChannels)],
          processorOptions: {
            channels: nextChannels,
            maxFrames: Math.round(nextRate / 4),
          },
        });
        node.connect(context.destination);
      })
      .catch((error) => {
        console.warn(`[rdp-direct] no audio: ${error}`);
      })
      .finally(() => URL.revokeObjectURL(url));
  };

  const close = () => {
    closed = true;
    node?.disconnect();
    node = null;
    ready = null;
    void context?.close().catch(() => {});
    context = null;
  };

  return {
    push(pcm: Uint8Array, nextRate: number, nextChannels: number) {
      if (nextRate <= 0 || nextChannels <= 0) return;
      // A format change mid-session is rare but real -- a different application
      // opening the device. Rebuilding is simpler than converting.
      if (!context || nextRate !== rate || nextChannels !== channels) {
        open(nextRate, nextChannels);
      }

      const copy = pcm.slice().buffer;
      void ready?.then(() => node?.port.postMessage(copy, [copy]));
    },

    resume() {
      void context?.resume().catch(() => {});
    },

    close,
  };
}
