import { GoogleGenAI, Modality } from '@google/genai';

/**
 * Thin wrapper around `@google/genai` Live API.
 *
 * Owns one Gemini Live WebSocket session. Only runs in the Electron main
 * process — never import this from the renderer (the API key would leak).
 *
 * Extension point: when adding rubric scoring or coaching prompts later,
 * extend `config` here (e.g. systemInstruction, tools) rather than the
 * IPC layer above. Callers should still only see transcripts/errors via
 * the four callbacks below.
 */

export const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

const INPUT_MIME = 'audio/pcm;rate=16000';

export class GeminiSession {
  /**
   * @param {{
   *   apiKey: string;
   *   onTranscript: (payload: { text: string, finished: boolean }) => void;
   *   onTurnComplete: () => void;
   *   onError: (message: string) => void;
   *   onClose: (reason: string) => void;
   * }} deps
   */
  constructor({ apiKey, onTranscript, onTurnComplete, onError, onClose }) {
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
    this.onTurnComplete = onTurnComplete;
    this.onError = onError;
    this.onClose = onClose;

    this.client = null;
    this.session = null;
    this.state = 'idle'; // 'idle' | 'opening' | 'open' | 'closed'
  }

  async open() {
    if (this.state !== 'idle') {
      throw new Error(`Cannot open session in state ${this.state}`);
    }
    this.state = 'opening';

    this.client = new GoogleGenAI({ apiKey: this.apiKey });

    this.session = await this.client.live.connect({
      model: GEMINI_MODEL,
      config: {
        // The native-audio model requires AUDIO modality — it errors out with
        // "Cannot extract voices from a non-audio request" if asked for TEXT.
        // We still only care about `inputAudioTranscription` for this step;
        // the model's audio response is intentionally ignored in
        // `_handleMessage` (we never wire it to an output).
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        // Tell the model to stay silent so we don't waste tokens generating
        // audio replies we throw away. When we add coaching later, this
        // instruction is where the coaching prompt goes.
        systemInstruction: {
          parts: [
            {
              text: 'You are a silent transcription endpoint. Do not respond, do not speak, do not generate audio. Just listen.',
            },
          ],
        },
      },
      callbacks: {
        onopen: () => {
          this.state = 'open';
        },
        onmessage: (message) => this._handleMessage(message),
        onerror: (event) => {
          const msg = event?.message || event?.error?.message || 'Gemini live error';
          this._fail(msg);
        },
        onclose: (event) => {
          if (this.state === 'closed') return;
          this.state = 'closed';
          this.onClose(event?.reason || 'closed');
        },
      },
    });

    return this;
  }

  /**
   * Send a chunk of 16kHz mono PCM (Int16, little-endian) as base64.
   * Silently no-ops if the session isn't open — keeps the renderer from
   * having to coordinate exactly with the open/close timing.
   */
  sendAudio(int16Buffer) {
    if (this.state !== 'open' || !this.session) return;

    // `int16Buffer` arrives as a Node Buffer (via IPC structured clone of a
    // Uint8Array). base64 encoding is the wire format Gemini expects.
    const base64 = Buffer.isBuffer(int16Buffer)
      ? int16Buffer.toString('base64')
      : Buffer.from(int16Buffer).toString('base64');

    try {
      this.session.sendRealtimeInput({
        audio: { data: base64, mimeType: INPUT_MIME },
      });
    } catch (err) {
      this._fail(err?.message || 'Failed to send audio');
    }
  }

  async close() {
    if (this.state === 'closed' || this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
    this.session = null;
  }

  _handleMessage(message) {
    const sc = message?.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      this.onTranscript({
        text: sc.inputTranscription.text,
        finished: Boolean(sc.inputTranscription.finished),
      });
    }

    if (sc.turnComplete) {
      this.onTurnComplete();
    }
  }

  _fail(message) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.onError(message);
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = null;
  }
}
