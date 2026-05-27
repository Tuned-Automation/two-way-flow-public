/**
 * Stage-1 facts scanner (post-test-call fixes batch 2 / Issue 3).
 *
 * Owns the periodic AI sweep that extracts monetary / time / headcount
 * / percentage / opportunity facts from the live transcript. Each
 * tick the scanner:
 *
 *   1. Asks `getEntries()` how many facts already exist (used as the
 *      next-id base so the renderer's drill-through ids stay
 *      monotonic).
 *   2. Snapshots the transcript lines committed since the previous
 *      scan via `getNewTranscriptLines()` — a sliding chunk, not the
 *      whole call.
 *   3. Calls the configured provider with a focused "extract facts"
 *      prompt and a JSON schema that mirrors the legacy
 *      `record_meeting_fact` tool shape.
 *   4. For each well-formed extracted entry, calls
 *      `appendEntry(entry)` (typically wired up in main.js to push
 *      onto `coachContext.factsSheet.entries` and trigger the
 *      Stage-2 quick-fix roller).
 *
 * Architectural separation
 *   This module replaces the Coach's old `record_meeting_fact` tool.
 *   Splitting the two responsibilities buys us:
 *     - A cadence that suits its workload (~12 s) without slowing the
 *       Coach's 1.5 s rubric/state tick.
 *     - A prompt narrowly scoped to "fact extraction" with no
 *       competing concerns about question suggestion or item-state
 *       lifecycle.
 *     - A `correction` flag the model can emit when the prospect
 *       explicitly revises a previous figure. Stage-2 uses this flag
 *       to allow the headline total to decrease (the monotonic
 *       constraint relaxes ONLY when a correction is present).
 *
 * Provider routing reuses `getQuickFix()` so the user's existing
 * "background financial analyst" provider+model choice applies to
 * both AI passes. No new Settings UI required.
 *
 * Lifecycle is owned by the caller (main.js):
 *   - construct via `createFactsScanner({...})`.
 *   - call `start()` on session open to arm the setInterval.
 *   - call `stop()` on teardown to clear it.
 *   - call `runNow()` for testability or a future "Refresh facts"
 *     manual button.
 *
 * Extension points
 *   - Cadence is read from `settings.factsScanner.intervalMs` by the
 *     caller and passed in via the constructor — change the value in
 *     Settings without touching this module.
 *   - To add a new fact kind, extend the enum in `FACTS_SCHEMA`
 *     AND the prompt's `kind` rules so the model + validator stay in
 *     lockstep.
 *   - To support a target currency other than USD, extend the
 *     schema and pass the target into `buildUserMessage()`.
 */

import { getProvider } from './providers/index.js';
import { getQuickFix, getApiKey } from './settings.js';

/* Default cadence (ms). 12 s is the spec'd default — short enough
 * that a fact mentioned during the call appears in the headline
 * within the same conversational beat, long enough to keep model
 * cost bounded. Configurable via `settings.factsScanner.intervalMs`,
 * which the caller passes through `intervalMs`. */
const DEFAULT_INTERVAL_MS = 12_000;

/* Enums kept in lockstep with the legacy `record_meeting_fact` tool
 * shape so existing entries from older call snapshots still validate
 * if a future migration ever replays them.
 *
 * The first seven kinds (current_spend through other) feed the Stage-2
 * rollup. The last three (context_only, hypothetical_fix_cost,
 * stated_total) are post-test-call additions:
 *
 *   - `context_only` — base salaries, hourly rates, headcount stated
 *     for context. Stage-2 filters these out before sending the FACTS
 *     list to the rollup model; they exist purely so the renderer can
 *     surface them for drill-through if needed. Heuristic: would the
 *     prospect RECOVER this dollar figure if their problem were
 *     solved? If no, it's context.
 *
 *   - `hypothetical_fix_cost` — prospective hires or tool purchases
 *     the prospect mentions as a hypothetical fix. Stage-2 filters
 *     these out too. Heuristic: would this expense only happen IF the
 *     prospect adopted a fix?
 *
 *   - `stated_total` — the speaker's own bottom-line sum of their
 *     opportunity ("we're talking $120-130K all in"). Stage-2 uses the
 *     LATEST stated_total as a headline ANCHOR so the rollup stays
 *     within ±20% of what the prospect said. Without this, the model
 *     re-derives a number that drifts away from ground truth (the
 *     $341K wobble seen on the 2026-05-26 test call). */
