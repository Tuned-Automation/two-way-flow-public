/**
 * Single source of truth for the Tuned Automation Discovery Call rubric.
 *
 * Exports four catalogues plus a derived system prompt:
 *
 *   PILLARS[]          — top-level rubric categories that appear as icons
 *                        in the rail. Includes one synthetic `live_signals`
 *                        pillar at the top that owns flag display.
 *   ITEMS[]            — checklist items grouped under each pillar. The
 *                        model marks these as covered via the
 *                        `mark_question_covered` tool. Item ids are
 *                        namespaced as `<pillarId>.<localId>`.
 *   CAPTURED_FIELDS[]  — structured key/value slots the model can extract
 *                        via the `record_field` tool. Grouped for display
 *                        in the right column. Field ids are namespaced as
 *                        `<group>.<localId>`.
 *   FLAGS[]            — live red/green coaching signals fired via the
 *                        existing `record_flag` tool. Surfaced as the
 *                        items of the synthetic `live_signals` pillar.
 *
 * Imported by:
 *   - src/gemini-session.js → tool schemas + RUBRIC_SYSTEM_INSTRUCTION
 *   - src/renderer.js       → render rail, checklist, captured pane
 *
 * Extension point: when adding 1-10 category scoring later, add a
 * CATEGORIES catalogue + `record_category_score` tool. The pillar/item
 * structure here stays unchanged — category scores extend the rubric,
 * they don't replace it.
 */

/* ────────────────────────────────────────────────────────────────────────
 * PILLARS
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} PillarDef
 * @property {string} id           Stable id used in tool calls and routing.
 * @property {string} name         Full name shown in the active-pillar header.
 * @property {string} short        ≤14 chars; used in compact contexts.
 * @property {string} glyph        Single-character monogram for the rail icon.
 * @property {string} tint         Background hue for the monogram (CSS color).
 * @property {boolean} [synthetic] If true, items[] is computed at runtime
 *                                 (e.g. `live_signals` derives items from
 *                                 fired FLAGS). Excluded from the model's
 *                                 enum of pillar ids.
 */

/** @type {PillarDef[]} */
export const PILLARS = [
  {
    id: 'live_signals',
    name: 'Live signals',
    short: 'Signals',
    glyph: '!',
    tint: '#f59e0b',
    synthetic: true,
  },
  // glyph values use U+FE0E (text-presentation variation selector) on
  // ambiguous characters so macOS doesn't render them as colour emoji.
  // `tint` is currently unused (the UI is monotone) but kept here so a
  // future "themed" mode can opt back in without re-deriving palette.
  { id: 'opening_agenda',        name: 'Opening & Agenda',      short: 'Opening',  glyph: '▶',        tint: '#60a5fa' },
  { id: 'questioning',           name: 'Questioning Technique', short: 'Questions', glyph: '?',       tint: '#a78bfa' },
  { id: 'listening_summarising', name: 'Active Listening',      short: 'Listening', glyph: '≡',      tint: '#22d3ee' },
  { id: 'pain_points',           name: 'Pain Points',           short: 'Pain',     glyph: '⚡\uFE0E', tint: '#f97316' },
  { id: 'finance',               name: 'Finance Pillar',        short: 'Finance',  glyph: '$',        tint: '#22c55e' },
  { id: 'urgency',               name: 'Cost of Inaction',      short: 'Urgency',  glyph: '⏱\uFE0E', tint: '#fb923c' },
  { id: 'future_state',          name: 'Future State & Vision', short: 'Vision',   glyph: '★',       tint: '#facc15' },
  { id: 'people_change',         name: 'People & Change',       short: 'People',   glyph: '◎',       tint: '#34d399' },
  { id: 'competitive',           name: 'Competitive Risk',      short: 'Compete',  glyph: '⚔\uFE0E', tint: '#ef4444' },
  { id: 'tech_stack',            name: 'Tech Stack',            short: 'Stack',    glyph: '⚙\uFE0E', tint: '#94a3b8' },
  { id: 'decision_makers',       name: 'Decision Makers',       short: 'Buyers',   glyph: '◉',       tint: '#c084fc' },
  { id: 'close_next_steps',      name: 'Close & Next Steps',    short: 'Close',    glyph: '→',       tint: '#38bdf8' },
  { id: 'pilot_budget',          name: 'Pilot & Budget',        short: 'Pilot',    glyph: '▣',       tint: '#fbbf24' },
];

