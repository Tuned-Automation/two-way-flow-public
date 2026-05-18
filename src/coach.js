import { GoogleGenAI, Type } from '@google/genai';
import {
  COACH_SYSTEM_INSTRUCTION,
  FIELD_IDS,
  ITEM_IDS,
  formatCoachState,
} from './rubric.js';

/**
 * Text-coach loop. Runs in the Electron main process alongside the live
 * audio session.
 *
 * Why this exists
 *   The native-audio Live model is great for fast detection (red/green
 *   flags) but slow and unreliable at scoring 45-item checklists or
 *   surfacing the "next question to ask". A parallel text-mode pass on
 *   the rolling transcript is much faster (~700ms-1.5s per pass) and
 *   produces better-grounded structured output.
 *
 * Pipeline
 *   main.js buffers transcript text → every TICK_MS ms, this module asks
 *   gemini-2.5-flash to (a) mark any newly-covered checklist items,
 *   (b) capture any newly-mentioned fields, (c) suggest the single most
 *   valuable next question. Function calls are routed back to main.js
 *   via the callbacks below.
 *
 * Extension points
 *   - To swap models (e.g. gemini-2.5-flash-lite), change COACH_MODEL.
 *   - To add a new structured output, declare another function in TOOLS
 *     and branch in _dispatch().
 *   - To change cadence under load, tweak TICK_MS or add an exponential
 *     backoff on errors.
 */

export const COACH_MODEL = 'gemini-2.5-flash';

const TICK_MS = 3500;

/* Stickiness window. A suggestion stays "active" for this long before the
 * coach is allowed to swap it for a new one — unless the seller addresses
 * it sooner (item gets marked covered) or presses → to skip. */
const SUGGESTION_TTL_MS = 12_000;

/* Skipped suggestions stay out of rotation for this long. After the TTL
 * expires the model is free to surface them again — important so the
 * rubric doesn't get permanently locked out by impatient skipping. */
const SKIPPED_TTL_MS = 60_000;

/* ────────────────────────────────────────────────────────────────────────
 * Tool declarations
 * ──────────────────────────────────────────────────────────────────────── */

const MARK_QUESTION_COVERED = {
  name: 'mark_question_covered',
  description:
    "Mark a rubric checklist item as observably covered in the transcript. Item ids are namespaced as '<pillarId>.<localId>'. Each item_id may be covered at most once per call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      item_id: { type: Type.STRING, enum: ITEM_IDS, description: "Namespaced item id, e.g. 'finance.annual_cost'." },
      evidence: { type: Type.STRING, description: 'Short quote or paraphrase (≤120 chars) from the transcript.' },
    },
    required: ['item_id', 'evidence'],
  },
};

const RECORD_FIELD = {
  name: 'record_field',
  description:
    "Record a captured key/value pair extracted from the transcript. Field ids are namespaced as '<group>.<localId>'. Calling again with the same field_id replaces the value.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      field_id: { type: Type.STRING, enum: FIELD_IDS },
      value: { type: Type.STRING, description: "Short display string for the value (e.g. '$2.4M ARR', '8 marketers, 3 sellers')." },
      evidence: { type: Type.STRING, description: 'Short quote or paraphrase (≤120 chars) from the transcript.' },
    },
    required: ['field_id', 'value', 'evidence'],
  },
};

const SUGGEST_NEXT_QUESTION = {
  name: 'suggest_next_question',
  description:
    'Suggest the single most valuable not-yet-covered rubric item for the seller to address next. Call EXACTLY ONCE per turn unless every item is covered.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      item_id: { type: Type.STRING, enum: ITEM_IDS, description: 'Namespaced item id that this question would surface.' },
      question: { type: Type.STRING, description: 'One-sentence question the seller could ask next, in the seller\'s voice.' },
      rationale: { type: Type.STRING, description: 'One-sentence explanation of why this is the highest-value next move.' },
    },
    required: ['item_id', 'question'],
  },
};

