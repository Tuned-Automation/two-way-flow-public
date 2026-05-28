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
import * as errorLog from './error-log.js';

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

/* Tolerance for the anchor constraint. When a `stated_total` fact
 * exists, the Stage-2 headline must land within ±20% of it. This is
 * the prospect's own self-stated total — ground truth. The model
 * gets latitude inside the band; outside it, we reject. */
const ANCHOR_TOLERANCE = 0.2;

/* Tolerance for the headline-vs-breakdown sum guard. If the model
 * returns a headline more than 5% off from sum(breakdown), we treat
 * the response like a validation failure (the wobble on the
 * 2026-05-26 test call showed bullets summing to ~$238K under a $340K
 * headline — that gap was hidden, not surfaced, and the rep had no
 * way to audit it). Catching it client-side surfaces "Rollup paused,
 * retrying…" instead of shipping a misleading number. */
const SUM_TOLERANCE = 0.05;

/* Fact kinds that NEVER enter the headline. Stage-1 emits these so
 * the renderer can surface them for drill-through and audit, but
 * Stage-2 filters them out of the payload before the rollup model
 * sees the FACTS list:
 *
 *   - `context_only`         — base salaries, hourly rates, headcount
 *                              stated for context, NOT opportunity.
 *   - `hypothetical_fix_cost` — prospective ops hires, tool purchases
 *                              that only happen IF the fix is adopted.
 *
 * `stated_total` is NOT excluded here — it's still kept in the
 * payload AND surfaced via `anchorUsdAnnual` so the model can use it
 * as both reference and constraint. */