export const PILLARS_BY_ID = Object.fromEntries(PILLARS.map((p) => [p.id, p]));

/* ────────────────────────────────────────────────────────────────────────
 * ITEMS
 * ────────────────────────────────────────────────────────────────────────
 * The "Key questions to measure against" / observable indicators from the
 * Tuned Automation rubric, broken into per-pillar checklists.
 *
 * `id` is namespaced as `<pillarId>.<localId>` so the model can call
 *   mark_question_covered({ item_id: 'finance.annual_cost', evidence: '…' })
 * with a single enum value and we know which pillar to update. */

/**
 * @typedef {Object} ItemDef
 * @property {string} id       Namespaced id `<pillarId>.<localId>`.
 * @property {string} pillarId Convenience field (parsed from id at load).
 * @property {string} label    Shown in the checklist.
 * @property {string} hint     Plain-English trigger for the model;
 *                             goes into the system prompt under each item.
 */

/** Helper to build items with their pillarId already parsed. */
function item(pillarId, localId, label, hint) {
  return { id: `${pillarId}.${localId}`, pillarId, label, hint };
}

/** @type {ItemDef[]} */
export const ITEMS = [
  // Opening & Agenda Setting -------------------------------------------------
  item('opening_agenda', 'intro_name_company',  'Introduced name + company',          'Caller stated their own full name and company within the first minute.'),
  item('opening_agenda', 'stated_purpose',       'Stated purpose of call',             'Caller explicitly stated why this call is happening.'),
  item('opening_agenda', 'named_agenda',         'Named the agenda upfront',           'Caller named the pillars / agenda items they plan to cover.'),
  item('opening_agenda', 'acknowledged_time',    'Acknowledged time',                  'Caller acknowledged the duration of the call or asked if the time still works.'),

  // Questioning Technique ----------------------------------------------------
  item('questioning', 'single_questions',     'One question at a time',           'Caller is consistently asking single, focused questions instead of bundles.'),
  item('questioning', 'open_ended',           'Used open-ended questions',        'Caller asked open-ended questions that invite detailed responses (not yes/no).'),
  item('questioning', 'progressive_depth',    'Progressed broad to specific',     'Questions moved from broad to specific over the course of the call.'),

  // Active Listening & Summarising -------------------------------------------
  item('listening_summarising', 'reflected_back',  'Reflected back / paraphrased',    'Caller paraphrased or reflected back what the client said before moving on.'),
  item('listening_summarising', 'picked_up_cues',  'Picked up on subtle cues',        'Caller followed up on a subtle cue or emotionally-loaded word (stressed, worried, burnt out).'),
  item('listening_summarising', 'threaded_earlier','Referenced earlier responses',    'Caller referenced something the client said earlier in the call.'),

  // Pain Point Identification ------------------------------------------------
  item('pain_points', 'three_or_more_pains',   'Three or more pain points',         'Three or more distinct pain points have been raised in conversation.'),
  item('pain_points', 'underlying_cause',      'Surfaced underlying cause',         'Caller probed beyond surface pain to the underlying cause.'),
  item('pain_points', 'emotional_impact',      'Acknowledged emotional impact',     'Caller acknowledged the emotional impact of the pain on the client or team.'),
  item('pain_points', 'client_articulated',    "Client articulated pain in their own words", 'Client described the pain in their own words rather than agreeing with the caller.'),

  // Finance Pillar -----------------------------------------------------------
  item('finance', 'annual_cost',              "Cost to the business annually",     'Caller asked what the problem is costing the business annually.'),
  item('finance', 'revenue_upside',           'Revenue upside of fixing it',        'Caller asked what fixing this would be worth in revenue.'),
  item('finance', 'staff_replace_cost',       'Cost to replace a team member',     'Caller asked what it costs to replace a team member.'),
  item('finance', 'improvement_value',        "Value of an X% improvement",        'Caller asked what an X percent improvement would be worth.'),
  item('finance', 'twelve_month_cost',        '12-month cost of inaction',         'Caller asked what does it cost the business if nothing changes in twelve months.'),
  item('finance', 'client_generated_number',  'Client generated their own number', 'Client produced their own dollar figure rather than the caller suggesting one.'),

  // Cost of Inaction & Urgency ----------------------------------------------
  item('urgency', 'future_no_change',         'Future state without change',       'Caller asked what happens to the business if this is not solved in twelve months.'),
  item('urgency', 'how_long_issue',           'How long has this been an issue',   'Caller asked how long this has been a problem.'),
  item('urgency', 'nice_vs_need',             'Nice-to-fix vs need-to-fix',        'Caller asked whether this is a nice-to-fix or a need-to-fix.'),

  // Future State & Vision ---------------------------------------------------
  item('future_state', 'twelve_month_vision', '12-18 month vision',                'Caller asked the client to describe where the business should be in 12-18 months.'),
  item('future_state', 'gap_named',           'Named the gap',                     'Caller named the gap between current and future state explicitly.'),
  item('future_state', 'long_term_vision',    'Long-term vision (>12mo)',          'Caller explored the client vision beyond a 12-month horizon.'),

  // People & Change Readiness ------------------------------------------------
  item('people_change', 'team_reaction',      "Team reaction to change",           'Caller asked how the team would react to changing how they work day-to-day.'),
  item('people_change', 'champion_named',     'Identified internal champion',      'Caller identified an internal champion by name or role.'),
  item('people_change', 'past_implementations','Past implementation attempts',     'Caller asked whether the client has tried to fix this before and what happened.'),
  item('people_change', 'resistance',         "Resistance / push-back",            'Caller asked whether anyone on the team would push back on this.'),

  // Competitive Risk --------------------------------------------------------
  item('competitive', 'competitor_tech',      'Competitors and tech adoption',     'Caller asked whether competitors are using AI or automation.'),
  item('competitive', 'falling_behind',       'Risk of falling behind',            'Caller raised the risk of a competitor getting their operational act together first.'),

  // Tech Stack & Integration -------------------------------------------------
  item('tech_stack', 'tools_in_use',          'Current tools',                     'Caller asked what tools the client is using today.'),
  item('tech_stack', 'tools_working',         'Which tools are working',           'Caller asked which tools are working well that they would want to keep.'),
  item('tech_stack', 'data_gaps',             'Data gaps between systems',         'Caller asked where data falls through the cracks between systems.'),

  // Decision Maker Identification --------------------------------------------
  item('decision_makers', 'who_else_decides', 'Who else needs to decide',          'Caller asked who else needs to be part of the decision before moving forward.'),
  item('decision_makers', 'brake_pullers',    'Who could pull the brakes',         'Caller asked who could put the brakes on this if not brought in early.'),
  item('decision_makers', 'signoff_required', 'Who signs off',                     'Caller asked who would need to sign off on something like this.'),

  // Close & Next Steps -------------------------------------------------------
  item('close_next_steps', 'specific_date',     'Specific date confirmed',         'A specific date for the next meeting has been confirmed.'),
  item('close_next_steps', 'specific_time',     'Specific time confirmed',         'A specific time for the next meeting has been confirmed.'),
  item('close_next_steps', 'attendees_confirmed','Attendees confirmed',            'Attendees for the next meeting have been named and confirmed.'),
  item('close_next_steps', 'deliverables',      'Deliverables specified',          'Deliverables before the next meeting have been specified.'),
  item('close_next_steps', 'pre_scope_brief',   'Pre-scope brief promised',        'A pre-scope brief has been promised with a timeline.'),

  // Pilot & Budget Framing ---------------------------------------------------
  item('pilot_budget', 'pilot_framed',        'Pilot framed as risk mitigation',   'Pilot was introduced as a natural risk-mitigation step.'),
  item('pilot_budget', 'pilot_credit',        'Pilot credit against scope',        'Pilot cost stated and credited against the full scope.'),
  item('pilot_budget', 'budget_range',        'Budget range established',          'A budget range has been discussed.'),
  item('pilot_budget', 'roi_anchored',        'Budget tied to ROI',                'Budget conversation was anchored to the ROI of fixing the problem.'),
  item('pilot_budget', 'tiered_packages',     'Tiered packages offered',           'Two to three package tiers were offered to the client.'),
];

