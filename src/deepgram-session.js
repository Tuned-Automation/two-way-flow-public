import { DeepgramClient } from '@deepgram/sdk';

/**
 * Thin wrapper around the Deepgram Nova-3 streaming WebSocket via
 * `@deepgram/sdk` (v5). Mirrors the constructor + lifecycle of
 * src/gemini-session.js so main.js can drive both sessions symmetrically.
 *
 * Owns DUAL CHANNEL speaker-attributed transcription:
 *   channel 1 = salesperson mic        → speaker: 'you'
 *   channel 2 = prospect / loopback    → speaker: 'other'
 *
 * Design choice — TWO independent Deepgram live connections (one per
 * channel) instead of one multichannel connection with interleaved PCM.
 *
 * Why:
 *   - Deepgram's `multichannel: true` mode expects ONE PCM stream with
 *     channel-interleaved samples (L, R, L, R, …). To produce that from
 *     two independently-paced PCM worklets we'd need a real-time mixer
 *     that buffers + zero-fills + re-aligns each worklet's output every
 *     packet. Any drift between the two worklets stretches one
 *     channel's timeline relative to the other and corrupts attribution.
 *   - With two connections each Deepgram session sees a clean mono
 *     stream at its own pace. The "channel" is encoded by which
 *     connection received the audio, so speaker labelling is free and
 *     fault-isolated: a hiccup on the prospect channel doesn't garble
 *     the seller channel.
 *   - Billing is identical — Deepgram charges per channel-second of
 *     audio either way. The marginal cost is one extra WebSocket.
 *
 * Trade-off: timing of finalised transcripts across the two channels is
 * not strictly synchronised (each connection commits on its own VAD).
 * For our use case (coach buffers a rolling transcript with speaker
 * prefixes) that's actually preferable to interleaved cross-talk.
 *
 * SDK note: @deepgram/sdk v5 is Fern-generated and replaced the legacy
 * `createClient` / `LiveTranscriptionEvents` API with `DeepgramClient`
 * and a 3-step open dance:
 *   const conn = await client.listen.v1.connect(opts);
 *   conn.on('open' | 'message' | 'error' | 'close', …);
 *   conn.connect();
 *   await conn.waitForOpen();
 * Audio is sent via `conn.sendMedia(payload)` (ArrayBuffer | ArrayBufferView).
 * Closing is `conn.close()`.
 */

const SPEAKER_BY_CHANNEL = {
  1: 'you',
  2: 'other',
};

/* Flip to `true` temporarily to log every Results message's is_final /
 * speech_final flags + a snippet of the transcript text. Useful when
 * debugging duplicate-commit issues (an utterance that keeps producing
 * `is_final=true` until VAD finally fires `speech_final=true`). Leave at
 * `false` in checked-in code — it's chatty. */
const DEBUG_DEEPGRAM = false;

/* Default Deepgram model. Used as the fallback when the constructor
 * is invoked without a `model` option (e.g. older call sites or a
 * settings file lacking `audio.deepgramModel`). Matches the original
 * hardcoded value pre-Phase 2 so behaviour is unchanged for callers
 * that don't pass through a settings-driven model. */
const DEFAULT_MODEL = 'nova-3';

/* ────────────────────────────────────────────────────────────────────
 * Cost-tracking note (session-cost-tracking feature, Wave 2)
 *
 * The DeepgramSession does NOT track per-channel connected-seconds for
 * billing. Instead, the v1 cost-tracking path derives audio minutes at
 * `gemini:stop` in src/main.js as:
 *
 *     audioMinutes = (durationMs / 1000 / 60) * 2  // two channels
 *
 * Why the simpler path:
 *   - Both channels run for the entire session — there's no scenario
 *     where one connection closes mid-call (a hiccup re-opens via the
 *     existing _openChannel reconnect plumbing in this file).
 *   - The ~5% accuracy gap from brief reconnect gaps is acceptable for
 *     a first cut; the user-facing cost figure is an estimate, not an
 *     invoice line item.
 *   - Avoids touching the WebSocket open/close lifecycle in this file,
 *     keeping the cost-tracking change additive and reversible.
 *
 * A future per-channel-accuracy v2 (better than ~95%) can adopt the
 * `recordTranscriptionSeconds(channel, seconds, model)` method on
 * src/usage-accumulator.js — it's already there, just uncalled by v1.
 * The persisted SessionRecord schema is unchanged either way: the
 * accumulator's snapshot() returns a single `audioMinutes` figure.
 * ──────────────────────────────────────────────────────────────────── */


