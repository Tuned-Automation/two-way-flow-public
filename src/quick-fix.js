/**
 * Stage 2 of the three-step AI facts pipeline (post-test-call fixes
 * batch 2 / Issue 3 — quick-fix wobble rearchitecture).
 *
 * Pipeline overview
 *
 *     Stage 0 — transcript                (src/main.js)
 *           ↓
 *     Stage 1 — facts scanner             (src/facts-scanner.js)
 *           ↓ append per fact
 *     coachContext.factsSheet.entries
 *           ↓ scheduleQuickFix()
 *     Stage 2 — quick-fix roller          (this module)
 *           ↓ dedupe + sum (NOT free-think)
 *     coachContext.factsSheet.quickFix
 *           ↓ scoring:quick-fix IPC
 *     #quickFix card in the renderer
 *
 * This module owns:
 *
 *   1. A single debounce timer (~2.5 s after the last fact write) so
 *      a flurry of facts from the Stage-1 scanner triggers ONE
 *      Stage-2 roundtrip when things settle.
 *
 *   2. A DEDUPE-AND-SUM-ONLY prompt. The Stage-2 model is no longer
 *      allowed to free-think the rollup on every pass; the prompt's
 *      explicit job is "look at this list of facts + the previous
 *      headline, identify overlaps, sum the unique ones, and produce
 *      a new headline that NEVER DECREASES unless a `correction: true`
 *      entry is present". This eliminates the wobble that the prior
 *      "convert and roll up" prompt produced (model re-classifying
 *      duplicates, dropping facts on later passes, non-deterministic
 *      sums).
 *
 *   3. Code-side monotonic enforcement (`enforceMonotonicConstraint`
 *      below). Even if the model produces a smaller headline without
 *      a justified reason, we REJECT the response: keep the previous
 *      rollup, mark it `stale: true`, and surface the "Rollup
 *      paused, retrying…" pill. The 3-strikes failure counter
 *      escalates to `error: true` if the model keeps trying to
 *      decrease unjustifiably.
 *
 *      Acceptance criteria for a decrease:
 *        (a) the active entries include at least one entry whose
 *            `correction` flag is true, OR
 *        (b) the response includes a non-empty `correctionReason`
 *            string explaining the drop.
 *
 *      Either condition is sufficient. The flag-based path is the
 *      common case (Stage-1 caught an explicit correction), the
 *      reason-string path is a model escape hatch for legitimate
 *      "dedupe revealed a double-count" rectifications.
 *
 *   4. A last-known-good fallback: a malformed Stage-2 response
 *      leaves the previous rollup intact, surfaces `stale: true`, and
 *      bumps the failure counter. After 3 consecutive failures we
 *      surface `error: true`. Reset to false on the next valid
 *      response.
 *
 *   5. `cancelPendingRollup()` so `teardownSession()` can cancel a
 *      debounced timer if the user stops the call before it fires.
 *
 * The worker reads `factsSheet.entries` via the getter passed in at
 * construction time so it never holds a shared mutable reference. A
 * reset on the source (`resetCoachContext` clears `factsSheet`) is
 * therefore safe — the worker's next read sees the cleared state
 * and produces an empty rollup or skips entirely.
 *
 * Provider routing: the Stage-2 provider is constructed at run time
 * via `getQuickFix()` from settings.js, which cascades the
 * `quickFix.provider` / `quickFix.model` overrides over the coach's
 * routed provider. The Stage-1 scanner shares the same routing so
 * both AI passes belong to the same "background financial analyst"
 * workflow.
 *
 * Extension points
 *   - To make the debounce cadence configurable, plumb the value
 *     through `createQuickFixRoller({ debounceMs })` — the consumer
 *     in main.js can read it from settings.coach.* once Phase 4 of
 *     the Settings expansion lands the timing knobs.
 *   - To support multi-currency, extend the prompt + schema to
 *     accept a target currency parameter; the validator already
 *     keeps a `currency` field on the result (always "USD" for v1).
 *   - To relax the monotonic constraint (e.g. allow a decrease when
 *     the call enters a "scope reduction" mode), gate
 *     `enforceMonotonicConstraint` on a new context flag passed in
 *     via the deps.
 */

import { getProvider } from './providers/index.js';
import { getQuickFix, getApiKey } from './settings.js';