const KIND_VALUES = [
  'current_spend',
  'pain_cost',
  'savings_opportunity',
  'revenue_uplift',
  'time_cost',
  'headcount_cost',
  'other',
  'context_only',
  'hypothetical_fix_cost',
  'stated_total',
];
const UNIT_VALUES = ['usd', 'hours', 'people', 'percent'];
const PERIOD_VALUES = ['one_time', 'weekly', 'monthly', 'quarterly', 'annual'];

/* Monetary kinds where a bare amount under $5K is almost certainly a
 * transcription artefact, not a real $30 line item. The Stage-1 scanner
 * drops these rather than letting them through to Stage-2 where they
 * compound into a wrong rollup. `time_cost`, `other`, `context_only`,
 * and `hypothetical_fix_cost` are deliberately EXCLUDED — they have
 * legitimate small-amount usages (e.g. "$150 hourly rate", "$500
 * one-time setup fee"). `stated_total` IS included because a bottom-
 * line opportunity stated as "$30" is virtually always meant to be
 * "$30 grand". */
const IMPLAUSIBILITY_USD_KINDS = new Set([
  'current_spend',
  'pain_cost',
  'savings_opportunity',
  'revenue_uplift',
  'headcount_cost',
  'stated_total',
]);

/**
 * Stage-1 system prompt. The scanner's job is narrowly scoped:
 * extract zero-or-more discrete facts from the chunk. No rollup, no
 * de-dup, no rationale — that's Stage-2's job.
 *
 * The `correction: true` flag is the load-bearing addition. The
 * monotonic Stage-2 constraint relaxes only when an entry carries
 * `correction: true` with a `supersedes_id`, so the prompt teaches
 * the model exactly when to set it.
 */