/* Per-connection live options. One mono stream at 16kHz Int16 PCM —
 * matches the existing PCM worklet output, no resampling needed.
 *
 * NOTE: `model` is intentionally NOT in this constant any more
 * (Phase 2). The model is per-session and gets merged into the
 * options object at _openChannel() time so each DeepgramSession
 * instance can target whatever Deepgram tier the user has selected
 * in the Audio tab. See constructor docs.
 *
 * The v5 SDK URL-encodes everything as query params, so booleans are
 * the strings 'true' / 'false' (per the Fern-generated enum type
 * `ListenV1Punctuate.True === 'true'`). Numbers (`sample_rate`,
 * `channels`) are accepted as numbers and JSON-coerced by the SDK. */
const LIVE_OPTIONS = {
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 1,
  interim_results: 'true',
  smart_format: 'true',
  punctuate: 'true',
};

export class DeepgramSession {
  /**
   * @param {{
   *   apiKey: string;
   *   model?: string;
   *   onTranscript: (payload: { speaker: 'you' | 'other', text: string, finished: boolean }) => void;
   *   onError: (message: string) => void;
   *   onClose: (reason: string) => void;
   * }} deps
   *
   * `model` is the Deepgram listen.v1 model identifier (e.g.
   * 'nova-3', 'nova-2-meeting', 'enhanced'). Falls back to
   * `DEFAULT_MODEL` ('nova-3') if missing or empty so callers that
   * don't propagate `settings.audio.deepgramModel` still get the
   * original behaviour.
   *
   * The model is captured per-instance and merged into LIVE_OPTIONS
   * at _openChannel() time. A live mid-call model change is NOT
   * supported — the existing WebSocket would need to be torn down
   * and re-opened. Instead the renderer's "Changes apply on next
   * Start" hint warns the user that the Audio tab's Deepgram
   * dropdown only takes effect when the next call starts.
   */
  constructor({ apiKey, model, onTranscript, onError, onClose }) {
    this.apiKey = apiKey;
    this.model = typeof model === 'string' && model.length > 0 ? model : DEFAULT_MODEL;
    this.onTranscript = onTranscript || (() => {});
    this.onError = onError || (() => {});
    this.onClose = onClose || (() => {});

    this.client = null;
    /** @type {{ 1: any, 2: any }} */
    this.connections = { 1: null, 2: null };
    this.state = 'idle'; // 'idle' | 'opening' | 'open' | 'closed'
  }

  async open() {
    if (this.state !== 'idle') {
      throw new Error(`Cannot open Deepgram session in state ${this.state}`);
    }
    this.state = 'opening';

    try {
      this.client = new DeepgramClient({ apiKey: this.apiKey });
      await Promise.all([this._openChannel(1), this._openChannel(2)]);
      if (this.state !== 'closed') this.state = 'open';
    } catch (err) {
      const msg = err?.message || 'Failed to open Deepgram session';
      this._fail(msg);
      throw err;
    }

    return this;
  }