/* Debounce window between the last factsSheet write and the Stage-2
 * roundtrip. 2.5 s is the sweet spot per the plan — short enough that
 * a deliberate single fact triggers a roll-up within the same beat of
 * the conversation, long enough that a flurry of related facts
 * coalesces into one roundtrip. Calibrate via the constructor arg
 * (debounceMs) once we have telemetry on real call cadence. */
const DEFAULT_DEBOUNCE_MS = 2_500;

/* Consecutive Stage-2 failures before we surface the `error: true`
 * flag on the rollup. Three is forgiving enough to absorb a single
 * malformed response from a temporary model glitch but tight enough
 * that a sustained provider outage doesn't go silent. Reset on the
 * next valid response. */
const ERROR_THRESHOLD = 3;

/* Stage-2 system prompt. Sent as-is to the configured provider; the
 * Gemini path uses `responseMimeType: 'application/json'` so the
 * model returns parseable JSON without prose preamble. Anthropic /
 * OpenAI paths fall through to the same prompt — both honour the
 * "return JSON only" instruction reliably for structured-output
 * tasks of this size.
 *
 * Crucially, this prompt is DEDUPE-AND-SUM only — it does NOT free-
 * think the rollup on every pass. The wobble that surfaced in the
 * post-test-call review came from the previous "convert and roll up"
 * prompt giving the model latitude to re-classify duplicates, drop
 * facts on later passes, and produce different numbers per call. The
 * job here is mechanical:
 *
 *   1. Walk the FACTS list, ignore the superseded ones, identify
 *      duplicates / overlaps within the remaining list.
 *   2. Sum the unique annualised amounts to produce
 *      `headlineUsdAnnual`.
 *   3. NEVER produce a headline LESS than `previousHeadlineUsdAnnual`
 *      unless either (a) the FACTS list contains an entry with
 *      `correction: true`, or (b) a top-level `correctionReason`
 *      string is set explaining the drop. Code-side enforcement
 *      catches any model that ignores this rule. */
const STAGE2_SYSTEM_PROMPT = [
  'You are a financial analyst supporting a live sales conversation.',
  'You receive (a) a JSON array of discrete, AI-extracted financial facts',
  'from a call in progress, and (b) the previously-accepted headline',
  'total. Your job is narrowly scoped:',
  '',
  '  1. DEDUPE the facts. Identify overlaps where two entries describe',
  '     the same underlying dollar stream from different angles',
  '     ("we spend $50K on consultants" + "consulting line item is',
  '     $4K/mo") and keep only ONE in the sum. Mention dropped',
  '     duplicates in `assumptions`.',
  '  2. IGNORE facts whose id appears in the `supersedes` field of a',
  '     newer fact — those entries have been replaced.',
  '  3. ANNUALISE each remaining fact to USD and SUM them to produce',
  '     `headlineUsdAnnual`. Conversions when the unit is not USD:',
  '       - hours/week × 52 × stated_hourly_rate_if_known (else note',
  '         "rate not stated" and carry the row at $0).',
  '       - hours/month × 12 × stated_hourly_rate_if_known.',
  '       - people × stated_loaded_cost_per_person (else note',
  '         "loaded cost not stated").',
  '       - percent → only meaningful applied to a base; treat as a',
  '         multiplier on a stated revenue/spend, otherwise carry as',
  '         a note at $0.',
  '       - period "one_time" → leave as-is, do NOT annualise; note',
  '         "one-time" in the row.',
  '  4. Each breakdown row must cite the source fact\'s `id` so the UI',
  '     can drill through to the anchor quote. Use the literal string',
  '     "derived" only when a row is the sum of two facts (the dedupe',
  '     winner).',
  '  5. Confidence rubric:',
  '       - high   → all facts have explicit amounts/units/periods,',
  '                  ≤1 inferred conversion, no unresolved duplicates.',
  '       - medium → 1-2 inferred conversions OR 1 likely double-count.',
  '       - low    → >2 inferences, OR >1 unresolved double-count, OR',
  '                  contradictory facts.',
  '',
  '*** MONOTONIC CONSTRAINT (LOAD-BEARING) ***',
  '',
  '  The headline total MUST NOT DECREASE compared to the previous',
  '  accepted headline (provided in the user message as',
  '  `previousHeadlineUsdAnnual`) UNLESS one of these is true:',
  '',
  '    (a) AT LEAST ONE entry in the FACTS list has `correction: true`',
  '        (the Stage-1 scanner caught an explicit revision like',
  '        "actually it\'s closer to $80K not $50K"), OR',
  '',
  '    (b) you set a top-level `correctionReason` string in the',
  '        response explaining WHY a decrease is justified (e.g. a',
  '        dedupe pass uncovered a previously-missed double-count',
  '        worth $X).',
  '',
  '  If neither condition holds, KEEP the previous headline value.',
  '  Code-side enforcement will REJECT a smaller headline with neither',
  '  (a) nor (b) — producing one will mark the rollup card stale until',
  '  the next tick. The rule is "add-only by default"; corrections',
  '  are the ONLY exception.',
  '',
  '  If a `correction: true` entry IS present, you SHOULD adjust the',
  '  headline accordingly (the prospect explicitly revised a figure).',
  '',
  '6. Return JSON only, matching the schema. No prose outside the JSON.',
  '   Omit `correctionReason` (or set it to null) when there is no',
  '   correction in play — populating it with empty/filler text would',
  '   bypass the monotonic constraint.',
].join('\n');

