import { Type } from '@google/genai';
import {
  COACH_SYSTEM_INSTRUCTION,
  FIELD_IDS,
  ITEM_IDS,
  SUGGESTABLE_ITEM_IDS,
  SUGGESTION_SENTINEL_ITEM_IDS,
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
 *   main.js buffers transcript text → every TICK_MS ms, this module
 *   asks the configured provider (Gemini / Anthropic / OpenAI) to
 *   (a) update the lifecycle state of any checklist items that just
 *   changed (pending → in_progress → covered, or any item → logged),
 *   (b) capture any newly-mentioned fields, (c) ONLY when a request
 *   kind is queued, suggest the single most valuable next question.
 *   Function calls are routed back to main.js via the callbacks below.
 *
 * Provider routing
 *   The provider is constructed in main.js (via getProvider() in
 *   src/providers/index.js) and passed into the Coach constructor.
 *   The Coach itself is provider-agnostic: it authors the tool
 *   declarations in the Gemini-native FunctionDeclaration shape, and
 *   the provider class translates that into whichever SDK-specific
 *   format is required (Anthropic input_schema, OpenAI tools[].function
 *   parameters, …). The response shape is normalised by each provider
 *   into { toolCalls, text } so the dispatch path below stays the
 *   same regardless of which model answered.
 *
 * Suggestion behaviour (redesigned v2.5)
 *   Suggestions are PULL not PUSH. The `suggest_next_question` tool is
 *   only offered to the model when one of the following has fired
 *   (`requestSuggestion({ kind })`):
 *     - 'next'    — rep pressed the Suggest button (or skipped the pin)
 *     - 'deeper'  — rep pressed Deeper (follow up on last prospect turn)
 *     - 'pivot'   — rep pressed Pivot (change to an unrelated low-cov pillar)
 *     - 'pause'   — Automated mode's pause detector saw ≥6s of silence
 *   On every other tick, suggest_next_question is NOT in the tool list,
 *   so even an over-eager model can't surface a new suggestion. The
 *   rest of the pipeline (state tracking + field capture) keeps running
 *   on every tick — that part is passive feedback, not chatter.
 *
 * Extension points
 *   - To swap models per-provider, change the per-provider defaultModel
 *     in Settings → Providers; the Coach reads it via the provider
 *     instance.
 *   - To add a new structured output, declare another function in TOOLS
 *     and branch in _dispatchCall().
 *   - To add a new suggestion "kind", extend the union type in
 *     requestSuggestion and add a directive block in DIRECTIVES.
 *   - To change cadence under load, tweak TICK_MS or add an exponential
 *     backoff on errors.
 */

/**
 * Legacy default coach model — preserved as a named export for back-
 * compat (older code paths referenced this directly). The active
 * routing today lives in src/settings.js
 * (`providers.gemini.defaultModel`); this constant is only a
 * fallback for callers that haven't switched to the per-provider
 * model setting yet.
 */
export const COACH_MODEL = 'gemini-2.5-flash';

/* Cadence: every 1.5s the rolling transcript is re-scored for state
 * tracking + field capture. With pull-based suggestions the chatter
 * concern from v2 is gone — the cadence drives passive feedback only,
 * so 1.5s remains a reasonable choice. */
const TICK_MS = 1500;

/* Skipped suggestions stay out of rotation for this long. After the TTL
 * expires the model is free to surface them again — important so the
 * rubric doesn't get permanently locked out by impatient skipping. */
const SKIPPED_TTL_MS = 60_000;

/**
 * Per-kind DIRECTIVE block injected into the user message when the
 * corresponding request fires. The directive is the only handle the
 * model has on "this turn's bias" — the system prompt teaches the
 * rules for each kind; the directive flags which one is in play.
 */
const DIRECTIVES = {
  next: [
    'DIRECTIVE (this turn only):',
    '- mode: next',
    '- The seller has explicitly asked for a suggestion. Pick the single',
    '  most valuable not-yet-covered rubric item and write a question',
    '  for it in the seller\'s voice. Read the last 2-3 turns first to',
    '  make sure the suggestion fits the current beat; if the most',
    "  natural question is conversational rather than rubric, you may",
    "  still pick from the rubric — but only if it lands cleanly here.",
    '- Prefer BOOSTED items if any are listed in the rubric state.',
  ].join('\n'),
  deeper: [
    'DIRECTIVE (this turn only):',
    '- mode: deeper',
    '- The seller wants a follow-up on the most recent prospect turn(s).',
    '  Ignore the rubric checklist priorities for this suggestion — the',
    '  question should be a natural follow-up to what the prospect just',
    '  said. If the natural follow-up happens to map to a rubric item',
    "  id, use that id; otherwise use 'freeform.deeper'.",
  ].join('\n'),
  pivot: [
    'DIRECTIVE (this turn only):',
    '- mode: pivot',
    '- The seller wants to change topic to a different pillar entirely.',
    '  Pick a pillar with low coverage (few or no items covered) that',
    '  has NOT been touched in the recent transcript. Generate the',
    '  question and tag it with a REAL rubric item_id from that pillar',
    '  (do not use the freeform sentinel).',
  ].join('\n'),
  pause: [
    'DIRECTIVE (this turn only):',
    '- mode: pause',
    '- The conversation has gone quiet — the rep may be mid-thought or',
    '  both parties are paused. Same selection logic as `next`, but bias',
    '  toward a LOW-PRESSURE, easy-to-answer question (e.g. open',
    '  opening prompts, simple stage-of-business questions) rather than',
    '  a hard discovery dig. Choose a real rubric item id.',
    '- IMPORTANT: rationale rules from the system prompt still apply.',
    "  Do NOT write \"Now might be a good moment to…\" — that's a stage",
    '  direction. Write WHY this question is the right move RIGHT NOW',
    '  given the last beat of conversation.',
  ].join('\n'),
  recap: [
    'DIRECTIVE (this turn only):',
    '- mode: recap',
    '- The seller wants to recap what the prospect has discussed so far',
    '  in their OWN words, then check understanding. Pick the 2–4 most',
    '  recent prospect pain points / facts / themes from the transcript.',
    '- The transcript below covers only what was said since you last',
    '  asked a tracked question (or, on early-call recaps before any',
    '  question has been asked, the standard trailing window). Recap',
    '  ONLY from this window — earlier conversation is out of scope',
    "  because the rep has already moved past it.",
    '- The `question` field is the literal recap statement the seller',
    '  will speak aloud. Shape: "If I\'m hearing you right, you',
    '  mentioned X, Y, and Z — does that capture it?" or similar.',
    '  Adjust phrasing to feel natural.',
    '- Anchor must come from a recent prospect turn.',
    '- Use the freeform.recap sentinel for item_id.',
    '- Length budget: ≤40 words for the recap statement (slightly',
    '  longer than the normal 25-word cap because recaps need to',
    '  enumerate items).',
  ].join('\n'),
  targeted: [
    'DIRECTIVE (this turn only):',
    '- mode: targeted',
    '- The seller has explicitly asked for a question for a SPECIFIC',
    '  rubric item. The target item id is given as TARGETED_ITEM in',
    '  the user message. Pick that exact item — do NOT substitute',
    '  another. Write the literal sentence the seller will speak to',
    '  the prospect to elicit information for that item.',
    '- Rationale rules from the system prompt still apply (no stage',
    '  directions, explain WHY this question fits the moment).',
    '- Anchor on whichever speaker most recently moved the',
    '  conversation.',
  ].join('\n'),
  reformulate: [
    'DIRECTIVE (this turn only):',
    '- mode: reformulate',
    '- A previously-pinned suggestion has not been asked yet. The',
    '  TARGETED_ITEM line tells you which item id. Generate a FRESH',
    '  rewording of the same question — keep the intent identical but',
    '  vary the phrasing significantly (different sentence shape,',
    '  different anchor word, different angle).',
    '- Do NOT repeat the previous question word-for-word.',
    '- Rationale rules from the system prompt still apply.',
    '- Anchor on whichever speaker most recently moved the',
    '  conversation.',
  ].join('\n'),
};

/** Set of legal kind tokens for requestSuggestion. */
const VALID_KINDS = new Set(['next', 'deeper', 'pivot', 'pause', 'recap', 'targeted', 'reformulate']);

/* ────────────────────────────────────────────────────────────────────────
 * Tool declarations
 * ──────────────────────────────────────────────────────────────────────── */

/* The 4-state lifecycle (pending → in_progress → covered, plus the
 * branch state `logged` for partially-addressed items) is documented in
 * full in COACH_SYSTEM_INSTRUCTION in src/rubric.js. The model only
 * ever sets the three non-pending states; absence from the state map
 * IS pending. */
const ITEM_STATES = ['in_progress', 'covered', 'logged'];

const UPDATE_ITEM_STATE = {
  name: 'update_item_state',
  description:
    "Update the lifecycle state of a rubric checklist item based on transcript evidence. Item ids are namespaced as '<pillarId>.<localId>'. Call this whenever an item transitions between states; absence from the state map is implicit `pending`.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      item_id: { type: Type.STRING, enum: ITEM_IDS, description: "Namespaced item id, e.g. 'finance.annual_cost'." },
      state: { type: Type.STRING, enum: ITEM_STATES, description: "New state. 'in_progress' = seller is approaching; 'covered' = asked + answered + moved on (terminal positive); 'logged' = partially addressed but not closed out." },
      evidence: { type: Type.STRING, description: 'Short quote or paraphrase (≤120 chars) from the transcript supporting this transition.' },
      confidence: { type: Type.NUMBER, description: 'Confidence in this transition, 0-100. Below 40 should be rare — prefer not firing over firing low-confidence transitions.' },
    },
    required: ['item_id', 'state', 'evidence', 'confidence'],
  },
};