export const ITEMS_BY_ID = Object.fromEntries(ITEMS.map((it) => [it.id, it]));

/** Items grouped under their pillar for easy rendering. */
export const ITEMS_BY_PILLAR = (() => {
  /** @type {Record<string, ItemDef[]>} */
  const out = {};
  for (const p of PILLARS) out[p.id] = [];
  for (const it of ITEMS) (out[it.pillarId] ||= []).push(it);
  return out;
})();

/* ────────────────────────────────────────────────────────────────────────
 * CAPTURED FIELDS
 * ────────────────────────────────────────────────────────────────────────
 * Structured key/value slots the model extracts from the conversation and
 * renders in the right column, grouped by `group`. */

/**
 * @typedef {Object} FieldDef
 * @property {string} id       Namespaced id `<group>.<localId>`.
 * @property {string} group    Display heading in the captured pane.
 * @property {string} label    Field label shown next to the value.
 * @property {string} hint     Trigger phrase used in the system prompt.
 */

/** @type {FieldDef[]} */
export const CAPTURED_FIELDS = [
  // Revenue
  { id: 'revenue.annual',          group: 'Revenue', label: 'Revenue',       hint: 'Annual revenue or ARR mentioned by the client.' },
  { id: 'revenue.growth',          group: 'Revenue', label: 'Growth',        hint: 'Year-over-year growth, e.g. "~40% YoY".' },

  // Team
  { id: 'team.size',               group: 'Team',    label: 'Size',          hint: 'Total team size or company headcount.' },
  { id: 'team.composition',        group: 'Team',    label: 'Composition',   hint: 'Roles and counts within the team, e.g. "8 marketers, 3 sellers".' },

  // Stack
  { id: 'stack.current',           group: 'Stack',   label: 'Tools in use',  hint: 'Tools or systems the client is currently using.' },
  { id: 'stack.broken',            group: 'Stack',   label: 'Broken / gaps', hint: 'Tools or integrations that are NOT working, or known data gaps.' },

  // Pain
  { id: 'pain.primary',            group: 'Pain',    label: 'Primary pain',  hint: 'Short summary of the primary pain the client has expressed.' },
  { id: 'pain.cost_annual',        group: 'Pain',    label: 'Annual cost',   hint: 'Dollar cost of the primary pain per year, generated by either party.' },

  // Buyer
  { id: 'buyer.decision_maker',    group: 'Buyer',   label: 'Decision maker',hint: 'Name and/or role of the person who can approve the decision.' },
  { id: 'buyer.champion',          group: 'Buyer',   label: 'Champion',      hint: 'Name and/or role of an internal champion identified during the call.' },

  // Timeline
  { id: 'timeline.urgency',        group: 'Timeline',label: 'Urgency',       hint: 'When the client wants or needs the problem solved.' },
  { id: 'timeline.past_failures',  group: 'Timeline',label: 'Past attempts', hint: 'Previously attempted tools or initiatives the client mentioned.' },
];