/**
 * JSON Schema for the Stage-2 response. Used by the Gemini provider
 * via `responseSchema` for native structured-output enforcement; other
 * providers see the same shape encoded as natural-language constraints
 * in the system prompt. The validator below is the authoritative
 * runtime check regardless of provider.
 *
 * Gemini-style Type constants would normally come from `@google/genai`
 * (uppercase strings); kept as plain lowercase here because the
 * provider abstraction translates between schemas, and the validator
 * doesn't read this object at all.
 */
const STAGE2_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headlineUsdAnnual: {
      type: 'NUMBER',
      description: 'Total annual USD opportunity rolled up from all active facts.',
    },
    breakdown: {
      type: 'ARRAY',
      description: 'Per-fact (or derived) breakdown rows that sum to the headline (modulo deliberate double-count discounting).',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', description: 'Short row label, ≤80 chars.' },
          amountUsdAnnual: { type: 'NUMBER', description: 'Row contribution to the headline in annual USD.' },
          source: { type: 'STRING', description: 'Source fact id from the input, OR the literal string "derived".' },
          notes: { type: 'STRING', description: '≤120 chars; may be empty.' },
        },
        required: ['label', 'amountUsdAnnual', 'source'],
      },
    },
    assumptions: {
      type: 'ARRAY',
      description: '0..5 short assumption strings, ≤120 chars each.',
      items: { type: 'STRING' },
    },
    confidence: {
      type: 'STRING',
      enum: ['low', 'medium', 'high'],
    },
    currency: {
      type: 'STRING',
      description: 'For v1 always "USD".',
    },
    correctionReason: {
      type: 'STRING',
      description:
        'Optional. Required by the monotonic-constraint enforcer ONLY when the new headline is LESS than the previous AND no entry in the active list has correction:true. Leave empty / omit otherwise — populating it without a real reason will not bypass the enforcer.',
    },
  },
  required: ['headlineUsdAnnual', 'breakdown', 'assumptions', 'confidence'],
};

/**
 * Hand-rolled validator (per the plan — no new npm dep). The
 * validator's job is to keep a malformed response from corrupting the
 * UI; it does NOT check that the breakdown sums to the headline
 * because the model is deliberately allowed to discount for
 * double-counts. That's the whole point of having an AI rollup.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` with
 * a short failure code. The caller logs the reason + the raw payload
 * for debugging when validation fails.
 *
 * @param {unknown} raw  Parsed JSON from the Stage-2 model.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateQuickFix(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_an_object' };
  if (typeof raw.headlineUsdAnnual !== 'number'
      || raw.headlineUsdAnnual < 0
      || !Number.isFinite(raw.headlineUsdAnnual)) {
    return { ok: false, reason: 'bad_headline' };
  }
  if (!Array.isArray(raw.breakdown)) return { ok: false, reason: 'breakdown_not_array' };
  for (const row of raw.breakdown) {
    if (!row || typeof row !== 'object') return { ok: false, reason: 'row_not_object' };
    if (typeof row.label !== 'string' || !row.label) return { ok: false, reason: 'row_no_label' };
    if (typeof row.amountUsdAnnual !== 'number' || !Number.isFinite(row.amountUsdAnnual)) {
      return { ok: false, reason: 'row_bad_amount' };
    }
    if (typeof row.source !== 'string') return { ok: false, reason: 'row_no_source' };
  }
  if (!Array.isArray(raw.assumptions)) return { ok: false, reason: 'assumptions_not_array' };
  if (!['low', 'medium', 'high'].includes(raw.confidence)) return { ok: false, reason: 'bad_confidence' };
  return { ok: true };
}

/**
 * Normalise the validated rollup into the shape the renderer expects.
 * Pass-through for the most part — strips any unknown fields and
 * coerces optional values to safe defaults (notes → '', currency →
 * 'USD'). Kept separate from `validateQuickFix` so the validator's
 * job stays "is this safe to use?" without taking on "make it nice".
 *
 * `correctionReason` is carried through unchanged from the model
 * (null when absent / empty). The renderer doesn't render it today
 * — it exists for the monotonic enforcer's audit log and any future
 * "why did the total drop?" tooltip on the card.
 */