/* ────────────────────────────────────────────────────────────────────────
 * Coach
 * ──────────────────────────────────────────────────────────────────────── */

export class Coach {
  /**
   * @param {{
   *   apiKey: string;
   *   getContext: () => {
   *     transcriptWindow: string,
   *     coveredItemIds: string[],
   *     capturedFields: Record<string, { value: string }>,
   *     recentSellerTurns?: string[],
   *   };
   *   onItemCovered: (payload: { itemId: string, evidence: string }) => void;
   *   onFieldCaptured: (payload: { fieldId: string, value: string, evidence: string }) => void;
   *   onSuggestion: (payload: { itemId: string, question: string, rationale: string }) => void;
   *   onError?: (message: string) => void;
   *   tickMs?: number;
   * }} deps
   */
  constructor({ apiKey, getContext, onItemCovered, onFieldCaptured, onSuggestion, onError, tickMs }) {
    this.apiKey = apiKey;
    this.getContext = getContext;
    this.onItemCovered = onItemCovered;
    this.onFieldCaptured = onFieldCaptured;
    this.onSuggestion = onSuggestion;
    this.onError = onError || (() => {});
    this.tickMs = tickMs || TICK_MS;

    this.client = null;
    this.tickHandle = null;
    this.inFlight = false;
    this.lastTranscriptHash = '';
    this.state = 'idle'; // 'idle' | 'running' | 'stopped'

    /** Currently-pinned suggestion. Null until first suggestion is dispatched
     *  or after a skip / cover. Drives _shouldSuggest() gating. */
    this.lastSuggestion = null; // { itemId, at }

    /** itemId → timestamp it was skipped. Items in here are excluded from
     *  fresh suggestions until SKIPPED_TTL_MS has elapsed. */
    this.skippedItemIds = new Map();
  }

  start() {
    if (this.state === 'running') return;
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
    this.state = 'running';
    this.tickHandle = setInterval(() => this._tick(), this.tickMs);
    // Don't fire immediately — give the live session ~1s of warm-up so the
    // transcript buffer has something useful in it.
    setTimeout(() => this._tick(), Math.min(this.tickMs, 1500));
  }