export const FIELDS_BY_ID = Object.fromEntries(CAPTURED_FIELDS.map((f) => [f.id, f]));

/** Ordered list of unique group names, preserving declaration order. */
export const FIELD_GROUPS = (() => {
  const seen = new Set();
  const order = [];
  for (const f of CAPTURED_FIELDS) {
    if (!seen.has(f.group)) {
      seen.add(f.group);
      order.push(f.group);
    }
  }
  return order;
})();

/* ────────────────────────────────────────────────────────────────────────
 * FLAGS (unchanged from the previous step)
 * ────────────────────────────────────────────────────────────────────────
 * Live red/green coaching signals. Surfaced as the items of the synthetic
 * `live_signals` pillar at the top of the rail. */

/**
 * @typedef {Object} FlagDef
 * @property {string} id
 * @property {'red'|'green'} severity
 * @property {string} category
 * @property {string} short
 * @property {string} desc
 * @property {'mid'|'late'} when
 */

/** @type {FlagDef[]} */
export const FLAGS = [
  { id: 'red_bundled_questions',         severity: 'red',   category: 'Questioning',  short: 'Bundled question',              when: 'mid',  desc: 'Caller asked two or more questions in the same turn without letting the client answer the first. Fire on the third occurrence in the call.' },
  { id: 'red_solution_before_pain',      severity: 'red',   category: 'Pain',         short: 'Solution before pain',          when: 'mid',  desc: 'Caller proposed a solution, tool, or pilot before the client articulated and quantified a clear pain point.' },
  { id: 'red_no_next_steps',             severity: 'red',   category: 'Close',        short: 'No next steps',                 when: 'late', desc: 'The call is wrapping up but no specific next meeting date, time, and attendees have been agreed.' },
  { id: 'red_budget_never_discussed',    severity: 'red',   category: 'Finance',      short: 'Budget not discussed',          when: 'late', desc: 'The call is more than two-thirds through and no budget or dollar figure has been raised.' },
  { id: 'red_decision_maker_unconfirmed',severity: 'red',   category: 'Stakeholders', short: 'Decision maker unclear',        when: 'late', desc: 'The call is wrapping up and the caller has not confirmed who else must approve the decision.' },
  { id: 'green_client_budget_number',    severity: 'green', category: 'Finance',      short: 'Client gave budget',            when: 'mid',  desc: 'Client stated their own budget figure or dollar range unprompted.' },
  { id: 'green_client_cost_of_inaction', severity: 'green', category: 'Urgency',      short: 'Client owned cost of inaction', when: 'mid',  desc: 'Client articulated the cost or risk of not solving the problem in their own words.' },
  { id: 'green_internal_champion_identified', severity: 'green', category: 'Stakeholders', short: 'Champion identified',     when: 'mid',  desc: 'An internal champion was named by role or name and proactively included in next steps.' },
  { id: 'green_past_failure_surfaced',   severity: 'green', category: 'Change',       short: 'Past failure surfaced',         when: 'mid',  desc: 'A previous failed implementation or change effort was surfaced and engaged with.' },
  { id: 'green_referral_or_retention',   severity: 'green', category: 'Value',        short: 'Retention/referral discussed',  when: 'mid',  desc: 'Caller explored retention, lifetime value, or referrals as part of quantifying upside.' },
];