const EXCLUDED_FROM_HEADLINE_KINDS = new Set([
  'context_only',
  'hypothetical_fix_cost',
]);

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
  'You receive (a) a JSON array of discrete, AI-extracted financial',
  'facts from a call in progress, (b) the previously-accepted headline',
  'total, and (c) an `anchorUsdAnnual` value — the prospect\'s own',
  'self-stated total opportunity, or 0 if they haven\'t summed one yet.',
  'Your job is narrowly scoped:',
  '',
  '  1. DEDUPE the facts. Two facts about the SAME UNDERLYING ACTIVITY,',
  '     measured two different ways, count ONCE — not twice. This is',
  '     the load-bearing dedupe axis; we lose money to it constantly.',
  '     Common patterns to collapse:',
  '       - "team duplicate work" via "12 people × 4 hrs/wk × $40" AND',
  '         "team duplicate work" via "25 hrs/wk total × $40" — these',
  '         are the same activity from two angles. Keep the higher-',
  '         confidence row, drop the other.',
  '       - "consulting spend" via "$50K/yr" AND via "$4K/mo" — same',
  '         dollar stream, drop one.',
  '       - "his admin time" billed at his salary rate AND at his',
  '         strategic-work rate — same hours; pick ONE rate (prefer',
  '         strategic when stated) and drop the other.',
  '     For each dropped duplicate add an entry to `assumptions` like',
  '     "dropped duplicate: <basis> via <alt formula>".',
  '  2. ANCHOR. If `anchorUsdAnnual` is non-zero, that is the LATEST',
  '     `stated_total` from the prospect — the speaker explicitly',
  '     summed their own opportunity. The headline MUST land within',
  '     ±20% of it. The anchor is GROUND TRUTH:',
  '       - If your bottom-up sum of components naturally lands HIGHER',
  '         than anchor × 1.2, drop the lowest-confidence components',
  '         until the headline fits the window. Note the dropped',
  '         components in `assumptions`.',
  '       - If your bottom-up sum lands LOWER than anchor × 0.8, keep',
  '         the headline at the anchor itself and surface the gap as',
  '         an assumption ("anchor higher than identified components',
  '         by $X — likely covering indirect costs not itemised").',
  '     Do not exceed the anchor band without a `correction: true`',
  '     entry justifying it. When `anchorUsdAnnual` is 0 or missing,',
  '     this rule does not apply.',
  '  3. IGNORE facts whose id appears in the `supersedes` field of a',
  '     newer fact — those entries have been replaced.',
  '  4. ANNUALISE each remaining fact to USD and SUM them to produce',
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
  '  5. HEADLINE = SUM(BREAKDOWN). The `headlineUsdAnnual` field MUST',
  '     equal the sum of `amountUsdAnnual` across all `breakdown` rows',
  '     (within 5% rounding tolerance). If they disagree, the rollup',
  '     is rejected client-side and the previous-good headline stays',
  '     stale until the next tick. Do not put a "summary" number in',
  '     the headline that isn\'t reflected in the visible bullets.',
  '  6. Each breakdown row must cite the source fact\'s `id` so the UI',
  '     can drill through to the anchor quote. Use the literal string',
  '     "derived" only when a row is the sum of two facts (the dedupe',
  '     winner).',
  '  7. Confidence rubric:',
  '       - high   → all facts have explicit amounts/units/periods,',
  '                  ≤1 inferred conversion, no unresolved duplicates,',
  '                  and (when an anchor is set) headline within',
  '                  ±10% of anchor.',
  '       - medium → 1-2 inferred conversions OR 1 likely double-count.',
  '       - low    → >2 inferences, OR >1 unresolved double-count, OR',
  '                  contradictory facts, OR anchor divergence > 10%.',
  '  8. ROW LABELS — each `breakdown[i].label` is a clean DESCRIPTOR-ONLY',
  '     noun phrase explaining WHAT the cost or opportunity is. The',
  '     amount column already shows the dollar value; do NOT repeat it',
  '     in the label.',
  '       GOOD labels:',
  '         - "Duplicate work across team"',
  '         - "Manual reporting time"',
  '         - "Lost deals to slow follow-up"',
  '         - "Consulting spend"',
  '         - "Tool licence cost"',
  '       BAD labels (these all leak into the live UI as garbage strings):',
  '         - "$120K in duplicate work"        ← embeds the dollar amount',
  '         - "thirty grand a year on consulting" ← echoes speech verbatim',
  '         - "$20 in wasted time"             ← embeds + echoes',
  '         - "$50 a year"                     ← only the amount, no descriptor',
  '     If the only sensible descriptor IS a dollar phrase (e.g. the',
  '     speaker only said the number with no context), fall back to the',
  '     fact\'s `kind` capitalised (e.g. "Pain cost", "Revenue uplift")',
  '     rather than embedding the figure.',
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
  '        worth $X), OR',
  '',
  '    (c) the new headline is being pulled DOWN to fit the',
  '        `anchorUsdAnnual` band (in which case set `correctionReason`',
  '        to "anchor enforcement: clamping to stated_total band").',
  '',
  '  If none of (a)/(b)/(c) holds, KEEP the previous headline value.',
  '  Code-side enforcement will REJECT a smaller headline with neither',
  '  justification — producing one will mark the rollup card stale',
  '  until the next tick. The rule is "add-only by default";',
  '  corrections and anchor enforcement are the ONLY exceptions.',
  '',
  '  If a `correction: true` entry IS present, you SHOULD adjust the',
  '  headline accordingly (the prospect explicitly revised a figure).',
  '',
  '  9. Return JSON only, matching the schema. No prose outside the JSON.',
  '     Omit `correctionReason` (or set it to null) when there is no',
  '     correction in play — populating it with empty/filler text would',
  '     bypass the monotonic constraint.',
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
          label: {
            type: 'STRING',
            description:
              'Short descriptor-only row label, ≤80 chars. MUST be a clean '
              + 'noun phrase describing what the cost or opportunity IS. MUST '
              + 'NOT include dollar amounts (the amount column renders the '
              + 'figure separately) and MUST NOT echo the speaker\'s literal '
              + 'phrasing verbatim. '
              + 'GOOD: "Duplicate work across team", "Manual reporting time", '
              + '"Lost deals to slow follow-up". '
              + 'BAD: "$120K in duplicate work", "thirty grand a year on '
              + 'consulting", "$20 in wasted time".',
          },
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
 * Annualise a `stated_total` fact into a USD-per-year figure for
 * anchor enforcement. Returns null when the entry can't be sensibly
 * annualised — those entries don't anchor the rollup (we'd rather
 * have no anchor than a wrong one).
 *
 * Mirrors the period conversions the Stage-2 model is told to apply
 * in the system prompt; kept here as code so the anchor math doesn't
 * depend on the model returning the right number.
 */
function annualiseStatedTotal(entry) {
  if (!entry || entry.unit !== 'usd') return null;
  if (!Number.isFinite(entry.amount)) return null;
  switch (entry.period) {
    case 'annual':
      return entry.amount;
    case 'monthly':
      return entry.amount * 12;
    case 'weekly':
      return entry.amount * 52;
    case 'quarterly':
      return entry.amount * 4;
    case 'one_time':
      // A one-time figure isn't a recurring opportunity; don't let it
      // anchor the rollup. The fact is still kept for drill-through.
      return null;
    default:
      return null;
  }
}

/**
 * Pick the LATEST `stated_total` entry from the active set and return
 * its annualised USD value. Returns 0 when no stated_total exists
 * (the Stage-2 prompt treats 0 as "no anchor; skip the constraint").
 *
 * "Latest" is chosen by `recordedAt`. A speaker who revises their
 * estimate ("I was thinking $80K but really it's more like $120K")
 * gets the newer number used as the anchor.
 */
