# Opportunity Card Collapse + Money-Parsing Accuracy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live "Total annual opportunity" card collapse its per-row notes and assumptions by default behind a small toggle, and stop the AI pipeline from stripping `grand` / `k` / `thousand` / `mil` off spoken dollar amounts so the breakdown rows surface the right magnitude.

**Goal (in 3 sentences):** Test calls keep capturing `"$30 in wasted time"` for what the prospect actually said was thirty grand — the wrong-magnitude rows then leak into the visible label string, polluting the rep's view. This plan tightens the Stage-1 magnitude post-processor + few-shot examples, locks down the Stage-2 row-label schema so the model stops echoing speaker phrasing into the label, and adds a collapse/expand affordance on the quick-fix card so the rep sees a clean "heading + cost" view by default with details one click away.

**Architecture:** Two-track plan against the existing quick-fix opportunity rollup pipeline. Track A (AI) hardens the existing Stage-1 LLM scanner (`src/facts-scanner.js`) and Stage-2 LLM rollup (`src/quick-fix.js`) — both are prompt + schema edits plus one regex extension in `normaliseMagnitude()` and one membership change in `IMPLAUSIBILITY_USD_KINDS`. No new fields, no IPC changes. Track B (UI) adds a `data-details='collapsed'|'expanded'` toggle to the existing static `#quickFix` section in `index.html`, wires the toggle in `renderQuickFix()` (`src/renderer.js`), and adds two short rules to `src/index.css` that hide `.quick-fix__row-notes` + `.quick-fix__assumptions` in the collapsed state. State is purely in-memory; no persistence.

**Tech Stack:** Electron 42 + vanilla JS + CSS, Vite 5 HMR, existing LLM providers (`@google/genai`, OpenAI, Anthropic via `src/providers/*.js`) — no new dependencies.

**Spec:** n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **App starts cleanly today.** Run `npm start`. App opens, no console errors. Quick-fix card scaffold exists at the top of the right-hand captured pane (hidden until Stage-2 fires).
- [ ] **You're on a clean working tree** (`git status` clean) or OK throwing away in-progress work.
- [ ] **At least one provider key configured in `.env`.** `GEMINI_API_KEY` is the default; `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` work via the provider switcher. Without a key the AI tracks can't be verified end-to-end (you can still ship the prompt/schema edits, but Task 8's manual verification needs a live call).
- [ ] **You have a way to re-record the speech patterns that triggered the bug.** Either an audio file from a prior test call you can replay through the system mic, or you can speak the failing phrases ("thirty, forty grand a year", "two hundred grand", "one point five mil") into a live call. Without this, Task 8 reduces to a code-review pass only.

Once `npm start` is running, HMR auto-reloads CSS / HTML / renderer changes. **Main-process changes** (`src/main.js`, `src/preload.js`) require typing `rs` in the npm-start terminal to restart. Prompt + schema edits in `src/facts-scanner.js` and `src/quick-fix.js` take effect on the next tick (Stage-1 every ~12s, Stage-2 ~2.5s after each new fact) — no restart needed beyond Vite's reload.

---

## File map

```
NEW files (created by this plan):
  (none)

MODIFIED files:
  src/facts-scanner.js     — extend normaliseMagnitude millions regex + thousands threshold;
                             add few-shot examples to FACTS_SYSTEM_PROMPT;
                             extend IMPLAUSIBILITY_USD_KINDS set
  src/quick-fix.js         — tighten STAGE2_RESPONSE_SCHEMA.breakdown.items.label description;
                             add label-writing rules to STAGE2_SYSTEM_PROMPT
  index.html               — add .quick-fix__details-toggle button to #quickFix header;
                             set #quickFix data-details='collapsed' as default
  src/renderer.js          — wire toggle click handler in renderQuickFix();
                             clear toggle state on Start (clearScoringState)
  src/index.css            — hide .quick-fix__row-notes + .quick-fix__assumptions when
                             [data-details='collapsed']; style the new toggle button

DELETED:
  (none)
```

---

## Public / shared interface impact

