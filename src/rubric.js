/**
 * Single source of truth for the Tuned Automation Discovery Call rubric.
 *
 * Exports four catalogues plus a derived system prompt:
 *
 *   PILLARS[]          — top-level rubric categories that appear as icons
 *                        in the rail. Includes one synthetic `live_signals`
 *                        pillar at the top that owns flag display.
 *   ITEMS[]            — checklist items grouped under each pillar. The
 *                        text coach transitions these through the
 *                        4-state lifecycle (pending → in_progress →
 *                        covered, plus the side-state `logged`) via
 *                        the `update_item_state` tool. Item ids are
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
  // Synthetic "logged" pillar — aggregates any items currently in the
  // `logged` state across all pillars (i.e. partially addressed but
  // not closed out yet). Mirrors live_signals but is fed from
  // state.itemStates rather than state.flags. The Coach never marks
  // items on this pillar directly; the renderer derives its body at
  // render time.
  {
    id: 'logged_questions',
    name: 'Logged questions',
    short: 'Logged',
    glyph: '↺',
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
 *   update_item_state({ item_id: 'finance.annual_cost', state: 'covered', evidence: '…', confidence: 85 })
 * with a single enum value and we know which pillar to update. */

/**
 * @typedef {Object} ItemDef
 * @property {string} id           Namespaced id `<pillarId>.<localId>`.
 * @property {string} pillarId     Convenience field (parsed from id at load).
 * @property {string} label        Shown in the checklist.
 * @property {string} hint         Plain-English trigger for the model;
 *                                 goes into the system prompt under each item.
 * @property {boolean} [suggestable] When false, this item is excluded from
 *                                 the `suggest_next_question` tool's enum
 *                                 so the coach can never pick it as the
 *                                 next thing for the seller to ASK. The
 *                                 item is still scored normally via
 *                                 `update_item_state` — `suggestable` only
 *                                 gates the question-suggestion path.
 *                                 Default true. Set to false for items
 *                                 that describe seller BEHAVIOUR (e.g.
 *                                 "Introduced name + company", "Used
 *                                 open-ended questions", "Specific date
 *                                 confirmed") — those don't translate
 *                                 into a question the seller would speak
 *                                 to the prospect.
 *
 * Item state lifecycle (NOT stored on the rubric itself — see
 * coachContext.itemStates in main.js and state.itemStates in renderer.js):
 *   pending     — default. No transcript evidence yet.
 *   in_progress — seller is approaching the question (just asked,
 *                 mid-question, or topic surfaced but not yet
 *                 answered).
 *   covered     — asked, answered substantively, and the conversation
 *                 has moved on. Terminal positive state.
 *   logged      — topic was touched but not closed out — either the
 *                 seller didn't ask cleanly, the prospect didn't
 *                 answer fully, or the thread was dropped. Surfaces in
 *                 the synthetic `logged_questions` pillar so the
 *                 seller can circle back.
 */

/** Helper to build items with their pillarId already parsed.
 *  Pass `suggestable: false` for behaviour/action items that should be
 *  scored but never offered as a "next question to ask". */
function item(pillarId, localId, label, hint, { suggestable = true } = {}) {
  return { id: `${pillarId}.${localId}`, pillarId, label, hint, suggestable };
}