function pickAnchorUsdAnnual(activeEntries) {
  if (!Array.isArray(activeEntries) || activeEntries.length === 0) return 0;
  let best = null;
  for (const entry of activeEntries) {
    if (!entry || entry.kind !== 'stated_total') continue;
    const annual = annualiseStatedTotal(entry);
    if (annual === null) continue;
    if (!best || (entry.recordedAt || 0) > (best.recordedAt || 0)) {
      best = { ...entry, _annual: annual };
    }
  }
  return best ? best._annual : 0;
}

/**
 * Code-side monotonic enforcement + anchor ceiling. Returns
 * `{ ok: true }` when the new rollup is acceptable or
 * `{ ok: false, reason }` when it should be rejected.
 *
 * Acceptance criteria (checks run top-down; first failure wins):
 *   - anchorUsdAnnual > 0 AND headline > anchor × 1.2          → REJECT
 *   - newHeadline >= previousHeadline                          → ok
 *   - newHeadline <  previousHeadline AND at least one         → ok
 *     active entry has correction === true
 *   - newHeadline <  previousHeadline AND `correctionReason`   → ok
 *     is a non-empty string
 *   - newHeadline <  previousHeadline with neither             → REJECT
 *
 * The first-pass case (`previousHeadline` null/undefined) is also
 * accepted for the monotonic check — there's nothing to compare
 * against on the very first rollup of a session — but the anchor
 * ceiling still applies if one has been stated.
 *
 * @param {{ headlineUsdAnnual: number, correctionReason: string | null }} newRollup
 * @param {number | null} previousHeadline
 * @param {Array<{ correction?: boolean }>} activeEntries
 * @param {number} anchorUsdAnnual
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function enforceMonotonicConstraint(newRollup, previousHeadline, activeEntries, anchorUsdAnnual) {
  // Anchor ceiling: when the prospect has stated their own total, a
  // headline more than 20% above it almost certainly means the model
  // double-counted or invented a component. Reject regardless of
  // monotonic state — anchor wins over add-only. (The PROSPECT'S
  // self-stated number is the ground truth, not whatever the model
  // re-derived.)
  if (Number.isFinite(anchorUsdAnnual) && anchorUsdAnnual > 0) {
    const ceiling = anchorUsdAnnual * (1 + ANCHOR_TOLERANCE);
    if (Number.isFinite(newRollup.headlineUsdAnnual) && newRollup.headlineUsdAnnual > ceiling) {
      return {
        ok: false,
        reason: `headline ${newRollup.headlineUsdAnnual} exceeds anchor ceiling ${ceiling.toFixed(0)} (anchor=${anchorUsdAnnual}, +${(ANCHOR_TOLERANCE * 100).toFixed(0)}%)`,
      };
    }
  }
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
 * Entries with `kind` in EXCLUDED_FROM_HEADLINE_KINDS (context_only,
 * hypothetical_fix_cost) are FILTERED OUT here — they exist on the
 * factsSheet for drill-through but must never enter the rollup math.
 *
 * `previousHeadlineUsdAnnual` is included even when null/0 so the
 * model sees a stable schema and the monotonic-constraint
 * instructions in the system prompt remain anchored on a concrete
 * field. The enforcer at the call site is the authoritative check
 * regardless — the prompt copy is the model's first line of
 * defence; the enforcer is the second.
 *
 * `anchorUsdAnnual` is 0 when no `stated_total` is on the sheet, or
 * the annualised USD value of the LATEST stated_total. Stage-2 uses
 * it to clamp the headline within ±20% of what the prospect said.
 *
 * @param {Array<object>} activeEntries
 * @param {number | null} previousHeadlineUsdAnnual
 * @param {number} anchorUsdAnnual
 */
