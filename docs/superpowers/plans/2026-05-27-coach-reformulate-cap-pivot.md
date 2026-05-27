# Coach Reformulate Cap + Pivot Within Pillar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the automated coach's per-item reformulate loop at one attempt; once exceeded, auto-pivot to a different not-yet-covered item in the same pillar. Make the single allowed reformulate meaningfully different by feeding prior wordings into the model's prompt.

## Goal

In automated mode the coach currently re-fires `kind: 'reformulate'` on the same rubric item every 10 seconds while a pin stays unasked, producing a chain of trivially-paraphrased questions that locks the rep onto one item until they manually tick it off. Shipping this plan changes that behaviour to: one reformulate (with prior-wordings context so it's a genuinely different angle), then an automatic pivot to a different item in the same pillar, with a directive-level fallback to a different pillar when the active pillar is exhausted.

## Architecture

A small per-item counter on `coachContext` (`currentItemReformulateCount`) increments only when a new pin lands with `kind === 'reformulate'` AND the same `itemId` as the previous pin, and resets to 0 in every other transition. `armReformulateTimer` in `src/main.js` consults the counter at fire time: zero → fire `reformulate` as today; ≥ 1 → fire a brand-new `kind: 'pivot_within_pillar'` with the original item's pillarId in a queued slot. The new kind lives alongside existing kinds in `src/coach.js`'s `DIRECTIVES` / `VALID_KINDS` and uses the same TARGETED-prefixed-line pattern as `targeted` / `reformulate` to carry its parameter, plus a directive-level fallback clause for the pillar-exhausted case. A `recentWordingsForPinnedItem` field added to the existing context snapshot lets the Coach prepend a `PREVIOUS WORDINGS for this item` block when `kind === 'reformulate'`.

## Tech Stack

Vanilla JS in the Electron main + renderer-side providers — no new dependencies; no schema migrations.

## Spec

n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **App starts cleanly today.** Run `npm start`. App opens, the coach session can be started, and an automated-mode test session lands at least one suggestion without console errors.
- [ ] **You're on a clean working tree** (`git status` shows clean) or OK throwing away in-progress work in `src/main.js` / `src/coach.js`.
- [ ] **`.env` has a working provider key** (`GEMINI_API_KEY` or one of the alt providers via Settings) so the manual integration test in Task 5 can fire real reformulate / pivot ticks.
- [ ] **Read the existing reformulate path** end-to-end: `armReformulateTimer` in [src/main.js](src/main.js):1712, the `DIRECTIVES` table in [src/coach.js](src/coach.js):94, `requestSuggestion` at [src/coach.js](src/coach.js):541, the dispatch cleanup at [src/coach.js](src/coach.js):902-910. The plan assumes you've seen these.

Once `npm start` is running, main-process changes (anything in `src/main.js` or `src/coach.js`) require typing `rs` in the npm-start terminal to restart, or quitting Electron and restarting `npm start`. Vite HMR will not pick these up.

---

## File map

```
NEW files (created by this plan):
  (none)

MODIFIED files:
  src/main.js                   — coachContext counter, resetCoachContext clear, onSuggestion
                                  increment/reset, armReformulateTimer branching, pillarIdForItem
                                  helper, buildCoachContextSnapshot extension
  src/coach.js                  — VALID_KINDS entry, DIRECTIVES entry, queuedPillarId field,
                                  requestSuggestion param, _tick prompt assembly + cleanup

DELETED:
  (none)
```

---

## Public / shared interface impact

- **New kind token** `'pivot_within_pillar'` in `VALID_KINDS` ([src/coach.js](src/coach.js):187). The `payload.kind` field on the renderer's `coach:suggestion` IPC event can now carry this value — renderer should treat unknown kinds the same as `next` (it already does, via the default branch in suggestion-card rendering).
- **`Coach.requestSuggestion` signature extended** ([src/coach.js](src/coach.js):541): now accepts an optional `pillarId` argument, used only when `kind === 'pivot_within_pillar'`. Existing call sites that don't pass it remain valid.
- **`coachContext` shape extended** ([src/main.js](src/main.js):661 area): new `currentItemReformulateCount: number` field. Reset to 0 in `resetCoachContext()`. Not persisted, not broadcast.
- **`buildCoachContextSnapshot` return shape extended** ([src/main.js](src/main.js):1359): adds `recentWordingsForPinnedItem: string[]`. Coach's `getContext` callback typedef in [src/coach.js](src/coach.js):326-331 expands accordingly.
- **No IPC channel changes.** No persisted-state schema changes. No CSS class or DOM contract changes.

---

## Potential overlaps with other in-flight plans

Concrete known overlaps in today's batch — coordinator should sequence accordingly:

- **`2026-05-27-auto-advance-on-green.md` — HIGH overlap.** Both plans edit:
  - The **Coach `{...}` constructor callback block** (`src/main.js`:~2772-2906). Their plan modifies `onQuestionAsked` (~2875-2878); mine modifies `onSuggestion` (~2854) and extends `getContext: buildCoachContextSnapshot` indirectly. Disjoint inner callbacks but same code region.
  - **`applyMarkAsked()`** (`src/main.js`:1586). Their plan adds a `requestSuggestion({ kind: 'next' })` call after `broadcastSuggestionHistory()`; mine adds `coachContext.currentItemReformulateCount = 0;` after the `entry.asked = true` assignment.
  - **`markSuggestionAskedManual()`** (`src/main.js`:1647) — same as above. Both plans add a single line in the asked-flip path.
  - **The coach-mode doc-block** (`src/main.js`:712-726). Their plan expands the list of Automated-mode triggers; if mine lands after, the list grows to five (kickstart, pause-nudge, auto-reformulate-or-pivot, auto-advance-on-green) and the auto-reformulate line should be edited to mention the cap + pivot variant.

  Recommended order: theirs first (smaller diff, no schema additions), then mine merges cleanly on top. If mine lands first, their plan needs trivial conflict resolution at the doc-block and at the two asked-flip functions.

- **`2026-05-27-api-call-error-log.md` — LOW overlap.** Touches `src/coach.js` only at the provider-construction call site (adds `source: 'coach'` to `getProvider(...)`). My `src/coach.js` edits are in disjoint regions (`DIRECTIVES` ~line 94, `VALID_KINDS` ~line 187, `Coach` constructor ~line 453, `requestSuggestion` ~line 541, `_tick` ~line 688-910). No textual conflict expected. Coordinator should verify the file map intersection has no line-level overlap.

- **`2026-05-18-liquid-glass-overlay-polish.md` — NONE.** Modifies `src/main.js` only in BrowserWindow options (~line 79-94), accent-color IPC, and Cmd+Shift+H fade — all disjoint from coach / suggestion / reformulate logic.

General hot zones any future parallel plan should be checked against:

- **`src/coach.js`** `DIRECTIVES` / `VALID_KINDS` / `requestSuggestion` / `_tick` / `Coach` constructor.
- **`src/main.js`** `armReformulateTimer` neighbourhood (~line 850-1770) and the Coach `{...}` constructor block (~line 2772-2906).
- **`coachContext`** schema (~line 590-665) and `resetCoachContext` (~line 902).
- **`coach:suggestion`** IPC payload `kind` field — any renderer plan that branches on kind must tolerate the new `'pivot_within_pillar'` value.

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-read.

1. **The reformulate counter is reset whenever the pin moves to a different `itemId`, when the new pin's `kind !== 'reformulate'`, or when the entry is marked `asked`.** It only increments on a reformulate-kind pin that lands on the same itemId.
2. **The cap is enforced at fire-time in `armReformulateTimer`, not in the Coach.** The Coach stays dumb about counts — it just executes the kind it's told. Future cap changes happen in main.js only.
3. **`pivot_within_pillar` is one-shot and queued, exactly like `targeted` / `reformulate`.** Its companion field `queuedPillarId` clears in the same dispatch-cleanup block that clears `queuedTargetedItemId` ([src/coach.js](src/coach.js):902-910).
4. **The pillar-exhausted fallback lives in the directive text, not in JS.** When `pivot_within_pillar` fires and no items in the pillar are eligible, the model is instructed to apply regular pivot semantics. We don't pre-compute "is this pillar exhausted?" on the JS side.
5. **The `PREVIOUS WORDINGS` prompt block only appears when `kind === 'reformulate'` AND the wordings array is non-empty.** It doesn't appear on `pivot_within_pillar` ticks (the new item shouldn't be primed by old wordings of the old item).
6. **No changes to existing kinds' behaviour.** `next` / `deeper` / `pivot` / `pause` / `recap` / `targeted` / `reformulate` all behave exactly as before.