const FACTS_SYSTEM_PROMPT = [
  'You are a financial analyst observing a live sales call. You receive a',
  'recent chunk of the call transcript (both speakers, prefixed "You:" for',
  'the salesperson and "Prospect:" for the client) and your only job is',
  'to extract discrete quantitative facts that could affect the total',
  'economic opportunity of the deal.',
  '',
  'Return STRICT JSON shaped as { "facts": Array<Fact> }. Each Fact:',
  '  {',
  '    "kind":          one of "current_spend" | "pain_cost" |',
  '                     "savings_opportunity" | "revenue_uplift" |',
  '                     "time_cost" | "headcount_cost" | "other" |',
  '                     "context_only" | "hypothetical_fix_cost" |',
  '                     "stated_total". See KIND CLASSIFICATION below',
  '                     — check the three new kinds (context_only,',
  '                     hypothetical_fix_cost, stated_total) FIRST,',
  '                     since they take priority when they apply.',
  '    "amount":        the number in BASE UNITS. ALWAYS apply',
  '                     thousands / millions multipliers from the',
  '                     speaker\'s words; never store a small bare',
  '                     integer when the speaker clearly meant',
  '                     thousands. Examples:',
  '                       "$50K/yr"             → 50000',
  '                       "thirty grand a year" → 30000',
  '                       "$15.20 grand"        → 15200',
  '                       "$4M ARR"             → 4000000',
  '                       "10 hours a week"     → 10',
  '                       "5%"                  → 5',
  '                     Do not convert period — hours/week stays',
  '                     weekly; Stage-2 handles annualisation.',
  '    "unit":          one of "usd" | "hours" | "people" | "percent".',
  '                     Pick the unit that matches "amount".',
  '    "period":        one of "one_time" | "weekly" | "monthly" |',
  '                     "quarterly" | "annual". Use the period as',
  '                     STATED — Stage-2 handles annualisation.',
  '    "basis":         one short sentence describing what the number',
  '                     represents ("Annual spend on the current',
  '                     automation tool").',
  '    "anchor_quote":  REQUIRED. Direct quote (≤120 chars) from the',
  '                     transcript chunk where this number was stated.',
  '                     Include the speaker label where relevant',
  '                     (e.g. \'Prospect: "we\\\'re at around $4M ARR"\').',
  '                     If you cannot quote it cleanly, DO NOT emit',
  '                     the fact.',
  '    "correction":    boolean. TRUE only when the speaker explicitly',
  '                     revised an earlier figure (cues: "actually",',
  '                     "let me correct that", "scratch that, it\'s',
  '                     closer to X", "sorry, I meant Y"). FALSE in',
  '                     every other case (restatements, clarifications,',
  '                     and rephrasings are NOT corrections).',
  '    "supersedes_id": optional. When `correction` is true, set this to',
  '                     the id of the earlier entry being corrected if',
  '                     it appears in the PRIOR FACTS list provided in',
  '                     the user message. Omit if you cannot match',
  '                     against a specific prior entry — Stage-2 will',
  '                     still use the `correction` flag to relax its',
  '                     monotonic constraint.',
  '  }',
  '',
  'KIND CLASSIFICATION (check in priority order, top down):',
  '',
  '  a. `stated_total` — the speaker explicitly sums their own',
  '     opportunity in one breath. Cues: "all in", "so we\'re talking",',
  '     "we\'re looking at", "add it all up", followed by a single',
  '     bottom-line number that covers their whole problem. Examples:',
  '       Prospect: "all in, we\'re probably leaving 70-80 grand on',
  '                 the table every year, just from disorganization."',
  '         → stated_total, amount: 75000, period: annual',
  '           (use mid-point when the speaker gives a range)',
  '       Prospect: "so we\'re talking $100K or more when you really',
  '                 add it up."',
  '         → stated_total, amount: 100000, period: annual',
  '     Only emit for explicit roll-ups — NOT for individual line',
  '     items. Multiple stated_totals can exist in one call (the',
  '     speaker may revise their estimate); Stage-2 uses the LATEST.',
  '',
  '  b. `context_only` — base salaries, hourly rates, headcount, or',
  '     any other figure volunteered as REFERENCE INFO rather than as',
  '     a waste/opportunity. Heuristic: would the speaker RECOVER this',
  '     dollar figure if their problem were solved? If NO →',
  '     context_only. Examples:',
  '       Prospect: "I pay myself around $80K a year"',
  '         → context_only, amount: 80000, unit: usd, period: annual',
  '       Prospect: "my hourly rate is around $150"',
  '         → context_only, amount: 150, unit: usd, period: one_time',
  '       Prospect: "we have 12 people on the team"',
  '         → context_only, amount: 12, unit: people, period: one_time',
  '',
  '  c. `hypothetical_fix_cost` — prospective hires, tool purchases,',
  '     or other expenses the speaker mentions as a hypothetical fix',
  '     to their problem. Heuristic: would this expense only happen',
  '     IF the prospect adopted a fix? If yes → hypothetical_fix_cost.',
  '     Examples:',
  '       Prospect: "another 30-40 grand a year in payroll if I',
  '                 hired an ops person"',
  '         → hypothetical_fix_cost, amount: 35000, period: annual',
  '       Prospect: "the tool itself would be maybe $5K a year"',
  '         → hypothetical_fix_cost, amount: 5000, period: annual',
  '',
  '  d. The existing seven kinds, when none of the above apply:',
  '       - current_spend       — what the prospect is paying today',
  '                               for the problem area.',
  '       - pain_cost           — money/time wasted by the broken',
  '                               status quo.',
  '       - savings_opportunity — would-be savings if the problem',
  '                               were solved.',
  '       - revenue_uplift      — additional revenue if the problem',
  '                               were solved.',
  '       - time_cost           — hours/people wasted in the status',
  '                               quo.',
  '       - headcount_cost      — team size or salary cost burden.',
  '       - other               — catch-all for anything monetary that',
  '                               doesn\'t fit cleanly above.',
  '',
  'Critical rules:',
  '  1. ADD-ONLY semantics. The scanner is the source of new facts on',
  '     every tick. Stage-2 does the de-duplication across the full',
  '     list — your job is just to surface what was stated in the',
  '     chunk you can see. Do NOT try to dedupe against prior facts',
  '     yourself UNLESS the speaker explicitly corrected one (in which',
  '     case emit a fact with `correction: true`).',
  '  2. If the same figure is restated by either speaker WITHOUT a',
  '     correction cue, DO NOT emit a new entry — Stage-2 only sees',
  '     the cumulative list and re-emitting would corrupt the count.',
  '  3. Speakers volunteering opinions / hypotheticals / round-numbers',
  '     are facts iff they relate to the prospect\'s business. A',
  '     salesperson asking "is it more like $50K?" is NOT a fact even',
  '     if the prospect agrees in a later turn — wait for the',
  '     prospect to volunteer or confirm the figure in their own',
  '     words before emitting.',
  '  4. Anchor quote is REQUIRED. No anchor → no fact. Better to',
  '     surface zero facts than to invent one.',
  '  5. Return `{ "facts": [] }` when nothing in the chunk qualifies.',
  '     An empty list is the correct answer most of the time.',
].join('\n');

