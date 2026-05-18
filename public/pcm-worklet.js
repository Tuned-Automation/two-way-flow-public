/**
 * AudioWorkletProcessor: mono Float32 input @ AudioContext sampleRate
 * → Int16 PCM @ targetRate (default 16 kHz), batched into ~100 ms frames.
 *
 * Loaded by the renderer via `audioWorklet.addModule(new URL(..., import.meta.url))`.
 * Runs in the audio rendering thread; communicates back via `this.port.postMessage`.
 *
 * Resampling: simple linear interpolation. Adequate for speech transcription;
 * if we ever start sending higher-fidelity audio we'd want a proper polyphase
 * low-pass before decimation, but at 48 → 16 kHz with a vocal source this is fine.
 */

const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.targetRate = opts.targetRate || DEFAULT_TARGET_RATE;
    this.frameSamples = opts.frameSamples || DEFAULT_FRAME_SAMPLES;

    // Input samples consumed per output sample.
    this.ratio = sampleRate / this.targetRate;

    // Fractional read position into the current input block. May go slightly
    // negative across block boundaries (handled below via `prev`).
    this.pos = 0;
    this.prev = 0;

    this.out = new Int16Array(this.frameSamples);
    this.outIdx = 0;
  }

  /**
   * `inputs[0][0]` is the first channel of the first input. We force mono by
   * only reading channel 0, which is fine because the renderer's
   * MediaStreamAudioSourceNode is constructed from a `{ audio: true }` stream
   * that the browser already mixes/downmixes appropriately.
   */
  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    const N = channel.length;

    while (true) {
      const i0 = Math.floor(this.pos);
      const i1 = i0 + 1;
      // Need both endpoints in (prev | channel). If i1 is past the block we
      // wait for the next block — preserves continuity at the boundary.
      if (i1 >= N) break;

      const frac = this.pos - i0;
      const s0 = i0 < 0 ? this.prev : channel[i0];
      const s1 = channel[i1];
      let sample = s0 + (s1 - s0) * frac;

      // Soft clip then convert to Int16 (asymmetric ranges to avoid wraparound).
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      this.out[this.outIdx++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this.outIdx >= this.out.length) {
        // Copy out; we keep reusing `this.out` to avoid GC churn.
        const buf = this.out.buffer.slice(0);
        this.port.postMessage(buf, [buf]);
        this.outIdx = 0;
      }

      this.pos += this.ratio;
    }

    // Shift read position so it's relative to the next block's start.
    this.pos -= N;
    this.prev = channel[N - 1];
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