---

## Task 1: Add the per-item counter + reset/increment logic in `src/main.js`

**Goal:** Lay the data foundation. Add `currentItemReformulateCount` to `coachContext`, reset it in the right places, increment it in the right place. No behaviour change yet — `armReformulateTimer` still fires reformulate every time.

**Files:**

- Modify: [src/main.js](src/main.js) (`coachContext` declaration, `resetCoachContext`, `onSuggestion` callback)

- [ ] **Step 1: Add `currentItemReformulateCount: 0` to the `coachContext` literal.**

Find the `coachContext = { ... }` declaration (around line 590-665). Locate the `suggestionHistory: new Map(),` line near the bottom (~line 661). Immediately after it, add:

```js
  /**
   * Per-item reformulate attempt counter, reset whenever the pin
   * moves to a different itemId or is marked asked. Read at fire
   * time in armReformulateTimer to decide between firing another
   * reformulate (count === 0) and firing pivot_within_pillar
   * (count >= 1). See Task 3 for the consumer.
   */
  currentItemReformulateCount: 0,
```

- [ ] **Step 2: Reset it in `resetCoachContext()`.**

Find `resetCoachContext()` (around line 902). After `coachContext.suggestionHistory = new Map();` add:

```js
  coachContext.currentItemReformulateCount = 0;
```

