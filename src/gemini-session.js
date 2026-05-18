import { GoogleGenAI, Modality, Type } from '@google/genai';
import { FLAG_IDS, RUBRIC_SYSTEM_INSTRUCTION } from './rubric.js';

/**
 * Thin wrapper around `@google/genai` Live API.
 *
 * Owns one Gemini Live WebSocket session. Only runs in the Electron main
 * process — never import this from the renderer (the API key would leak).
 *
 * Responsibilities:
 *   - Stream PCM audio to Gemini.
 *   - Surface input transcription via `onTranscript`.
 *   - Surface `record_flag` tool calls via `onFlag`.
 *   - Acknowledge tool calls in batched sendToolResponse calls.
 *
 * Scope deliberately narrow: this session owns LIVE detection (flags). The
 * structured rubric scoring (item coverage, captured fields, next-question
 * suggestions) lives in src/coach.js, which runs a parallel text-model
 * loop over the rolling transcript. Splitting the two surfaces was the
 * latency unlock — the live model's job stays small enough that the
 * native-audio preview model can stay responsive.
 *
 * Extension point: if a future signal genuinely needs sub-second audio
 * detection (e.g. interruption / overtalk), add another tool to the
 * functionDeclarations below and branch in _dispatchToolCall(). Anything
 * that can wait 3–5s belongs in the coach instead.
 */

export const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

const INPUT_MIME = 'audio/pcm;rate=16000';

/* Aggressive turn-detection settings: short silence threshold so the model
 * commits transcripts on ~300ms pauses instead of the default ~1s, and
 * high sensitivity on both endpoints so it doesn't wait for a perfectly
 * clean silence to mark a turn. The trade-off is occasional premature
 * turn commits on slow speakers — acceptable for our use case since the
 * coach reads the full rolling buffer anyway. */
const TURN_DETECTION = {
  disabled: false,
  startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
  endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
  silenceDurationMs: 300,
};

/* ────────────────────────────────────────────────────────────────────────
 * Tool declarations
 * ──────────────────────────────────────────────────────────────────────── */

const RECORD_FLAG = {
  name: 'record_flag',
  description:
    'Record one of the catalogued red/green coaching flags. Each id may be recorded at most once per call.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: {
        type: Type.STRING,
        description: 'Flag identifier from the catalogue in the system instruction.',
        enum: FLAG_IDS,
      },
      evidence: {
        type: Type.STRING,
        description: 'Short quote or paraphrase (≤120 chars) of the moment that triggered this flag.',
      },
    },
    required: ['id', 'evidence'],
  },
};

const TOOLS = [{ functionDeclarations: [RECORD_FLAG] }];

/* ────────────────────────────────────────────────────────────────────────
 * Session
 * ──────────────────────────────────────────────────────────────────────── */

export class GeminiSession {
  /**
   * @param {{
   *   apiKey: string;
   *   onTranscript: (payload: { text: string, finished: boolean }) => void;
   *   onTurnComplete: () => void;
   *   onFlag: (payload: { id: string, evidence: string }) => void;
   *   onError: (message: string) => void;
   *   onClose: (reason: string) => void;
   * }} deps
   */
  constructor({ apiKey, onTranscript, onTurnComplete, onFlag, onError, onClose }) {
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
    this.onTurnComplete = onTurnComplete;
    this.onFlag = onFlag;
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
        // The native-audio model requires AUDIO modality. We ignore its
        // audio output entirely — every signal we care about comes back
        // via inputAudioTranscription or tool calls.
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: RUBRIC_SYSTEM_INSTRUCTION }] },
        tools: TOOLS,
        realtimeInputConfig: {
          automaticActivityDetection: TURN_DETECTION,
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
   * Send a chunk of 16kHz mono PCM (Int16 little-endian) as base64.
   * Silently no-ops if the session isn't open.
   */
  sendAudio(int16Buffer) {
    if (this.state !== 'open' || !this.session) return;

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
    // Tool calls and serverContent arrive in the same message envelope.
    this._handleToolCall(message);
    this._handleServerContent(message);
  }

  _handleServerContent(message) {
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

  _handleToolCall(message) {
    const calls = message?.toolCall?.functionCalls;
    if (!calls || calls.length === 0) return;

    for (const call of calls) {
      this._dispatchToolCall(call);
    }

    // Acknowledge every call in a single batched response. The Live API
    // needs every call answered so the model knows the client is alive.
    try {
      this.session?.sendToolResponse({
        functionResponses: calls.map((call) => ({
          id: call.id,
          name: call.name,
          response: { ok: true },
        })),
      });
    } catch (err) {
      console.warn('[gemini] failed to send tool response:', err?.message || err);
    }
  }

  /**
   * Live-model dispatcher. Today only `record_flag` is wired; future
   * sub-second tools plug in here. Each branch is defensive about
   * argument shape — the model occasionally returns extra/missing keys
   * and we never want a bad call to crash the session.
   */
  _dispatchToolCall(call) {
    const args = call?.args || {};
    switch (call?.name) {
      case 'record_flag': {
        const id = typeof args.id === 'string' ? args.id : null;
        if (!id) return;
        this.onFlag({ id, evidence: typeof args.evidence === 'string' ? args.evidence : '' });
        return;
      }
      default:
        console.warn('[gemini] ignoring unknown tool call:', call?.name);
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