const RECORD_FIELD = {
  name: 'record_field',
  description:
    "Record a captured key/value pair extracted from the transcript. Field ids are namespaced as '<group>.<localId>'. Calling again with the same field_id replaces the value. Use this for non-aggregable text descriptors only; dollar amounts and other quantitative opportunity figures are handled by a separate background scanner — do NOT try to record them here.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      field_id: { type: Type.STRING, enum: FIELD_IDS },
      value: { type: Type.STRING, description: "Short display string for the value (e.g. '40% YoY', '8 marketers, 3 sellers')." },
      evidence: { type: Type.STRING, description: 'Short quote or paraphrase (≤120 chars) from the transcript.' },
    },
    required: ['field_id', 'value', 'evidence'],
  },
};

/*
 * NOTE — record_meeting_fact removed in post-test-call fixes batch 2.
 *
 * The Coach used to own a `record_meeting_fact` tool here that ran
 * every 1.5 s alongside item-state tracking and field capture. That
 * coupling produced the headline-wobble symptom: on every Coach tick
 * the model would re-classify duplicates and re-fire similar facts,
 * which the Stage-2 worker then re-summed differently each time.
 *
 * The new pipeline moves quantitative-fact extraction OUT of the
 * Coach into a dedicated Stage-1 scanner (src/facts-scanner.js) that
 * runs on its own cadence (~12 s) and appends directly to
 * `coachContext.factsSheet.entries`. The Coach is no longer in the
 * monetary-extraction business — its focus is back to rubric scoring
 * + ask suggestions + mark_question_asked.
 *
 * The system prompt in src/rubric.js has been updated accordingly
 * (the section describing record_meeting_fact has been replaced with
 * a "leave money to the scanner" note).
 */