- [ ] **Step 3: Capture the previous pin's itemId BEFORE the new pin overwrites state in the `onSuggestion` callback.**

The Coach construction site is around line 2772 (`coachSession = new Coach({`). Inside the `onSuggestion: (payload) => { ... }` callback (around line 2854), at the very top of the function body (before the existing `registerSuggestion({ ... })` call):

```js
        const previousPinnedItemId = (() => {
          if (!currentPinnedSuggestionId) return null;
          return coachContext.suggestionHistory.get(currentPinnedSuggestionId)?.itemId ?? null;
        })();
```

- [ ] **Step 4: Increment / reset the counter right after `registerSuggestion(...)` lands.**

Still inside the `onSuggestion` callback, after the `registerSuggestion({ ... })` call but BEFORE `armReformulateTimer(currentPinnedSuggestionId)`:

```js
        if (payload.kind === 'reformulate' && payload.itemId === previousPinnedItemId) {
          coachContext.currentItemReformulateCount += 1;
        } else {
          coachContext.currentItemReformulateCount = 0;
        }
```

- [ ] **Step 5: Also reset the counter when an entry is flipped to `asked: true`.**

The two paths that mark a pin asked are `applyMarkAsked` (main.js:1586, AI-driven) and `markSuggestionAskedManual` (main.js:1647, rep-driven). In each, after the `entry.asked = true` line:

```js
  coachContext.currentItemReformulateCount = 0;
```

This guarantees that if the rep finally asks the question, the next pin (whatever it is) starts with a clean counter.

- [ ] **Step 6: Restart and sanity-check.**

Type `rs` in the npm-start terminal. Open DevTools console. In an automated-mode session, let one suggestion pin. Inspect `process.versions` (or expose `coachContext` via a temporary `console.log` in `onSuggestion` to verify the counter is set to 0 on first pin, 1 if you wait 10s for a reformulate, 0 if you skip or boost). No behaviour change is expected yet.

- [ ] **Step 7: Commit.**

```bash
git add src/main.js
git commit -m "feat(coach): track per-item reformulate attempts in coachContext

Adds coachContext.currentItemReformulateCount. Increments only when
a new pin lands with kind='reformulate' AND the same itemId as the
previous pin; resets to 0 on every other transition (different item,
different kind, asked, session reset).

No behaviour change yet — Task 3 wires armReformulateTimer to read
the counter."
```

---

## Task 2: Add the `pivot_within_pillar` kind in `src/coach.js`

**Goal:** Surface the new kind end-to-end in the Coach: VALID_KINDS, DIRECTIVES, the queued pillarId slot, `requestSuggestion`, and the `_tick` prompt assembly + dispatch cleanup. The new kind is self-contained — none of the existing kinds change behaviour.

**Files:**

- Modify: [src/coach.js](src/coach.js)

- [ ] **Step 1: Add the directive entry.**

In the `DIRECTIVES` object (line 94-184), after the `reformulate` entry (which ends at line 183), insert:

```js
  pivot_within_pillar: [
    'DIRECTIVE (this turn only):',
    '- mode: pivot_within_pillar',
    '- The auto-coach has already reformulated the previous question once without it',
    '  being asked. Pick a DIFFERENT not-yet-covered item from the pillar named on the',
    '  TARGETED_PILLAR line and write a question for it. Read the last 2-3 turns first',
    '  so the choice lands naturally.',
    '- The item_id you return MUST be namespaced under TARGETED_PILLAR (e.g. for',
    '  TARGETED_PILLAR=finance, use finance.<localId>). Do NOT use freeform sentinels.',
    '- Fallback: if no items in TARGETED_PILLAR are eligible (all covered, logged, or',
    '  in RECENTLY SKIPPED), apply pivot semantics — pick a low-coverage pillar that',
    '  has not been touched in the recent transcript, and tag the question with a',
    '  real rubric item id from that pillar.',
    '- Rationale rules from the system prompt still apply (no stage directions; explain',
    '  WHY this question fits the moment).',
  ].join('\n'),
```

- [ ] **Step 2: Add the kind to `VALID_KINDS`.**

Find line 187:

```js
const VALID_KINDS = new Set(['next', 'deeper', 'pivot', 'pause', 'recap', 'targeted', 'reformulate']);
```

Replace with:

```js
const VALID_KINDS = new Set(['next', 'deeper', 'pivot', 'pause', 'recap', 'targeted', 'reformulate', 'pivot_within_pillar']);
```

- [ ] **Step 3: Add the `queuedPillarId` field next to `queuedTargetedItemId`.**

In the `Coach` constructor (around line 453), immediately after `this.queuedTargetedItemId = null;`:

```js
    /** Companion to queuedSuggestionKind for `pivot_within_pillar` asks: the
     *  rubric pillar id the auto-pivot should stay within. Read by _tick()
     *  and appended to the user message as `TARGETED_PILLAR: <id>` right
     *  after the DIRECTIVE block. Cleared once the tick has dispatched
     *  (one-shot, same lifecycle as queuedTargetedItemId). */
    this.queuedPillarId = null;
```

- [ ] **Step 4: Extend `requestSuggestion` to accept and route the `pillarId` param.**

In `requestSuggestion({ kind, itemId } = {})` at line 541, change the destructured params to:

```js
  requestSuggestion({ kind, itemId, pillarId } = {}) {
```

After the existing `if ((normalised === 'targeted' || normalised === 'reformulate') && ...)` branch (~line 569-573), add a parallel block:

```js
    if (normalised === 'pivot_within_pillar' && typeof pillarId === 'string' && pillarId) {
      this.queuedPillarId = pillarId;
    } else {
      this.queuedPillarId = null;
    }
```

Order matters: the `else` here only clears `queuedPillarId` when the kind isn't `pivot_within_pillar`, so a `pillarId` carried in by mistake on (e.g.) `next` is dropped. The earlier `if/else` for `queuedTargetedItemId` should already do the same for itemId — leave it alone.

- [ ] **Step 5: Add the `TARGETED_PILLAR` line to the `_tick` prompt assembly.**

In `_tick` (around line 838-845), find:

```js
      if (wantSuggest) {
        parts.push('', DIRECTIVES[requestedKind] || DIRECTIVES.next);
        if ((requestedKind === 'targeted' || requestedKind === 'reformulate') && targetedItemId) {
          parts.push(`TARGETED_ITEM: ${targetedItemId}`);
        }
      }
```

Just before the closing `}` of this block, after the `TARGETED_ITEM` push, add a parallel push for the new kind. Also grab the queued pillar id alongside `targetedItemId` (which is captured at line 839: `const targetedItemId = this.queuedTargetedItemId;`).

Add at line 839 area, alongside `targetedItemId`:

```js
      const targetedPillarId = this.queuedPillarId;
```

Then inside the `if (wantSuggest)` block, after the `TARGETED_ITEM` branch:

```js
        if (requestedKind === 'pivot_within_pillar' && targetedPillarId) {
          parts.push(`TARGETED_PILLAR: ${targetedPillarId}`);
        }
```

- [ ] **Step 6: Clear `queuedPillarId` in the dispatch-cleanup block.**

At [src/coach.js](src/coach.js):902-910 (the existing cleanup block that clears `queuedSuggestionKind` and `queuedTargetedItemId` after a successful dispatch), extend the clearing logic. The current block looks like:

```js
      if (this.queuedSuggestionKind === requestedKind) {
        this.queuedSuggestionKind = null;
        if (
          (requestedKind === 'targeted' || requestedKind === 'reformulate') &&
          this.queuedTargetedItemId === targetedItemId
        ) {
          this.queuedTargetedItemId = null;
        }
      }
```

Add a parallel inner clause for the new kind:

```js
      if (this.queuedSuggestionKind === requestedKind) {
        this.queuedSuggestionKind = null;
        if (
          (requestedKind === 'targeted' || requestedKind === 'reformulate') &&
          this.queuedTargetedItemId === targetedItemId
        ) {
          this.queuedTargetedItemId = null;
        }
        if (requestedKind === 'pivot_within_pillar' && this.queuedPillarId === targetedPillarId) {
          this.queuedPillarId = null;
        }
      }
```

- [ ] **Step 7: Restart and sanity-check in isolation.**

Restart (`rs`). The kind isn't yet wired to fire from any timer — but you can force it via DevTools in the main process by calling `coachSession.requestSuggestion({ kind: 'pivot_within_pillar', pillarId: 'finance' })` from a debug REPL or temporary IPC. Expected: a fresh suggestion lands tagged with a `finance.<something>` item id, and the renderer console shows the new payload.kind value. (If you don't have a debug REPL handy, skip this micro-test — Task 5 will exercise the full path.)

- [ ] **Step 8: Commit.**

```bash
git add src/coach.js
git commit -m "feat(coach): add pivot_within_pillar kind for auto-pivot

New kind + directive: pivot to a different item in a given pillar
when the auto-reformulate cap is exceeded. Carries the pillar id via
queuedPillarId / TARGETED_PILLAR line, in the same one-shot pattern
used by targeted/reformulate's queuedTargetedItemId / TARGETED_ITEM.

Directive includes a model-side fallback: if the pillar is exhausted
(all items covered/logged/recently-skipped) apply regular pivot
semantics.

No call sites use the new kind yet — Task 3 wires armReformulateTimer
to fire it."
```

---

## Task 3: Branch `armReformulateTimer` to fire reformulate vs pivot_within_pillar

**Goal:** This is the behaviour change. After the existing guards pass, consult `coachContext.currentItemReformulateCount` and fire one of two requests.

**Files:**

- Modify: [src/main.js](src/main.js) (`armReformulateTimer`, add `pillarIdForItem` helper)

- [ ] **Step 1: Add the `pillarIdForItem` helper near the top of `src/main.js`.**

Pick a location near the other small helpers (e.g., near the `silentFailureLogged` block ~line 859, or anywhere at module scope above `armReformulateTimer`). Add:

```js
/**
 * Extract the pillar id from a namespaced rubric item id. Items are
 * stored as `<pillarId>.<localId>` (e.g. 'finance.annual_cost'). Returns
 * the input unchanged if no dot is found (defensive — shouldn't happen
 * for real rubric items, but freeform sentinels like 'freeform.deeper'
 * are pre-filtered upstream).
 */
function pillarIdForItem(itemId) {
  if (typeof itemId !== 'string') return '';
  const dot = itemId.indexOf('.');
  return dot > 0 ? itemId.slice(0, dot) : itemId;
}
```

- [ ] **Step 2: Branch the timer's fire path.**

Find the `setTimeout` callback inside `armReformulateTimer` ([src/main.js](src/main.js):1736-1762). The current last two lines of the callback (after all guards) are:

```js
    console.log('[coach] auto-reformulating pinned suggestion:', entry.itemId);
    coachSession.requestSuggestion({ kind: 'reformulate', itemId: entry.itemId });
```

Replace those two lines with:

```js
    if (coachContext.currentItemReformulateCount === 0) {
      console.log('[coach] auto-reformulating pinned suggestion:', entry.itemId);
      coachSession.requestSuggestion({ kind: 'reformulate', itemId: entry.itemId });
    } else {
      const pillarId = pillarIdForItem(entry.itemId);
      console.log(
        '[coach] auto-pivoting within pillar after reformulate cap:',
        entry.itemId,
        '→ pillar',
        pillarId,
      );
      coachSession.requestSuggestion({ kind: 'pivot_within_pillar', pillarId });
    }
```

Notes:
- `requestSuggestion` already stamps the previous pin's itemId into the Coach's `skippedItemIds` set for any non-reformulate kind ([src/coach.js](src/coach.js):553-555), so the old item is automatically dropped from candidacy. No extra stamping needed.
- The freeform-sentinel case (`entry.itemId === 'freeform.deeper'` etc.) is unlikely to land in this path — reformulate-eligible items are real rubric items — but `pillarIdForItem` defensively returns the input unchanged if there's no dot, so the model still receives a well-formed TARGETED_PILLAR line. If you want to be belt-and-braces, add an `if (entry.itemId.startsWith('freeform.')) return;` at the very top of the setTimeout callback so the auto-pivot path never fires for sentinels.

