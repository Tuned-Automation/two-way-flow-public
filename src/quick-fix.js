/**
 * Stage 2 of the two-stage AI facts pipeline (Strategy A / Work-stream
 * C of the post-test-call fixes).
 *
 * The Coach (src/coach.js) captures structured monetary facts via the
 * `record_meeting_fact` tool. Each capture appends an entry to
 * `coachContext.factsSheet.entries` in main, which then calls
 * `scheduleQuickFix()` exported below. This module owns:
 *
 *   1. A single debounce timer (~2.5 s after the last fact write) so
 *      a flurry of facts from a quick exchange triggers ONE Stage-2
 *      roundtrip when things settle, rather than a roundtrip per
 *      capture.
 *
 *   2. The Stage-2 prompt + JSON schema + validator that asks a more
 *      capable model ("financial analyst") to roll the active facts
 *      up into a single annualised USD opportunity with a breakdown,
 *      assumptions, and a confidence rating.
 *
 *   3. A last-known-good fallback: a malformed Stage-2 response leaves
 *      the previous rollup intact and surfaces a `stale: true` flag
 *      so the renderer can show a "Rollup paused, retrying…" pill on
 *      the card. After three consecutive invalid responses we set
 *      `error: true` so the rep knows the rollup is unavailable —
 *      reset to false on the next valid response.
 *
 *   4. A `cancelPendingRollup()` exported so `teardownSession()` can
 *      cancel a debounced timer if the user stops the call before it
 *      fires (otherwise a late roll-up would arrive after the
 *      coachContext reset).
 *
 * Architecture diagram (mirrors the plan):
 *
 *     coachContext.factsSheet.entries
 *           ↓ (every write)
 *     scheduleQuickFix() — debounce 2.5 s
 *           ↓
 *     runQuickFix() — Stage-2 AI roundtrip
 *           ↓
 *     coachContext.factsSheet.quickFix = result
 *     send('scoring:quick-fix', { quickFix, entries })
 *
 * The worker reads `factsSheet.entries` indirectly via the getter
 * passed in at construction time so it never holds a shared mutable
 * reference. A reset on the source (resetCoachContext clears
 * factsSheet) is therefore safe — the worker's next read sees the
 * cleared state and produces an empty rollup or skips entirely.
 *
 * Provider routing: the Stage-2 provider is constructed at run time
 * via `getQuickFix()` from settings.js, which cascades the
 * `quickFix.provider` / `quickFix.model` overrides over the coach's
 * routed provider. So the user can keep the live coach on Flash and
 * point the rollup at Pro without touching the live path.
 *
 * Extension points
 *   - To make the debounce cadence configurable, plumb the value
 *     through `createQuickFixRoller({ debounceMs })` — the consumer
 *     in main.js can read it from settings.coach.* once Phase 4 of
 *     the Settings expansion lands the timing knobs.
 *   - To support multi-currency, extend the prompt + schema to
 *     accept a target currency parameter; the validator already
 *     keeps a `currency` field on the result (always "USD" for v1).
 *   - To swap the schema for a richer breakdown (e.g. annualised
 *     ARR vs. one-time savings), update the JSON schema below AND
 *     the validator in lockstep so a future model that returns the
 *     new shape doesn't get dropped.
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
 * tasks of this size. */
const STAGE2_SYSTEM_PROMPT = [
  'You are a financial analyst supporting a live sales conversation.',
  'You receive a JSON array of discrete, AI-extracted financial facts',
  'from a call in progress and produce a single summary of the total',
  'annual economic opportunity for the prospect.',
  '',
  'Rules:',
  '1. Convert every fact to annual USD. Use these standard conversions',
  '   when the unit is not USD:',
  '   - hours/week × 52 × stated_hourly_rate_if_known (otherwise note',
  '     "rate not stated")',
  '   - hours/month × 12 × stated_hourly_rate_if_known',
  '   - people × stated_loaded_cost_per_person (otherwise note',
  '     "loaded cost not stated")',
  '   - percent → only meaningful when applied to a base; treat as a',
  '     multiplier on a stated revenue/spend, otherwise carry forward',
  '     as a note.',
  '   - period "one_time" → leave as-is, do NOT annualise; note "one-time".',
  '2. Detect and flag double-counts: if two facts describe the same',
  '   dollar stream from different angles (e.g. "we spend $50K on',
  '   consultants" and "consulting line item is $4K/mo"), include only',
  '   ONE in the sum and mention the duplicate in `assumptions`.',
  '3. If a fact is superseded (`supersedes_id` populated) ignore the',
  '   older entry entirely.',
  '4. Each breakdown row must cite the source fact\'s `id` so the UI',
  '   can drill through to the anchor quote.',
  '5. Confidence rubric:',
  '   - high  → all facts have explicit amounts, units, periods, and',
  '             at most one inferred conversion.',
  '   - medium → 1-2 inferred conversions OR 1 likely-but-not-confirmed',
  '              double-count.',
  '   - low   → more than 2 inferences, OR more than one unresolved',
  '             double-count, OR contradictory facts.',
  '6. Return JSON only, matching the schema. No prose outside the JSON.',
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
 */
function normaliseRollup(raw, updatedAt) {
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
    updatedAt,
    stale: false,
    error: false,
  };
}

/**
 * Build the user-message payload for the Stage-2 model. Active
 * entries only (i.e. nothing that has been superseded by a newer
 * entry). The fact id, kind, amount, unit, period, basis, quote, and
 * recordedAt are all included so the model can reason about
 * conversions and double-counts.
 *
 * @param {Array<object>} activeEntries
 */
function buildStage2UserMessage(activeEntries) {
  const json = activeEntries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    amount: entry.amount,
    unit: entry.unit,
    period: entry.period,
    basis: entry.basis,
    quote: entry.quote,
    recordedAt: entry.recordedAt,
  }));
  return [
    'FACTS (active):',
    JSON.stringify(json, null, 2),
    '',
    'Return the rollup JSON.',
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
      // a subsequent failure doesn't restore stale data.
      lastGoodRollup = null;
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

    const userMessage = buildStage2UserMessage(entries);
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
      lastGoodRollup = normalised;
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