function normaliseRollup(raw, updatedAt) {
  const correctionReason =
    typeof raw.correctionReason === 'string' && raw.correctionReason.trim().length > 0
      ? raw.correctionReason.trim()
      : null;
  return {
    headlineUsdAnnual: raw.headlineUsdAnnual,
    breakdown: raw.breakdown.map((row) => ({
      label: row.label,
      amountUsdAnnual: row.amountUsdAnnual,
      source: row.source,
      notes: typeof row.notes === 'string' ? row.notes : '',
    })),
    assumptions: raw.assumptions
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .slice(0, 5),
    confidence: raw.confidence,
    currency: typeof raw.currency === 'string' && raw.currency.length > 0 ? raw.currency : 'USD',
    correctionReason,
    updatedAt,
    stale: false,
    error: false,
  };
}

/**
 * Code-side monotonic enforcement (post-test-call fixes batch 2 /
 * Issue 3 — add-only headline). Returns `{ ok: true }` when the new
 * rollup is acceptable or `{ ok: false, reason }` when it should be
 * rejected.
 *
 * Acceptance criteria:
 *   - newHeadline >= previousHeadline                       → ok
 *   - newHeadline <  previousHeadline AND at least one      → ok
 *     active entry has correction === true
 *   - newHeadline <  previousHeadline AND `correctionReason` → ok
 *     is a non-empty string
 *   - newHeadline <  previousHeadline with neither           → REJECT
 *
 * The first-pass case (`previousHeadline` null/undefined) is also
 * accepted — there's nothing to compare against on the very first
 * rollup of a session.
 *
 * @param {{ headlineUsdAnnual: number, correctionReason: string | null }} newRollup
 * @param {number | null} previousHeadline
 * @param {Array<{ correction?: boolean }>} activeEntries
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function enforceMonotonicConstraint(newRollup, previousHeadline, activeEntries) {
  if (previousHeadline === null || previousHeadline === undefined) {
    return { ok: true };
  }
  if (!Number.isFinite(previousHeadline)) {
    return { ok: true };
  }
  if (newRollup.headlineUsdAnnual >= previousHeadline) {
    return { ok: true };
  }
  const hasCorrectionEntry = Array.isArray(activeEntries)
    && activeEntries.some((entry) => entry && entry.correction === true);
  if (hasCorrectionEntry) return { ok: true };
  if (typeof newRollup.correctionReason === 'string' && newRollup.correctionReason.trim().length > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `headline decreased from ${previousHeadline} to ${newRollup.headlineUsdAnnual} without correction flag or reason`,
  };
}

/**
 * Build the user-message payload for the Stage-2 model. Active
 * entries only (i.e. nothing that has been superseded by a newer
 * entry). The fact id, kind, amount, unit, period, basis, quote,
 * recordedAt, and the `correction` flag are all included so the
 * model can reason about conversions, double-counts, and explicit
 * revisions.
 *
 * `previousHeadlineUsdAnnual` is included even when null/0 so the
 * model sees a stable schema and the monotonic-constraint
 * instructions in the system prompt remain anchored on a concrete
 * field. The enforcer at the call site is the authoritative check
 * regardless — the prompt copy is the model's first line of
 * defence; the enforcer is the second.
 *
 * @param {Array<object>} activeEntries
 * @param {number | null} previousHeadlineUsdAnnual
 */