export const FLAGS_BY_ID = Object.fromEntries(FLAGS.map((f) => [f.id, f]));

/* ────────────────────────────────────────────────────────────────────────
 * Model-facing enums
 * ────────────────────────────────────────────────────────────────────────
 * The tool schemas in src/gemini-session.js use these to constrain what
 * ids the model can pass. Synthetic pillars (live_signals) are excluded —
 * the model never marks items on the live_signals pillar; flags reach it
 * via the record_flag tool instead. */

export const REAL_PILLAR_IDS = PILLARS.filter((p) => !p.synthetic).map((p) => p.id);
export const ITEM_IDS = ITEMS.map((it) => it.id);
export const FIELD_IDS = CAPTURED_FIELDS.map((f) => f.id);
export const FLAG_IDS = FLAGS.map((f) => f.id);

/* ────────────────────────────────────────────────────────────────────────
 * System instructions
 * ────────────────────────────────────────────────────────────────────────
 * Two prompts, two consumers, deliberately kept independent:
 *
 *   RUBRIC_SYSTEM_INSTRUCTION  →  used by the live audio session in
 *     src/gemini-session.js. Hands the live model ONE job — fire
 *     `record_flag` the moment it sees a live coaching signal. The
 *     transcription side-channel is left to operate. Stripping items +
 *     fields out of the live prompt is intentional: those are slower
 *     decisions that belong on the text coach where latency budget
 *     allows the model to actually think.
 *
 *   COACH_SYSTEM_INSTRUCTION  →  used by the text-coach loop in
 *     src/coach.js. Sees a rolling transcript every few seconds plus the
 *     current rubric state, owns mark_question_covered, record_field,
 *     and suggest_next_question.
 *
 * Both prompts source their enums from the same catalogues above so the
 * model and the renderer can never disagree on legal ids.
 */