/**
 * JSON schema for the Stage-1 response. Gemini's structured-output
 * mode uses this directly via `responseSchema`. Anthropic / OpenAI
 * paths receive the same constraint via the natural-language prompt.
 */
const FACTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    facts: {
      type: 'ARRAY',
      description: 'Zero-or-more facts extracted from the chunk.',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: KIND_VALUES },
          amount: { type: 'NUMBER' },
          unit: { type: 'STRING', enum: UNIT_VALUES },
          period: { type: 'STRING', enum: PERIOD_VALUES },
          basis: { type: 'STRING' },
          anchor_quote: { type: 'STRING' },
          correction: { type: 'BOOLEAN' },
          supersedes_id: { type: 'STRING' },
        },
        required: ['kind', 'amount', 'unit', 'period', 'basis', 'anchor_quote'],
      },
    },
  },
  required: ['facts'],
};

/**
 * Coerce a monetary amount when the anchor_quote indicates a thousands
 * / millions multiplier that the model failed to apply.
 *
 * Background: Deepgram occasionally drops the "grand"/"K" suffix from
 * sales-call audio ("$30 a year" instead of "$30 grand a year"). The
 * Stage-1 model dutifully stores `30`, which compounds into a wrong
 * Stage-2 rollup. This post-processor reads the anchor_quote for
 * "grand"/"thousand"/"K"/"M"/"million" tokens and multiplies the
 * amount accordingly when it's too small to plausibly be the literal
 * value.
 *
 * Only applied to monetary facts (unit === 'usd'). Hours, percent, and
 * people don't share the same magnitude ambiguity.
 *
 * Conservative on purpose: only scales UP when the amount is below the
 * relevant threshold (1000 for thousands, 100_000 for millions). A
 * model that already correctly returned 30000 with anchor "30 grand"
 * is not double-scaled.
 *
 * @param {number} amount      The amount the model returned.
 * @param {string} anchorQuote The quote it claims to come from.
 * @param {string} unit        Validated unit string.
 * @returns {number} Adjusted amount.
 */
function normaliseMagnitude(amount, anchorQuote, unit) {
  if (unit !== 'usd') return amount;
  if (!Number.isFinite(amount)) return amount;
  const quote = String(anchorQuote || '').toLowerCase();
  // "30k" / "$30 k" / "thirty k" — \b matching catches a bare K that
  // isn't part of a larger word (e.g. "okay"). "$30K" with no space
  // also matches because \b sits between the digit and the letter.
  const hasThousands =
    /\bgrand\b/.test(quote)
    || /\bthousand\b/.test(quote)
    || /\d\s*k\b/.test(quote);
  const hasMillions =
    /\bmillion\b/.test(quote)
    || /\d\s*m\b/.test(quote);
  if (hasMillions && amount < 100_000) {
    return amount * 1_000_000;
  }
  if (hasThousands && amount < 1_000) {
    return amount * 1_000;
  }
  return amount;
}