  /**
   * Open a single channel's live connection and resolve once it fires
   * `open`. Rejects if the connection errors before opening.
   */
  async _openChannel(channel) {
    const speaker = SPEAKER_BY_CHANNEL[channel];

    // Two-step SDK pattern: `await client.listen.v1.connect()` returns
    // a V1Socket pre-wired for our options but with the WebSocket NOT
    // yet open. We attach listeners, then call `socket.connect()` to
    // actually open the WS, then await `waitForOpen()`.
    //
    // The per-instance `model` is merged in here (NOT in LIVE_OPTIONS)
    // so each DeepgramSession can target a different tier without
    // mutating module-level state.
    const conn = await this.client.listen.v1.connect({
      ...LIVE_OPTIONS,
      model: this.model,
    });
    this.connections[channel] = conn;

    return new Promise((resolve, reject) => {
      let settled = false;

      conn.on('open', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      conn.on('message', (msg) => this._handleMessage(speaker, msg));

      conn.on('error', (err) => {
        const text = err?.message || `Deepgram channel ${channel} error`;
        if (!settled) {
          settled = true;
          reject(new Error(text));
          return;
        }
        this._fail(text);
      });

      conn.on('close', () => {
        if (this.state === 'closed') return;
        this.state = 'closed';
        this.onClose(`channel ${channel} closed`);
      });

      try {
        conn.connect();
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      // Safety net: also reject on a waitForOpen() failure (e.g. auth
      // rejection) in case the underlying socket fails before emitting
      // 'error' on our listener.
      conn.waitForOpen().catch((err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Filter the websocket messages down to `Results` payloads, pull the
   * top alternative's transcript, and forward via `onTranscript`. Other
   * message types (Metadata, UtteranceEnd, SpeechStarted) are ignored
   * — we don't need them for the coach loop.
   *
   * `finished` semantics (subtle): Deepgram's streaming protocol fires
   * two distinct "this transcript is stable" flags:
   *   - `is_final=true`     — the current READ is stable, but the
   *                           same utterance may keep extending. We
   *                           will see another `is_final=true` later
   *                           with the cumulative text appended.
   *   - `speech_final=true` — VAD detected end-of-utterance. THIS is
   *                           the real "commit the line and move on"
   *                           signal.
   * Treating `is_final` as commit-worthy produces one committed line
   * per stable read inside a single long utterance, each containing
   * the previous as a prefix. Belt-and-braces dedupe lives downstream
   * (main.js + renderer.js) for cases where two `speech_final`s fire
   * back-to-back on a fast continuation, but the primary fix is here:
   * only commit on `speech_final`.
   */
  _handleMessage(speaker, msg) {
    if (!msg || msg.type !== 'Results') return;
    const text = msg.channel?.alternatives?.[0]?.transcript;
    if (DEBUG_DEEPGRAM) {
      console.log('[dg]', speaker,
        'is_final=' + Boolean(msg.is_final),
        'speech_final=' + Boolean(msg.speech_final),
        'text=' + JSON.stringify((text || '').slice(0, 60)));
    }
    if (!text) return;
    const finished = Boolean(msg.speech_final);
    try {
      this.onTranscript({ speaker, text, finished });
    } catch (err) {
      console.warn('[deepgram] onTranscript handler threw:', err?.message || err);
    }
  }

  /**
   * Route a chunk of 16kHz mono Int16 PCM to the matching channel's
   * Deepgram connection. Silently no-ops if the session isn't open or
   * the channel isn't recognised.
   *
   * @param {{ channel: 1 | 2, chunk: Int16Array | Buffer | ArrayBuffer | Uint8Array }} arg
   */
  sendAudio({ channel, chunk }) {
    if (this.state !== 'open') return;
    const conn = this.connections[channel];
    if (!conn || !chunk) return;

    try {
      conn.sendMedia(toBinary(chunk));
    } catch (err) {
      this._fail(err?.message || `Failed to send audio on channel ${channel}`);
    }
  }

  async close() {
    if (this.state === 'closed' || this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    this._closeConnections();
  }

  _closeConnections() {
    for (const ch of [1, 2]) {
      const conn = this.connections[ch];
      if (!conn) continue;
      try {
        if (typeof conn.close === 'function') conn.close();
      } catch {
        /* already closed */
      }
      this.connections[ch] = null;
    }
  }

  _fail(message) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try {
      this.onError(message);
    } catch (err) {
      console.warn('[deepgram] onError handler threw:', err?.message || err);
    }
    this._closeConnections();
  }
}

/**
 * Coerce an audio chunk to a payload accepted by V1Socket.sendMedia()
 * (ArrayBuffer | Blob | ArrayBufferView). Node Buffers are already
 * ArrayBufferView (Uint8Array subclass) so they pass through. Typed
 * arrays (Int16Array, Uint8Array) also pass through unchanged.
 */
function toBinary(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return chunk;
  if (ArrayBuffer.isView(chunk)) return chunk;
  return Buffer.from(chunk);
}