const SUGGEST_NEXT_QUESTION = {
  name: 'suggest_next_question',
  description:
    'Suggest the next question for the seller to ask. Only call this when the tool is present in your tool list (the seller has asked for a suggestion, or a natural pause was detected in Automated mode). Read the last 2-3 transcript turns first and let the conversational beat — not the rubric checklist — drive the choice. An anchor_quote from the transcript is REQUIRED so the rep can see what the suggestion is responding to.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      item_id: {
        type: Type.STRING,
        // Strict allow-list: only items the model is allowed to surface as
        // a question. Excludes behaviour items like
        // `opening_agenda.intro_name_company` or
        // `questioning.open_ended` so the model can't return a meta
        // instruction like "Could you introduce yourself?" addressed at
        // the seller. Scoring (update_item_state) still uses the full
        // ITEM_IDS enum, so those items keep getting marked covered.
        enum: [...SUGGESTABLE_ITEM_IDS, ...SUGGESTION_SENTINEL_ITEM_IDS],
        description:
          "Namespaced rubric item id this question would surface (e.g. 'finance.annual_cost'), or the sentinel 'freeform.deeper' when the natural follow-up does not map to any rubric item — only legal in 'deeper' mode.",
      },
      question: {
        type: Type.STRING,
        description: "One-sentence question the seller could ask next, in the seller's voice.",
      },
      rationale: {
        type: Type.STRING,
        description: 'One-sentence explanation of why this is the best next move RIGHT NOW given the conversational beat.',
      },
      anchor_quote: {
        type: Type.STRING,
        description:
          'Short quote (≤120 chars) from the transcript showing the moment this suggestion is responding to — include the speaker label when it matters (e.g. \'Prospect: "we lose two days a week on this"\'). If you cannot find an anchor, do NOT call this tool.',
      },
    },
    required: ['item_id', 'question', 'anchor_quote'],
  },
};

/**
 * mark_question_asked — gated tool. Only present in the per-tick
 * declarations when (a) the user has Advanced → Track question state
 * toggled on AND (b) main has supplied at least one unresolved
 * suggestion in the PENDING SUGGESTIONS context block.
 *
 * Semantics: when the seller actually asks one of the previously-
 * pinned suggestions (with the same intent, even if the wording
 * differs), the model fires this tool with the suggestion's id +
 * a short evidence quote. Main flips the history entry's `asked`
 * flag to true and broadcasts the updated history to the renderer,
 * which surfaces the question with a green outline + tint under
 * the `logged_questions` synthetic pillar.
 */
const MARK_QUESTION_ASKED = {
  name: 'mark_question_asked',
  description:
    'Mark a previously-suggested question as actually asked by the seller, based on what was said in the transcript. Only call this when you can quote the seller asking the same intent (possibly with different words).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      suggestion_id: { type: Type.STRING, description: 'The id of the suggestion entry from the PENDING SUGGESTIONS list in the user message.' },
      evidence: { type: Type.STRING, description: 'The exact (or near-exact) quote (≤120 chars) from the transcript where the seller asked it.' },
    },
    required: ['suggestion_id', 'evidence'],
  },
};

/* ────────────────────────────────────────────────────────────────────────
 * Coach
 * ──────────────────────────────────────────────────────────────────────── */