/**
 * Lightweight per-entry validator. Mirrors the schema constants
 * above so a malformed model response (missing fields, bad enum
 * value, non-finite amount) is dropped before reaching the
 * factsSheet. Returns `null` when the entry is unusable (caller
 * skips silently) or a normalised entry object when it's safe to
 * append.
 *
 * Magnitude normalisation + implausibility drop run AFTER the
 * structural checks: if any field is malformed we drop unconditionally;
 * only well-formed amounts get the suffix-scaling treatment.
 *
 * Kept hand-rolled to match the rest of the codebase's "no new npm
 * deps" rule.
 */
function validateFact(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (!KIND_VALUES.includes(kind)) return null;

  const rawAmount = Number(raw.amount);
  if (!Number.isFinite(rawAmount)) return null;

  const unit = typeof raw.unit === 'string' ? raw.unit : '';
  if (!UNIT_VALUES.includes(unit)) return null;

  const period = typeof raw.period === 'string' ? raw.period : '';
  if (!PERIOD_VALUES.includes(period)) return null;

  const basis = typeof raw.basis === 'string' ? raw.basis.trim() : '';
  if (!basis) return null;

  const anchorQuote = typeof raw.anchor_quote === 'string' ? raw.anchor_quote.trim() : '';
  // Anchor quote is load-bearing — without it the renderer's drill-
  // through is dead and Stage-2 can't tell apart the two times the
  // same number was stated. Drop facts without one.
  if (!anchorQuote) return null;

  // Apply the magnitude post-processor before any plausibility check —
  // a fact that scales 30 → 30000 via the "grand" suffix is the
  // expected case, not a drop.
  const amount = normaliseMagnitude(rawAmount, anchorQuote, unit);

  // Implausibility drop: monetary kinds that should be in thousands
  // but came in below $5K (after normalisation) are almost always
  // transcription artefacts ("$30 a year" where the speaker said "$30
  // grand a year" but Deepgram lost the suffix AND the anchor lost it
  // too). We'd rather lose the fact than feed Stage-2 a corrupting $30
  // line item. Logged so we can audit false-positives later.
  if (unit === 'usd'
      && amount < 5000
      && IMPLAUSIBILITY_USD_KINDS.has(kind)) {
    console.warn(
      '[facts-scanner] dropped implausible monetary amount',
      amount,
      'for kind',
      kind,
      '— anchor:',
      anchorQuote.slice(0, 80),
    );
    return null;
  }

  const correction = raw.correction === true;
  const supersedesId =
    typeof raw.supersedes_id === 'string' && raw.supersedes_id.trim().length > 0
      ? raw.supersedes_id.trim()
      : null;

  return { kind, amount, unit, period, basis, anchorQuote, correction, supersedesId };
}

/**
 * Build the user-message payload. We include a short PRIOR FACTS list
 * so the model can match `supersedes_id` against an existing entry
 * when the prospect explicitly corrects an earlier figure. The list
 * is intentionally short (last N entries) to keep token cost down —
 * Stage-2 has full visibility for the actual rollup.
 *
 * @param {string} chunk            Transcript chunk to scan.
 * @param {Array<object>} priorFacts  Up to 8 most-recent factsSheet entries.
 */
function buildUserMessage(chunk, priorFacts) {
  const priorJson = priorFacts.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    amount: entry.amount,
    unit: entry.unit,
    period: entry.period,
    basis: entry.basis,
  }));
  return [
    'PRIOR FACTS (most recent ≤8, for matching supersedes_id only):',
    JSON.stringify(priorJson, null, 2),
    '',
    'TRANSCRIPT CHUNK:',
    chunk,
    '',
    'Extract any new facts in the chunk and return JSON only.',
  ].join('\n');
}

/**
 * Construct the periodic facts scanner.
 *
 * @param {{
 *   getNewTranscriptLines: () => string[],
 *   getEntries: () => Array<object>,
 *   appendEntry: (entry: { kind: string, amount: number, unit: string, period: string, basis: string, anchorQuote: string, correction: boolean, supersedesId: string | null }) => void,
 *   onError?: (message: string) => void,
 *   intervalMs?: number,
 * }} deps
 *
 * `getNewTranscriptLines` is the caller-owned source of "since last
 * tick" lines. The scanner tracks no internal index — it simply
 * passes whatever the caller hands back. main.js advances its own
 * cursor on the rolling transcript so the same lines aren't fed back
 * across ticks.
 *
 * `getEntries` returns the live `coachContext.factsSheet.entries`
 * array so the scanner can build the PRIOR FACTS list each tick.
 * Read by reference — a reset that mutates the array in place is
 * picked up automatically next tick.
 *
 * `appendEntry` is the caller's append + rollup hook. Typically wired
 * to push onto `coachContext.factsSheet.entries` and trigger the
 * Stage-2 quick-fix roller. The scanner intentionally does NOT own
 * the rollup scheduling — that responsibility stays with main so
 * teardown can fan-out cleanly.
 */