function buildStage2UserMessage(activeEntries, previousHeadlineUsdAnnual) {
  const json = activeEntries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    amount: entry.amount,
    unit: entry.unit,
    period: entry.period,
    basis: entry.basis,
    quote: entry.quote,
    recordedAt: entry.recordedAt,
    correction: entry.correction === true,
    supersedes: entry.supersedes || null,
  }));
  return [
    `previousHeadlineUsdAnnual: ${
      Number.isFinite(previousHeadlineUsdAnnual) ? previousHeadlineUsdAnnual : 0
    }`,
    '',
    'FACTS (active, after supersedes filter):',
    JSON.stringify(json, null, 2),
    '',
    'Return the rollup JSON. Remember: NEVER decrease the headline',
    'unless an entry has `correction: true` OR you provide a',
    '`correctionReason` string in the response.',
  ].join('\n');
}

/**
 * Construct the rolling debouncer that owns the Stage-2 pipeline for
 * a single call.
 *
 * The returned object exposes:
 *   - `schedule()`           — call after every factsSheet write to
 *                              arm/reset the 2.5 s debounce.
 *   - `cancelPendingRollup()` — cancel an armed timer without firing.
 *                              Called from teardownSession() so a late
 *                              roll-up can't land after the user has
 *                              stopped the call.
 *   - `runNow()`             — fire immediately, skipping the debounce.
 *                              Exposed for testability — not wired in
 *                              v1 but handy if a future "Refresh
 *                              rollup" button is added.
 *
 * @param {{
 *   getEntries: () => Array<{ id: string, kind: string, amount: number, unit: string, period: string, basis: string, quote: string, recordedAt: number, supersedes: string | null }>,
 *   onRollup: (rollup: object, entries: Array<object>) => void,
 *   onError?: (message: string) => void,
 *   debounceMs?: number,
 * }} deps
 */