/** @type {ItemDef[]} */
export const ITEMS = [
  // Opening & Agenda Setting -------------------------------------------------
  // Behaviour items (seller does, not asks) — scored but never suggested.
  // `stated_purpose` stays suggestable: a question like "Mind if I share
  // what I'm hoping we cover today?" is a legitimate spoken move.
  item('opening_agenda', 'intro_name_company',  'Introduced name + company',          'Caller stated their own first name (or full name) AND their company name early in the call.', { suggestable: false }),
  item('opening_agenda', 'stated_purpose',       'Stated purpose of call',             'Caller stated why this call is happening (the purpose / what they want to achieve).'),
  item('opening_agenda', 'named_agenda',         'Named the agenda upfront',           'Caller named the pillars / agenda items they plan to cover.', { suggestable: false }),
  item('opening_agenda', 'acknowledged_time',    'Acknowledged time',                  'Caller acknowledged the duration of the call or asked if the time still works.', { suggestable: false }),

  // Questioning Technique — these are behaviour patterns across the whole
  // call, not single questions. Scored, but never suggested.
  item('questioning', 'single_questions',     'One question at a time',           'Caller is consistently asking single, focused questions instead of bundles.', { suggestable: false }),
  item('questioning', 'open_ended',           'Used open-ended questions',        'Caller asked open-ended questions that invite detailed responses (not yes/no).', { suggestable: false }),
  item('questioning', 'progressive_depth',    'Progressed broad to specific',     'Questions moved from broad to specific over the course of the call.', { suggestable: false }),

  // Active Listening & Summarising — also behaviour patterns. Same rule.
  item('listening_summarising', 'reflected_back',  'Reflected back / paraphrased',    'Caller paraphrased or reflected back what the client said before moving on.', { suggestable: false }),
  item('listening_summarising', 'picked_up_cues',  'Picked up on subtle cues',        'Caller followed up on a subtle cue or emotionally-loaded word (stressed, worried, burnt out).', { suggestable: false }),
  item('listening_summarising', 'threaded_earlier','Referenced earlier responses',    'Caller referenced something the client said earlier in the call.', { suggestable: false }),

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

  // Close & Next Steps — confirmations & seller commitments, not asks the
  // seller would phrase as a spoken question to the prospect. Scored, but
  // never suggested.
  item('close_next_steps', 'specific_date',     'Specific date confirmed',         'A specific date for the next meeting has been confirmed.', { suggestable: false }),
  item('close_next_steps', 'specific_time',     'Specific time confirmed',         'A specific time for the next meeting has been confirmed.', { suggestable: false }),
  item('close_next_steps', 'attendees_confirmed','Attendees confirmed',            'Attendees for the next meeting have been named and confirmed.', { suggestable: false }),
  item('close_next_steps', 'deliverables',      'Deliverables specified',          'Deliverables before the next meeting have been specified.', { suggestable: false }),
  item('close_next_steps', 'pre_scope_brief',   'Pre-scope brief promised',        'A pre-scope brief has been promised with a timeline.', { suggestable: false }),

  // Pilot & Budget Framing — `pilot_framed`, `pilot_credit`, `tiered_packages`
  // are seller-led offers/framings (no question to ask). `budget_range` and
  // `roi_anchored` stay suggestable because the elicit reading is real
  // ("What budget range have you set aside for this?").
  item('pilot_budget', 'pilot_framed',        'Pilot framed as risk mitigation',   'Pilot was introduced as a natural risk-mitigation step.', { suggestable: false }),
  item('pilot_budget', 'pilot_credit',        'Pilot credit against scope',        'Pilot cost stated and credited against the full scope.', { suggestable: false }),
  item('pilot_budget', 'budget_range',        'Budget range established',          'A budget range has been discussed.'),
  item('pilot_budget', 'roi_anchored',        'Budget tied to ROI',                'Budget conversation was anchored to the ROI of fixing the problem.'),
  item('pilot_budget', 'tiered_packages',     'Tiered packages offered',           'Two to three package tiers were offered to the client.', { suggestable: false }),
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

/**
 * @type {FieldDef[]}
 *
 * MONETARY CAPTURE LIVES ELSEWHERE — STRATEGY A (post-test-call fixes):
 *
 * Previously this list included `revenue.annual` and
 * `pain.cost_annual` for the coach to drop dollar figures into via
 * `record_field`. That fed the legacy regex "Total potential
 * revenue" rollup in the renderer, which (a) couldn't tell apart
 * client revenue from pain cost, (b) silently double-counted, and
 * (c) re-displayed a number that changed every time the same fact
 * was restated.
 *
 * Replaced by the two-stage AI pipeline in src/quick-fix.js. ALL
 * monetary / quantitative-opportunity captures (current spend, pain
 * cost, savings, revenue uplift, time cost, headcount cost) now flow
 * through the `record_meeting_fact` tool declared in src/coach.js;
 * a debounced background worker rolls the structured facts up into
 * the renderer's `#quickFix` panel.
 *
 * `revenue.growth` STAYS here — it's a percentage descriptor, doesn't
 * contribute to a dollar sum, and has a natural home in the captured-
 * field grid alongside the other non-aggregable text descriptors.
 */
export const CAPTURED_FIELDS = [
  // Revenue (descriptor only — revenue.annual moved to record_meeting_fact)
  { id: 'revenue.growth',          group: 'Revenue', label: 'Growth',        hint: 'Year-over-year growth, e.g. "~40% YoY".' },

  // Team
  { id: 'team.size',               group: 'Team',    label: 'Size',          hint: 'Total team size or company headcount.' },
  { id: 'team.composition',        group: 'Team',    label: 'Composition',   hint: 'Roles and counts within the team, e.g. "8 marketers, 3 sellers".' },

  // Stack
  { id: 'stack.current',           group: 'Stack',   label: 'Tools in use',  hint: 'Tools or systems the client is currently using.' },
  { id: 'stack.broken',            group: 'Stack',   label: 'Broken / gaps', hint: 'Tools or integrations that are NOT working, or known data gaps.' },

  // Pain (descriptor only — pain.cost_annual moved to record_meeting_fact)
  { id: 'pain.primary',            group: 'Pain',    label: 'Primary pain',  hint: 'Short summary of the primary pain the client has expressed.' },

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

/** Ids of items that the `suggest_next_question` tool is allowed to pick.
 *  Excludes items flagged `suggestable: false` — typically seller-behaviour
 *  or seller-action items (e.g. "Introduced name + company", "Used
 *  open-ended questions", "Specific date confirmed") that don't translate
 *  cleanly into a spoken question for the prospect. Those items still
 *  participate in scoring via `update_item_state`. */
export const SUGGESTABLE_ITEM_IDS = ITEMS
  .filter((it) => it.suggestable !== false)
  .map((it) => it.id);

/* ────────────────────────────────────────────────────────────────────────
 * Sentinel item ids for non-rubric suggestions
 * ────────────────────────────────────────────────────────────────────────
 * The redesigned coach can occasionally return a "freeform" suggestion
 * that doesn't map to any rubric item:
 *   - `freeform.deeper` — used by the Deeper button when the natural
 *     follow-up on the prospect's last turn has no rubric counterpart.
 *   - `freeform.recap`  — used by the Recap button. Recaps are always
 *     freeform; they enumerate 2–4 recent prospect themes and aren't
 *     a "next question" against any single rubric item.
 *
 * The renderer treats these ids as opaque (no lookup in ITEMS_BY_ID).
 * The suggestion card still renders the question + anchor quote; it
 * just doesn't surface a pillar badge or item association.
 */
export const SUGGESTION_SENTINEL_ITEM_IDS = ['freeform.deeper', 'freeform.recap'];

/** Combined enum for the `suggest_next_question` tool's `item_id`
 *  parameter — SUGGESTABLE rubric ids (behaviour items excluded) plus the
 *  freeform sentinels above. All other tools (update_item_state,
 *  record_field) keep using the strict ITEM_IDS / FIELD_IDS enums so
 *  scoring is still allowed on every item. */
export const SUGGESTION_ITEM_IDS = [...SUGGESTABLE_ITEM_IDS, ...SUGGESTION_SENTINEL_ITEM_IDS];

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
 *     src/coach.js. Sees a rolling transcript every 1.5s plus the
 *     current rubric state, owns update_item_state, record_field,
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
  'You are reviewing a live discovery sales call as it happens. Every',
  '1.5s you receive (a) the latest transcript and (b) the current state',
  'of the rubric — which checklist items are in which state and which',
  'fields are already captured. Your output is zero or more tool calls',
  'per turn. Do NOT produce any prose response.',
  '',
  'SPEAKER ATTRIBUTION (CRITICAL — read this carefully):',
  'Every transcript line is prefixed with the speaker label:',
  '  - "You: …"      means the SALESPERSON spoke this line.',
  '  - "Prospect: …" means the PROSPECT (the client on the other end',
  '                  of the call) spoke this line.',
  '',
  'Both labels are populated by a per-channel speech-to-text pipeline',
  '— they are reliable and you can treat them as ground truth. Use the',
  'labels to apply these rules:',
  '',
  '  • Only mark a rubric item as `covered` when BOTH conditions hold:',
  '    1. The SALESPERSON ("You:") clearly asked the question for that',
  '       item, AND',
  '    2. The PROSPECT ("Prospect:") answered substantively (not "yeah",',
  '       "uh-huh", or a deflection) AND the conversation has moved on.',
  '    A salesperson assertion without a prospect answer is NEVER',
  '    enough to mark an item covered.',
  '',
  '  • Mark an item `in_progress` when the SALESPERSON is approaching',
  '    the question — they just raised the topic, are mid-phrasing,',
  '    or asked it but the prospect has not yet answered substantively.',
  '',
  '  • Mark an item `logged` when the question was partially addressed',
  '    but never fully closed out — e.g. the prospect deflected ("we',
  '    can talk about that later"), gave a non-answer, or the seller',
  '    moved on before pinning the answer down.',
  '',
  '  • `record_field` should ONLY capture facts the PROSPECT actually',
  '    volunteered. Numbers, names, tools, and timelines the SALESPERSON',
  '    guessed at, hypothesised, or proposed are NOT facts about the',
  '    prospect — do not record them. If the prospect confirmed a',
  '    figure the seller suggested ("yes, around $2M"), that counts as',
  '    the prospect volunteering it.',
  '',
  'Every checklist item lives in one of four states:',
  '  - pending     — default. No transcript evidence yet. The model',
  '                  never explicitly sets this state; absence from',
  '                  the state map IS pending.',
  '  - in_progress — the SELLER is approaching this question: they',
  '                  just opened it, are mid-question, or the topic',
  '                  was raised but the PROSPECT has not yet answered',
  '                  substantively.',
  '  - covered     — the SELLER asked the question AND the PROSPECT',
  '                  answered substantively AND the conversation has',
  '                  moved on. This is the terminal positive state',
  '                  and the highest bar — be conservative.',
  '  - logged      — the topic was touched but not closed out: the',
  '                  seller did not ask cleanly, the prospect did not',
  '                  answer fully, or the thread was dropped. Use',
  '                  this when something is "kind of" addressed but',
  '                  the seller should circle back. Items in this',
  '                  state appear in a dedicated "Logged" pillar in',
  '                  the UI so the seller can boost them later.',
  '',
  'You have four core tools, plus one optional gated tool:',
  '',
  '1. update_item_state({ item_id, state, evidence, confidence }) —',
  '   call this whenever an item should transition to a new state',
  '   based on transcript evidence. `state` must be one of',
  '   "in_progress" | "covered" | "logged" (never "pending"; absence',
  '   from the state map IS pending). `confidence` is 0-100 — be',
  '   honest, the renderer surfaces low-confidence transitions',
  '   visually. State transitions are monotonic-ish:',
  '     • pending → in_progress when the seller starts approaching',
  '       the question.',
  '     • in_progress → covered ONLY when asked-by-You + answered-by-',
  '       Prospect + moved on.',
  '     • in_progress → logged when the topic was touched but the',
  '       seller dropped it without a substantive answer.',
  '     • covered → (nothing). Once covered, the item is done.',
  '     • Any other transition is unusual; prefer not firing over',
  '       firing a confusing transition.',
  '',
  '2. record_field({ field_id, value, evidence }) — call this whenever',
  '   the PROSPECT volunteers a concrete fact that maps to one of the',
  '   captured fields. `value` is a short display string ("40% YoY",',
  '   "8 marketers, 3 sellers"). Calling it again for the same',
  '   field_id replaces the value. Do NOT record facts the seller',
  '   guessed at unless the prospect confirmed them.',
  '',
  '   IMPORTANT: NEVER use `record_field` for dollar amounts or any',
  '   quantitative opportunity figure (spend, pain cost, savings,',
  '   revenue lift, time cost, headcount cost). Those go through the',
  '   separate `record_meeting_fact` tool below so the structured',
  '   roll-up can aggregate them correctly. For example, if the',
  '   prospect says "we lose about $50K a year to manual reporting",',
  '   call record_meeting_fact (not record_field) — there is no',
  '   field_id in the enum for that anyway. record_field is for',
  '   non-aggregable text descriptors only (team size, tools in use,',
  '   primary pain summary, growth %, decision-maker name, etc.).',
  '',
  '3. record_meeting_fact({ kind, amount, unit, period, basis,',
  '   anchor_quote, supersedes_id? }) — call this whenever the prospect',
  '   states a quantitative figure that affects the total economic',
  '   opportunity of the deal. Examples: current spend on a tool, hours',
  '   lost per week, headcount on a process, expected revenue lift,',
  '   pain cost per year. Each call adds a new entry to a structured',
  '   facts sheet that a separate background AI rolls up into a total',
  '   annual opportunity for the rep.',
  '',
  '   Field rules:',
  '     - kind: one of "current_spend", "pain_cost",',
  '       "savings_opportunity", "revenue_uplift", "time_cost",',
  '       "headcount_cost", "other". Pick the closest match — when in',
  '       doubt prefer "other" over guessing.',
  '     - amount: the raw number AS STATED (not converted). So',
  '       "$50K/yr" → 50000; "10 hours a week" → 10.',
  '     - unit: one of "usd", "hours", "people", "percent". Pick the',
  '       unit that matches the number you put in `amount`.',
  '     - period: one of "one_time", "weekly", "monthly", "quarterly",',
  '       "annual". When the prospect says "we lose 10 hours a week"',
  '       that\'s {amount: 10, unit: "hours", period: "weekly"} — let',
  '       the rollup do the annualisation; don\'t multiply yourself.',
  '     - basis: one short sentence explaining what the number',
  '       represents ("Annual spend on the current automation tool").',
  '     - anchor_quote: REQUIRED. Direct quote from the transcript',
  '       (≤120 chars) where this number was stated. The renderer',
  '       uses the quote to scroll the transcript to the source when',
  '       the rep clicks the row. If you can\'t anchor the quote',
  '       cleanly, DO NOT call this tool.',
  '     - supersedes_id: optional. If the prospect just CORRECTED an',
  '       earlier fact ("actually it\'s closer to $80K, not $50K"),',
  '       pass the earlier entry\'s id here so the rollup ignores the',
  '       stale value. Otherwise omit it.',
  '',
  '   Restate-vs-correct rule: when the prospect repeats a figure they',
  '   already gave, do NOT fire a new fact unless the figure has',
  '   actually changed. The rollup is debounced and will re-run on the',
  '   next genuine new fact.',
  '',
  '4. suggest_next_question({ item_id, question, rationale,',
  '   anchor_quote }) — only included in your tool list when the rep',
  '   has explicitly asked for a suggestion (or, in Automated mode,',
  '   when a natural pause is detected). When this tool IS available,',
  '   call it exactly ONCE per turn — but the prompt will tell you',
  '   which "mode" the ask is in, and that changes how you choose the',
  '   question. CONTEXT-FIRST RULES (read these every time):',
  '',
  '   a. FIRST, read the last 2-3 turns of the transcript. What did',
  '      the prospect just say? What did the seller just say? What is',
  '      the conversational beat we are actually on right now?',
  '',
  '   b. THEN, ask yourself: what would a senior salesperson do next',
  '      here? If the prospect just shared a pain point, the natural',
  '      follow-up is "what is this costing you", NOT a pivot to',
  '      budget. If the prospect just answered a finance question,',
  '      the natural beat may be to anchor it back to pain or to',
  '      explore impact. The rubric is a checklist of important',
  '      questions across the call — it is NOT a script for the next',
  '      thirty seconds.',
  '',
  '   c. THEN, check the rubric. If the natural next move happens to',
  '      map to a not-yet-covered rubric item, use that item_id. If',
  '      it does NOT map (because the natural follow-up is too',
  '      conversational / specific to what was just said), evaluate',
  '      whether the natural follow-up is more valuable than picking',
  '      from the rubric backlog. USUALLY IT IS. In the `deeper`',
  '      mode specifically, you may use the sentinel item id',
  '      "freeform.deeper" when no rubric item fits.',
  '',
  '   d. `anchor_quote` (REQUIRED, ≤120 chars) is a short quote from',
  '      the transcript showing the moment the suggestion is',
  '      responding to. The renderer surfaces it under the suggestion',
  '      as "responding to: …" so the rep can see why this is the',
  '      next move. IF YOU CANNOT FIND AN ANCHOR, the suggestion is',
  '      probably weak — output nothing rather than guess. Better to',
  '      stay silent than to surface a generic suggestion that does',
  '      not respond to what was actually just said.',
  '      In `deeper` mode the anchor MUST come from a PROSPECT turn',
  '      (a "Prospect: …" line). For `next` / `pivot` / `pause`,',
  '      anchor on whichever speaker most recently moved the',
  '      conversation.',
  '',
  '   HARD RULES on the `question` and `rationale` fields — these are',
  '   the main reason this tool ships bad output, so read them every',
  '   time:',
  '',
  '   • The `question` field is the LITERAL SENTENCE THE SELLER',
  '     SPEAKS ALOUD TO THE PROSPECT. It is the script. It is what',
  '     comes out of the seller\'s mouth next.',
  '',
  '   • The `question` MUST satisfy ALL of:',
  '       - Addressed to the PROSPECT as "you" (e.g.',
  '         "What\'s your biggest pain point right now?"). NEVER',
  '         addressed at the seller ("Could you introduce yourself?",',
  '         "Try asking about pain points" — these are forbidden,',
  '         they are coaching instructions, not a script).',
  '       - Phrased as a real spoken question. End with a question',
  '         mark.',
  '       - ≤25 words. Conversational, not a paragraph.',
  '       - Answerable by the prospect — a fact, opinion, story, or',
  '         number they can actually share. Not a self-directed',
  '         reminder, behaviour note, or stage direction.',
  '',
  '   • The `rationale` field is for the seller\'s eyes only. It',
  '     explains, in ONE short sentence (≤1 sentence), WHY this is',
  '     the highest-value move right now. Do NOT restate the',
  '     question. Do NOT describe what the seller "could" or "should"',
  '     do — that\'s the question\'s job.',
  '',
  '   • If you cannot construct a real spoken question from the',
  '     available items and the current conversational beat, OUTPUT',
  '     NOTHING. Do NOT invent a meta-instruction. Silence is the',
  '     correct answer when the rubric backlog only contains items',
  '     that map to seller behaviour (introducing themselves, naming',
  '     an agenda, confirming a date, etc.) — those items are scored',
  '     but never suggested, and the tool\'s `item_id` enum already',
  '     excludes them. If nothing in the enum fits the moment, stay',
  '     silent.',
  '',
  '   The prompt may include a "DIRECTIVE (this turn only)" block',
  '   right after the rubric state. Honour it — it tells you whether',
  '   this is a `next` / `deeper` / `pivot` / `pause` request and',
  '   nudges your selection logic accordingly.',
  '',
  '   - `next`   = highest-priority not-yet-covered rubric item.',
  '   - `deeper` = follow-up on the most recent prospect turn(s);',
  '                may use the freeform.deeper sentinel.',
  '   - `pivot`  = change topic to a different pillar with low',
  '                coverage that has not been touched recently;',
  '                always tag with a real rubric item id.',
  '   - `pause`  = same as `next`, but bias toward a low-pressure,',
  '                easy-to-answer question (the rep has gone quiet).',
  '                Rationale rules unchanged — explain WHY this is the',
  '                right move given the last beat; no stage directions.',
  '   - When a "TARGETED_ITEM: <id>" line is present after the',
  '     DIRECTIVE block, that means the seller asked for a question',
  '     for that specific item id. Use that id verbatim. Do not pick',
  '     a different one.',
  '',
  '   `rationale` is a one-sentence explanation of why this is the',
  '   best next move RIGHT NOW given the conversational beat. Avoid',
  '   suggesting questions that are nearly identical to something',
  '   the seller just asked.',
  '',
  '   EXAMPLES — read these to calibrate the shape of `question`:',
  '',
  '   GOOD (real spoken questions, addressed to the prospect):',
  '     - item_id: finance.annual_cost',
  '       question: "What would you say this is costing the business',
  '         each year?"',
  '       rationale: "They just admitted ops is bleeding time —',
  '         anchor it in dollars before moving on."',
  '     - item_id: decision_makers.who_else_decides',
  '       question: "Who else on your side would need to weigh in',
  '         before this moves forward?"',
  '       rationale: "We\'re late in the call and have no map of the',
  '         buying committee."',
  '     - item_id: pain_points.underlying_cause',
  '       question: "What do you think is actually driving that?"',
  '       rationale: "They named a symptom — push one layer deeper."',
  '     - item_id: freeform.recap',
  '       question: "If I\'m hearing you right, you mentioned the team is',
  '         juggling three different tools, you\'re losing about ten hours a',
  '         week to manual updates, and you\'ve got a board review in six',
  '         weeks — does that capture it?"',
  '       rationale: "We\'ve gathered enough pain — recapping now signals',
  '         listening and tees up the solution conversation."',
  '',
  '   BAD (coaching instructions, behaviour notes, or generic',
  '   prompts — never output these):',
  '     - "Could you introduce yourself and your company name to the',
  '        prospect?" — addressed at the SELLER, not a script.',
  '     - "Now might be a good moment to ask about pain points." —',
  '        a stage direction, not a question the prospect can',
  '        answer.',
  '     - "Try to use more open-ended questions." — behaviour note,',
  '        not a spoken question; the prospect cannot reply to it.',
  '',
  '5. mark_question_asked({ suggestion_id, evidence }) — call this',
  '   when you see in the transcript that the seller asked a question',
  '   whose intent matches one of the PENDING SUGGESTIONS listed in',
  '   the user message. "Match" is generous: exact wording is not',
  '   required. If the seller asked about the same rubric item using',
  '   different phrasing, call this. `evidence` must be a short quote',
  '   (≤120 chars) of the seller\'s question in the transcript. Only',
  '   fire when the tool is present in your declarations — the rep',
  '   can toggle question-state tracking off, in which case the tool',
  '   is absent and the PENDING SUGGESTIONS block is not surfaced.',
  '',
  '`evidence` on update_item_state and record_field is a short quote',
  'or paraphrase (≤120 chars) of the moment that justified the call.',
  'Include the speaker label in the quote when it matters (e.g.',
  '\'Prospect: "we\\\'re at around $4M ARR"\' is much stronger evidence',
  'than a bare quote).',
  '',
  'Do NOT call `record_flag` — a separate model handles live coaching',
  'flags in parallel.',
  '',
  'When in doubt, fire fewer rather than more tools. Be conservative',
  'on evidence — only fire when you can quote what was said. The',
  'suggestion tool is only available on turns where the rep has asked',
  'for one; on every other turn focus on state tracking + field',
  'capture and stay silent.',
  '',
  'Checklist items:',
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
 * `boostedItemIds` lists items the seller explicitly asked the coach to
 * resurface (typically by clicking a logged item in the Logged pillar).
 * These should be prioritised for the next suggestion.
 *
 * @param {{
 *   itemStates?: Record<string, { state: string }>,
 *   capturedFields: Record<string, { value: string }>,
 *   recentSellerTurns?: string[],
 *   recentlySkippedIds?: string[],
 *   boostedItemIds?: string[],
 * }} state
 */
export function formatCoachState(state) {
  const itemStates = state.itemStates || {};

  /** Bucket the rubric by state so the model can see the full picture
   *  without having to scan a flat dictionary. */
  const inProgress = [];
  const covered = [];
  const logged = [];
  for (const [id, s] of Object.entries(itemStates)) {
    if (s?.state === 'in_progress') inProgress.push(id);
    else if (s?.state === 'covered') covered.push(id);
    else if (s?.state === 'logged') logged.push(id);
  }

  const captured = Object.entries(state.capturedFields || {})
    .map(([id, v]) => `${id}="${v.value}"`)
    .join(', ') || '(none yet)';

  const skipped = state.recentlySkippedIds || [];
  const boosted = state.boostedItemIds || [];
  const skippedSet = new Set(skipped);
  const coveredSet = new Set(covered);
  const candidates = ITEMS
    .filter((it) => !coveredSet.has(it.id) && !skippedSet.has(it.id))
    .map((it) => it.id)
    .join(', ') || '(everything covered — skip suggest_next_question)';

  const recent = state.recentSellerTurns?.length
    ? state.recentSellerTurns.slice(-3).map((t, i) => `  ${i + 1}. "${t}"`).join('\n')
    : '  (no recent seller turns)';

  const lines = [
    'RUBRIC STATE',
    `Items in_progress: ${inProgress.join(', ') || '(none)'}`,
    `Items covered:     ${covered.join(', ')     || '(none)'}`,
    `Items logged:      ${logged.join(', ')      || '(none)'}`,
    `Captured fields:   ${captured}`,
    `Candidates for next suggestion: ${candidates}`,
  ];

  if (boosted.length) {
    lines.push(
      `BOOSTED ITEMS (if suggest_next_question is available this turn, PRIORITISE these): ${boosted.join(', ')}`,
    );
  }

  if (skipped.length) {
    lines.push(`RECENTLY SKIPPED (do not re-suggest unless boosted): ${skipped.join(', ')}`);
  }

  lines.push('', 'Recent seller turns (avoid suggesting near-duplicates):', recent);

  return lines.join('\n');
}