function buildStage2UserMessage(activeEntries, previousHeadlineUsdAnnual, anchorUsdAnnual) {
  const includedEntries = activeEntries.filter(
    (entry) => entry && !EXCLUDED_FROM_HEADLINE_KINDS.has(entry.kind),
  );
  const json = includedEntries.map((entry) => ({
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
    `anchorUsdAnnual: ${Number.isFinite(anchorUsdAnnual) ? anchorUsdAnnual : 0}`,
    '',
    'FACTS (active, after supersedes filter and excluded-kind filter):',
    JSON.stringify(json, null, 2),
    '',
    'Return the rollup JSON. Remember:',
    ' - NEVER decrease the headline unless an entry has `correction: true`',
    '   OR you provide a `correctionReason` string OR you are clamping to',
    '   the anchor band.',
    ' - If anchorUsdAnnual > 0, the headline MUST land within ±20% of it.',
    ' - The headline MUST equal the sum of the breakdown rows.',
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
export function createQuickFixRoller({ getEntries, onRollup, onError, debounceMs, usageAccumulator }) {
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
      provider = getProvider(providerName, { apiKey, model, source: 'quick-fix' });
    } catch (err) {
      console.warn('[quick-fix] failed to construct provider:', err?.message || err);
      return;
    }

    // Compute the anchor BEFORE filtering — `stated_total` entries
    // must be considered even though they're not part of the
    // breakdown math themselves. Anchor pickup uses the full active
    // set; the model's view of FACTS is filtered down inside
    // buildStage2UserMessage().
    const anchorUsdAnnual = pickAnchorUsdAnnual(entries);
    const userMessage = buildStage2UserMessage(entries, lastAcceptedHeadline, anchorUsdAnnual);
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

      // Forward token usage into the per-session accumulator (cost-
      // tracking feature). Null-safe both ways per invariant #2.
      usageAccumulator?.recordLlmCall('quickFix', result?.usage);

      const raw = typeof result?.text === 'string' ? result.text : '';
      if (!raw) {
        recordFailure('empty_response', entries, '<empty>', providerName, model);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        recordFailure(`parse_error: ${err?.message || 'invalid_json'}`, entries, raw, providerName, model);
        return;
      }
      const validation = validateQuickFix(parsed);
      if (!validation.ok) {
        recordFailure(validation.reason, entries, raw, providerName, model);
        return;
      }
      const normalised = normaliseRollup(parsed, Date.now());

      // Headline-vs-breakdown sum guard. The Stage-2 model has been
      // told the headline MUST equal the sum of the breakdown rows;
      // we enforce that client-side because Window-2 / Window-3 of
      // the 2026-05-26 test call shipped bullets summing to ~$238K
      // under a $340K headline — the rep had a visible card that
      // didn't add up. Reject any response where the gap exceeds 5%
      // and re-broadcast the previous-good with stale=true.
      const breakdownSum = Array.isArray(normalised.breakdown)
        ? normalised.breakdown.reduce(
            (acc, row) => acc + (Number.isFinite(row.amountUsdAnnual) ? row.amountUsdAnnual : 0),
            0,
          )
        : 0;
      const headline = normalised.headlineUsdAnnual;
      if (Number.isFinite(headline) && headline > 0 && breakdownSum > 0) {
        const divergence = Math.abs(headline - breakdownSum) / Math.max(headline, breakdownSum);
        if (divergence > SUM_TOLERANCE) {
          recordFailure(
            `headline_sum_mismatch: headline=${headline} sum=${breakdownSum.toFixed(0)} divergence=${(divergence * 100).toFixed(1)}%`,
            entries,
            raw,
            providerName,
            model,
          );
          return;
        }
      }

      // Monotonic constraint + anchor ceiling: reject any decrease
      // that lacks a justification (correction flag, correctionReason,
      // or anchor enforcement) and reject any headline more than 20%
      // above the prospect's own stated total. On rejection the
      // previous lastGoodRollup is re-broadcast with stale=true and
      // the failure counter ticks toward the error-threshold so a
      // model that keeps trying to drift unjustifiably eventually
      // surfaces "Rollup unavailable" to the rep.
      const monotonic = enforceMonotonicConstraint(
        normalised,
        lastAcceptedHeadline,
        entries,
        anchorUsdAnnual,
      );
      if (!monotonic.ok) {
        recordFailure(`monotonic_violation: ${monotonic.reason}`, entries, raw, providerName, model);
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
      recordFailure(`exception: ${message}`, entries, '', providerName, model);
    } finally {
      inFlight = false;
    }
  }

  /**
   * Bookkeeping for a single Stage-2 failure. Re-broadcasts the last
   * good rollup with `stale: true` so the UI can flag "rollup paused".
   * After ERROR_THRESHOLD consecutive failures, escalates to
   * `error: true` so the rep knows the rollup is unavailable.
   *
   * `providerName` + `model` are threaded through from `runNow` so
   * the errorLog entry below carries the right attribution. They're
   * positional args (not closure state) so the failure recorded for
   * a given run uses the same provider/model the model call actually
   * targeted — even if the user swaps providers mid-call between
   * the runNow read and the recordFailure call.
   */
  function recordFailure(reason, entries, rawPayload, providerName, model) {
    consecutiveFailures += 1;
    // Two-channel surfacing — see facts-scanner.js JSON-parse warn-path
    // for the rationale. The provider-wrapper at src/providers/index.js
    // catches generateContent THROWS, but quick-fix's failures are
    // mostly POST-success client-side rejections (parse / validation /
    // sum-mismatch / monotonic-violation) that the wrapper can't see,
    // so the warn-channel append here is load-bearing.
    errorLog.append({
      level: 'warn',
      source: 'quick-fix',
      provider: providerName,
      model,
      reason,
      message: reason,
      rawResponse: rawPayload,
    });
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