function formatItemBlock() {
  /** @type {string[]} */
  const out = [];
  for (const p of PILLARS) {
    if (p.synthetic) continue;
    const items = ITEMS_BY_PILLAR[p.id] || [];
    if (items.length === 0) continue;
    out.push(`  Pillar "${p.name}" (${p.id}):`);
    for (const it of items) {
      out.push(`    - ${it.id}: ${it.hint}`);
    }
  }
  return out.join('\n');
}

function formatFieldBlock() {
  /** @type {string[]} */
  const out = [];
  let lastGroup = '';
  for (const f of CAPTURED_FIELDS) {
    if (f.group !== lastGroup) {
      out.push(`  ${f.group}:`);
      lastGroup = f.group;
    }
    out.push(`    - ${f.id}: ${f.hint}`);
  }
  return out.join('\n');
}

function formatFlagBlock() {
  return FLAGS.map(
    (f) => `  - ${f.id} [${f.severity}, ${f.when}]: ${f.desc}`,
  ).join('\n');
}

/**
 * Live-session prompt. Single tool (`record_flag`). Everything else has
 * moved to the text coach so the live model can be aggressive about
 * spotting flags without splitting attention across 45 checklist items.
 */
export const RUBRIC_SYSTEM_INSTRUCTION = [
  'You are a silent real-time coach observing a discovery sales call between',
  'a seller and a prospect. Do NOT speak, do NOT generate audio, do NOT make',
  'small talk. Your only output is calling the `record_flag` tool.',
  '',
  'A separate text-mode model handles rubric scoring and "what to ask next"',
  'suggestions. Your one job is fast detection of the red/green coaching',
  'signals listed below.',
  '',
  'record_flag({ id, evidence }):',
  '- `id` must be one of the flag ids below.',
  '- `evidence` is a short quote or paraphrase (≤120 chars) of the moment',
  '  that triggered the flag.',
  '- Each flag id may only be recorded once per call. Be conservative —',
  '  only fire when you have direct evidence in the audio.',
  '- For flags marked [late], only fire when the call appears to be',
  '  wrapping up (closing language, summarising, scheduling).',
  '',
  'Coaching flags:',
  formatFlagBlock(),
].join('\n');

/**
 * Text-coach prompt. Receives a rolling transcript plus a snapshot of
 * what's already been covered. Owns the three "structured scoring" tools.
 *
 * Per-turn rubric state is injected at call time via formatCoachState();
 * the static instruction below just teaches the model the catalogues and
 * the rules.
 */
