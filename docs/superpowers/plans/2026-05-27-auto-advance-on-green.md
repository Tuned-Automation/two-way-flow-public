# Auto-Advance on Green — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Automated coach mode, fire a fresh `next` suggestion the instant a pinned question goes green — whether the AI auto-detected the seller asking it or the rep manually ticked it — so a follow-up question is already being generated before the prospect finishes answering.

**Architecture:** The green transition is a single function flip — `applyMarkAsked()` in `src/main.js` — reached via two callers (the AI's `mark_question_asked` tool dispatch and the manual mark-asked IPC handler). The change adds a guarded `coachSession.requestSuggestion({ kind: 'next' })` call after each caller's existing `broadcastSuggestionHistory()`, gated on `coachMode === 'automated'`. No new state, no new IPC channels, no renderer or UI changes; rides on existing `requestSuggestion`-stamps-skip-set logic in `src/coach.js` and the coach's per-tick inflight mutex to stay safe under double-clicks and overlapping ticks.

**Tech Stack:** Existing Electron 42 main-process JS. No new dependencies.

**Spec:** n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **Clean working tree** (`git status` shows clean) or OK throwing away in-progress work.
- [ ] **App starts cleanly today.** Run `npm start`. Window opens; no console errors at startup.
- [ ] **`.env` has `GEMINI_API_KEY`** (or another configured provider key) if you want to exercise the AI auto-detect path. The manual-tick path is testable end-to-end without a key — start a session, type a question into the chat, click the green tick on the pinned suggestion, watch the console.
- [ ] **You can switch the coach into Automated mode** via the header pill (the Signalled/Automated toggle). This plan's behaviour ONLY fires in Automated mode, so verification requires that toggle to flip.

`src/main.js` lives in the main process, so HMR does NOT pick up changes. Type `rs` in the `npm start` terminal (or kill + rerun) after every edit.

---

## File map

```
NEW files (created by this plan):
  (none)

MODIFIED files:
  src/main.js
    - onQuestionAsked callback (~line 2875-2878) inside the
      Coach({...}) constructor call
    - ipcMain.handle('coach:mark-suggestion-asked') handler
      (~line 3492-3500)
    - coachMode doc-block at ~line 712-726: add a fourth bullet
      ("auto-advance-on-green") alongside the existing
      kickstart / pause-nudge / auto-reformulate triggers

DELETED:
  (none)
```

The file map is intentionally narrow — every behavioural touch is in `src/main.js`. No `src/coach.js`, `src/preload.js`, `src/renderer.js`, `index.html`, or CSS edits are required to ship this feature.

---

## Public / shared interface impact

None — purely internal to `src/main.js`.

- No new IPC channels.
- The existing `coach:mark-suggestion-asked` IPC handler's request payload and return shape are unchanged (still `{ ok, error?, alreadyAsked? }`).
- The existing `coach:suggestion`, `scoring:suggestion-history`, and `scoring:item-state` events are unchanged (same payload, same emit conditions).
- `coachSession.requestSuggestion({ kind: 'next' })` is being CALLED from new code, but its signature, queue semantics, and inflight-gate behaviour are unchanged.
- No `localStorage` keys, no Settings schema, no persisted state.
- No new CSS classes, no DOM contract changes.

---

## Potential overlaps with other in-flight plans

The change is localised to `src/main.js`, but specifically touches three high-traffic regions of that file. Any parallel plan working in those regions will overlap textually with this plan.

- **The Coach session callbacks block** (`src/main.js`:~2810-2906, where the `Coach({ onSuggestion, onField, onMeetingFact, onQuestionAsked, getSuggestionContext, onError, onTickStart, onTickEnd })` constructor call lives). Any plan that adds or modifies callbacks (e.g. a plan that changes `onSuggestion` payload shape, adds a new callback for the model, or wires a new tool through the Coach) will need to merge with our `onQuestionAsked` edit.
- **The `coach:*` IPC handler cluster** (`src/main.js`:~3408-3553, where `coach:set-mode`, `coach:skip`, `coach:boost`, `coach:mark-suggestion-asked`, `coach:ask-suggest`, `coach:ask-recap`, `coach:ask-item` all live). Any plan adding new ask-style buttons or modifying mark-asked semantics overlaps directly with our IPC-handler edit.
- **The coach-mode doc-block** (`src/main.js`:~712-726). Any plan that adds a new Automated-mode trigger (a new pause-style heuristic, a "follow-up depth" feature, etc.) will also want to update this doc-block.
- **`coachSession.requestSuggestion` semantics in `src/coach.js`** — this plan does not change the function, but a parallel plan that changes when / how the previous pin's `itemId` is stamped into `skippedItemIds` could subtly affect our auto-advance's "don't immediately re-pin the same item" guarantee.

Coordinator should check the above regions across the other ~10 parallel plans for collisions.

---

## Architecture invariants

These rules must hold across every task in this plan. If a step contradicts one, stop and re-read.

1. **The change is additive only.** No existing branch of `applyMarkAsked`, `markSuggestionAskedManual`, the `onQuestionAsked` callback, or the `coach:mark-suggestion-asked` IPC handler is removed or rewritten. We append behaviour.
2. **The auto-advance MUST be gated on `coachMode === 'automated'`.** Signalled mode is documented at `src/main.js`:717 as "the coach NEVER auto-suggests" — that contract is load-bearing for users who explicitly opted out of automation.
3. **`requestSuggestion({ kind: 'next' })` MUST be called AFTER `broadcastSuggestionHistory()`.** The renderer must see `entry.asked = true` (and green the pin) BEFORE the new suggestion arrives on `coach:suggestion`. Reversed order would cause a flash of the old un-greened pin being instantly replaced.
4. **Both call sites must continue to short-circuit on `entry.asked` already being true.** The existing idempotency guards (`applyMarkAsked` returning `false` and `markSuggestionAskedManual` returning `{ alreadyAsked: true }`) are what protect us from duplicate auto-advance fires on double-clicks. Do not bypass them.
5. **The intentional asymmetry between AI path and manual path is preserved.** Per the doc-block at `src/main.js`:1625-1631, only the manual path transitions the rubric item to `'logged'`. This plan does NOT add a `'logged'` transition to the AI path — the AI is expected to pair `mark_question_asked` with `update_item_state(covered)`, and our auto-advance is safe regardless (see Task 1 verification).
6. **The reformulate timer cancellation in `applyMarkAsked` (line 1610-1613) is preserved.** A new pin from the auto-advance will re-arm a clean reformulate timer via the existing `onSuggestion` callback at `src/main.js`:2861.
7. **For consistency with the other ask-* handlers, call `cancelReformulateTimer()` immediately before `requestSuggestion()`** in both new sites. `coach:ask-suggest` (line 3514), `coach:ask-recap` (line 3529), and `coach:ask-item` (line 3550) all follow this pattern — auto-advance follows it too. `applyMarkAsked` already cancels the timer for the matching pin, but this belt-and-braces step covers the edge case where the asked entry was a stale (non-current) pin whose reformulate timer wasn't tied to it.

---

## Task 1: Auto-advance on AI question-asked detection

**Goal:** When the model fires `mark_question_asked` and `applyMarkAsked` flips a question to green, queue a fresh `next`-kind suggestion if the coach is in Automated mode.

**Files:**

- Modify: `src/main.js:2875-2878` (`onQuestionAsked` callback inside the `Coach({...})` constructor call)

**Steps:**

- [ ] **Step 1: Read the current callback to confirm shape.**

Open `src/main.js` and locate the `onQuestionAsked` slot in the Coach constructor call. Today:

```2875:2878:src/main.js
      onQuestionAsked: ({ suggestionId, evidence }) => {
        const changed = applyMarkAsked({ suggestionId, evidence });
        if (changed) broadcastSuggestionHistory();
      },
```

If the surrounding context has moved (different line number, different sibling callbacks), confirm by searching for `onQuestionAsked:` — it must be inside the Coach session constructor in `setupCoachSession` (or whatever the current setup function is named).

- [ ] **Step 2: Replace the callback with the auto-advance variant.**

Replace the four-line block above with:

```js
      onQuestionAsked: ({ suggestionId, evidence }) => {
        const changed = applyMarkAsked({ suggestionId, evidence });
        if (!changed) return;
        broadcastSuggestionHistory();
        // Auto-advance-on-green: in Automated mode, fire a fresh
        // 'next' the moment the model spots the seller asking a
        // pinned question. The pin greens via the broadcast above,
        // and the new suggestion lands within ~1 tick (~1.5s) so
        // the rep has a follow-up ready before the prospect
        // finishes answering. Signalled mode stays calm — see the
        // coachMode doc-block above for the contract.
        //
        // Why no explicit markItemAsAsked() here (unlike the manual
        // path): requestSuggestion() itself stamps the previous
        // pin's itemId into skippedItemIds (see src/coach.js
        // lines 553-555), and the AI typically pairs this call with
        // update_item_state(covered) which also removes the item
        // from the candidate pool. Either way, the next tick won't
        // re-pin the same item.
        if (coachMode === 'automated' && coachSession) {
          cancelReformulateTimer();
          coachSession.requestSuggestion({ kind: 'next' });
        }
      },
```

- [ ] **Step 3: Restart the main process.**

Type `rs` in the `npm start` terminal (or kill + rerun). HMR doesn't apply to main-process code.

- [ ] **Step 4: Verify the AI path in Automated mode.**

Pre-conditions:

1. App is running.
2. Header pill is on **Automated**.
3. Settings → Coach → **Track question state** is ON (otherwise the AI never fires `mark_question_asked`).
4. You have a Gemini key + mic and can start a recording.

Test:

- Start a recording. Wait for the kickstart to fire (~10s) so a question is pinned.
- Read the pinned question out loud (or close enough — paraphrases count).
- Within 1-2 ticks, expect these console lines in order:
  - `[coach] question asked: <id> — <evidence>`
  - `[coach] suggest: <itemId> → <new question> [kind: next, anchor: …]`
- The pin card should green for ~1-2s, then a fresh suggestion replaces it.

If only the first line appears (no `[coach] suggest:` follow-up), confirm:

- `coachMode === 'automated'` (header pill, not Signalled).
- `coachSession` is not null (a session is active).
- No other plan has changed the `Coach` constructor to make `requestSuggestion` a no-op.

- [ ] **Step 5: Verify Signalled mode safety.**

Flip the header pill to **Signalled**. Read another pinned question out loud. Expect:

- `[coach] question asked: …` still fires (the AI still tracks asked questions).
- NO `[coach] suggest: …` follow-up. The pin greens and stays green until the rep clicks Suggest/Deeper/Pivot.

- [ ] **Step 6: Commit.**

```bash
git add src/main.js
git commit -m "feat(coach): auto-advance on AI-detected green in Automated mode

When the Coach's mark_question_asked tool flips a pinned suggestion
to asked, immediately queue a fresh next-kind suggestion so the
rep has a follow-up ready before the prospect finishes answering.

Gated on coachMode === 'automated' — Signalled mode preserves its
'no auto-suggest' contract. Cancels the reformulate timer first
to match the cancel-then-request pattern used by coach:ask-suggest,
coach:ask-recap, and coach:ask-item.

No explicit markItemAsAsked() needed: requestSuggestion() already
stamps the previous pin's itemId into skippedItemIds (coach.js
lines 553-555), and the AI typically pairs mark_question_asked
with update_item_state(covered). Belt-and-suspenders coverage."
```

---

## Task 2: Auto-advance on manual mark-asked (tick button)

**Goal:** When the rep clicks the green tick on the pinned suggestion card and `markSuggestionAskedManual` flips it to green, queue a fresh `next`-kind suggestion if the coach is in Automated mode.

**Files:**

- Modify: `src/main.js:3492-3500` (`ipcMain.handle('coach:mark-suggestion-asked', …)`)

**Steps:**

- [ ] **Step 1: Read the current IPC handler to confirm shape.**

Today:

```3492:3500:src/main.js
  ipcMain.handle('coach:mark-suggestion-asked', (_event, payload) => {
    const suggestionId = typeof payload?.suggestionId === 'string' ? payload.suggestionId : null;
    if (!suggestionId) return { ok: false, error: 'missing_suggestion_id' };
    const result = markSuggestionAskedManual({ suggestionId, source: 'manual_mark_asked' });
    if (result.unknown) return { ok: false, error: 'unknown_suggestion' };
    if (result.alreadyAsked) return { ok: true, alreadyAsked: true };
    if (result.changed) broadcastSuggestionHistory();
    return { ok: true };
  });
```

If the line numbers have shifted, search for `'coach:mark-suggestion-asked'`. The handler must remain inside the main `registerIpcHandlers` (or equivalent) so it picks up `coachMode` and `coachSession` from the same closure.

- [ ] **Step 2: Replace the handler with the auto-advance variant.**

Replace the nine-line block above with:

```js
  ipcMain.handle('coach:mark-suggestion-asked', (_event, payload) => {
    const suggestionId = typeof payload?.suggestionId === 'string' ? payload.suggestionId : null;
    if (!suggestionId) return { ok: false, error: 'missing_suggestion_id' };
    const result = markSuggestionAskedManual({ suggestionId, source: 'manual_mark_asked' });
    if (result.unknown) return { ok: false, error: 'unknown_suggestion' };
    if (result.alreadyAsked) return { ok: true, alreadyAsked: true };
    if (result.changed) {
      broadcastSuggestionHistory();
      // Auto-advance-on-green: in Automated mode, mirror the AI
      // path's behaviour so a manual tick also triggers a fresh
      // next-kind suggestion. The rep has already touched the
      // pin, so the explicit cleanup inside markSuggestionAskedManual
      // (markItemAsAsked + 'logged' transition + skip-set stamp)
      // has run before we get here. requestSuggestion is therefore
      // safe to call without further bookkeeping.
      //
      // Signalled mode stays calm — same contract as Task 1.
      if (coachMode === 'automated' && coachSession) {
        cancelReformulateTimer();
        coachSession.requestSuggestion({ kind: 'next' });
      }
    }
    return { ok: true };
  });
```

- [ ] **Step 3: Restart the main process.**

`rs` in the npm-start terminal.

- [ ] **Step 4: Verify the manual path in Automated mode.**

Pre-conditions: header pill on **Automated**, a session active, a pinned suggestion visible.

Test:

- Click the green tick on the pinned suggestion card.
- Within 1-2 ticks, expect in order:
  - `[coach] question asked: <id> — Manually marked asked by rep: "…"`
  - `[coach] manual mark-asked → logged: <itemId> — <questionText>` (this is the rubric `'logged'` transition that the manual path already does)
  - `[coach] suggest: <itemId> → <new question> [kind: next, …]` (this is the new auto-advance)
- Visually: pin card greens, then ~1-2s later a fresh suggestion replaces it.

- [ ] **Step 5: Verify Signalled mode safety.**

Flip header pill to **Signalled**. Click the green tick on the next pinned suggestion. Expect:

- `[coach] question asked: …` and `[coach] manual mark-asked → logged: …` still fire (the mark-asked itself doesn't depend on mode).
- NO `[coach] suggest: …` follow-up. Pin stays green; rep has to manually ask.

- [ ] **Step 6: Verify idempotency under double-clicks.**

Flip back to **Automated**. Get a fresh pinned suggestion. Click the green tick rapidly 3-4 times in a row. Expect:

- Exactly ONE `[coach] question asked: …` line in the console (the second/third/fourth click resolve `{ alreadyAsked: true }` and short-circuit).
- Exactly ONE `[coach] suggest: …` follow-up (no duplicate auto-advance fires).

This validates that the `result.changed` guard is keeping the new request out of the duplicate-click path.

- [ ] **Step 7: Commit.**

```bash
git add src/main.js
git commit -m "feat(coach): auto-advance on manual green-tick in Automated mode

When the rep clicks the green tick on the pinned suggestion card
and markSuggestionAskedManual flips it to asked, immediately queue
a fresh next-kind suggestion in Automated mode — mirror of the AI
path landed in the previous commit.

The manual path's existing cleanup (markItemAsAsked + 'logged'
rubric transition + skip-set stamp) runs inside
markSuggestionAskedManual before we call requestSuggestion, so no
additional bookkeeping is needed.

Gated on coachMode === 'automated'. Cancels reformulate timer
first for consistency with the other ask-* IPC handlers.
Idempotent under double-clicks: the result.changed guard skips
duplicate auto-advance fires."
```

---

## Task 3: Update the coach-mode doc-block

**Goal:** Update the load-bearing comment that documents what Automated mode does, so future readers see the auto-advance-on-green trigger listed alongside kickstart, pause-nudge, and auto-reformulate.

**Files:**

- Modify: `src/main.js:712-726` (the coach-mode + pause-detection doc-block)

**Steps:**

- [ ] **Step 1: Read the current doc-block.**

Today:

```712:726:src/main.js
/* ── Coach mode + pause detection (v2.5 redesign) ──────────────────────
 *
 * Coach mode is a per-session setting forwarded from the renderer (with
 * a localStorage default of 'signalled'). It controls whether the
 * pause-detection nudge is active:
 *
 *   'signalled' (default) — the coach NEVER auto-suggests. Suggestions
 *                           only come from the rep's explicit asks
 *                           (Suggest / Deeper / Pivot) or a skip.
 *   'automated'           — same as signalled, PLUS the pause detector
 *                           fires a `kind: 'pause'` request whenever
 *                           the transcript has been silent on both
 *                           channels for PAUSE_THRESHOLD_MS and there's
 *                           no currently-pinned suggestion.
```

(The block continues for a few more lines — leave the trailing lines untouched.)

- [ ] **Step 2: Update the `'automated'` description to list all automated triggers.**

Replace the `'automated'` branch line (the last 6 lines of the snippet above) with:

```js
 *   'automated'           — same as signalled, PLUS the following
 *                           automated triggers:
 *                             • Kickstart — one-shot opening suggestion
 *                               ~10s after session start. See
 *                               `armKickstart()`.
 *                             • Pause nudge — `kind: 'pause'` request
 *                               whenever the transcript has been silent
 *                               on both channels for PAUSE_THRESHOLD_MS
 *                               and there's no currently-pinned
 *                               suggestion. See `maybeFirePauseNudge()`.
 *                             • Auto-reformulate — `kind: 'reformulate'`
 *                               request every REFORMULATE_DELAY_MS while
 *                               a pin stays unasked. Additionally gated
 *                               on coach.trackQuestionState and
 *                               coach.autoReformulate Advanced toggles.
 *                               See `armReformulateTimer()`.
 *                             • Auto-advance on green — `kind: 'next'`
 *                               request the moment a pinned question
 *                               flips to asked (either via the AI's
 *                               mark_question_asked tool or the rep's
 *                               manual tick button). See the
 *                               onQuestionAsked callback and the
 *                               coach:mark-suggestion-asked IPC handler.
```

If the file uses a different exact prefix (`*` vs `* `), match it. Don't change the trailing lines after the `'automated'` branch.

- [ ] **Step 3: Sanity-read the updated block.**

Re-read the whole doc-block top to bottom. Confirm the four bullets are clearly distinct, each names the function/IPC that implements it, and the "Signalled NEVER auto-suggests" contract above still reads cleanly as the opposing rule.

- [ ] **Step 4: Commit.**

```bash
git add src/main.js
git commit -m "docs(coach): expand Automated-mode doc-block with all four triggers

The block at src/main.js:712 was last touched when only pause-nudge
existed in Automated mode. Since then we have kickstart, auto-
reformulate, and (this PR) auto-advance-on-green. Make all four
explicit so future readers see one canonical list and the
Signalled vs Automated contract stays unambiguous."
```

---

## Task 4: Final cross-mode regression sweep

**Goal:** Walk every combination of (mode × path × timing) to confirm no behaviour regressed and the new auto-advance fires exactly when it should.

**Files:** none changed unless something fails.

**Steps:**

- [ ] **Step 1: Automated × AI auto-detect.**

Pre-conditions: Automated mode, Track question state ON, recording active, a pinned suggestion that the AI can plausibly detect being asked.

Read the pinned question out loud (paraphrase OK). Expect a new pin within ~1-2s.

- [ ] **Step 2: Automated × manual tick.**

Get a fresh pinned suggestion (click Suggest if needed). Click the green tick. Expect a new pin within ~1-2s.

- [ ] **Step 3: Automated × manual tick × double-click.**

Click the green tick twice rapidly. Expect exactly one new pin (no duplicates).

- [ ] **Step 4: Automated × AI auto-detect while rep is mid-sentence.**

This is the user-described "occasionally answered as the speaker is talking" case. Mid-recording, while the prospect is mid-answer, watch the console. If the AI fires `mark_question_asked` on a paraphrase the rep already worked in earlier, the auto-advance should fire the moment the green lands, regardless of who is currently talking.

- [ ] **Step 5: Signalled × AI auto-detect.**

Flip to Signalled. Read a pinned question out loud. Expect `[coach] question asked: …` to fire, but NO `[coach] suggest: …` follow-up. The pin greens and stays.

- [ ] **Step 6: Signalled × manual tick.**

Click the green tick. Expect the same — green lands, no auto-advance.

- [ ] **Step 7: Mode flip mid-call.**

In Automated mode with a pinned suggestion, flip the header pill to Signalled. Then click the green tick. Expect NO auto-advance (the read of `coachMode` happens at click-time, so the new mode applies immediately).

Flip back to Automated; on the next green transition the auto-advance should fire again.

- [ ] **Step 8: Existing pause-nudge still works.**

In Automated mode with NO pinned suggestion, wait 6+ seconds with no transcript activity. The pause-nudge should still fire (`[coach] pause nudge fired (silence = …ms)` → `[coach] suggest: …`). The auto-advance plan does not change this path.

- [ ] **Step 9: Existing auto-reformulate still works.**

In Automated mode with Track question state ON and Auto-reformulate ON, get a pinned suggestion and let it sit unasked for 10s+. The reformulate should still fire (`[coach] suggest: <same item> → … [kind: reformulate, …]`).

- [ ] **Step 10: Recap / Deeper / Pivot / targeted ask still work.**

Click each of those buttons. Each should still fire its corresponding `[coach] suggest:` with the right `kind:` label. No regression.

- [ ] **Step 11: If everything passes, no further commit needed.**

Tasks 1-3 already encode the work. `git status` should be clean.

If something failed, the fix belongs in a focused follow-up commit on the appropriate task's files.

---

## Final state — what the engineer should hand back

When this plan is done:

- `src/main.js`'s `onQuestionAsked` callback and `coach:mark-suggestion-asked` IPC handler each include a guarded `coachSession.requestSuggestion({ kind: 'next' })` call after the existing `broadcastSuggestionHistory()`, gated on `coachMode === 'automated'`.
- The coach-mode doc-block at `src/main.js`:712 lists all four Automated-mode triggers (kickstart, pause-nudge, auto-reformulate, auto-advance-on-green).
- All other source files (`src/coach.js`, `src/renderer.js`, `src/preload.js`, `index.html`, `src/index.css`, settings, providers, etc.) are unchanged.
- The manual test plan in Task 4 passes — green-on-asked auto-advances in Automated mode (both AI and manual paths), Signalled mode stays calm, double-clicks stay idempotent, and the existing kickstart / pause-nudge / auto-reformulate / Deeper / Pivot / Recap / targeted paths still work.

## Pointers for follow-up work (out of scope here)

- A new Settings toggle to control auto-advance independently of the Signalled/Automated header pill (e.g. an "advanced" `coach.autoAdvanceOnAsked`). The current plan rides on the header pill, which is the lightest behaviour the user asked for; a separate toggle would need a Settings UI + persistence + schema entry.
- Auto-advancing with a different `kind` based on the original pin's kind (e.g. asked a Deeper → auto-fire another Deeper). The current plan always fires `kind: 'next'` because the user asked for "the next question to be asked".
- Symmetric `'logged'` rubric-state transition on the AI auto-detect path. The asymmetry between AI and manual paths is intentional today (see `src/main.js`:1625-1631) and not in scope; the new auto-advance is safe under the existing asymmetry.
- Visual feedback during the ~1-2s window between green and the new pin landing (e.g. a faint loading shimmer on the pin card). Today the renderer's existing "thinking" dot (`coach:tick-start` / `coach:tick-end`) is enough; a more prominent indicator would be a renderer change.