- **New DOM contract on `#quickFix`:** a `data-details` attribute with values `collapsed` (default) or `expanded`. Renderer flips this; CSS reads it.
- **New CSS class:** `.quick-fix__details-toggle` for the chevron/label button inside `.quick-fix__header`.
- **Stage-2 schema description text changed** for `STAGE2_RESPONSE_SCHEMA.breakdown.items.label` in [src/quick-fix.js](src/quick-fix.js) (the `description` string only — the JSON `type: 'STRING'` and field key are unchanged, so the LLM contract surface is the same; downstream validators don't read the description).
- **Stage-1 prompt text changed** (`FACTS_SYSTEM_PROMPT` few-shot block) and Stage-2 prompt text changed (`STAGE2_SYSTEM_PROMPT` gains a "Row labels:" rule). No prompt key/shape changes.
- **`IMPLAUSIBILITY_USD_KINDS` Set** in `src/facts-scanner.js` gains two members (`time_cost`, `other`). This is an internal module constant — not exported, not referenced outside the module.
- **`normaliseMagnitude(amount, anchorQuote, unit)` signature unchanged.** Only its internal regexes and threshold widen.
- **No IPC channel changes, no persisted schema changes, no `state.quickFix` / `state.quickFixEntries` shape changes.** A coordinator running overlap triage against the renderer state contract or the IPC surface should see no impact from this plan.

---

## Potential overlaps with other in-flight plans

The opportunity-card and AI-pipeline files are high-touch surfaces. The coordinator should explicitly check overlap on each of the five modified files:

**By file:**

- **`src/renderer.js` `renderQuickFix()` (L2555–2694), `clearScoringState()` (~L2933), the `scoring:quick-fix` IPC subscriber (~L3709), and the `state` object (~L820).** This file is a known mega-file; many plans likely touch it. Specifically:
  - Other 2026-05-27 plans whose names suggest renderer involvement: `2026-05-27-auto-advance-on-green` (likely touches pillar state + `clearScoringState`), `2026-05-27-editable-rubric-system` (likely touches `state` + render path).
- **`src/quick-fix.js` `STAGE2_SYSTEM_PROMPT` (L164–267) and `STAGE2_RESPONSE_SCHEMA` (L281–322).** Any plan editing the Stage-2 rollup prompt or schema overlaps with my edits to the `label` description and the new "Row labels" rule:
  - `2026-05-27-coach-reformulate-cap-pivot` — name suggests anchor/cap pivot logic, possibly inside the Stage-2 anchor band rules.
- **`src/facts-scanner.js` `FACTS_SYSTEM_PROMPT` (L136–270), `IMPLAUSIBILITY_USD_KINDS` (L117–124), `normaliseMagnitude` (L327–348).** No other 2026-05-27 plan name obviously suggests Stage-1 work, but coordinator should check.
- **`src/index.css` `.quick-fix__*` block (L2811–3037)** and CSS custom property tokens (`--text-strong`, `--text-dim`, etc.):
  - `2026-05-27-per-surface-transparency-settings` — highly likely to overlap on the whole CSS file or its tokens. My new toggle styles reference `--text-strong` / `--text-dim`; if that plan renames or restructures the tokens, the references break.
- **`index.html` `#quickFix` `<section>` (L357–380)** — any plan restructuring the right-hand captured pane scaffold. No other 2026-05-27 plan name obviously suggests captured-pane work, but the file is small enough that any HTML rewrite plan would notice.

**By behaviour:**

- **The Stage-1 → Stage-2 → renderer money-pipeline contract** (`state.quickFix` shape, `STAGE2_RESPONSE_SCHEMA`'s required keys, anchor logic, monotonic constraint). My plan touches only prompt text + label description + the implausibility Set — no contract changes — but any plan adding fields to the rollup, changing the anchor/cap behaviour, or splitting Stage-2 into multiple LLM passes should coordinate.
- **Provider files (`src/providers/*.js`)** — this plan does NOT modify them, but the Stage-2 prompt changes flow through whichever provider is active. `2026-05-27-api-call-error-log` and `2026-05-27-session-cost-tracking` likely touch provider call sites; my changes are text-literal additions to existing prompts and should merge cleanly with provider-layer work, but coordinator should sequence the merges so prompt edits land after any provider refactor.

Coordinator should check the above before greenlighting concurrent execution.

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-read.

1. **The `state.quickFix` shape is an immutable contract.** Keys: `headlineUsdAnnual`, `breakdown[]`, `assumptions[]`, `confidence`, `currency`, `correctionReason`, `updatedAt`, `stale`, `error`. Don't add or rename top-level keys in this plan.
2. **The opportunity card's element ids and class names are an immutable contract.** Don't rename `#quickFix`, `.quick-fix__header`, `.quick-fix__title`, `.quick-fix__headline`, `.quick-fix__breakdown`, `.quick-fix__row`, `.quick-fix__row-label`, `.quick-fix__row-amount`, `.quick-fix__row-notes`, `.quick-fix__assumptions`, `.quick-fix__assumption`, `.quick-fix__confidence`, `.quick-fix__controls`, `.quick-fix__export`, `.quick-fix__status`. `renderQuickFix()` and the existing CSS query them by exact name.
3. **The collapse state is purely in-memory in the renderer.** No IPC, no `localStorage`, no settings panel for v1. Every fresh render that has no prior state defaults to `collapsed`. `clearScoringState()` (called on Start) resets the toggle state.
4. **Stage-1 magnitude post-processor stays a code-side belt-and-braces, not a replacement for prompt teaching.** Prompt examples remain the primary mechanism; `normaliseMagnitude` is the safety net for when Deepgram drops the multiplier word from the anchor quote. The implausibility drop is the final guard for cases neither layer caught.
5. **Stage-2 row labels are descriptor-only — never include dollar amounts or echo speaker phrasing.** The amount column already renders the dollar value via `formatMoney()`. This invariant lives in the prompt body AND the schema description so the model gets reinforced from two angles.
6. **The export button's behaviour is unchanged.** It still copies the FULL `{exportedAt, rollup, entries}` JSON including the per-row `notes` and `assumptions` — collapsing only hides them from the live UI, not from the post-call data export.

---

## Task 1: Strengthen `normaliseMagnitude` in `src/facts-scanner.js`

**Goal:** Catch the `"mil"` abbreviation in the millions branch and widen the thousands threshold slightly so amounts like 30 / 40 / 200 with a "grand" / "k" / "thousand" suffix in the quote get rescaled even when the LLM stored them as small bare integers up to 9,999. Keep the change narrow — this is a safety net, not a parser rewrite.

**Files:**

- Modify: [src/facts-scanner.js](src/facts-scanner.js) (function `normaliseMagnitude`, currently L327–348)

- [ ] **Step 1: Extend the millions regex to recognise `mil` / `mill`.**

Currently:

```js
const hasMillions =
  /\bmillion\b/.test(quote)
  || /\d\s*m\b/.test(quote);
```

Replace with:

```js
const hasMillions =
  /\bmillion\b/.test(quote)
  || /\bmillions\b/.test(quote)
  || /\bmil\b/.test(quote)
  || /\bmill\b/.test(quote)
  || /\d\s*m\b/.test(quote);
```

`\bmil\b` covers "two mil", "1.5 mil to 2 mil". `\bmill\b` is a common transcription variant. `\bmillions\b` covers plural cases like "we're looking at a couple of millions".

- [ ] **Step 2: Widen the thousands rescaling threshold from 1,000 to 10,000.**

Currently:

```js
if (hasThousands && amount < 1_000) {
  return amount * 1_000;
}
```

Replace with:

```js
if (hasThousands && amount < 10_000) {
  return amount * 1_000;
}
```

Rationale: when the speaker says "two hundred grand" and the LLM stores `200` (forgetting the `× 1000`), the existing `< 1_000` guard fires. But when they say "fifteen hundred grand" and the LLM stores `1500`, the existing guard fails because `1500 >= 1000`. Widening to `< 10_000` covers up to "nine thousand grand" (i.e. $9M) at the cost of a rare false positive where the LLM correctly stored e.g. `5000` for "five thousand dollars" — but if the quote contains `grand`/`thousand`/`k`, the speaker meant thousands of thousands.

- [ ] **Step 3: Mirror the same widening on the millions branch.**

Currently:

```js
if (hasMillions && amount < 100_000) {
  return amount * 1_000_000;
}
```

The existing `< 100_000` already catches "1.5 mil" (LLM might store `1.5`) and "two hundred mil" (LLM might store `200`). Leave as is — no edit on this line.

- [ ] **Step 4: Update the JSDoc to reflect the new patterns.**

Find the JSDoc comment block above `normaliseMagnitude` (currently around L301–325) and add `"mil" / "mill"` to the list of recognised millions tokens, plus a note about the new 10K thousands threshold. Keep it terse — a single line each.

- [ ] **Step 5: Verify by reading the function back.**

No automated tests exist for this module. Re-read the function and confirm:

- `hasMillions` recognises `million`, `millions`, `mil`, `mill`, and bare `\dm`.
- `hasThousands` still recognises `grand`, `thousand`, `\dk` (unchanged).
- Thousands rescale fires when `amount < 10_000`.
- Millions rescale fires when `amount < 100_000`.
- USD-only guard (`if (unit !== 'usd') return amount;`) is unchanged.

- [ ] **Step 6: Commit.**

```bash
git add src/facts-scanner.js
git commit -m "fix(facts): widen normaliseMagnitude for 'mil' and larger bare amounts

The millions regex now also matches 'mil', 'mill', and 'millions' so
phrases like 'one point five mil' / 'two mil' scale up when the LLM
returned the bare integer.

The thousands rescaling threshold widens from < 1_000 to < 10_000 so
'fifteen hundred grand' / 'two hundred grand' / 'nine thousand grand'
also get the x1000 fallback when the LLM dropped the multiplier."
```

---

## Task 2: Add Stage-1 few-shot examples in `FACTS_SYSTEM_PROMPT`

**Goal:** Teach the Stage-1 scanner the failing patterns from the captured test call so the model returns the right `amount` field without relying on `normaliseMagnitude` to bail it out. Targets the specific phrasings reported: range with comma, "hundred grand", "mil" abbreviation, "X point Y mil" decimals.

**Files:**

- Modify: [src/facts-scanner.js](src/facts-scanner.js) (the `FACTS_SYSTEM_PROMPT` array, L136–270 — specifically the `Examples:` block inside the `"amount"` field description, currently L157–163)

- [ ] **Step 1: Locate the examples block.**

Find this block in `FACTS_SYSTEM_PROMPT` (currently around L157–163):

```js
'                     Examples:',
'                       "$50K/yr"             → 50000',
'                       "thirty grand a year" → 30000',
'                       "$15.20 grand"        → 15200',
'                       "$4M ARR"             → 4000000',
'                       "10 hours a week"     → 10',
'                       "5%"                  → 5',
```

- [ ] **Step 2: Replace that block with an expanded list covering the failing patterns.**

```js
'                     Examples:',
'                       "$50K/yr"                    → 50000',
'                       "thirty grand a year"        → 30000',
'                       "$15.20 grand"               → 15200',
'                       "two hundred grand"          → 200000',
'                       "fifteen hundred dollars"    → 1500   (no multiplier)',
'                       "fifteen hundred grand"      → 1500000 (1500 × 1000)',
'                       "thirty, forty grand a year" → 35000  (range — emit the',
'                                                              MIDPOINT)',
'                       "ten, fifteen, twenty grand" → 15000  (range — midpoint;',
'                                                              do NOT emit one',
'                                                              fact per number)',
'                       "$4M ARR"                    → 4000000',
'                       "1.5 mil"                    → 1500000',
'                       "two mil"                    → 2000000',
'                       "one point five to two mil"  → 1750000 (range midpoint)',
'                       "10 hours a week"            → 10',
'                       "5%"                         → 5',
```

Three behaviours this teaches the model that the current examples don't:

1. **Spoken decimals as range, not a literal decimal.** The current "thirty grand a year" → 30000 doesn't tell the model what "thirty, forty grand" means. Without this example, the model has been emitting `30.40` (interpreting the comma as a decimal point) instead of a range midpoint.
2. **"mil" / "mill" as million.** The current "$4M ARR" only covers the uppercase-M abbreviation. Spoken transcripts rarely produce "$4M"; they produce "four mil" / "four million".
3. **"hundred grand" pattern.** Stored as `200` with `grand` in the anchor, the model should output `200000` directly. The current "$15.20 grand" → 15200 doesn't generalise — the model treats "$15.20" as the number and "grand" as the multiplier. "two hundred grand" has no `$` prefix and no decimal, so the model needs an explicit example.

- [ ] **Step 3: Add a "ranges" note to the critical rules section.**

Find the `Critical rules:` block (currently L218–270) and insert a new rule right before rule 1:

```js
'Critical rules:',
'  0. RANGES — when the speaker gives two numbers connected by',
'     a comma, "or", "to", or "between … and …", emit ONE fact for the',
'     MIDPOINT. Do not emit one fact per endpoint, and do not interpret',
'     a comma between two spoken numbers as a decimal. Examples:',
'       "thirty, forty grand"          → ONE fact, amount: 35000',
'       "ten to fifteen grand a month" → ONE fact, amount: 12500',
'       "between 100K and 150K"        → ONE fact, amount: 125000',
'     Reference the midpoint in the `basis` (e.g. "midpoint of the',
'     30-40 grand range stated").',
'  1. ADD-ONLY semantics. The scanner is the source of new facts on',
```

Renumber the subsequent rules from 1..5 to 2..6 — sed-style: rule 1 becomes rule 2, etc. The closing string `'  5. Return \`{ "facts": [] }\` when nothing in the chunk qualifies.'` becomes rule 6.

- [ ] **Step 4: Verify the prompt array compiles.**

Re-read the resulting `FACTS_SYSTEM_PROMPT` array. Confirm:

- The array is still terminated with `].join('\n');`.
- Every string ends with `,` (Vite/Node JS parses the array literal).
- No mis-escaped apostrophes in the new strings (the existing block uses `\'` inside `'...'` strings).

A quick sanity check: load the file in DevTools / Node REPL and `console.log(FACTS_SYSTEM_PROMPT.length)` — should be a healthy multi-line string (>2500 chars).

- [ ] **Step 5: Commit.**

```bash
git add src/facts-scanner.js
git commit -m "feat(facts): teach Stage-1 scanner ranges, 'mil' abbreviation, hundred grand

Expands the amount-field few-shot examples to cover:
  - spoken ranges with commas / 'or' / 'to' / 'between' (emit midpoint)
  - 'two hundred grand' (200 + grand multiplier)
  - 'fifteen hundred grand' (1500 + grand)
  - '1.5 mil', 'two mil', 'one point five to two mil' (mil abbreviation
    + range midpoint)

Adds a new top-of-rules entry teaching the range -> single midpoint
fact behaviour explicitly, since the model was emitting one fact per
endpoint and interpreting the comma as a decimal point."
```

---

## Task 3: Tighten Stage-2 row-label schema + add label-writing rules

**Goal:** Stop Stage-2 from echoing speaker phrasing or dollar amounts into the row `label` string. The amount column already renders the dollar figure via `formatMoney()`; the label should be a clean descriptor. This is the biggest leverage fix per the explore agent's analysis — most of the visible "$30 in wasted time" / "$50 a year" strings live in this field, not the amount column.

**Files:**

- Modify: [src/quick-fix.js](src/quick-fix.js) (`STAGE2_RESPONSE_SCHEMA` at L281–322; `STAGE2_SYSTEM_PROMPT` at L164–267)

- [ ] **Step 1: Tighten the `label` field description in `STAGE2_RESPONSE_SCHEMA`.**

Currently (L294):

```js
label: { type: 'STRING', description: 'Short row label, ≤80 chars.' },
```

Replace with:

```js
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
```

- [ ] **Step 2: Add a "Row labels" rule to `STAGE2_SYSTEM_PROMPT`.**

Find the rule list inside `STAGE2_SYSTEM_PROMPT` (currently L172–233). After rule 7 (Confidence rubric) and before the `*** MONOTONIC CONSTRAINT (LOAD-BEARING) ***` block, insert a new rule 8 (renumbering the existing rule 8 — "Return JSON only..." — to rule 9). The insertion:

```js
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
```

- [ ] **Step 3: Renumber the trailing rule.**

The existing rule (currently L263–266):

```js
'8. Return JSON only, matching the schema. No prose outside the JSON.',
'   Omit `correctionReason` (or set it to null) when there is no',
'   correction in play — populating it with empty/filler text would',
'   bypass the monotonic constraint.',
```

Becomes:

```js
'9. Return JSON only, matching the schema. No prose outside the JSON.',
'   Omit `correctionReason` (or set it to null) when there is no',
'   correction in play — populating it with empty/filler text would',
'   bypass the monotonic constraint.',
```

Also fix the indentation: the existing block uses two leading spaces on rule numbers 1–7 (`'  1. ...'`) but rule 8 used zero. Make the new rule 8 use two leading spaces (`'  8. ROW LABELS — ...'`) and the renumbered rule 9 likewise (`'  9. Return JSON only...'`). This keeps the numbered list aligned visually in the prompt.

- [ ] **Step 4: Verify the prompt array compiles.**

Same checks as Task 2 Step 4. Re-read `STAGE2_SYSTEM_PROMPT` — confirm it still terminates with `].join('\n');`, every string ends with `,`, and no escape issues.

- [ ] **Step 5: Commit.**

```bash
git add src/quick-fix.js
git commit -m "fix(quick-fix): forbid dollar amounts and speaker echoing in row labels

Stage-2's breakdown.items.label was emitting garbage strings like
'$30.40 grand a year' and '$20 in wasted time' because the schema
description was just 'Short row label, ≤80 chars.' with no rule
against embedding the amount or echoing the prospect's phrasing.

Schema description now spells out the descriptor-only contract with
GOOD/BAD examples. System prompt gains a new rule 8 reinforcing the
same with five GOOD and four BAD label examples, and a fallback to
capitalised \`kind\` when only a dollar phrase is available. The
old rule 8 (Return JSON only...) renumbers to rule 9."
```

---

## Task 4: Extend the implausibility drop to cover `time_cost` and `other`

**Goal:** Close the silent leak where `time_cost` and `other` kinds with unit `usd` were excluded from the under-$5K drop, so phrases like "twenty grand in wasted time" (when Deepgram dropped "grand" AND the LLM didn't multiply AND the model classified as `time_cost`) were surfacing as $20 line items instead of being dropped.

**Files:**

- Modify: [src/facts-scanner.js](src/facts-scanner.js) (`IMPLAUSIBILITY_USD_KINDS` Set at L117–124; the comment block above it at L108–116)

- [ ] **Step 1: Add `time_cost` and `other` to the Set.**

Currently:

```js
const IMPLAUSIBILITY_USD_KINDS = new Set([
  'current_spend',
  'pain_cost',
  'savings_opportunity',
  'revenue_uplift',
  'headcount_cost',
  'stated_total',
]);
```

Replace with:

```js
const IMPLAUSIBILITY_USD_KINDS = new Set([
  'current_spend',
  'pain_cost',
  'savings_opportunity',
  'revenue_uplift',
  'time_cost',
  'headcount_cost',
  'other',
  'stated_total',
]);
```

- [ ] **Step 2: Update the comment block above the Set.**

The current comment (L108–116) reads:

```js
/* Monetary kinds where a bare amount under $5K is almost certainly a
 * transcription artefact, not a real $30 line item. The Stage-1 scanner
 * drops these rather than letting them through to Stage-2 where they
 * compound into a wrong rollup. `time_cost`, `other`, `context_only`,
 * and `hypothetical_fix_cost` are deliberately EXCLUDED — they have
 * legitimate small-amount usages (e.g. "$150 hourly rate", "$500
 * one-time setup fee"). `stated_total` IS included because a bottom-
 * line opportunity stated as "$30" is virtually always meant to be
 * "$30 grand". */
```

Replace with:

```js
/* Monetary kinds where a bare amount under $5K is almost certainly a
 * transcription artefact, not a real $30 line item. The Stage-1 scanner
 * drops these rather than letting them through to Stage-2 where they
 * compound into a wrong rollup.
 *
 * `time_cost` and `other` are included as of 2026-05-27 — a test call
 * showed phrases like "twenty grand in wasted time" producing $20
 * `time_cost` line items when Deepgram lost "grand" from the audio
 * AND the LLM didn't multiply. Losing the fact entirely is the right
 * outcome.
 *
 * `context_only` and `hypothetical_fix_cost` remain EXCLUDED — they
 * have legitimate small-amount usages ("$150 hourly rate", "$500
 * one-time setup fee") AND they're filtered out of the Stage-2
 * rollup anyway (see EXCLUDED_FROM_HEADLINE_KINDS in quick-fix.js),
 * so a wrong-magnitude entry in these kinds can't corrupt the
 * headline. */
```

- [ ] **Step 3: Verify by reading the validateFact() drop block.**

Re-read `validateFact()` (L365–421). Confirm:

- The implausibility check at L400–412 still keys off `IMPLAUSIBILITY_USD_KINDS.has(kind)` — no other call site of the Set to worry about.
- The drop still logs `console.warn(...)` with the amount, kind, and anchor — auditing remains possible.
- The order of operations is unchanged: structural validation → `normaliseMagnitude` → implausibility check.

- [ ] **Step 4: Commit.**

```bash
git add src/facts-scanner.js
git commit -m "fix(facts): drop sub-\$5K time_cost and other facts too

A test call surfaced 'twenty grand in wasted time' as a \$20 time_cost
line item because the kind was excluded from the implausibility drop.
Adds time_cost and other to IMPLAUSIBILITY_USD_KINDS so the validator
discards bare under-\$5K monetary facts in those kinds instead of
letting them pollute the Stage-2 rollup.

context_only and hypothetical_fix_cost remain excluded — they have
legitimate small-amount usages and are filtered out of the Stage-2
headline anyway."
```

---

## Task 5: Add collapse/expand scaffold to `#quickFix` in `index.html`

**Goal:** Add a small "Details ▾" / "Details ▴" toggle button to the card header and a `data-details='collapsed'` default attribute on the section, so the renderer + CSS can read/flip the state without touching the existing `.quick-fix__breakdown` / `.quick-fix__assumptions` element ids.

**Files:**

- Modify: [index.html](index.html) (the `#quickFix` section currently at L357–380)

- [ ] **Step 1: Replace the `<section id="quickFix">` block.**

Current block (L357–380):

```html
<section id="quickFix" class="quick-fix" hidden>
  <header class="quick-fix__header">
    <span class="quick-fix__title">Total annual opportunity</span>
    <div class="quick-fix__controls">
      <!-- Copies {exportedAt, rollup, entries} JSON to the
           clipboard so the rep can paste the full
           opportunity breakdown + underlying facts into
           post-call notes. Wired in renderQuickFix(). -->
      <button
        type="button"
        class="quick-fix__export"
        title="Copy rollup + facts JSON to clipboard"
        hidden
      >
        Export
      </button>
      <span class="quick-fix__confidence" data-level="medium">medium</span>
    </div>
  </header>
  <div class="quick-fix__headline"></div>
  <ul class="quick-fix__breakdown"></ul>
  <ul class="quick-fix__assumptions"></ul>
  <div class="quick-fix__status" hidden></div>
</section>
```

Replace with:

```html
<section id="quickFix" class="quick-fix" data-details="collapsed" hidden>
  <header class="quick-fix__header">
    <span class="quick-fix__title">Total annual opportunity</span>
    <div class="quick-fix__controls">
      <!-- Toggles whether per-row notes and the bottom Assumptions
           list are visible. Default 'collapsed' — the rep sees only
           heading + label/amount rows. Expanded reveals the muted
           italic notes under each row and the assumptions list at
           the bottom. State is in-memory; resets to collapsed on
           Stop / Start (see clearScoringState in renderer.js). -->
      <button
        type="button"
        class="quick-fix__details-toggle"
        title="Show / hide per-row notes and assumptions"
        aria-expanded="false"
        aria-controls="quickFix"
      >
        <span class="quick-fix__details-toggle-label">Details</span>
        <span class="quick-fix__details-toggle-chevron" aria-hidden="true">▾</span>
      </button>
      <!-- Copies {exportedAt, rollup, entries} JSON to the
           clipboard so the rep can paste the full
           opportunity breakdown + underlying facts into
           post-call notes. Wired in renderQuickFix(). -->
      <button
        type="button"
        class="quick-fix__export"
        title="Copy rollup + facts JSON to clipboard"
        hidden
      >
        Export
      </button>
      <span class="quick-fix__confidence" data-level="medium">medium</span>
    </div>
  </header>
  <div class="quick-fix__headline"></div>
  <ul class="quick-fix__breakdown"></ul>
  <ul class="quick-fix__assumptions"></ul>
  <div class="quick-fix__status" hidden></div>
</section>
```

Changes:

- `data-details="collapsed"` on the `<section>` — read by CSS to hide notes/assumptions, read by JS to track state.
- New `<button class="quick-fix__details-toggle">` inside `.quick-fix__controls`, placed BEFORE the existing `.quick-fix__export` button so the visual order is Details · Export · Confidence.
- `aria-expanded="false"` mirrors the collapsed default; renderer flips it to `"true"` when expanded.
- `aria-controls="quickFix"` points the screen reader at the section the toggle reveals.
- The chevron uses a Unicode triangle (▾ / ▴). The existing card already uses non-SVG glyphs (the assumption `::before` uses `·`), so inlining a Unicode triangle here is consistent with that style. No new SVG asset needed.

- [ ] **Step 2: Verify HMR picks up the new markup.**

Save and reload (HMR is automatic). Open DevTools → Elements → find `#quickFix`. Confirm:

- The section has `data-details="collapsed"`.
- The new `.quick-fix__details-toggle` button exists with the chevron span.
- The Confidence pill still renders to the right of the Export button.

Visually the card will look the same as before (we haven't added CSS yet — Task 7). The toggle is unstyled.

- [ ] **Step 3: Commit.**

```bash
git add index.html
git commit -m "feat(html): add details toggle scaffold to #quickFix

Adds data-details='collapsed' to the #quickFix section and a new
.quick-fix__details-toggle button inside .quick-fix__controls. The
button sits before the existing .quick-fix__export and includes a
Unicode chevron (▾) plus aria-expanded='false' / aria-controls.

No CSS or JS wiring yet — Task 7 styles, Task 6 wires the click."
```

---

## Task 6: Wire the toggle in `src/renderer.js`

**Goal:** Make the new button flip `#quickFix`'s `data-details` between `collapsed` and `expanded`, update `aria-expanded`, swap the chevron glyph, and reset to `collapsed` whenever `clearScoringState()` runs (i.e. on Start). Keep the state purely in-memory — no persistence.

**Files:**

- Modify: [src/renderer.js](src/renderer.js) (`renderQuickFix()` at L2555–2694; `clearScoringState()` at ~L2933)

- [ ] **Step 1: Add a module-level state flag near the existing `state.quickFix` declaration.**

Find the `state` object (around L820–840 — the part that declares `state.quickFix`, `state.quickFixEntries`, etc.). Add a sibling field:

```js
state.quickFixDetailsExpanded = false;
```

If `state` is declared as a frozen / sealed object, use whatever pattern the surrounding declarations use. (Per the existing code in `clearScoringState`, the state object accepts ad-hoc field assignment — same approach is fine.)

- [ ] **Step 2: Inside `renderQuickFix()`, wire the toggle's click handler and sync the visual state.**

At the end of `renderQuickFix()` — directly before the closing `}` of the function (currently L2694) — add this block:

```js
// Details toggle — flips data-details on #quickFix and updates the
// aria-expanded + chevron glyph. State is mirrored on
// state.quickFixDetailsExpanded so it survives re-renders. Reset to
// collapsed in clearScoringState().
const toggleBtn = quickFixEl.querySelector('.quick-fix__details-toggle');
if (toggleBtn instanceof HTMLButtonElement) {
  const expanded = Boolean(state.quickFixDetailsExpanded);
  quickFixEl.dataset.details = expanded ? 'expanded' : 'collapsed';
  toggleBtn.setAttribute('aria-expanded', String(expanded));
  const chevronEl = toggleBtn.querySelector('.quick-fix__details-toggle-chevron');
  if (chevronEl instanceof HTMLElement) {
    chevronEl.textContent = expanded ? '▴' : '▾';
  }
  // Reassign .onclick (not addEventListener) so we don't accumulate
  // duplicate handlers across re-renders. Same pattern as the export
  // button above.
  toggleBtn.onclick = () => {
    state.quickFixDetailsExpanded = !state.quickFixDetailsExpanded;
    renderQuickFix();
  };
}
```

The single `renderQuickFix()` re-call on click is cheap (DOM is already populated, we're just flipping attributes) and keeps the sync logic in one place.

- [ ] **Step 3: Reset the flag in `clearScoringState()`.**

Find `clearScoringState()` (around L2933–2941). It currently wipes `state.quickFix` and `state.quickFixEntries`. Add the new flag to the wipe:

Before:

```js
function clearScoringState() {
  state.quickFix = null;
  state.quickFixEntries = [];
  // … other state resets …
}
```

After (insert the one line):

```js
function clearScoringState() {
  state.quickFix = null;
  state.quickFixEntries = [];
  state.quickFixDetailsExpanded = false;
  // … other state resets …
}
```

(The "… other state resets …" placeholder is whatever else `clearScoringState` currently does — leave that untouched. Just append the one new line in the same block.)

- [ ] **Step 4: Verify the toggle wires up.**

Reload (HMR). Start a call and wait for Stage-2 to fire (it needs at least one extracted fact, so speak a couple of numbers). Once the card appears:

- Confirm the section has `data-details="collapsed"` in DevTools.
- Click "Details ▾". `data-details` flips to `expanded`, the chevron becomes `▴`, `aria-expanded` flips to `true`.
- Click again. Flips back.
- Press Stop and Start again. Card disappears, then reappears on next Stage-2 fire — the toggle resets to `collapsed` (verify via `data-details` and chevron glyph).

Visually nothing else changes yet (Task 7 adds the CSS that hides the notes/assumptions when collapsed).

- [ ] **Step 5: Commit.**

```bash
git add src/renderer.js
git commit -m "feat(renderer): wire .quick-fix__details-toggle click handler

renderQuickFix() now flips #quickFix's data-details attribute between
'collapsed' and 'expanded', mirrors aria-expanded, and swaps the
chevron glyph (▾ ↔ ▴) on each render. State lives on
state.quickFixDetailsExpanded so it survives intra-call re-renders.

clearScoringState() resets the flag to false so Start always opens
the card collapsed.

The click handler reassigns .onclick (not addEventListener) to avoid
duplicate handlers across re-renders — same pattern as the existing
export button wiring."
```

---

## Task 7: Hide notes + assumptions when collapsed; style the toggle in `src/index.css`

**Goal:** Two short CSS rules: (a) hide `.quick-fix__row-notes` and `.quick-fix__assumptions` when `#quickFix[data-details='collapsed']`, (b) give the new toggle button a quiet visual register that matches the existing `.quick-fix__export` aesthetic.

**Files:**

- Modify: [src/index.css](src/index.css) (the `.quick-fix__*` block around L2811–3037)

- [ ] **Step 1: Add the collapse rules.**

Insert at the end of the `.quick-fix__*` block (after `.quick-fix__status[data-status='error']` around L3037, and before the next unrelated block):

```css
/* Collapse / expand — data-details='collapsed' (default in HTML) hides
 * the per-row italic notes and the bottom assumptions list, leaving
 * just heading + label/amount rows. data-details='expanded' shows
 * everything (the default-on state of the original card). The
 * renderer flips the attribute via the .quick-fix__details-toggle
 * button (see renderQuickFix in renderer.js). */
.quick-fix[data-details='collapsed'] .quick-fix__row-notes,
.quick-fix[data-details='collapsed'] .quick-fix__assumptions {
  display: none;
}
```

`display: none` (not `visibility: hidden`) so the collapsed rows reflow to a single line and the assumptions list collapses its margin.

- [ ] **Step 2: Style the toggle button.**

Append immediately after the rules from Step 1:

```css
/* Details toggle — quiet ghost button matching the existing
 * .quick-fix__export aesthetic. Sits in .quick-fix__controls between
 * the title and the confidence pill / export button. */
.quick-fix__details-toggle {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  font: inherit;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}

.quick-fix__details-toggle:hover {
  color: var(--text-strong);
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

.quick-fix__details-toggle:focus-visible {
  outline: 2px solid rgba(74, 222, 128, 0.6);
  outline-offset: 2px;
}

.quick-fix__details-toggle-chevron {
  display: inline-block;
  font-size: 9px;
  line-height: 1;
  opacity: 0.85;
}
```

The token names `--text-strong` and `--text-dim` already exist in this codebase per the existing `.quick-fix__row` / `.quick-fix__row-notes` rules — confirm by reading the top of `src/index.css` for the `:root { ... }` declarations. If those tokens aren't defined yet at the point you're working, fall back to `rgba(255,255,255,0.95)` and `rgba(255,255,255,0.55)` respectively. Don't introduce new tokens in this plan.

- [ ] **Step 3: Verify the visual result.**

Reload (HMR). Run a call until the card appears with at least one breakdown row.

- Collapsed (default): card shows title row + headline + bullet rows (label + amount only). No italic notes under bullets, no `·`-prefixed assumptions list at the bottom. The card is visibly shorter than before.
- Click "Details ▾": rows re-flow to show italic muted notes; assumptions list reappears at the bottom. Chevron flips to ▴.
- Hover the toggle: subtle background + brighter text.
- Tab to the toggle: focus ring (Apple-system green) appears.

- [ ] **Step 4: Commit.**

```bash
git add src/index.css
git commit -m "feat(styles): collapse per-row notes + assumptions by default

Adds .quick-fix[data-details='collapsed'] rules that hide
.quick-fix__row-notes and .quick-fix__assumptions via display:none.
Default state (set by index.html) is collapsed so the card opens with
just heading + label/amount rows visible.

Styles the new .quick-fix__details-toggle button as a quiet ghost
control matching the existing .quick-fix__export aesthetic: 10.5px
text-dim label + 9px chevron, transparent ghost background, hover
lifts to text-strong + faint bg, focus ring tinted accent-green."
```

---

## Task 8: Manual verification on a re-recorded test call

**Goal:** Walk through the failing transcript patterns from the original test call and confirm the AI now captures the right magnitudes AND the visible card behaves as designed. This task creates no commits unless something is broken.

**Files:** (none modified)

- [ ] **Step 1: Start a fresh recording with `npm start`.**

Press Start. Speak the following phrases in sequence, leaving ~3s between each so Stage-1 ticks (every ~12s) can land cleanly. Use your real voice through the system mic. Optional: do this with a colleague playing the prospect, so the speaker labels are correct.

```
Prospect: "We're spending thirty, forty grand a year on this."
Prospect: "It's also probably twenty grand in wasted time."
Prospect: "Lost deals to slow follow-up — maybe fifty grand a year."
Prospect: "Our consulting tools are ten grand each."
Prospect: "All in, two hundred grand to the business."
Prospect: "Top line: one point five to two mil ARR."
```

- [ ] **Step 2: Verify the captured Stage-1 facts.**

Open DevTools → Console. After ~30s, you should see Stage-1 ticks landing without `[facts-scanner] dropped implausible monetary amount` warnings for any of the phrases above. Specifically:

- "thirty, forty grand a year" → ONE fact with `amount: 35000` (midpoint) and `kind: 'current_spend'` or `pain_cost`.
- "twenty grand in wasted time" → either `amount: 20000` `time_cost` OR dropped via implausibility (if "grand" was lost from the audio). Either is acceptable — what's NOT acceptable is a $20 entry surviving.
- "fifty grand a year" → `amount: 50000`.
- "ten grand each" → `amount: 10000`.
- "two hundred grand" → `amount: 200000`.
- "one point five to two mil" → ONE fact with `amount: 1750000` (midpoint).

If any phrase produces a wrong-magnitude fact, log the anchor quote and the fact's kind/amount/unit/period. The fix likely belongs in Task 1 (`normaliseMagnitude` regex) or Task 2 (Stage-1 prompt examples) — add one more example pair covering the failing phrasing.

- [ ] **Step 3: Verify the live card behaviour.**

Once Stage-2 has fired (a few seconds after the first fact), the `#quickFix` card appears at the top of the captured pane:

- The card opens **collapsed**: only the green headline + label/amount rows visible. No italic notes, no `·` assumptions list.
- Each row's `label` is a **descriptor noun phrase** with NO dollar amount and NO speaker phrasing — e.g. "Current spend", "Lost deals to slow follow-up", "Wasted time", "Total opportunity". NOT "$30K a year on consulting" or "twenty grand in wasted time".
- The amount column on the right shows the correct figure via `formatMoney()` (e.g. `$30K`, `$200K`, `$1.5M`).
- Click "Details ▾". The card expands: italic notes appear under each row (when present), assumptions appear at the bottom of the card. Chevron flips to ▴.
- Click again. Card collapses. Chevron flips back to ▾.

- [ ] **Step 4: Verify Stop / Start resets.**

Press Stop. Card hides. Press Start. After Stage-2 fires again, the card should reappear in the collapsed state (toggle reset, no leftover expand from the previous call).

- [ ] **Step 5: Verify the export still includes hidden detail.**

While the card is collapsed, click Export. Paste the clipboard into a scratch file. Confirm:

- The JSON includes `rollup.breakdown[*].notes` (the per-row notes, full text).
- The JSON includes `rollup.assumptions[*]` (the bottom assumptions list).
- The visual UI hiding these does NOT remove them from the data export.

- [ ] **Step 6: Verify the accessibility surface.**

Tab through the card with the keyboard. Confirm:

- `.quick-fix__details-toggle` receives focus and shows a visible focus ring.
- Activating it with Space / Enter toggles the section.
- `aria-expanded` flips to `"true"` when expanded.
- A screen reader (VoiceOver via Cmd+F5) announces the toggle and reads the section contents when expanded.

- [ ] **Step 7: If nothing broke, no commit needed.**

If Steps 1–6 all pass clean, stop here. The previous seven task commits encode the work. If any step found a regression, fix it in a focused follow-up commit on the appropriate file.

---

## Final state — what the engineer should hand back

When this plan is done:

- The Stage-1 scanner (`src/facts-scanner.js`) recognises "mil" / "mill" as million, scales bare amounts under 10K when "grand"/"k"/"thousand" appears in the quote, has explicit few-shot examples for ranges + hundred-grand + spoken decimals, and drops sub-$5K `time_cost` and `other` USD facts as implausible.
- The Stage-2 rollup (`src/quick-fix.js`) refuses to emit row labels that embed dollar amounts or echo speaker phrasing; the schema description and system-prompt rule reinforce this from two angles.
- The `#quickFix` section in `index.html` carries `data-details="collapsed"` by default and includes a `.quick-fix__details-toggle` button.
- `renderQuickFix()` in `src/renderer.js` flips the attribute, mirrors `aria-expanded`, swaps the chevron, and `clearScoringState()` resets the toggle to collapsed on every Start.
- `src/index.css` hides `.quick-fix__row-notes` and `.quick-fix__assumptions` when collapsed, and styles the new toggle as a quiet ghost button.
- A manual test pass confirms the failing transcript phrasings from the 2026-05-26 / 2026-05-27 test calls now produce correct magnitudes and descriptor-only labels in the live card.

## Pointers for follow-up work (out of scope here)

- Persisting the expand/collapse preference across sessions (LocalStorage key `quickFix:detailsExpanded`).
- Surfacing dropped implausibility facts as a small "we heard this but couldn't parse it" affordance — currently they only log to the console.
- Per-row expand (click a single row to see only its note) rather than the card-wide toggle.
- A separate post-call summary screen that always shows notes + assumptions in full (the current Export JSON is the workaround for v1).
- Teaching Stage-1 to handle "X grand each × N people" → `amount: X*N*1000` directly, instead of requiring Stage-2 to combine two facts.

These all touch the same files the plan modifies; reach for them when the scope is approved.