- [ ] **Step 3: Restart and smoke-test the count===0 path.**

Restart (`rs`). In an automated-mode session, click Suggest. Don't ask the question. Wait ~10s. Expected: the console logs `[coach] auto-reformulating pinned suggestion: <itemId>` exactly once and the pinned suggestion is replaced by a reworded variant on the same item. Same behaviour as today.

- [ ] **Step 4: Smoke-test the count>=1 path.**

After the reformulate above lands, again don't ask the question. Wait another ~10s. Expected: console logs `[coach] auto-pivoting within pillar after reformulate cap: <itemId> → pillar <pillarId>` exactly once, and the new pin's `itemId` is a DIFFERENT item from the same pillar (e.g. `finance.annual_cost` → `finance.budget_process`). The Coach's `Recently skipped` diagnostic in the prompt should now include the original itemId.

If the new pin lands on a different pillar, the model judged the active pillar exhausted — verify by checking the `RUBRIC STATE` block in the prompt logs that the original pillar genuinely has no eligible candidates. If it does and the model still pivoted away, the directive needs tightening; revisit in Task 2.

- [ ] **Step 5: Commit.**

```bash
git add src/main.js
git commit -m "feat(coach): cap auto-reformulate at 1 attempt, then pivot within pillar

armReformulateTimer's setTimeout callback now branches on
coachContext.currentItemReformulateCount:
 - 0 → fire reformulate as today (same item, fresh wording)
 - >=1 → fire pivot_within_pillar with the original item's pillarId

Adds pillarIdForItem(itemId) helper (slice on '.').

The previous-item drop from candidacy is handled by Coach.requestSuggestion's
existing skip-set stamp for non-reformulate kinds — no extra stamping needed."
```

---

## Task 4: Pass previous wordings into the reformulate prompt

**Goal:** Make the single allowed reformulate genuinely different by feeding the model the wordings it has already used for this item. Small additive change to `buildCoachContextSnapshot` (the upstream) and `_tick` (the consumer).

**Files:**

- Modify: [src/main.js](src/main.js) (`buildCoachContextSnapshot`)
- Modify: [src/coach.js](src/coach.js) (`_tick` prompt assembly)

- [ ] **Step 1: Extend `buildCoachContextSnapshot` with the new field.**

Find `buildCoachContextSnapshot()` at [src/main.js](src/main.js):1359. Inside the returned object literal (around line 1378-1390 area, where `itemStates`, `capturedFields`, `recentSellerTurns`, `recapWindow` are returned), add:

```js
    recentWordingsForPinnedItem: (() => {
      if (!currentPinnedSuggestionId) return [];
      const pinned = coachContext.suggestionHistory.get(currentPinnedSuggestionId);
      if (!pinned) return [];
      const out = [];
      for (const entry of coachContext.suggestionHistory.values()) {
        if (entry.id === pinned.id) continue;
        if (entry.itemId !== pinned.itemId) continue;
        if (typeof entry.questionText !== 'string' || !entry.questionText) continue;
        out.push(entry.questionText);
      }
      return out.slice(-5);
    })(),
```

This walks every history entry, keeps the ones whose `itemId` matches the currently-pinned item (excluding the current pin itself), keeps only the most recent 5 in insertion order. With a cap of 1 reformulate the list will usually contain 1 entry — the original wording — but the surface tolerates a larger cap if we ever raise it.

- [ ] **Step 2: Update the Coach typedef to document the new field.**

In [src/coach.js](src/coach.js) at the constructor JSDoc (~line 326-331), where the `getContext` return shape is documented, add the new field:

```js
 *   getContext: () => {
 *     transcriptWindow: string,
 *     itemStates: Record<string, { state: string, evidence?: string, confidence?: number, at?: number }>,
 *     capturedFields: Record<string, { value: string }>,
 *     recentSellerTurns?: string[],
 *     recentWordingsForPinnedItem?: string[],
 *   };
```

This is doc-only; the runtime just reads `ctx.recentWordingsForPinnedItem`.

- [ ] **Step 3: Render the `PREVIOUS WORDINGS` block in `_tick` on reformulate.**

In `_tick` ([src/coach.js](src/coach.js)) at the prompt-assembly area (~line 822-866), after the `parts` array is created (~line 822: `const parts = [stateBlock];`) and before the directive is pushed, add a guarded block:

```js
      if (wantSuggest && requestedKind === 'reformulate') {
        const wordings = Array.isArray(ctx.recentWordingsForPinnedItem)
          ? ctx.recentWordingsForPinnedItem
          : [];
        if (wordings.length > 0) {
          const lines = [
            '',
            'PREVIOUS WORDINGS for this item (do not paraphrase trivially — vary the angle, not just the verb):',
          ];
          wordings.forEach((w, i) => {
            lines.push(`${i + 1}. "${w}"`);
          });
          parts.push(...lines);
        }
      }
```

Place this BEFORE the `if (wantMarkAsked) { ... }` block that adds the `PENDING SUGGESTIONS` lines, so the prompt reads top-down as: rubric state → previous wordings → pending suggestions → directive → targeted lines → transcript. (Ordering is cosmetic; the model reads everything regardless. Pick this order for readability when debugging logs.)

- [ ] **Step 4: Restart and verify the prompt contains the block.**

Restart (`rs`). Trigger a reformulate (click Suggest, wait 10s without asking). Enable provider request logging if available (Settings → Providers → Show prompts) OR temporarily `console.log(userText)` in `_tick` just before `provider.generateContent`. Expected: the user message for the reformulate tick includes a `PREVIOUS WORDINGS for this item ...` line followed by `1. "<original wording>"`.

If the block is missing:
- Confirm `currentPinnedSuggestionId` is set when the tick fires (it should be — the reformulate timer only fires when a pin is live).
- Confirm `buildCoachContextSnapshot` returns the new field (log it).
- Confirm the wordings array isn't empty (the original pin's text should be in `suggestionHistory` with the previous id).

- [ ] **Step 5: Commit.**

```bash
git add src/main.js src/coach.js
git commit -m "feat(coach): surface previous wordings on reformulate prompts

buildCoachContextSnapshot now returns recentWordingsForPinnedItem —
last 5 questionText values from suggestionHistory entries that share
itemId with the currently-pinned suggestion (excluding the pin itself).

Coach._tick prepends a 'PREVIOUS WORDINGS for this item' block before
the directive when kind === 'reformulate' and the array is non-empty.
The block instructs the model to vary the angle, not just the verb.

JSDoc for the getContext typedef updated to document the new field."
```

---

## Task 5: Verify the end-to-end behaviour with a real session

**Goal:** Walk through the full per-item lifecycle in an automated-mode session. Catch anything missed by the per-task smoke tests.

No files are modified in this task unless a check fails. Each failed check requires a follow-up commit on the appropriate file.

- [ ] **Step 1: Happy path — single-item lifecycle.**

Start an automated-mode coach session. Wait for the kickstart pin (or click Suggest). Do NOT ask the question. Tick each as it happens:

- [ ] **t≈10s:** Console logs `[coach] auto-reformulating pinned suggestion: <itemId>`. New pin's `questionText` is meaningfully different from the original (different anchor word, different sentence shape — not just a verb swap). `coachContext.currentItemReformulateCount` is 1.
- [ ] **t≈20s:** Console logs `[coach] auto-pivoting within pillar after reformulate cap: <originalItemId> → pillar <pillarId>`. New pin's `itemId` is a different item but starts with the same `<pillarId>` prefix. `coachContext.currentItemReformulateCount` is back to 0.
- [ ] **t≈30s:** A new reformulate fires on the NEW item (count goes 0 → 1 on the new item).
- [ ] **t≈40s:** Another pivot fires.

- [ ] **Step 2: Counter reset cases.**

In a fresh session, exercise each branch:

- [ ] After a reformulate lands (count=1), click **Skip** on the suggestion card. New pin from `coachSession.skip()` ([src/coach.js](src/coach.js):588) has a different itemId → counter resets to 0. Confirm via DevTools.
- [ ] After a reformulate lands (count=1), tick the suggestion off manually. The renderer's mark-asked IPC → `markSuggestionAskedManual` → counter resets. Next pin starts at 0.
- [ ] After a reformulate lands (count=1), the AI fires `mark_question_asked` from the transcript. `applyMarkAsked` resets the counter. Next pin starts at 0.
- [ ] Mid-cycle, the rep clicks **Deeper** / **Pivot** / **Recap**. New pin has a different kind → counter resets to 0.

- [ ] **Step 3: Pillar-exhausted fallback.**

Either pick a small pillar with few items, or use DevTools to manually transition all items in the active pillar to `covered` (via temporary IPC or by setting `coachContext.itemStates`). Trigger the pivot path (let the timer fire twice on a now-exhausted-pillar item). Expected: the model falls back to a regular pivot — new pin's `itemId` is from a different pillar. Console still shows the pivot log (the kind is unchanged from main.js's perspective; the model honoured the directive's fallback).