export function createFactsScanner({ getNewTranscriptLines, getEntries, appendEntry, onError, intervalMs }) {
  if (typeof getNewTranscriptLines !== 'function') {
    throw new Error('facts-scanner: getNewTranscriptLines() is required');
  }
  if (typeof getEntries !== 'function') {
    throw new Error('facts-scanner: getEntries() is required');
  }
  if (typeof appendEntry !== 'function') {
    throw new Error('facts-scanner: appendEntry() is required');
  }
  const errorCb = typeof onError === 'function' ? onError : () => {};
  const tickMs = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;

  let timer = null;
  let inFlight = false;
  let stopped = true;

  async function runOnce() {
    if (stopped) return;
    if (inFlight) {
      // A previous scan is still mid-roundtrip. Skip this tick. The
      // caller's transcript cursor stays put, so the lines we'd have
      // scanned this tick are picked up on the next one.
      return;
    }

    /** @type {string[]} */
    let lines;
    try {
      lines = getNewTranscriptLines() || [];
    } catch (err) {
      console.warn('[facts-scanner] getNewTranscriptLines threw:', err?.message || err);
      return;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    const chunk = lines.join('\n').trim();
    if (chunk.length < 25) {
      // Too short to meaningfully extract from. Skipping is cheaper
      // than firing a roundtrip we'd discard anyway.
      return;
    }

    const { provider: providerName, model } = getQuickFix();
    if (!providerName || !model) {
      console.warn('[facts-scanner] no provider configured — skipping tick');
      return;
    }
    const apiKey = getApiKey(providerName);
    if (!apiKey) {
      console.warn('[facts-scanner] no API key for', providerName, '— skipping tick');
      return;
    }

    let provider;
    try {
      provider = getProvider(providerName, { apiKey, model });
    } catch (err) {
      console.warn('[facts-scanner] failed to construct provider:', err?.message || err);
      return;
    }

    const existing = (() => {
      try {
        const out = getEntries();
        return Array.isArray(out) ? out : [];
      } catch (err) {
        console.warn('[facts-scanner] getEntries threw:', err?.message || err);
        return [];
      }
    })();
    // Trail of 8 keeps the prior-facts payload small enough to be
    // cheap, large enough that a corrected figure stated in the last
    // ~minute (rough cap given typical fact cadence) is still
    // matchable via supersedes_id.
    const priorFacts = existing.slice(-8);

    const userMessage = buildUserMessage(chunk, priorFacts);

    inFlight = true;
    try {
      const result = await provider.generateContent({
        systemInstruction: FACTS_SYSTEM_PROMPT,
        userMessage,
        responseMimeType: 'application/json',
        responseSchema: FACTS_SCHEMA,
      });

      const raw = typeof result?.text === 'string' ? result.text : '';
      if (!raw) return;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn('[facts-scanner] JSON parse failed:', err?.message || err, '— raw:', raw.slice(0, 200));
        return;
      }

      const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
      let appended = 0;
      for (const rawFact of facts) {
        const validated = validateFact(rawFact);
        if (!validated) continue;
        try {
          appendEntry(validated);
          appended += 1;
        } catch (err) {
          console.warn('[facts-scanner] appendEntry threw:', err?.message || err);
        }
      }
      if (appended > 0) {
        console.log('[facts-scanner] appended', appended, 'fact(s) from', lines.length, 'line(s)');
      }
    } catch (err) {
      const message = err?.message || 'facts-scanner roundtrip failed';
      console.warn('[facts-scanner] roundtrip threw:', message);
      errorCb(message);
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(runOnce, tickMs);
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runNow: runOnce };
}