  stop() {
    if (this.state !== 'running') return;
    this.state = 'stopped';
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Force the next tick to surface a brand-new suggestion. Called from
   * main when the seller presses → at the live edge of history.
   *
   * Semantics:
   *   - Stamp the current suggestion's itemId into the skip set so the
   *     model doesn't immediately re-suggest it.
   *   - Null out lastSuggestion so _shouldSuggest() returns true.
   *   - Trigger an immediate tick. If a tick is in-flight, the user
   *     waits for it to settle and the next tick (≤ TICK_MS later) will
   *     pick up the new state.
   */
  skip() {
    if (this.lastSuggestion?.itemId) {
      this.skippedItemIds.set(this.lastSuggestion.itemId, Date.now());
    }
    this.lastSuggestion = null;
    this._pruneSkipped();
    this._tick();
  }

  _pruneSkipped() {
    const cutoff = Date.now() - SKIPPED_TTL_MS;
    for (const [id, at] of this.skippedItemIds) {
      if (at < cutoff) this.skippedItemIds.delete(id);
    }
  }

  /** Should the next tick offer `suggest_next_question` to the model? */
  _shouldSuggest(coveredItemIds) {
    if (!this.lastSuggestion) return true;
    if (coveredItemIds.includes(this.lastSuggestion.itemId)) return true;
    if (Date.now() - this.lastSuggestion.at > SUGGESTION_TTL_MS) return true;
    return false;
  }

  async _tick() {
    if (this.state !== 'running' || this.inFlight) return;
    const ctx = this.getContext();
    if (!ctx || !ctx.transcriptWindow || ctx.transcriptWindow.length < 25) return;

    // Cheap dedup: if the transcript hasn't grown since the last successful
    // tick AND we don't have a pending decision about suggesting, skip.
    const hash = `${ctx.transcriptWindow.length}:${ctx.transcriptWindow.slice(-50)}`;
    const coveredItemIds = ctx.coveredItemIds || [];
    const wantSuggest = this._shouldSuggest(coveredItemIds);
    if (hash === this.lastTranscriptHash && !wantSuggest) return;

    this._pruneSkipped();

    // Build the per-tick tool list. Items + fields always available;
    // the suggest tool is gated on stickiness so the model isn't given
    // the option to rotate the current pinned suggestion before its TTL.
    const functionDeclarations = [MARK_QUESTION_COVERED, RECORD_FIELD];
    if (wantSuggest) functionDeclarations.push(SUGGEST_NEXT_QUESTION);

    this.inFlight = true;
    try {
      const stateBlock = formatCoachState({
        coveredItemIds,
        capturedFields: ctx.capturedFields || {},
        recentSellerTurns: ctx.recentSellerTurns || [],
        recentlySkippedIds: [...this.skippedItemIds.keys()],
      });

      const userText = [
        stateBlock,
        '',
        'TRANSCRIPT (most recent at the end):',
        ctx.transcriptWindow,
      ].join('\n');

      const result = await this.client.models.generateContent({
        model: COACH_MODEL,
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        config: {
          systemInstruction: COACH_SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations }],
          // Tool-call only; we don't render the coach's prose.
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        },
      });

      this._dispatchResult(result);
      this.lastTranscriptHash = hash;
    } catch (err) {
      const message = err?.message || 'Coach call failed';
      console.warn('[coach] tick failed:', message);
      this.onError(message);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Walk the response candidates' parts looking for functionCall entries,
   * route each one. Stays defensive about the response shape because the
   * SDK occasionally returns either functionCalls() helpers or raw parts
   * depending on version.
   */
  _dispatchResult(result) {
    /** @type {Array<{ name: string, args: any }>} */
    const calls = [];

    // Newer SDK: result.functionCalls is a getter returning an array.
    if (Array.isArray(result?.functionCalls)) {
      for (const c of result.functionCalls) calls.push({ name: c.name, args: c.args });
    }

    // Fallback: walk the parts on the first candidate.
    if (calls.length === 0) {
      const parts = result?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part?.functionCall) {
          calls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
        }
      }
    }

    for (const call of calls) {
      this._dispatchCall(call);
    }
  }

  _dispatchCall(call) {
    const args = call?.args || {};
    switch (call?.name) {
      case 'mark_question_covered': {
        const itemId = typeof args.item_id === 'string' ? args.item_id : null;
        if (!itemId) return;
        // If the seller just addressed the pinned suggestion, drop the
        // pin so the next tick is free to surface a fresh question
        // without waiting out the full 12s TTL.
        if (this.lastSuggestion?.itemId === itemId) this.lastSuggestion = null;
        this.onItemCovered({
          itemId,
          evidence: typeof args.evidence === 'string' ? args.evidence : '',
        });
        return;
      }
      case 'record_field': {
        const fieldId = typeof args.field_id === 'string' ? args.field_id : null;
        const value = typeof args.value === 'string' ? args.value : null;
        if (!fieldId || !value) return;
        this.onFieldCaptured({
          fieldId,
          value,
          evidence: typeof args.evidence === 'string' ? args.evidence : '',
        });
        return;
      }
      case 'suggest_next_question': {
        const itemId = typeof args.item_id === 'string' ? args.item_id : null;
        const question = typeof args.question === 'string' ? args.question : null;
        if (!itemId || !question) return;
        // Stamp the new pin so _shouldSuggest gates re-rotation until
        // the TTL elapses or the item gets covered.
        this.lastSuggestion = { itemId, at: Date.now() };
        this.onSuggestion({
          itemId,
          question,
          rationale: typeof args.rationale === 'string' ? args.rationale : '',
        });
        return;
      }
      default:
        console.warn('[coach] unknown tool:', call?.name);
    }
  }
}
