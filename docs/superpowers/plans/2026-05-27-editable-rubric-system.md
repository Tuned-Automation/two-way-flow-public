# Editable Rubric System — Implementation Plan

**Goal:** Lift the hardcoded rubric out of `src/rubric.js` into a swappable JSON-backed library managed from a new "Rubrics" tab in Settings, where each rubric owns its own pillars, items, captured fields, live flags, voice & tone, and full AI coaching instructions.

**Architecture:** One JSON file per rubric in `userData/rubrics/<id>.json` plus an `index.json` tracking the active id. `src/rubric-defaults.js` (NEW) holds the current Tuned Automation rubric verbatim as a seed and is written to disk on first launch by `src/rubric-store.js` (NEW). `src/rubric.js` is refactored from a `const` catalogue into a thin loader that exposes the same named exports (`PILLARS`, `ITEMS`, …, `COACH_SYSTEM_INSTRUCTION`) as `let` bindings backed by the active rubric, plus a `reloadActiveRubric()` function. CRUD lives in a new "Rubrics" tab in the existing Settings modal, driven by new `rubrics:*` IPC channels; swapping the active rubric is gated to between-calls and triggers a Coach + live-session teardown so the new schemas land on the next Start.

**Tech Stack:** Electron 42, Vite 5, vanilla JS, existing provider SDKs (`@google/genai`, `@anthropic-ai/sdk`, `openai`) unchanged. No new npm dependencies.

**Spec:** n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **App boots cleanly today.** `npm start` opens the overlay, the pillar rail renders all 14 pillars, and a Start + Stop cycle completes without console errors.
- [ ] **Clean working tree.** `git status` shows clean (or OK throwing away in-progress work).
- [ ] **`.env` has `GEMINI_API_KEY` and `DEEPGRAM_API_KEY`** for the smoke test at the end. Editor work itself doesn't need them.
- [ ] **Note your existing `userData` rubric folder.** Normally absent on a fresh install. If `~/Library/Application Support/Two Way Flow/rubrics/` already exists, move it aside — first-run seeding only fires when the folder is missing.

HMR auto-reloads CSS / HTML / renderer changes. **Main-process changes** (`src/main.js`, `src/preload.js`, `src/rubric.js`, `src/rubric-store.js`, `src/rubric-defaults.js`, `src/coach.js`) require typing `rs` in the `npm start` terminal or restarting.

---

## File map

```
NEW files:
  src/rubric-defaults.js              — DEFAULT_RUBRIC seed (current Tuned Automation rubric + prompts, as JS data)
  src/rubric-store.js                 — JSON-on-disk store: list/load/save/create/duplicate/delete/set-active/export/import/validate/ensureSeeded

MODIFIED files:
  src/rubric.js                       — refactor: live-binding `let` exports + reloadActiveRubric() + per-rubric prompt build
  src/coach.js                        — move UPDATE_ITEM_STATE / RECORD_FIELD / SUGGEST_NEXT_QUESTION / MARK_QUESTION_ASKED tool schemas into a per-Coach _buildTools() method so each new Coach picks up the active rubric's enums
  src/main.js                         — register rubrics:* IPC handlers; call rubricStore.ensureSeeded() at boot; gate set-active on idle; teardown Coach + live session on rubric swap; broadcast rubrics:changed
  src/preload.js                      — expose rubrics:* channels on contextBridge (window.rubrics.*); subscribe rubrics:changed
  src/renderer.js                     — Rubrics tab UI (library bar, sectioned editor, save/discard/set-active); listen for rubrics:changed and re-render rail/items/captured pane; wire #rubricSwitcher pill
  src/index.css                       — styles for the new Rubrics tab (list rows, drag handles, glyph picker, tint swatch, advanced-prompt warning banner, error/warning banners)
  index.html                          — add seventh "Rubrics" tab to Settings modal; update #rubricSwitcher title to reflect the active rubric's name
  src/settings.js                     — minor: read-through accessor for `general.activeRubricId` as a backup pointer (the source of truth stays rubrics/index.json; settings field exists so a settings-export bundles the user's active-rubric choice)

DELETED:
  None.
```

