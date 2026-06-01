/**
 * DEFAULT_RUBRIC — seed for the rubric library.
 *
 * Written verbatim to disk by `src/rubric-store.js:ensureSeeded()` on
 * first launch (and only on first launch — afterwards the on-disk copy
 * is the source of truth). Treat this file as the source-of-truth for
 * the Tuned Automation Discovery rubric pre-feature; behaviour at
 * HEAD~1 (before the editable-rubric feature) and HEAD (after the
 * feature, first-run user) must be identical.
 *
 * Shape mirrors the persisted JSON shape (see plan §"New persisted
 * schemas"):
 *
 *   schemaVersion : 1
 *   id            : 'tuned_automation'
 *   name, description, createdAt, updatedAt
 *   pillars[]         — non-synthetic only (live_signals / logged_questions
 *                       are re-injected at runtime by `src/rubric.js`)
 *   items[]           — { id, pillarId, label, hint, suggestable }
 *   capturedFields[]  — { id, group, label, hint }
 *   flags[]           — { id, severity, category, short, when, desc }
 *   prompts:
 *     voiceAndTone           — short tone/style override, empty by default
 *     coachSystemInstruction — text-coach prose TEMPLATE (no catalogue blocks)
 *     liveSystemInstruction  — live-session prose TEMPLATE (no flag block)
 *
 * The prompt TEMPLATES deliberately stop before the dynamic catalogue
 * sections ("Checklist items:" / "Captured fields:" / "Coaching flags:").
 * `src/rubric.js:applyRubric()` rebuilds those sections from the active
 * rubric's data and concatenates them onto the templates at load time.
 * Storing only the prose template means editing the prompt in the Rubrics
 * tab can never desynchronise the catalogue render.
 */

/* ────────────────────────────────────────────────────────────────────
 * Prompt templates
 * ──────────────────────────────────────────────────────────────────── */

const LIVE_PROMPT_TEMPLATE = [
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
].join('\n');

const COACH_PROMPT_TEMPLATE = [
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
  'You have three core tools, plus two optional gated tools:',
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
  '   the PROSPECT volunteers a concrete non-monetary fact that maps to',
  '   one of the captured fields. `value` is a short display string',
  '   ("40% YoY", "8 marketers, 3 sellers"). Calling it again for the',
  '   same field_id replaces the value. Do NOT record facts the seller',
  '   guessed at unless the prospect confirmed them.',
  '',
  '   IMPORTANT — money is NOT your job: a separate background',
  '   scanner extracts dollar amounts, hours, headcount, and other',
  '   quantitative opportunity figures (spend, pain cost, savings,',
  '   revenue lift, time cost, headcount cost) on its own cadence and',
  '   rolls them into a headline total. Do NOT try to record monetary',
  '   facts in any tool — there is no field_id in the record_field',
  '   enum for them and they will simply be ignored. Your record_field',
  '   responsibility is limited to non-aggregable text descriptors',
  '   only (team size composition, tools in use, primary pain summary,',
  '   growth %, decision-maker name, urgency timeline, etc.).',
  '',
  '3. suggest_next_question({ item_id, question, rationale,',
  '   anchor_quote }) — only included in your tool list when the rep',
  '   has explicitly asked for a suggestion (or, in Automated mode,',
  '   when a natural pause is detected). If this tool is NOT present',
  '   in your declarations this turn, DO NOT emit a suggestion in any',
  '   form — not as a function call, not as text, not as a',
  '   work-around through another tool. Stay silent on suggestions',
  '   until the tool reappears. When this tool IS available, call it',
  '   exactly ONCE per turn — but the prompt will tell you which',
  '   "mode" the ask is in, and that changes how you choose the',
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
  '4. mark_question_asked({ suggestion_id, evidence }) — call this',
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
].join('\n');

/* ────────────────────────────────────────────────────────────────────
 * Catalogues
 * ──────────────────────────────────────────────────────────────────── */