export class Coach {
  /**
   * @param {{
   *   provider: { generateContent: Function, name?: string, model?: string };
   *   getContext: () => {
   *     transcriptWindow: string,
   *     itemStates: Record<string, { state: string, evidence?: string, confidence?: number, at?: number }>,
   *     capturedFields: Record<string, { value: string }>,
   *     recentSellerTurns?: string[],
   *   };
   *   onItemStateChange: (payload: { itemId: string, state: 'in_progress'|'covered'|'logged', evidence: string, confidence: number }) => void;
   *   onFieldCaptured: (payload: { fieldId: string, value: string, evidence: string }) => void;
   *   onSuggestion: (payload: { itemId: string, question: string, rationale: string, anchorQuote: string, kind: string }) => void;
   *   onMeetingFact?: (payload: { kind: string, amount: number, unit: string, period: string, basis: string, anchorQuote: string, supersedesId: string | null }) => void;
   *   onQuestionAsked?: (payload: { suggestionId: string, evidence: string }) => void;
   *   getSuggestionContext?: () => Array<{ id: string, itemId: string, questionText: string }>;
   *   onError?: (message: string) => void;
   *   onTickStart?: () => void;
   *   onTickEnd?: () => void;
   *   tickMs?: number;
   * }} deps
   *
   * `getSuggestionContext` is the Advanced → Track question state
   * integration point. Each tick the Coach asks main for the current
   * set of unresolved (not-yet-asked, not-replaced) suggestion entries.
   * When the array is non-empty, the Coach (a) includes the
   * `mark_question_asked` tool in this tick's declarations, and
   * (b) prepends a PENDING SUGGESTIONS context block to the user
   * message so the model knows which entries to check against the
   * transcript. Returning an empty array (or omitting the callback)
   * means the feature is disabled — neither the tool nor the block
   * appear in the prompt, and the model behaves exactly as before.
   *
   * `onQuestionAsked` is fired by `_dispatchCall` whenever the
   * model invokes `mark_question_asked`. Main updates the matching
   * history entry and re-broadcasts to the renderer.
   */
  constructor({ provider, getContext, onItemStateChange, onFieldCaptured, onSuggestion, onMeetingFact, onQuestionAsked, getSuggestionContext, onError, onTickStart, onTickEnd, tickMs }) {
    if (!provider || typeof provider.generateContent !== 'function') {
      throw new Error('Coach: provider with generateContent() is required');
    }
    this.provider = provider;
    this.getContext = getContext;
    this.onItemStateChange = onItemStateChange;
    this.onFieldCaptured = onFieldCaptured;
    this.onSuggestion = onSuggestion;
    // onMeetingFact is DEPRECATED as of post-test-call fixes batch 2.
    // The Coach no longer owns the `record_meeting_fact` tool — that
    // job moved to the Stage-1 scanner (src/facts-scanner.js), which
    // appends directly to coachContext.factsSheet.entries.
    //
    // The parameter is kept in the constructor signature (with a
    // no-op default) so older call sites that still pass it don't
    // throw. The dispatch path above ignores any stray
    // record_meeting_fact calls a stale model might still emit.
    this.onMeetingFact = onMeetingFact || (() => {});
    // Optional callbacks for the Advanced → Track question state
    // feature. Both default to no-ops so existing call sites that
    // don't supply them keep working.
    this.onQuestionAsked = onQuestionAsked || (() => {});
    this.getSuggestionContext = typeof getSuggestionContext === 'function'
      ? getSuggestionContext
      : () => [];
    this.onError = onError || (() => {});
    // Lifecycle hooks fire around each API-bound _tick() (no-op early
    // returns from dedup / minimum-transcript guards don't fire them).
    // The renderer uses these to surface a "thinking" indicator beside
    // the suggestion card.
    this.onTickStart = onTickStart || (() => {});
    this.onTickEnd = onTickEnd || (() => {});
    this.tickMs = tickMs || TICK_MS;

    this.tickHandle = null;
    this.inFlight = false;
    this.lastTranscriptHash = '';
    this.state = 'idle'; // 'idle' | 'running' | 'stopped'

    /**
     * Hash of the tick currently holding the `inFlight` slot.
     * Captured when a normal periodic tick starts an API call;
     * cleared when it finishes (in finally). A priority tick (Recap)
     * that bypasses the in-flight gate reads this value at landing
     * time to stamp `abandonedTickHash`, so the piggy-backed
     * periodic tick's response is dropped on arrival rather than
     * overlaying the priority tick's results.
     *
     * Empty string means no tick currently holds the slot.
     */
    this.inFlightHash = '';

    /**
     * When non-empty, marks a previously-in-flight tick's hash as
     * abandoned. When that tick's response lands, the dispatcher
     * checks `if (hash === this.abandonedTickHash)` and skips
     * dispatch entirely (idempotent — clears the marker after first
     * match). Set by a priority tick (Recap) immediately before its
     * own dispatch, so the rep sees the priority result rather than
     * a stale periodic-tick result that landed seconds later.
     */
    this.abandonedTickHash = '';

    /** Currently-pinned suggestion. Null until first suggestion is dispatched
     *  or after a skip / cover. A pin stays until either the rep skips it
     *  or the model marks its item covered — no time-based rotation. */
    this.lastSuggestion = null; // { itemId, at, kind }

    /** itemId → timestamp it was skipped. Items in here are excluded from
     *  fresh suggestions until SKIPPED_TTL_MS has elapsed. */
    this.skippedItemIds = new Map();

    /** itemIds the seller has asked the coach to resurface (typically by
     *  clicking a logged item in the Logged pillar). Consumed on the next
     *  tick — one-shot. Mirrors the skipped-set pattern. */
    this.boostedItemIds = new Set();

    /** One-shot request kind. Set by requestSuggestion / skip / boost;
     *  read at the top of _tick(); cleared once the tick has dispatched
     *  to the API successfully. While set, the next tick will include
     *  SUGGEST_NEXT_QUESTION in its tool list and prepend the matching
     *  DIRECTIVE block to the user message.
     *
     *  Values: null | 'next' | 'deeper' | 'pivot' | 'pause' |
     *          'recap' | 'targeted' */
    this.queuedSuggestionKind = null;

    /** Companion to queuedSuggestionKind for `targeted` asks: the
     *  rubric item id the seller wants a question generated for.
     *  Read by _tick() and appended to the user message as
     *  `TARGETED_ITEM: <id>` right after the DIRECTIVE block.
     *  Cleared once the tick has dispatched (one-shot, same lifecycle
     *  as queuedSuggestionKind). */
    this.queuedTargetedItemId = null;
  }