If the model instead returns an item from the exhausted pillar anyway, tighten the directive in Task 2 (e.g. add an explicit "do NOT return an item from TARGETED_PILLAR if all of its items appear in covered / logged / RECENTLY SKIPPED").

- [ ] **Step 4: Reformulate quality eyeball.**

Compare the original wording with its reformulate side-by-side for 3 different items / pillars. The reformulate should:
- Use a different anchor word ("How much" vs "What's your current spend on…").
- Use a different sentence shape (statement-then-question vs direct question).
- Stay on-intent for the same rubric item.

If reformulates still feel like trivial paraphrases, escalate the language in the `PREVIOUS WORDINGS` block (Task 4 Step 3) — e.g. spell out "different anchor, different shape, different angle — not a verb swap".

- [ ] **Step 5: Regression — existing kinds still behave.**

Run through each manual coach trigger in automated mode and confirm nothing else broke:

- [ ] **Suggest button** → fires `next`, counter resets, no reformulate-cap interference.
- [ ] **Deeper button** → fires `deeper`, counter resets.
- [ ] **Pivot button** → fires `pivot`, counter resets.
- [ ] **Per-item + Ask button** → fires `targeted` with the requested itemId, counter resets.
- [ ] **Pause nudge** (rep silent for 6s in automated mode) → fires `pause`, counter resets.
- [ ] **Recap button** → fires `recap` (priority bypass), counter resets.
- [ ] **Logged-pillar item click** → fires `boost` → counter resets.

- [ ] **Step 6: Fix anything broken.**

For each failing check above, fix the issue in the appropriate file. Common things to look for:

- Counter not resetting: confirm the `onSuggestion` callback's reset path (`else { ... = 0; }`) actually fires for the kind in question. The condition `payload.kind === 'reformulate' && payload.itemId === previousPinnedItemId` should only be truthy for actual reformulate-on-same-item pins.
- Counter not incrementing: confirm `previousPinnedItemId` is captured BEFORE `registerSuggestion` overwrites `currentPinnedSuggestionId`. If it's null when it shouldn't be, the capture closure is reading state too late.
- TARGETED_PILLAR line missing in prompt: confirm `queuedPillarId` is set in `requestSuggestion` and read in `_tick`'s assembly. The dispatch-cleanup block (Task 2 Step 6) should not clear it before the prompt is built.
- Model returning items from a different pillar: directive needs tightening OR the model is interpreting "the conversational beat" as a stronger signal than the pillar constraint. Add an emphatic line to the directive.

Each fix gets its own focused commit.

- [ ] **Step 7: Final commit (only if Steps 1-6 found nothing wrong).**

If the full verification passes without changes, no commit needed — Tasks 1-4 already encode the work. Verify `git status` is clean.

---

## Final state — what the engineer should hand back

When this plan is done:

- In automated mode, a single rubric item gets at most: 1 original pin + 1 reformulate pin + an auto-pivot to a different item in the same pillar. Roughly 20 seconds total before the coach moves on.
- The single allowed reformulate visibly differs from the original (driven by the `PREVIOUS WORDINGS` block in the prompt).
- The `pivot_within_pillar` kind appears in the renderer's `coach:suggestion` payload's `kind` field when the auto-pivot fires.
- `coachContext.currentItemReformulateCount` correctly tracks consecutive reformulates on the same item and resets on every relevant transition.
- All existing coach kinds (`next` / `deeper` / `pivot` / `pause` / `recap` / `targeted` / `reformulate`) behave exactly as before.

## Pointers for follow-up work (out of scope here)

- **Transcript-movement gating** of the reformulate timer (don't fire if the rep has been silent since the pin landed). Decided not to include in this fix; revisit if the cap-of-1 still feels too eager.
- **User-configurable cap** in Advanced settings. Keep hard-coded at 1 for now; revisit only if real-world calls show the cap should differ per session style.
- **Renderer badge** ("Coach pivoted within Finance") when `payload.kind === 'pivot_within_pillar'`. Nice-to-have for visibility; doesn't affect underlying behaviour.
- **Same-pillar logic for the pause-nudge path.** `pause` already stamps the previous item into the skip set via `requestSuggestion`, so the model naturally picks something else. Only revisit if the model is observed to leak away from the active pillar on pause nudges too.

These all touch the same files this plan modifies; reach for them when the scope is approved.