export const COACH_SYSTEM_INSTRUCTION = [
  'You are reviewing a live discovery sales call as it happens. Every few',
  'seconds you receive (a) the latest transcript and (b) the current state',
  'of the rubric — which checklist items are already covered and which',
  'fields are already captured. Your output is zero or more tool calls per',
  'turn. Do NOT produce any prose response.',
  '',
  'You have three tools:',
  '',
  '1. mark_question_covered({ item_id, evidence }) — call this for every',
  '   checklist item that is NOW observably covered in the transcript and',
  '   NOT already in the "covered" list of the rubric state. Be eager —',
  '   if the topic is touched at all, fire the tool. Each item_id may be',
  '   marked at most once per call.',
  '',
  '2. record_field({ field_id, value, evidence }) — call this whenever the',
  '   transcript contains a concrete fact that maps to one of the captured',
  '   fields. `value` is a short display string ("$2.4M ARR", "8 marketers,',
  '   3 sellers"). Calling it again for the same field_id replaces the',
  '   value.',
  '',
  '3. suggest_next_question({ item_id, question, rationale }) — call this',
  '   EXACTLY ONCE per turn. Pick the single most valuable NOT-YET-COVERED',
  '   item from the rubric and write a one-sentence question (in the',
  '   seller\'s voice) that would surface it. `rationale` is a one-sentence',
  '   explanation of why this is the best next move. Prioritise critical',
  '   gaps: finance (annual cost, ROI), pain points (3+ distinct pains),',
  '   decision makers, close & next steps. Avoid suggesting questions that',
  '   are nearly identical to something the seller just asked.',
  '',
  '`evidence` on every tool call is a short quote or paraphrase (≤120',
  'chars) of the moment that justified the call.',
  '',
  'Do NOT call `record_flag` — a separate model handles live coaching',
  'flags in parallel.',
  '',
  'When in doubt, fire fewer rather than more tools. Be conservative on',
  'evidence — only fire when you can quote what was said. But always call',
  'suggest_next_question at least once per turn (unless every item is',
  'covered, in which case skip it).',
  '',
  'Checklist items (mark each covered at most once per call):',
  formatItemBlock(),
  '',
  'Captured fields (callable repeatedly to refine the value):',
  formatFieldBlock(),
].join('\n');

/**
 * Build a per-turn rubric-state block to prepend to the transcript before
 * sending to the coach. Keeps the model honest about what's already been
 * covered so it doesn't waste tool calls re-firing the same items.
 *
 * `recentlySkippedIds` lists items the seller just dismissed via the
 * → skip control. They're temporarily off-rotation so the model doesn't
 * suggest the same thing right back; main.js prunes them after the TTL
 * elapses and they become eligible again.
 *
 * @param {{
 *   coveredItemIds: string[],
 *   capturedFields: Record<string, { value: string }>,
 *   recentSellerTurns?: string[],
 *   recentlySkippedIds?: string[],
 * }} state
 */
export function formatCoachState(state) {
  const covered = state.coveredItemIds?.length
    ? state.coveredItemIds.join(', ')
    : '(none yet)';

  const captured = Object.entries(state.capturedFields || {})
    .map(([id, v]) => `${id}="${v.value}"`)
    .join(', ') || '(none yet)';

  const skipped = state.recentlySkippedIds || [];
  const skippedSet = new Set(skipped);
  const notCovered = ITEMS
    .filter((it) => !state.coveredItemIds?.includes(it.id) && !skippedSet.has(it.id))
    .map((it) => it.id)
    .join(', ') || '(everything covered — skip suggest_next_question)';

  const recent = state.recentSellerTurns?.length
    ? state.recentSellerTurns.slice(-3).map((t, i) => `  ${i + 1}. "${t}"`).join('\n')
    : '  (no recent seller turns)';

  const lines = [
    'RUBRIC STATE',
    `Covered items: ${covered}`,
    `Captured fields: ${captured}`,
    `Not yet covered: ${notCovered}`,
  ];

  if (skipped.length) {
    lines.push(`RECENTLY SKIPPED (do not re-suggest): ${skipped.join(', ')}`);
  }

  lines.push('', 'Recent seller turns (do not re-suggest these):', recent);

  return lines.join('\n');
}