  start() {
    if (this.state === 'running') return;
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

  /* ── In-flight gate semantics (and why Recap feels slow without bypass)
   *
   * `_tick()` guards on `this.inFlight` so we never have two API
   * roundtrips outstanding at once. The trade-off the gate buys us
   * (predictable rate-limit + cost behaviour, no overlapping tool
   * dispatches racing on `coachContext.itemStates`) is also the
   * source of the "Recap is sometimes slow" complaint in test-call
   * note 5:
   *
   *   1. A periodic tick fires (passive state tracking + field
   *      capture, kind=null).
   *   2. The roundtrip lands at the provider — `inFlight = true`,
   *      typically a 700 ms – 1.5 s wait depending on prompt size
   *      and provider load.
   *   3. The rep clicks Recap. `requestSuggestion('recap')` calls
   *      `_tick()` synchronously, but the gate short-circuits
   *      because `inFlight` is true. The kind stays queued; the
   *      bypass below (D7) is what lets Recap jump the queue
   *      instead of waiting for step 2 to finish.
   *
   * For every kind EXCEPT `recap` the queueing is fine — `next` /
   * `deeper` / `pivot` are user-driven but conversational and the
   * latency budget can absorb up to one tick. Recap is different
   * because the rep clicks it at a beat boundary and expects the
   * statement on screen before they speak — even a 1 s queue feels
   * like a lag.
   *
   * D7 (priority bypass) sits in `_tick({ priority: true })`. The
   * "Recap in progress…" pill in the renderer covers the residual
   * provider-roundtrip latency the bypass can't eliminate.
   * ──────────────────────────────────────────────────────────────── */

  /**
   * Open a one-shot opportunity for the coach to fire
   * `suggest_next_question`. Called from main when:
   *   - the rep clicks one of the three ask buttons (Suggest / Deeper /
   *     Pivot) → kind 'next' | 'deeper' | 'pivot'
   *   - the rep clicks Recap → kind 'recap' (priority-bypasses the
   *     in-flight gate, see D7)
   *   - the pause detector fires in Automated mode → kind 'pause'
   *   - the rep clicks a per-item `+ Ask` button (or the rail's
   *     "Cover remaining" queue advances) → kind 'targeted' with an
   *     accompanying `itemId`
   *
   * Semantics:
   *   - Stamp the currently-pinned suggestion's itemId into the skip set
   *     so the model doesn't immediately re-suggest it (the rep is
   *     moving on regardless of which kind they asked for).
   *   - Null out lastSuggestion so the new suggestion can take the pin.
   *   - Queue the kind. The next tick (immediately or up to one
   *     `tickMs` later) reads it, includes the suggest tool in its
   *     declarations, and prepends the matching DIRECTIVE block to the
   *     user message.
   *   - For `targeted`, also stash the requested itemId so _tick() can
   *     append a `TARGETED_ITEM: <id>` line after the DIRECTIVE.
   *   - Trigger an immediate tick. If a tick is in-flight, the kind
   *     stays queued and the next tick picks it up — UNLESS kind ===
   *     'recap', which sets `priority: true` and short-circuits the
   *     in-flight gate so the recap fires immediately. The in-flight
   *     periodic tick's response is abandoned (its hash is stamped
   *     into `abandonedTickHash` so its result is ignored when it
   *     lands). Safe because Recap is explicitly user-initiated.
   *
   * Idempotent: calling repeatedly with the same kind keeps the latest
   * one. Calling with different kinds back-to-back overwrites the
   * earlier — the rep's most recent click wins.
   */
  requestSuggestion({ kind, itemId } = {}) {
    const normalised = typeof kind === 'string' && VALID_KINDS.has(kind) ? kind : 'next';
    // Stamp the previous pin's itemId into the skip set so the model
    // doesn't immediately re-suggest it on the next tick.
    //
    // EXCEPTION: reformulate. The whole point is to re-suggest the
    // SAME item with a fresh wording, so stamping it into the skipped
    // set would (a) hide the candidate from the prompt's
    // formatCoachState block and (b) confuse the model about why a
    // recently-skipped item is being targeted. We deliberately skip
    // the stamp for reformulate so the next tick can land on the
    // same item with a new phrasing.
    if (this.lastSuggestion?.itemId && normalised !== 'reformulate') {
      this.skippedItemIds.set(this.lastSuggestion.itemId, Date.now());
    }
    this.lastSuggestion = null;
    this._pruneSkipped();
    this.queuedSuggestionKind = normalised;
    // Carry the requested itemId for the two kinds that need it:
    //   - 'targeted'    — seller asked for a question for this exact
    //                     rubric id (per-item Ask button, Cover
    //                     remaining queue).
    //   - 'reformulate' — main's 10s timer wants a fresh wording for
    //                     the previously-pinned item. The directive
    //                     block tells the model to rephrase rather
    //                     than re-select.
    // Other kinds clear the slot so a stale id can't leak into the
    // next tick's directive.
    if ((normalised === 'targeted' || normalised === 'reformulate') && typeof itemId === 'string' && itemId) {
      this.queuedTargetedItemId = itemId;
    } else {
      this.queuedTargetedItemId = null;
    }
    // Recap clicks bypass the in-flight gate so the rep's click latency
    // is bounded by the provider roundtrip alone (no waiting for a
    // periodic tick to finish first). See the in-flight-gate doc-block
    // above for why this kind is the only one that gets the bypass.
    const priority = normalised === 'recap';
    this._tick({ priority });
  }

  /**
   * Force the next tick to surface a brand-new 'next'-kind suggestion.
   * Equivalent to requestSuggestion({ kind: 'next' }) — kept as a
   * standalone method because the IPC channel and renderer plumbing
   * already use the name `skip` and the spec preserves its semantics.
   */
  skip() {
    this.requestSuggestion({ kind: 'next' });
  }

  /**
   * Ask the coach to prioritise an item in its next suggestion. Called
   * from main when the seller clicks a logged item in the Logged
   * pillar. The id is stamped into a one-shot boost queue that's read
   * by formatCoachState() on the next tick and cleared after dispatch.
   *
   * Like skip(), this enqueues a 'next'-kind request so the suggestion
   * tool is actually offered to the model on the next tick.
   */
  boost(itemId) {
    if (typeof itemId !== 'string' || !itemId) return;
    this.boostedItemIds.add(itemId);
    this.lastSuggestion = null;
    this.queuedSuggestionKind = 'next';
    this._tick();
  }

  /**
   * True iff there is a currently-pinned suggestion. Used by the main
   * process's pause detector to gate "fire a pause suggestion" — we
   * don't want to overwrite a live pin just because the room went
   * quiet.
   */
  hasPinnedSuggestion() {
    return Boolean(this.lastSuggestion);
  }

  _pruneSkipped() {
    const cutoff = Date.now() - SKIPPED_TTL_MS;
    for (const [id, at] of this.skippedItemIds) {
      if (at < cutoff) this.skippedItemIds.delete(id);
    }
  }

  /** Should the next tick offer `suggest_next_question` to the model?
   *  Pull-only: a kind must be queued. State tracking + field capture
   *  still run every tick because those are passive feedback. */
  _shouldSuggest() {
    return this.queuedSuggestionKind !== null;
  }

  async _tick({ priority = false } = {}) {
    // Priority ticks (Recap) bypass the in-flight gate so the rep's
    // click latency isn't bounded by an unrelated periodic tick that's
    // mid-roundtrip. The bypassed periodic tick's response is dropped
    // when it lands (see abandonedTickHash check below). Non-priority
    // ticks still queue behind in-flight as before — the gate is the
    // load-bearing constraint that prevents overlapping periodic
    // tool dispatches racing on shared coachContext state.
    if (this.state !== 'running') return;
    if (!priority && this.inFlight) return;
    const ctx = this.getContext();
    if (!ctx || !ctx.transcriptWindow || ctx.transcriptWindow.length < 25) return;

    // itemStates is the source of truth for the coach prompt's "what's
    // already covered" block; main.js mirrors it from the dispatched
    // updates we send back.
    const itemStates = ctx.itemStates || {};

    // Cheap dedup: if the transcript hasn't grown since the last successful
    // tick AND we don't have a queued suggestion request, skip the API
    // call entirely. The transcript-hash dedup keeps the model from
    // re-scoring the same window repeatedly during quiet stretches.
    const hash = `${ctx.transcriptWindow.length}:${ctx.transcriptWindow.slice(-50)}`;
    const requestedKind = this.queuedSuggestionKind;
    const wantSuggest = requestedKind !== null;
    if (hash === this.lastTranscriptHash && !wantSuggest) return;

    this._pruneSkipped();

    // Snapshot the boost queue for this tick. Cleared after dispatch
    // (one-shot semantics) regardless of whether the model actually
    // surfaced the boosted item — if it doesn't pick one up on the
    // next call, the seller can click again.
    const boostedThisTick = [...this.boostedItemIds];

    // Pull the current unresolved suggestion entries (Advanced →
    // Track question state). Empty array means the feature is off
    // OR there's nothing to check this tick; either way we skip the
    // tool + context block.
    const pendingSuggestions = (() => {
      try {
        const out = this.getSuggestionContext();
        return Array.isArray(out) ? out : [];
      } catch (err) {
        console.warn('[coach] getSuggestionContext threw:', err?.message || err);
        return [];
      }
    })();
    const wantMarkAsked = pendingSuggestions.length > 0;

    // Build the per-tick tool list. Items + fields are always
    // available; the suggest tool is included ONLY when a request
    // kind is queued so the model has no way to spontaneously rotate
    // suggestions. mark_question_asked is gated separately — it's
    // only useful when there are unresolved pending suggestions to
    // validate against.
    //
    // record_meeting_fact USED to live here but moved out to a
    // dedicated Stage-1 scanner (src/facts-scanner.js) — see the
    // doc-block above the now-removed RECORD_MEETING_FACT constant
    // for the rationale. The Coach no longer participates in
    // monetary fact extraction.
    const functionDeclarations = [UPDATE_ITEM_STATE, RECORD_FIELD];
    if (wantSuggest) functionDeclarations.push(SUGGEST_NEXT_QUESTION);
    if (wantMarkAsked) functionDeclarations.push(MARK_QUESTION_ASKED);

    // Concurrency model:
    //   - Normal periodic ticks are mutually exclusive — only one
    //     can hold the `inFlight` slot at a time.
    //   - A priority tick that bypassed the gate doesn't claim the
    //     slot; the existing in-flight normal tick still owns it.
    //     This keeps `inFlight` semantically "is a normal tick in
    //     progress?" and avoids racing the finally-block clear when
    //     the priority and normal ticks complete out of order.
    //   - A priority tick that found `inFlight` already false (i.e.
    //     no normal tick is running) DOES claim the slot, so a
    //     periodic tick arriving while the recap is in flight will
    //     still queue politely behind it.
    const isConcurrent = priority && this.inFlight;
    if (!isConcurrent) {
      this.inFlight = true;
      this.inFlightHash = hash;
    }
    this.onTickStart();
    try {
      const stateBlock = formatCoachState({
        itemStates,
        capturedFields: ctx.capturedFields || {},
        recentSellerTurns: ctx.recentSellerTurns || [],
        recentlySkippedIds: [...this.skippedItemIds.keys()],
        boostedItemIds: boostedThisTick,
      });

      // Prepend the per-kind directive when a suggestion is queued so
      // the model has explicit, turn-scoped guidance on which selection
      // logic to apply (next vs deeper vs pivot vs pause vs targeted vs
      // reformulate). For `targeted` and `reformulate`, append a
      // TARGETED_ITEM line right after the directive so the model
      // knows which exact rubric id to honour.
      const parts = [stateBlock];

      if (wantMarkAsked) {
        const lines = ['', 'PENDING SUGGESTIONS (not yet asked):'];
        for (const entry of pendingSuggestions) {
          if (!entry || typeof entry.id !== 'string') continue;
          const itemId = typeof entry.itemId === 'string' ? entry.itemId : '(unknown)';
          const questionText = typeof entry.questionText === 'string' ? entry.questionText : '';
          // The triple-id render keeps the prompt scannable. The
          // model just needs the `id` to fire mark_question_asked;
          // the `item` and `question` provide enough surface for
          // intent-matching against the transcript.
          lines.push(`- id: ${entry.id}, item: ${itemId}, question: "${questionText}"`);
        }
        parts.push(...lines);
      }

      const targetedItemId = this.queuedTargetedItemId;
      if (wantSuggest) {
        parts.push('', DIRECTIVES[requestedKind] || DIRECTIVES.next);
        if ((requestedKind === 'targeted' || requestedKind === 'reformulate') && targetedItemId) {
          parts.push(`TARGETED_ITEM: ${targetedItemId}`);
        }
      }

      // For Recap kind, swap the standard trailing window for the
      // "since last asked question" slice that main computes alongside
      // the snapshot. Falls back to the standard window automatically
      // when no question has been asked yet (see getRecapWindow in
      // main.js for the fallback contract) — so this branch never
      // sends an empty transcript to the model.
      //
      // The Coach stays decoupled from main's history map by reading
      // through ctx.recapWindow rather than walking suggestionHistory
      // directly. If a future tick wants the "since last X" pattern
      // for another kind, the snapshot grows another field.
      let transcriptForPrompt = ctx.transcriptWindow;
      if (requestedKind === 'recap' && ctx.recapWindow && Array.isArray(ctx.recapWindow.lines)) {
        const recapLines = ctx.recapWindow.lines;
        if (recapLines.length > 0) {
          transcriptForPrompt = recapLines.join('\n');
        }
      }
      parts.push('', 'TRANSCRIPT (most recent at the end):', transcriptForPrompt);
      const userText = parts.join('\n');

      const result = await this.provider.generateContent({
        systemInstruction: COACH_SYSTEM_INSTRUCTION,
        tools: functionDeclarations,
        userMessage: userText,
      });

      // Abandonment check (D7): a priority Recap tick may have
      // bypassed our in-flight gate and stamped our hash as abandoned.
      // Skip dispatch entirely so the priority tick's results aren't
      // overlaid by our (now-stale) periodic result. One-shot: clear
      // the marker after the first match so a subsequent unrelated
      // tick with the same hash isn't accidentally suppressed.
      if (this.abandonedTickHash && hash === this.abandonedTickHash) {
        this.abandonedTickHash = '';
        console.log('[coach] tick abandoned (preempted by priority recap)');
        return;
      }

      // If THIS is a concurrent priority tick (Recap bypassing an
      // in-flight normal tick), stamp the periodic tick's hash as
      // abandoned BEFORE we dispatch. When the periodic tick lands
      // its abandonment guard above will see the match and skip its
      // own dispatch — so the rep sees only our Recap result, not a
      // delayed periodic-tick result piling on a second later.
      if (isConcurrent && this.inFlightHash && this.inFlightHash !== hash) {
        this.abandonedTickHash = this.inFlightHash;
      }

      this._dispatchResult(result, { suggestionKind: requestedKind });
      this.lastTranscriptHash = hash;
      // One-shot: drop any boost ids we surfaced to the model this turn.
      for (const id of boostedThisTick) this.boostedItemIds.delete(id);
      // Clear the queued kind only on success. If the API call threw we
      // leave it in place so the next tick retries. The companion
      // queuedTargetedItemId travels with the kind — also one-shot.
      if (this.queuedSuggestionKind === requestedKind) {
        this.queuedSuggestionKind = null;
        if (
          (requestedKind === 'targeted' || requestedKind === 'reformulate') &&
          this.queuedTargetedItemId === targetedItemId
        ) {
          this.queuedTargetedItemId = null;
        }
      }
    } catch (err) {
      const message = err?.message || 'Coach call failed';
      console.warn('[coach] tick failed:', message);
      this.onError(message);
    } finally {
      // Only release the in-flight slot if we claimed it. A concurrent
      // priority tick that bypassed the gate doesn't own the slot —
      // releasing it here would prematurely let a NEW periodic tick
      // fire while the original normal tick is still in flight.
      if (!isConcurrent) {
        this.inFlight = false;
        this.inFlightHash = '';
      }
      this.onTickEnd();
    }
  }

  /**
   * Route every tool call surfaced by the provider through the
   * per-tool dispatcher. The provider abstraction has already
   * normalised the SDK-specific response shape into
   * `{ toolCalls: Array<{ name, args }>, text }`, so we just walk
   * the array. The `text` field is currently unused by the Coach —
   * we only render structured tool output.
   *
   * @param {{ toolCalls?: Array<{ name: string, args: any }>, text?: string }} result
   * @param {object} [meta]  Per-tick metadata threaded through to
   *                         the call dispatcher (currently just the
   *                         suggestion kind so the renderer can
   *                         render the appropriate "ask kind" badge).
   */
  _dispatchResult(result, meta = {}) {
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    for (const call of calls) {
      this._dispatchCall(call, meta);
    }
  }

  _dispatchCall(call, meta = {}) {
    const args = call?.args || {};
    switch (call?.name) {
      case 'update_item_state': {
        const itemId = typeof args.item_id === 'string' ? args.item_id : null;
        const nextState = typeof args.state === 'string' ? args.state : null;
        if (!itemId || !nextState) return;
        // Defensive: only allow the three model-settable states.
        if (nextState !== 'in_progress' && nextState !== 'covered' && nextState !== 'logged') {
          console.warn('[coach] ignoring invalid state:', nextState);
          return;
        }
        // If the seller just addressed the pinned suggestion (item
        // transitioned to `covered`), drop the pin so a future request
        // for a new suggestion isn't blocked by stale state.
        if (nextState === 'covered' && this.lastSuggestion?.itemId === itemId) {
          this.lastSuggestion = null;
        }
        // Clamp confidence into [0, 100]. The model occasionally returns
        // strings or out-of-range numbers; main needs a clean value.
        let confidence = Number(args.confidence);
        if (!Number.isFinite(confidence)) confidence = 50;
        confidence = Math.max(0, Math.min(100, confidence));
        this.onItemStateChange({
          itemId,
          state: nextState,
          evidence: typeof args.evidence === 'string' ? args.evidence : '',
          confidence,
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
      case 'record_meeting_fact': {
        // Defensive ignore. record_meeting_fact was removed from the
        // Coach's tool declarations in batch 2 (the Stage-1 scanner
        // in src/facts-scanner.js owns this now), but a stale model
        // that has the tool description cached in its context may
        // still try to emit a call. Drop silently rather than route
        // through the deprecated onMeetingFact callback.
        console.warn('[coach] dropping deprecated record_meeting_fact call (now scanner-owned)');
        return;
      }
      case 'suggest_next_question': {
        // Belt-and-braces SIGNALLED-mode gate (Issue 2 of post-test-
        // call fixes batch 2): the tool is conditionally added to
        // `functionDeclarations` only when `wantSuggest` was true for
        // this tick, but a provider that ignores the declarations
        // filter — or a future model trained to fire tools mentioned
        // in the system prompt regardless of declarations — could
        // still emit this call. `meta.suggestionKind` is non-null
        // ONLY when `_tick()` ran with a queued kind, so it's the
        // authoritative signal that this dispatch is legitimate.
        // Dropping unsolicited calls here keeps Signalled mode
        // strictly silent (acceptance criterion: zero
        // coach:suggestion IPC events during a 60 s idle test).
        if (!meta.suggestionKind) {
          console.warn(
            '[coach] dropping unsolicited suggest_next_question (no queued kind — signalled-mode gate)',
            typeof args.item_id === 'string' ? args.item_id : '',
          );
          return;
        }
        const itemId = typeof args.item_id === 'string' ? args.item_id : null;
        const question = typeof args.question === 'string' ? args.question : null;
        const anchorQuote = typeof args.anchor_quote === 'string' ? args.anchor_quote.trim() : '';
        if (!itemId || !question) return;
        // Anchor-quote gating: the new prompt instructs the model to
        // stay silent rather than guess. Belt-and-brace at the
        // dispatcher so a model that ignored the rule can't surface a
        // generic suggestion. The renderer expects this field.
        if (!anchorQuote) {
          console.warn('[coach] dropping suggestion (missing anchor_quote):', itemId, '—', question);
          return;
        }
        // Stamp the new pin. Pull-based: the pin holds until the rep
        // explicitly asks for a new one (skip / Suggest / Deeper /
        // Pivot) or the model marks the item covered.
        this.lastSuggestion = { itemId, at: Date.now(), kind: meta.suggestionKind };
        this.onSuggestion({
          itemId,
          question,
          rationale: typeof args.rationale === 'string' ? args.rationale : '',
          anchorQuote,
          kind: meta.suggestionKind,
        });
        return;
      }
      case 'mark_question_asked': {
        const suggestionId = typeof args.suggestion_id === 'string' ? args.suggestion_id : null;
        const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
        if (!suggestionId || !evidence) {
          console.warn('[coach] dropping mark_question_asked (missing id or evidence)');
          return;
        }
        // Forward to main, which owns the suggestionHistory map.
        // Validation of "did the suggestion id exist?" happens there
        // — a hallucinated id is a no-op rather than an error so
        // the model's tick keeps flowing.
        this.onQuestionAsked({ suggestionId, evidence });
        return;
      }
      default:
        console.warn('[coach] unknown tool:', call?.name);
    }
  }
}