export function createQuickFixRoller({ getEntries, onRollup, onError, debounceMs }) {
  if (typeof getEntries !== 'function') {
    throw new Error('quick-fix: getEntries() is required');
  }
  if (typeof onRollup !== 'function') {
    throw new Error('quick-fix: onRollup() is required');
  }
  const errorCb = typeof onError === 'function' ? onError : () => {};
  const wait = typeof debounceMs === 'number' && debounceMs > 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;

  let timer = null;
  let inFlight = false;
  let consecutiveFailures = 0;
  /** Last successfully validated rollup. Kept here (NOT on the
   *  factsSheet) so the worker is the single source of truth for
   *  fallback semantics — the broadcast carries this value with
   *  `stale: true` when a validation fails. */
  let lastGoodRollup = null;
  /** Last ACCEPTED headline total (the value the monotonic enforcer
   *  compares against on the next rollup). Distinct from
   *  `lastGoodRollup.headlineUsdAnnual` only in name: tracking it
   *  explicitly makes the intent of the enforcer obvious at read
   *  time, and gives us one place to clear it on reset. */
  let lastAcceptedHeadline = null;

  /**
   * Build the active-entries view: filter superseded entries, sort by
   * insertion order. The model needs to see the snapshot at run time
   * (not at schedule time) so a fact that lands during the debounce
   * window is naturally included.
   */
  function activeEntries() {
    const all = getEntries();
    if (!Array.isArray(all)) return [];
    const supersededIds = new Set();
    for (const e of all) {
      if (e && typeof e.supersedes === 'string' && e.supersedes) {
        supersededIds.add(e.supersedes);
      }
    }
    return all.filter((e) => e && !supersededIds.has(e.id));
  }

  async function runNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) {
      // A previous run is still mid-roundtrip. Drop this trigger;
      // when the in-flight run finishes it will see any newer facts
      // and the next schedule() call after that will fire a fresh
      // roundtrip. Avoids stacking concurrent Stage-2 calls during a
      // burst of facts.
      return;
    }
    const entries = activeEntries();
    if (entries.length === 0) {
      // Nothing to roll up — clear the rollup if we had one (e.g.
      // user superseded their only fact). Marks lastGood null too so
      // a subsequent failure doesn't restore stale data. Reset the
      // monotonic baseline so the next non-empty rollup starts from
      // zero rather than carrying a stale ceiling.
      lastGoodRollup = null;
      lastAcceptedHeadline = null;
      consecutiveFailures = 0;
      onRollup(null, entries);
      return;
    }

    const { provider: providerName, model } = getQuickFix();
    if (!providerName || !model) {
      console.warn('[quick-fix] no provider configured — skipping rollup');
      return;
    }
    const apiKey = getApiKey(providerName);
    if (!apiKey) {
      console.warn('[quick-fix] no API key for', providerName, '— skipping rollup');
      return;
    }

    let provider;
    try {
      provider = getProvider(providerName, { apiKey, model });
    } catch (err) {
      console.warn('[quick-fix] failed to construct provider:', err?.message || err);
      return;
    }

    const userMessage = buildStage2UserMessage(entries, lastAcceptedHeadline);
    inFlight = true;
    try {
      const result = await provider.generateContent({
        systemInstruction: STAGE2_SYSTEM_PROMPT,
        userMessage,
        // Gemini-specific structured-output flags — providers that
        // don't understand them ignore the keys (see Anthropic /
        // OpenAI provider abstractions). The system prompt itself
        // instructs the model to return JSON, so the cross-provider
        // path still works.
        responseMimeType: 'application/json',
        responseSchema: STAGE2_RESPONSE_SCHEMA,
      });

      const raw = typeof result?.text === 'string' ? result.text : '';
      if (!raw) {
        recordFailure('empty_response', entries, '<empty>');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        recordFailure(`parse_error: ${err?.message || 'invalid_json'}`, entries, raw);
        return;
      }
      const validation = validateQuickFix(parsed);
      if (!validation.ok) {
        recordFailure(validation.reason, entries, raw);
        return;
      }
      const normalised = normaliseRollup(parsed, Date.now());
      // Monotonic constraint: reject any decrease that lacks a
      // justification (correction flag or correctionReason). On
      // rejection the previous lastGoodRollup is re-broadcast with
      // stale=true and the failure counter ticks toward the
      // error-threshold so a model that keeps trying to decrease
      // unjustifiably eventually surfaces "Rollup unavailable" to
      // the rep.
      const monotonic = enforceMonotonicConstraint(normalised, lastAcceptedHeadline, entries);
      if (!monotonic.ok) {
        recordFailure(`monotonic_violation: ${monotonic.reason}`, entries, raw);
        return;
      }
      lastGoodRollup = normalised;
      lastAcceptedHeadline = normalised.headlineUsdAnnual;
      consecutiveFailures = 0;
      onRollup(normalised, entries);
    } catch (err) {
      // Network or provider-thrown errors — same treatment as
      // validation failure: keep last good, mark stale, escalate to
      // error flag after the threshold.
      const message = err?.message || 'quick-fix roundtrip failed';
      console.warn('[quick-fix] roundtrip threw:', message);
      errorCb(message);
      recordFailure(`exception: ${message}`, entries, '');
    } finally {
      inFlight = false;
    }
  }

  /**
   * Bookkeeping for a single Stage-2 failure. Re-broadcasts the last
   * good rollup with `stale: true` so the UI can flag "rollup paused".
   * After ERROR_THRESHOLD consecutive failures, escalates to
   * `error: true` so the rep knows the rollup is unavailable.
   */
  function recordFailure(reason, entries, rawPayload) {
    consecutiveFailures += 1;
    console.warn(
      '[quick-fix] validation/roundtrip failed:',
      reason,
      '— consecutive:',
      consecutiveFailures,
      '— raw:',
      rawPayload.slice(0, 240),
    );
    if (!lastGoodRollup) {
      // Nothing to fall back to. Broadcast a synthetic empty rollup
      // so the renderer can render the "Rollup unavailable" pill
      // without crashing on a null payload.
      onRollup(
        {
          headlineUsdAnnual: 0,
          breakdown: [],
          assumptions: [],
          confidence: 'low',
          currency: 'USD',
          correctionReason: null,
          updatedAt: Date.now(),
          stale: true,
          error: consecutiveFailures >= ERROR_THRESHOLD,
        },
        entries,
      );
      return;
    }
    onRollup(
      {
        ...lastGoodRollup,
        stale: true,
        error: consecutiveFailures >= ERROR_THRESHOLD,
      },
      entries,
    );
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Fire-and-forget; the runNow promise handles its own errors.
      runNow();
    }, wait);
  }

  function cancelPendingRollup() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { schedule, cancelPendingRollup, runNow };
}