const PILLARS = [
  // Synthetic pillars (`live_signals`, `logged_questions`) are NOT
  // persisted — they are re-injected at runtime by `src/rubric.js`.
  // The 14 non-synthetic pillars below match HEAD~1 verbatim.
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

const ITEMS = [
  // Opening & Agenda Setting
  { id: 'opening_agenda.intro_name_company',  pillarId: 'opening_agenda', label: 'Introduced name + company', hint: 'Caller stated their own first name (or full name) AND their company name early in the call.', suggestable: false },
  { id: 'opening_agenda.stated_purpose',      pillarId: 'opening_agenda', label: 'Stated purpose of call',    hint: 'Caller stated why this call is happening (the purpose / what they want to achieve).',     suggestable: true  },
  { id: 'opening_agenda.named_agenda',        pillarId: 'opening_agenda', label: 'Named the agenda upfront',  hint: 'Caller named the pillars / agenda items they plan to cover.',                              suggestable: false },
  { id: 'opening_agenda.acknowledged_time',   pillarId: 'opening_agenda', label: 'Acknowledged time',         hint: 'Caller acknowledged the duration of the call or asked if the time still works.',           suggestable: false },

  // Questioning Technique
  { id: 'questioning.single_questions',  pillarId: 'questioning', label: 'One question at a time',       hint: 'Caller is consistently asking single, focused questions instead of bundles.',                  suggestable: false },
  { id: 'questioning.open_ended',        pillarId: 'questioning', label: 'Used open-ended questions',    hint: 'Caller asked open-ended questions that invite detailed responses (not yes/no).',                suggestable: false },
  { id: 'questioning.progressive_depth', pillarId: 'questioning', label: 'Progressed broad to specific', hint: 'Questions moved from broad to specific over the course of the call.',                            suggestable: false },

  // Active Listening & Summarising
  { id: 'listening_summarising.reflected_back',   pillarId: 'listening_summarising', label: 'Reflected back / paraphrased',   hint: 'Caller paraphrased or reflected back what the client said before moving on.',                       suggestable: false },
  { id: 'listening_summarising.picked_up_cues',   pillarId: 'listening_summarising', label: 'Picked up on subtle cues',       hint: 'Caller followed up on a subtle cue or emotionally-loaded word (stressed, worried, burnt out).',     suggestable: false },
  { id: 'listening_summarising.threaded_earlier', pillarId: 'listening_summarising', label: 'Referenced earlier responses',   hint: 'Caller referenced something the client said earlier in the call.',                                  suggestable: false },

  // Pain Point Identification
  { id: 'pain_points.three_or_more_pains', pillarId: 'pain_points', label: 'Three or more pain points',                       hint: 'Three or more distinct pain points have been raised in conversation.',                   suggestable: true },
  { id: 'pain_points.underlying_cause',    pillarId: 'pain_points', label: 'Surfaced underlying cause',                       hint: 'Caller probed beyond surface pain to the underlying cause.',                             suggestable: true },
  { id: 'pain_points.emotional_impact',    pillarId: 'pain_points', label: 'Acknowledged emotional impact',                   hint: 'Caller acknowledged the emotional impact of the pain on the client or team.',           suggestable: true },
  { id: 'pain_points.client_articulated',  pillarId: 'pain_points', label: "Client articulated pain in their own words",     hint: 'Client described the pain in their own words rather than agreeing with the caller.',     suggestable: true },

  // Finance Pillar
  { id: 'finance.annual_cost',             pillarId: 'finance', label: "Cost to the business annually",     hint: 'Caller asked what the problem is costing the business annually.',              suggestable: true },
  { id: 'finance.revenue_upside',          pillarId: 'finance', label: 'Revenue upside of fixing it',       hint: 'Caller asked what fixing this would be worth in revenue.',                      suggestable: true },
  { id: 'finance.staff_replace_cost',      pillarId: 'finance', label: 'Cost to replace a team member',     hint: 'Caller asked what it costs to replace a team member.',                          suggestable: true },
  { id: 'finance.improvement_value',       pillarId: 'finance', label: "Value of an X% improvement",        hint: 'Caller asked what an X percent improvement would be worth.',                    suggestable: true },
  { id: 'finance.twelve_month_cost',       pillarId: 'finance', label: '12-month cost of inaction',         hint: 'Caller asked what does it cost the business if nothing changes in twelve months.', suggestable: true },
  { id: 'finance.client_generated_number', pillarId: 'finance', label: 'Client generated their own number', hint: 'Client produced their own dollar figure rather than the caller suggesting one.', suggestable: true },

  // Cost of Inaction & Urgency
  { id: 'urgency.future_no_change', pillarId: 'urgency', label: 'Future state without change', hint: 'Caller asked what happens to the business if this is not solved in twelve months.', suggestable: true },
  { id: 'urgency.how_long_issue',   pillarId: 'urgency', label: 'How long has this been an issue', hint: 'Caller asked how long this has been a problem.',                                  suggestable: true },
  { id: 'urgency.nice_vs_need',     pillarId: 'urgency', label: 'Nice-to-fix vs need-to-fix',    hint: 'Caller asked whether this is a nice-to-fix or a need-to-fix.',                       suggestable: true },

  // Future State & Vision
  { id: 'future_state.twelve_month_vision', pillarId: 'future_state', label: '12-18 month vision',     hint: 'Caller asked the client to describe where the business should be in 12-18 months.', suggestable: true },
  { id: 'future_state.gap_named',           pillarId: 'future_state', label: 'Named the gap',          hint: 'Caller named the gap between current and future state explicitly.',                  suggestable: true },
  { id: 'future_state.long_term_vision',    pillarId: 'future_state', label: 'Long-term vision (>12mo)', hint: 'Caller explored the client vision beyond a 12-month horizon.',                     suggestable: true },

  // People & Change Readiness
  { id: 'people_change.team_reaction',         pillarId: 'people_change', label: "Team reaction to change",        hint: 'Caller asked how the team would react to changing how they work day-to-day.',     suggestable: true },
  { id: 'people_change.champion_named',        pillarId: 'people_change', label: 'Identified internal champion',   hint: 'Caller identified an internal champion by name or role.',                          suggestable: true },
  { id: 'people_change.past_implementations',  pillarId: 'people_change', label: 'Past implementation attempts',   hint: 'Caller asked whether the client has tried to fix this before and what happened.', suggestable: true },
  { id: 'people_change.resistance',            pillarId: 'people_change', label: "Resistance / push-back",         hint: 'Caller asked whether anyone on the team would push back on this.',                 suggestable: true },

  // Competitive Risk
  { id: 'competitive.competitor_tech', pillarId: 'competitive', label: 'Competitors and tech adoption', hint: 'Caller asked whether competitors are using AI or automation.',                  suggestable: true },
  { id: 'competitive.falling_behind',  pillarId: 'competitive', label: 'Risk of falling behind',        hint: 'Caller raised the risk of a competitor getting their operational act together first.', suggestable: true },

  // Tech Stack & Integration
  { id: 'tech_stack.tools_in_use',  pillarId: 'tech_stack', label: 'Current tools',           hint: 'Caller asked what tools the client is using today.',                         suggestable: true },
  { id: 'tech_stack.tools_working', pillarId: 'tech_stack', label: 'Which tools are working', hint: 'Caller asked which tools are working well that they would want to keep.',     suggestable: true },
  { id: 'tech_stack.data_gaps',     pillarId: 'tech_stack', label: 'Data gaps between systems', hint: 'Caller asked where data falls through the cracks between systems.',        suggestable: true },

  // Decision Maker Identification
  { id: 'decision_makers.who_else_decides', pillarId: 'decision_makers', label: 'Who else needs to decide', hint: 'Caller asked who else needs to be part of the decision before moving forward.', suggestable: true },
  { id: 'decision_makers.brake_pullers',    pillarId: 'decision_makers', label: 'Who could pull the brakes', hint: 'Caller asked who could put the brakes on this if not brought in early.',         suggestable: true },
  { id: 'decision_makers.signoff_required', pillarId: 'decision_makers', label: 'Who signs off',             hint: 'Caller asked who would need to sign off on something like this.',                suggestable: true },

  // Close & Next Steps
  { id: 'close_next_steps.specific_date',       pillarId: 'close_next_steps', label: 'Specific date confirmed',   hint: 'A specific date for the next meeting has been confirmed.',                suggestable: false },
  { id: 'close_next_steps.specific_time',       pillarId: 'close_next_steps', label: 'Specific time confirmed',   hint: 'A specific time for the next meeting has been confirmed.',                suggestable: false },
  { id: 'close_next_steps.attendees_confirmed', pillarId: 'close_next_steps', label: 'Attendees confirmed',       hint: 'Attendees for the next meeting have been named and confirmed.',           suggestable: false },
  { id: 'close_next_steps.deliverables',        pillarId: 'close_next_steps', label: 'Deliverables specified',    hint: 'Deliverables before the next meeting have been specified.',               suggestable: false },
  { id: 'close_next_steps.pre_scope_brief',     pillarId: 'close_next_steps', label: 'Pre-scope brief promised',  hint: 'A pre-scope brief has been promised with a timeline.',                    suggestable: false },

  // Pilot & Budget Framing
  { id: 'pilot_budget.pilot_framed',    pillarId: 'pilot_budget', label: 'Pilot framed as risk mitigation', hint: 'Pilot was introduced as a natural risk-mitigation step.',           suggestable: false },
  { id: 'pilot_budget.pilot_credit',    pillarId: 'pilot_budget', label: 'Pilot credit against scope',      hint: 'Pilot cost stated and credited against the full scope.',            suggestable: false },
  { id: 'pilot_budget.budget_range',    pillarId: 'pilot_budget', label: 'Budget range established',        hint: 'A budget range has been discussed.',                                suggestable: true  },
  { id: 'pilot_budget.roi_anchored',    pillarId: 'pilot_budget', label: 'Budget tied to ROI',              hint: 'Budget conversation was anchored to the ROI of fixing the problem.', suggestable: true  },
  { id: 'pilot_budget.tiered_packages', pillarId: 'pilot_budget', label: 'Tiered packages offered',         hint: 'Two to three package tiers were offered to the client.',            suggestable: false },
];

const CAPTURED_FIELDS = [
  // Revenue (descriptor only — revenue.annual moved to record_meeting_fact)
  { id: 'revenue.growth',         group: 'Revenue',  label: 'Growth',         hint: 'Year-over-year growth, e.g. "~40% YoY".' },

  // Team
  { id: 'team.size',              group: 'Team',     label: 'Size',           hint: 'Total team size or company headcount.' },
  { id: 'team.composition',       group: 'Team',     label: 'Composition',    hint: 'Roles and counts within the team, e.g. "8 marketers, 3 sellers".' },

  // Stack
  { id: 'stack.current',          group: 'Stack',    label: 'Tools in use',   hint: 'Tools or systems the client is currently using.' },
  { id: 'stack.broken',           group: 'Stack',    label: 'Broken / gaps',  hint: 'Tools or integrations that are NOT working, or known data gaps.' },

  // Pain (descriptor only — pain.cost_annual moved to record_meeting_fact)
  { id: 'pain.primary',           group: 'Pain',     label: 'Primary pain',   hint: 'Short summary of the primary pain the client has expressed.' },

  // Buyer
  { id: 'buyer.decision_maker',   group: 'Buyer',    label: 'Decision maker', hint: 'Name and/or role of the person who can approve the decision.' },
  { id: 'buyer.champion',         group: 'Buyer',    label: 'Champion',       hint: 'Name and/or role of an internal champion identified during the call.' },

  // Timeline
  { id: 'timeline.urgency',       group: 'Timeline', label: 'Urgency',        hint: 'When the client wants or needs the problem solved.' },
  { id: 'timeline.past_failures', group: 'Timeline', label: 'Past attempts',  hint: 'Previously attempted tools or initiatives the client mentioned.' },
];

const FLAGS = [
  { id: 'red_bundled_questions',              severity: 'red',   category: 'Questioning',  short: 'Bundled question',              when: 'mid',  desc: 'Caller asked two or more questions in the same turn without letting the client answer the first. Fire on the third occurrence in the call.' },
  { id: 'red_solution_before_pain',           severity: 'red',   category: 'Pain',         short: 'Solution before pain',          when: 'mid',  desc: 'Caller proposed a solution, tool, or pilot before the client articulated and quantified a clear pain point.' },
  { id: 'red_no_next_steps',                  severity: 'red',   category: 'Close',        short: 'No next steps',                 when: 'late', desc: 'The call is wrapping up but no specific next meeting date, time, and attendees have been agreed.' },
  { id: 'red_budget_never_discussed',         severity: 'red',   category: 'Finance',      short: 'Budget not discussed',          when: 'late', desc: 'The call is more than two-thirds through and no budget or dollar figure has been raised.' },
  { id: 'red_decision_maker_unconfirmed',     severity: 'red',   category: 'Stakeholders', short: 'Decision maker unclear',        when: 'late', desc: 'The call is wrapping up and the caller has not confirmed who else must approve the decision.' },
  { id: 'green_client_budget_number',         severity: 'green', category: 'Finance',      short: 'Client gave budget',            when: 'mid',  desc: 'Client stated their own budget figure or dollar range unprompted.' },
  { id: 'green_client_cost_of_inaction',      severity: 'green', category: 'Urgency',      short: 'Client owned cost of inaction', when: 'mid',  desc: 'Client articulated the cost or risk of not solving the problem in their own words.' },
  { id: 'green_internal_champion_identified', severity: 'green', category: 'Stakeholders', short: 'Champion identified',           when: 'mid',  desc: 'An internal champion was named by role or name and proactively included in next steps.' },
  { id: 'green_past_failure_surfaced',        severity: 'green', category: 'Change',       short: 'Past failure surfaced',         when: 'mid',  desc: 'A previous failed implementation or change effort was surfaced and engaged with.' },
  { id: 'green_referral_or_retention',        severity: 'green', category: 'Value',        short: 'Retention/referral discussed',  when: 'mid',  desc: 'Caller explored retention, lifetime value, or referrals as part of quantifying upside.' },
];

/* ────────────────────────────────────────────────────────────────────
 * Export
 * ──────────────────────────────────────────────────────────────────── */

export const DEFAULT_RUBRIC = {
  schemaVersion: 1,
  id: 'tuned_automation',
  name: 'Tuned Automation Discovery',
  description: 'Default discovery call rubric.',
  // Internal/proprietary: hidden from the library unless unlocked.
  // The authoritative hide list is INTERNAL_RUBRIC_IDS in rubric-store.js;
  // this flag is documentation + a hook for any future generic filter.
  hidden: true,
  createdAt: null,
  updatedAt: null,
  pillars: PILLARS,
  items: ITEMS,
  capturedFields: CAPTURED_FIELDS,
  flags: FLAGS,
  prompts: {
    voiceAndTone: '',
    coachSystemInstruction: COACH_PROMPT_TEMPLATE,
    liveSystemInstruction: LIVE_PROMPT_TEMPLATE,
  },
};