Note on consumers NOT in MODIFIED: `src/gemini-session.js`, `src/summary.js`, `src/facts-scanner.js`, `src/quick-fix.js`, `src/deepgram-session.js`, and `src/providers/*` consume the active rubric only at call-time (no module-level constants captured from rubric.js's enums). With live `let` bindings in `src/rubric.js`, they pick up the new active rubric automatically on the next call. Task 12 (smoke test) verifies this.

---

## Public / shared interface impact

**New IPC channels (renderer → main, registered in `src/main.js`):**

| Channel | Payload in | Payload out |
| --- | --- | --- |
| `rubrics:list` | — | `Array<{ id, name, description, isActive, updatedAt }>` |
| `rubrics:load` | `{ id }` | full rubric object |
| `rubrics:save` | `{ id, rubric }` | `{ ok, errors?, warnings? }` |
| `rubrics:create` | `{ name, copyFrom? }` | `{ ok, id }` |
| `rubrics:duplicate` | `{ id, newName }` | `{ ok, newId }` |
| `rubrics:delete` | `{ id }` | `{ ok, reason? }` |
| `rubrics:set-active` | `{ id }` | `{ ok, reason? }` (reason `call_in_progress` blocks) |
| `rubrics:export` | `{ id }` | `{ ok, json }` |
| `rubrics:import` | `{ json }` | `{ ok, id?, errors? }` |
| `rubrics:validate` | `{ rubric }` | `{ ok, errors, warnings }` |

**New broadcast (main → renderer):**

- `rubrics:changed` — fires after `set-active` succeeds or after a save that mutated the active rubric. Renderer listens to refresh the rail, pillar buttons, captured-pane skeleton, and Rubrics tab editor state.

**New preload bridge surface:** `window.rubrics.list`, `window.rubrics.load`, `window.rubrics.save`, `window.rubrics.create`, `window.rubrics.duplicate`, `window.rubrics.delete`, `window.rubrics.setActive`, `window.rubrics.export`, `window.rubrics.import`, `window.rubrics.validate`, `window.rubrics.onChanged(fn)`. Pattern matches the existing `window.settings.*` surface.

**New persisted schemas:**

- `userData/rubrics/index.json` — `{ schemaVersion: 1, activeId: string, rubrics: string[] }`
- `userData/rubrics/<id>.json` — `{ schemaVersion: 1, id, name, description, createdAt, updatedAt, pillars[], items[], capturedFields[], flags[], prompts: { voiceAndTone, coachSystemInstruction, liveSystemInstruction } }`

**Existing named exports from `src/rubric.js`** — surface stays identical, but the values become per-rubric live bindings instead of frozen constants: `PILLARS`, `PILLARS_BY_ID`, `ITEMS`, `ITEMS_BY_ID`, `ITEMS_BY_PILLAR`, `CAPTURED_FIELDS`, `FIELDS_BY_ID`, `FIELD_GROUPS`, `FLAGS`, `FLAGS_BY_ID`, `REAL_PILLAR_IDS`, `ITEM_IDS`, `FIELD_IDS`, `FLAG_IDS`, `SUGGESTABLE_ITEM_IDS`, `SUGGESTION_ITEM_IDS`, `SUGGESTION_SENTINEL_ITEM_IDS`, `RUBRIC_SYSTEM_INSTRUCTION`, `COACH_SYSTEM_INSTRUCTION`, `formatCoachState`. Newly added: `reloadActiveRubric()`, `getActiveRubricMeta()`.

**Shared CSS classes** — all new editor styles scoped under `.rubrics-tab` to avoid bleed into other settings tabs.

**Settings schema:** `general.activeRubricId: string` added (defaults to `'tuned_automation'`). Backward-compat: missing field defaults at load.

---

## Potential overlaps with other in-flight plans

Coordinator should check for overlap with any plan that:

- **Adds Settings tabs** — Phase 2-6 of the settings roadmap (`src/settings.js` lines 12–37) explicitly anticipates Audio / Appearance expansion / Coach tuning / Workflow & persistence / Onboarding & help tabs. Anything in those phases touches `index.html` Settings modal, `src/renderer.js` settings-tab handlers, `src/index.css` settings-tab styles, and `src/settings.js` schema.
- **Extends `src/rubric.js`** — any plan adding new pillars, items, fields, or flags must coordinate so the seed in `src/rubric-defaults.js` absorbs the additions (otherwise a first-run user gets the stale rubric).
- **Refactors `src/coach.js` tool schemas** — Task 4 here moves them inside the class. Any other plan refactoring Coach's tool list will collide.
- **Registers IPC handlers in `src/main.js`** — every parallel plan adding `*:*` channels edits the same `registerIpcHandlers()` function.
- **Adds preload bridges in `src/preload.js`** — same.
- **AI rubric creation** (the second question from the previous chat) — explicitly out of scope here, but a follow-up plan likely depends on the data layer this plan ships. Coordinator should sequence: this one first, AI second.
- **Replay-against-transcript calibration** — also a follow-up that builds on this plan's rubric store.
- **Anything else editing `src/renderer.js` Settings modal**, `src/index.css` Settings tab styles, or `src/settings.js` defaults.

---

## Architecture invariants

These hold across every task. If a step contradicts one, stop and re-read this plan.

1. **`src/rubric.js`'s import surface is an immutable contract** — names and arities must match today's exports. Only the values become dynamic.
2. **The active rubric is loaded once at app start.** Mid-call hot-swap is forbidden. Switching active triggers Coach + live-session teardown and is gated on the live session being idle.
3. **All persisted rubrics carry a `schemaVersion`.** Files with an unsupported version fail to load with a clear error rather than silently being absorbed.
4. **The current Tuned Automation rubric is faithfully reproduced on first launch.** Behaviour at HEAD~1 (pre-feature) and HEAD (post-feature, first run) must be identical end-to-end.
5. **The model's tool-call enums are derived from the active rubric** — no hardcoded item / field / flag ids elsewhere. Task 4 enforces this for `src/coach.js`.
6. **Validation runs on every save and every import.** Only valid rubrics ever reach disk.
7. **No new npm dependencies.** Hand-roll the store the same way `src/settings.js` hand-rolls its persistence.
8. **All new editor CSS is scoped under `.rubrics-tab`.** No bare element selectors that could bleed into other settings tabs.

---

## Task 1: Lift the current rubric into a defaults seed

**Goal:** Pure refactor — extract the four catalogues and the two system-instruction strings out of `src/rubric.js` into a JS data object suitable for serialising to JSON. No behaviour change yet.

**Files:**

- Create: `src/rubric-defaults.js`
- (Read-only reference) `src/rubric.js`

Steps:

- [ ] Create `src/rubric-defaults.js` exporting `export const DEFAULT_RUBRIC = { schemaVersion: 1, id: 'tuned_automation', name: 'Tuned Automation Discovery', description: 'Default discovery call rubric.', createdAt: null, updatedAt: null, pillars: [...], items: [...], capturedFields: [...], flags: [...], prompts: { voiceAndTone: '', coachSystemInstruction: '...', liveSystemInstruction: '...' } }`.
- [ ] Populate `pillars` by copying the current `PILLARS` array verbatim from `src/rubric.js`. Drop synthetic pillars (`live_signals`, `logged_questions`) — they stay computed by the renderer, not stored.
- [ ] Populate `items` by copying the result of the `item()` helper calls in `src/rubric.js`. Each entry is `{ id, pillarId, label, hint, suggestable }`. Preserve `suggestable: false` where set.
- [ ] Populate `capturedFields` from the current `CAPTURED_FIELDS` array verbatim.
- [ ] Populate `flags` from the current `FLAGS` array verbatim.
- [ ] Populate `prompts.coachSystemInstruction` and `prompts.liveSystemInstruction` with the literal text the current `COACH_SYSTEM_INSTRUCTION` and `RUBRIC_SYSTEM_INSTRUCTION` constants resolve to — **excluding** the catalogue blocks that the build helpers (`formatItemBlock`, `formatFieldBlock`, `formatFlagBlock`) generate at runtime. The seed stores the *template prose* only.
- [ ] Verify by snapshot diff: `node -e "import('./src/rubric-defaults.js').then(m => console.log(JSON.stringify(m.DEFAULT_RUBRIC, null, 2).length))"` runs without error and prints a non-zero byte count.
- [ ] Commit: `git add src/rubric-defaults.js && git commit -m "refactor(rubric): extract Tuned Automation rubric into rubric-defaults.js seed"`.

---

## Task 2: Build the rubric store

**Goal:** A small, dependency-free JSON store under `userData/rubrics/` exposing list/load/save/CRUD/import/export + a `validateRubric` helper. Mirrors the in-repo pattern of `src/settings.js`.

**Files:**

- Create: `src/rubric-store.js`

Steps:

- [ ] Create `src/rubric-store.js`. Import `app` from electron, `path`, `node:fs` (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`, `unlinkSync`, `readdirSync`).
- [ ] Implement `getRubricsDir()` → `path.join(app.getPath('userData'), 'rubrics')`.
- [ ] Implement `getIndexPath()` and `getRubricPath(id)`.
- [ ] Implement `ensureSeeded()` — if rubrics dir is missing or index.json is missing, create the dir, write `DEFAULT_RUBRIC` (timestamps applied) to `tuned_automation.json`, and write `index.json` with `{ schemaVersion: 1, activeId: 'tuned_automation', rubrics: ['tuned_automation'] }`.
- [ ] Implement `loadIndex()` and `saveIndex()` with an in-memory cache, matching the cache pattern in `src/settings.js:loadSettings`.
- [ ] Implement `listRubrics()` returning `[{ id, name, description, isActive, updatedAt }]` by reading the index and each rubric file's metadata header.
- [ ] Implement `loadRubric(id)` and `loadActiveRubric()` (the latter resolves activeId from index, falls back to seeding if the file is missing).
- [ ] Implement `saveRubric(id, rubric)` — runs `validateRubric` first; on success, stamps `updatedAt`, writes JSON atomically (`write to <id>.json.tmp` then `rename`). Returns `{ ok, errors?, warnings? }`.
- [ ] Implement `createRubric({ name, copyFrom? })` — assigns an id from a slugified name + uniqueness suffix; seeds from `copyFrom` rubric or an empty template `{ pillars: [], items: [], capturedFields: [], flags: [], prompts: { ... } }`.
- [ ] Implement `duplicateRubric(id, { newName })`.
- [ ] Implement `deleteRubric(id)` — refuses if `id === activeId` (return `{ ok: false, reason: 'is_active' }`); otherwise removes the file and prunes the index.
- [ ] Implement `setActiveRubric(id)` — verifies the file exists; updates `index.json.activeId`. Returns `{ ok: true }` (call-in-progress gate lives in main.js, not here).
- [ ] Implement `exportRubric(id)` → JSON string. Implement `importRubric(json)` → parses, validates, assigns a fresh id if conflicting, writes.
- [ ] Implement `validateRubric(rubric)` returning `{ ok, errors, warnings }`. Errors: missing/wrong schemaVersion; missing id/name; pillars empty; item ids not matching `<pillarId>.<localId>`; pillarId references not resolvable; field ids not matching `<group>.<localId>`; duplicate ids inside an array; empty `label` / `hint` / `desc`. Warnings: clashing pillar glyphs; >25-char short labels; pillars with zero items.
- [ ] Smoke test from a Node REPL (or a temp test file): `import('./src/rubric-store.js').then(m => { m.ensureSeeded(); console.log(m.listRubrics()); console.log(m.loadActiveRubric().pillars.length); })`. Confirm pillar count matches today's pre-refactor `PILLARS.length`.
- [ ] Commit: `git add src/rubric-store.js && git commit -m "feat(rubric-store): hand-rolled JSON-on-disk rubric library"`.

---

## Task 3: Refactor `src/rubric.js` into a live-binding active-rubric loader

**Goal:** Replace the `const` catalogues + frozen system-instruction strings with `let` bindings backed by the active rubric. Add `reloadActiveRubric()`. Preserve every existing named export. App behaves identically at this point.

**Files:**

- Modify: `src/rubric.js`

Steps:

- [ ] At the top of `src/rubric.js`, import `loadActiveRubric` and `getActiveRubricMeta` from `./rubric-store.js`.
- [ ] Replace each `export const X = ...` for the catalogue arrays (`PILLARS`, `ITEMS`, `CAPTURED_FIELDS`, `FLAGS`) and their derived constants (`PILLARS_BY_ID`, `ITEMS_BY_ID`, `ITEMS_BY_PILLAR`, `FIELDS_BY_ID`, `FIELD_GROUPS`, `FLAGS_BY_ID`, `REAL_PILLAR_IDS`, `ITEM_IDS`, `FIELD_IDS`, `FLAG_IDS`, `SUGGESTABLE_ITEM_IDS`, `SUGGESTION_ITEM_IDS`, `RUBRIC_SYSTEM_INSTRUCTION`, `COACH_SYSTEM_INSTRUCTION`) with `export let X;`. Keep `SUGGESTION_SENTINEL_ITEM_IDS` as `const` (it's static).
- [ ] Add an internal `_applyRubric(rubric)` function that recomputes every export from the supplied rubric object: synthetic pillars (`live_signals`, `logged_questions`) are re-injected at the top of `PILLARS` from a small internal `SYNTHETIC_PILLARS` constant; the derived maps / id lists are recomputed; the two system instructions are built by re-using the existing `formatItemBlock` / `formatFieldBlock` / `formatFlagBlock` helpers against the new data, with `prompts.voiceAndTone` appended as a `VOICE & TONE OVERRIDE:` block when non-empty.
- [ ] Add `export function reloadActiveRubric() { _applyRubric(loadActiveRubric()); }`.
- [ ] At module init, call `_applyRubric(loadActiveRubric())` once.
- [ ] Keep `formatCoachState` as-is — it reads the (now-`let`) `ITEMS` binding at call-time.
- [ ] Add `export function getActiveRubricMeta() { return getActiveRubricMeta() from store; }` (renaming to avoid the self-reference — call the imported one `loadActiveMeta`).
- [ ] Manual smoke test: `npm start`. App boots and looks identical to today — all 14 pillars in the rail, items render, captured pane renders. Start a quick recording; coach + live session work as before. Stop. No console errors mentioning rubric.
- [ ] Commit: `git add src/rubric.js && git commit -m "refactor(rubric): live-binding exports backed by active rubric on disk"`.

---

## Task 4: Refactor `src/coach.js` tool schemas to per-instance construction

**Goal:** Move the four tool-schema constants (`UPDATE_ITEM_STATE`, `RECORD_FIELD`, `SUGGEST_NEXT_QUESTION`, `MARK_QUESTION_ASKED`) from module-level captures into a `_buildTools()` method on the `Coach` class so each new Coach instance reads the current rubric's enums.

**Files:**

- Modify: `src/coach.js`

Steps:

- [ ] Read the current shape: `UPDATE_ITEM_STATE` (line ~200), `RECORD_FIELD` (line ~216), `SUGGEST_NEXT_QUESTION` (line ~252), `MARK_QUESTION_ASKED` (line ~304). All four reference enums from `./rubric.js` (`ITEM_IDS`, `FIELD_IDS`, `SUGGESTABLE_ITEM_IDS`, `SUGGESTION_SENTINEL_ITEM_IDS`).
- [ ] Move the four object literals into a `_buildTools()` private method on the `Coach` class, taking no arguments and returning `{ UPDATE_ITEM_STATE, RECORD_FIELD, SUGGEST_NEXT_QUESTION, MARK_QUESTION_ASKED }`. Inside, read `ITEM_IDS`, `FIELD_IDS`, etc. from the live imports — they will be the current values because the Coach instance is constructed after the active rubric has loaded.
- [ ] Update every call-site inside `Coach` that referenced the module constants to use the per-instance ones (`this._tools`, populated in the constructor via `this._tools = this._buildTools();`).
- [ ] Where the per-tick tool list is assembled (look for `tools.push(SUGGEST_NEXT_QUESTION)` and `tools.push(MARK_QUESTION_ASKED)`), use `this._tools.SUGGEST_NEXT_QUESTION` etc.
- [ ] Manual smoke test: `npm start`, run a recording; observe coach ticks fire, item-state transitions log, suggestion + recap flows still work. Confirm via DevTools that the tool list is non-empty when the rep clicks Suggest.
- [ ] Commit: `git add src/coach.js && git commit -m "refactor(coach): build tool schemas per Coach instance from active rubric"`.

---

## Task 5: IPC handlers and Coach lifecycle in `src/main.js`

**Goal:** Wire the renderer to the store; gate active-swap on idle; teardown + reconstruct the Coach (and the live session if running, though policy prohibits) on a successful swap; broadcast `rubrics:changed`.

**Files:**

- Modify: `src/main.js`

Steps:

- [ ] Near the top of `src/main.js`, `import * as rubricStore from './rubric-store.js'` and `import { reloadActiveRubric } from './rubric.js'`.
- [ ] In the `app.whenReady().then(...)` boot flow, call `rubricStore.ensureSeeded()` BEFORE the first `new Coach(...)` construction. (Search for where the Coach is constructed today; this call must precede it.)
- [ ] In `registerIpcHandlers()`, register handlers for: `rubrics:list`, `rubrics:load`, `rubrics:save`, `rubrics:create`, `rubrics:duplicate`, `rubrics:delete`, `rubrics:set-active`, `rubrics:export`, `rubrics:import`, `rubrics:validate`. Each is a thin wrapper around the corresponding `rubricStore.*` function.
- [ ] For `rubrics:set-active`: check the live-session running flag (the same flag that gates other lifecycle-sensitive paths in main.js — search for "session.running" / equivalent). If running, return `{ ok: false, reason: 'call_in_progress' }`. If idle, call `rubricStore.setActiveRubric(id)`, then `reloadActiveRubric()`, then tear down the current Coach (`coach.stop()` + null the reference), then broadcast `rubrics:changed` to all `BrowserWindow` instances. A fresh Coach is constructed on the next Start.
- [ ] For `rubrics:save`: validate via the store. If the saved id is the active id AND the live session is idle, call `reloadActiveRubric()` and broadcast `rubrics:changed`. If the live session is running, write to disk but skip the reload — the renderer surfaces "Will apply on next call".
- [ ] Add `broadcastRubricsChanged()` helper that iterates `BrowserWindow.getAllWindows()` and sends `rubrics:changed` to each.
- [ ] Manual smoke test: `npm start`, open DevTools, run `await window.rubrics.list()` — returns the seeded rubric. Run `await window.rubrics.setActive('tuned_automation')` — succeeds. Press Start, then in DevTools attempt `await window.rubrics.setActive('tuned_automation')` again — returns `{ ok: false, reason: 'call_in_progress' }`. Stop. Try again — succeeds.
- [ ] Commit: `git add src/main.js && git commit -m "feat(main): rubrics:* IPC handlers + active-swap lifecycle"`.

---

## Task 6: Preload bridge

**Goal:** Expose `window.rubrics.*` mirroring the IPC channels, plus an `onChanged(fn)` subscription.

**Files:**

- Modify: `src/preload.js`

Steps:

- [ ] Find the existing `contextBridge.exposeInMainWorld('settings', ...)` block in `src/preload.js`. Use it as the template.
- [ ] Add `contextBridge.exposeInMainWorld('rubrics', { list: () => ipcRenderer.invoke('rubrics:list'), load: (id) => ipcRenderer.invoke('rubrics:load', { id }), save: (id, rubric) => ipcRenderer.invoke('rubrics:save', { id, rubric }), create: (args) => ipcRenderer.invoke('rubrics:create', args), duplicate: (id, newName) => ipcRenderer.invoke('rubrics:duplicate', { id, newName }), delete: (id) => ipcRenderer.invoke('rubrics:delete', { id }), setActive: (id) => ipcRenderer.invoke('rubrics:set-active', { id }), export: (id) => ipcRenderer.invoke('rubrics:export', { id }), import: (json) => ipcRenderer.invoke('rubrics:import', { json }), validate: (rubric) => ipcRenderer.invoke('rubrics:validate', { rubric }), onChanged: (fn) => { const handler = (_e, payload) => fn(payload); ipcRenderer.on('rubrics:changed', handler); return () => ipcRenderer.removeListener('rubrics:changed', handler); } })`.
- [ ] Restart the app (`rs` in npm-start terminal). Open DevTools, run `await window.rubrics.list()`. Confirm output matches Task 5's smoke result.
- [ ] Commit: `git add src/preload.js && git commit -m "feat(preload): expose window.rubrics.* bridge"`.

---

## Task 7: Add the Rubrics tab to the Settings modal markup

**Goal:** Static HTML skeleton for the new tab, including the library bar at the top, sectioned editor body, and sticky save bar. No styling, no JS wiring yet.

**Files:**

- Modify: `index.html`

Steps:

- [ ] Locate the existing Settings modal in `index.html` (the six tabs: Providers / Audio / Appearance / Coach / General / Help). Add a seventh tab button `<button data-settings-tab="rubrics" class="settings-tab">Rubrics</button>` inserted between Coach and General (so the order is Providers / Audio / Appearance / Coach / Rubrics / General / Help — Rubrics sits next to Coach which is most thematically adjacent).
- [ ] Add the corresponding `<section data-settings-tab-panel="rubrics" class="settings-panel rubrics-tab" hidden>` panel matching the markup pattern of the existing panels.
- [ ] Inside, add a library bar: `<header class="rubrics-tab__library">` containing a `<select id="rubricLibrarySelect">` dropdown, plus buttons `#rubricLibraryNew`, `#rubricLibraryDuplicate`, `#rubricLibraryRename`, `#rubricLibraryDelete`, `#rubricLibraryExport`, `#rubricLibraryImport`, `#rubricLibrarySetActive`.
- [ ] Add the sectioned editor body as a series of `<details class="rubrics-tab__section" data-section="identity|voice|pillars|items|fields|flags|scoring|advanced">` collapsibles, in that order. Each contains a `<summary>` heading and an empty `<div class="rubrics-tab__section-body" id="rubricSection<Name>">` that the renderer will populate.
- [ ] Add the sticky save bar at the bottom: `<footer class="rubrics-tab__savebar">` with `#rubricSaveBtn`, `#rubricDiscardBtn`, `#rubricSetActiveBtn`, and a `<span id="rubricSaveHint"></span>` slot for "Will apply on next call" hints.
- [ ] Update the existing `#rubricSwitcher` button's `title` attribute from the hardcoded "Switch rubric — currently Tuned Automation" to an empty title that the renderer will populate at boot from `getActiveRubricMeta()`.
- [ ] Restart, open Settings → Rubrics. Tab button is visible. Panel is empty placeholders. No console errors.
- [ ] Commit: `git add index.html && git commit -m "feat(settings): scaffold Rubrics tab markup"`.

---

## Task 8: Renderer — library bar + section navigation

**Goal:** Make the library bar functional (load rubric → populate sections, New / Duplicate / Rename / Delete / Export / Import / Set as active). Sections still render read-only at this point.

**Files:**

- Modify: `src/renderer.js`

Steps:

- [ ] Add a new top-level state object `state.rubricEditor = { activeId: null, loadedId: null, draft: null, dirty: false, errors: [], warnings: [] }`.
- [ ] On the first activation of the Rubrics tab, fetch `await window.rubrics.list()` and populate `#rubricLibrarySelect`. Pre-select the active rubric. Call `_loadRubricIntoEditor(activeId)`.
- [ ] Implement `_loadRubricIntoEditor(id)`: fetch the rubric, set `state.rubricEditor.loadedId = id; draft = structuredClone(rubric); dirty = false;` then call `_renderRubricSection(name)` for each of the eight sections — read-only renderings (Tasks 9 makes them writeable).
- [ ] Wire `#rubricLibraryNew` → prompt for a name, call `await window.rubrics.create({ name })`, reload the dropdown, switch to the new rubric.
- [ ] Wire `#rubricLibraryDuplicate` → use the loaded id, prompt for a name, call `await window.rubrics.duplicate(...)`.
- [ ] Wire `#rubricLibraryRename` → prompt for a name, update `draft.name`, mark dirty.
- [ ] Wire `#rubricLibraryDelete` → confirm dialog, call `await window.rubrics.delete(id)`. Show error if it's the active rubric.
- [ ] Wire `#rubricLibraryExport` → `await window.rubrics.export(id)`, write to a file via Electron's `dialog.showSaveDialog` (use IPC channel from main).
- [ ] Wire `#rubricLibraryImport` → file-picker, call `await window.rubrics.import(jsonString)`.
- [ ] Wire `#rubricLibrarySetActive` → `await window.rubrics.setActive(id)`. Show error toast on `reason: 'call_in_progress'`.
- [ ] Subscribe `window.rubrics.onChanged(() => { ... re-fetch list, refresh rail, refresh captured pane, refresh editor if open ... })`.
- [ ] Where the renderer currently initialises `state.pillarStatus = Object.fromEntries(PILLARS.map(p => [p.id, 'idle']))` — extract into a `_initPillarStatus()` helper and call it on `rubrics:changed` along with `_renderRail()` and `_renderCapturedPane()`.
- [ ] Manual smoke test: open Settings → Rubrics, see library bar, switch the dropdown (sections still empty / placeholder text is fine at this point), import/export round-trip a rubric.
- [ ] Commit: `git add src/renderer.js && git commit -m "feat(rubrics-tab): library bar + read-only section navigation"`.

---

## Task 9: Renderer — editable sections + validation

**Goal:** Make each section writeable. Save + Discard wired. Save runs validation, shows error + warning banners, persists via IPC, and reflects "Will apply on next call" when active.

**Files:**

- Modify: `src/renderer.js`

Steps:

- [ ] **Identity section.** Two inputs bound to `draft.name` and `draft.description`. Mark `dirty = true` on change.
- [ ] **Voice & Tone section.** One multiline textarea bound to `draft.prompts.voiceAndTone`. Helper text underneath: "Optional. Gets appended to the AI's coaching prompt under a 'VOICE & TONE OVERRIDE' heading. Use to set tone, style, or domain context (e.g. 'Plain English. No jargon. Be concise.')."
- [ ] **Pillars section.** Render `draft.pillars` as a sortable list (drag handle on each row). Per-row fields: name, short label, glyph picker (a small grid of curated single-character monograms — copy the set from the current rubric's `glyph` values), tint colour picker, delete button. Plus an "Add pillar" button at the bottom that appends a new pillar with an auto-generated id `pillar_<n>` slugified from name on first save.
- [ ] **Items section.** Group by pillar. Each row: label, hint textarea, `suggestable` checkbox. Helper text on the suggestable checkbox: "Off for behaviour items the seller does (e.g. 'Introduced themselves'). On for things the seller asks the prospect (e.g. 'What's this costing you?')." "Add item" button per pillar.
- [ ] **Captured fields section.** Group by `group`. Each row: group, label, hint. "Add field" + "Add group" buttons.
- [ ] **Live flags section.** Each row: severity (red/green radio), category, short title, description, when (mid/late radio). "Add flag" button.
- [ ] **Scoring section (read-only in v1).** Render a static summary: "Each pillar is scored as `% covered = (covered items) / (total items) × 100`. The post-call scorecard surfaces every non-synthetic pillar." List the pillars currently in `draft.pillars` so the user can preview which will appear in the scorecard.
- [ ] **Advanced — System prompts section** (collapsed by default). Two big text areas bound to `draft.prompts.coachSystemInstruction` and `draft.prompts.liveSystemInstruction`. Each has a "Reset to default" button that fetches the text from `DEFAULT_RUBRIC` via a new IPC call `rubrics:get-default-prompts` (add this small handler in main.js + the bridge). Above the section: red warning banner "These prompts drive the AI's behaviour. Only edit if you understand the existing instructions. Use Reset to default to restore."
- [ ] **Save bar wiring.** `#rubricSaveBtn` calls `await window.rubrics.save(loadedId, draft)`. On `{ ok: false, errors }`, render an error banner at the top of the panel listing each error with a "Jump to section" link. On `{ ok: true, warnings }`, show a yellow banner with the warnings. Reset `dirty = false`. If the saved id was active and the live session is running, populate `#rubricSaveHint` with "Will apply on next call."
- [ ] `#rubricDiscardBtn` calls `_loadRubricIntoEditor(loadedId)` (re-fetches from disk, resets the draft).
- [ ] `#rubricSetActiveBtn` is hidden when the loaded rubric IS active; visible otherwise. Click calls `await window.rubrics.setActive(loadedId)`.
- [ ] Manual smoke test: open Settings → Rubrics, duplicate the default rubric, rename it, edit a pillar name, add a new flag, save. Confirm validation rejects an obviously broken edit (e.g. delete every pillar). Set the new rubric active. Close and reopen the Settings modal — the new rubric is active.
- [ ] Commit: `git add src/renderer.js && git commit -m "feat(rubrics-tab): writeable editor sections + save validation"`.

---

## Task 10: Wire the existing `#rubricSwitcher` pill

**Goal:** The pill above the pillar rail is currently a no-op. Make it (a) display the active rubric's name and (b) open Settings → Rubrics tab on click.

**Files:**

- Modify: `src/renderer.js`, `index.html`

Steps:

- [ ] In `src/renderer.js`, on boot, fetch the active rubric's `name` via `window.rubrics.list()` (the entry with `isActive: true`) and update `#rubricSwitcher`'s `title` attribute and visible label (if any) to that name.
- [ ] Add a click handler that opens the Settings modal (use the existing modal-open helper, search for `openSettings` / equivalent) and programmatically clicks the `Rubrics` tab button.
- [ ] On `rubrics:changed`, re-fetch and update the pill's label/title.
- [ ] Manual smoke test: hover the pill, tooltip shows active rubric name. Click it, Settings opens on the Rubrics tab.
- [ ] Commit: `git add src/renderer.js index.html && git commit -m "feat(rubric-switcher): wire pill to open Rubrics tab"`.

---

## Task 11: Style the Rubrics tab

**Goal:** Apply the same Soft-Frosted aesthetic as the other settings tabs. Section dividers, sortable-row affordances, glyph picker grid, tint swatch, advanced-prompt warning banner, error/warning banners.

**Files:**

- Modify: `src/index.css`

Steps:

- [ ] Add a `.rubrics-tab` selector at the bottom of the existing Settings styles in `src/index.css`. Scope every new rule under it.
- [ ] Style the library bar (`.rubrics-tab__library`) as a horizontal flex row matching the height/spacing of the existing settings headers.
- [ ] Style each `details.rubrics-tab__section`: rounded card, hairline border, expanded state shows a thin top divider on the body.
- [ ] Style the per-row layout inside each section: drag handle (using the existing pill drag-grip pattern from `#recToggle` if applicable, else a simple `≡` glyph), text inputs filling remaining width, delete button right-aligned.
- [ ] Glyph picker: small grid of `<button class="glyph-pick">` with each candidate glyph. Selected state has a tinted background.
- [ ] Tint colour picker: native `<input type="color">` is fine; wrap in a small swatch-display element.
- [ ] Save bar (`.rubrics-tab__savebar`): sticky bottom, hairline top border, button row right-aligned.
- [ ] Warning banner (`.rubrics-tab__warning--advanced`): red tinted background, white text, bold.
- [ ] Error banner (`.rubrics-tab__banner--error`) and warning banner (`.rubrics-tab__banner--warn`): red and yellow tints respectively, list of `<li>` issues with "Jump to section" anchor links.
- [ ] Visual smoke test: open the tab, edit a couple of things, save with a deliberate validation error. Confirm banner readability matches the rest of the app's tone.
- [ ] Commit: `git add src/index.css && git commit -m "feat(rubrics-tab): scoped styles matching Settings aesthetic"`.

---

## Task 12: Integration smoke test

**Goal:** Verify end-to-end that the seeded default rubric is behaviourally identical to today and that swapping between two rubrics works across a full Start → Stop → Start cycle.

**Files:**

- None (manual test).

Steps:

- [ ] Quit the app. Delete `~/Library/Application Support/Two Way Flow/rubrics/` to force a first-run seed.
- [ ] `npm start`. Verify the rubrics folder is created and contains `index.json` + `tuned_automation.json`. Verify `JSON.parse(fs.readFileSync('.../tuned_automation.json')).pillars.length` matches today's count.
- [ ] Run a short test recording against the default rubric. Verify all expected pillars / items / fields / flags exist and behave identically to HEAD~1.
- [ ] Open Settings → Rubrics. Duplicate the default. Rename the copy "Test rubric". Delete two items, edit a hint, change the voice & tone box to "Be concise. Use bullet points where possible." Save. Set as active.
- [ ] Run another test recording. Verify (a) the two deleted items no longer appear in the rail, (b) the modified hint reaches the coach (check DevTools network panel or coach.js console logs for the system prompt), (c) the voice & tone block is present in the system prompt.
- [ ] Stop. Switch active back to the default. Run a third recording — back to the original behaviour.
- [ ] Try to set active while a call is running — confirm the toast / error fires.
- [ ] Try to delete the active rubric — confirm the store refuses.
- [ ] Export the test rubric to a JSON file. Delete it. Import the JSON file. Confirm it round-trips.
- [ ] Commit: `git commit --allow-empty -m "test: editable rubric system smoke test passes"`.
