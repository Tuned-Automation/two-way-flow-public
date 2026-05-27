# API Call Error Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture failures from every automated AI provider call (coach tick, facts scan, quick-fix rollup, summary debrief, Settings → Test Provider) into a session-scoped ring buffer, surface them live in a new **Settings → Error Log** tab, and auto-save the call's failures to a timestamped `.jsonl` file when Stop is pressed.

**Goal narrative:** Today every provider error is `console.warn`-only, so a "stalled auto generation" (most likely [src/facts-scanner.js](src/facts-scanner.js) or [src/quick-fix.js](src/quick-fix.js)) leaves the rep with no on-screen explanation. Shipping this plan makes those failures observable in the UI, captures the SDK-level context (`status`, `rawResponse`, `durationMs`) that the existing `friendlyError(err)` helpers throw away today, and writes a per-call `error-log-<ts>.jsonl` to disk so a post-mortem is possible after the call ends.

**Architecture:** New `src/error-log.js` module owns an in-memory ring buffer (size 500), an IPC broadcast helper, and a per-call file flush. The instrumentation point is the provider abstraction in [src/providers/index.js](src/providers/index.js): `getProvider(name, { apiKey, model, source })` returns a proxied instance whose `generateContent` / `testConnection` time the call, catch errors with status + raw-response extraction, append a `level: 'error'` entry, and rethrow. Non-throw warning paths (`recordFailure` in [src/quick-fix.js](src/quick-fix.js), JSON-parse fails in [src/facts-scanner.js](src/facts-scanner.js)) call `errorLog.append({ level: 'warn', … })` directly. The Settings UI gains one new tab whose markup slots into the existing data-driven tablist in [index.html](index.html) without touching the tab-switch logic in [src/renderer.js](src/renderer.js).

**Tech Stack:** Electron 42, Vite 5, vanilla JS, existing `@google/genai` / `@anthropic-ai/sdk` / `openai` SDKs. No new dependencies.

**Spec:** n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **App starts cleanly today.** Run `npm start`. Window opens; Settings modal opens; the six existing tabs (Providers / Audio / Appearance / Coach / General / Help) all switch correctly.
- [ ] **You're on a clean working tree** (`git status` shows clean) or OK throwing away in-progress work.
- [ ] **At least one provider key is configured** in `.env` or in Settings → Providers, so you can exercise the error path by toggling the key to garbage and watching it surface in the log.
- [ ] **Read [src/settings.js](src/settings.js) module header** (lines 5-130) — the Phase 1-6 roadmap establishes the convention for where new top-level Settings blocks land. The Error Log doesn't add a `settings.json` block (its data is runtime + per-call file), but the docs help if you decide to add a retention preference later.

Once `npm start` is running, HMR auto-reloads renderer + CSS changes. **Main-process changes** (anything in `src/main.js`, `src/preload.js`, or any file in `src/providers/`, `src/coach.js`, `src/facts-scanner.js`, `src/quick-fix.js`, `src/summary.js`, `src/error-log.js`) require typing `rs` in the npm-start terminal, or quitting Electron and restarting.

---

## File map

```
NEW files (created by this plan):
  src/error-log.js                       — ring buffer + IPC broadcast + flush-to-file
  docs/superpowers/plans/2026-05-27-api-call-error-log.md  — this plan

MODIFIED files:
  src/providers/index.js                 — wrap getProvider() to instrument calls
  src/coach.js                           — pass source='coach' to getProvider()
  src/facts-scanner.js                   — pass source='facts-scanner'; append on parse fail
  src/quick-fix.js                       — pass source='quick-fix'; append on recordFailure()
  src/summary.js                         — pass source='summary' to getProvider()
  src/main.js                            — IPC handlers, Stop hook, source='provider-test'
  src/preload.js                         — expose window.gemini.logs.*; add 'logs:entry' event
  src/renderer.js                        — Error Log tab handler + live subscription
  index.html                             — Error Log tab button + panel markup
  src/index.css                          — .log-row styling (rows, expand details, level pills)

DELETED:
  (none)
```

---

## Public / shared interface impact

The following surfaces are added or extended by this plan. Other in-flight plans that touch these symbols will conflict and need coordinator triage.

**New IPC channels (renderer ↔ main):**

- `logs:load` — invoke. `(opts?: { limit?: number, offset?: number }) => Array<LogEntry>`. Returns a snapshot from the ring buffer.
- `logs:clear` — invoke. `() => void`. Clears the in-memory ring (on-disk per-call files are untouched).
- `logs:reveal-folder` — invoke. `() => void`. Calls `shell.openPath(<userData>/error-logs/)`.
- `logs:entry` — push (main → renderer). Payload is a single `LogEntry`. Fired on every new entry.

**New `window.gemini.logs` API (preload):**

- `window.gemini.logs.load(opts?)`
- `window.gemini.logs.clear()`
- `window.gemini.logs.revealFolder()`
- `window.gemini.onLogsEntry(callback)` — subscribe helper that returns an unsubscribe thunk.

**Extended provider factory signature ([src/providers/index.js](src/providers/index.js)):**

- `getProvider(name, { apiKey, model, source })` — `source` is new and optional. Accepted values: `'coach' | 'facts-scanner' | 'quick-fix' | 'summary' | 'provider-test'`. When omitted, the provider behaves exactly as today (no log entry tagged with an undefined source — the instrumentation defaults to `'unknown'`).

**New `LogEntry` shape (persisted in the JSONL file):**

```js
{
  id: 'log_<random>',
  at: 1748396400000,       // ms since epoch
  level: 'error' | 'warn',
  source: 'coach' | 'facts-scanner' | 'quick-fix' | 'summary' | 'provider-test' | 'unknown',
  provider: 'gemini' | 'anthropic' | 'openai',
  model: 'gemini-3.5-flash',
  durationMs: 1234,
  message: 'Resource has been exhausted (e.g. check quota).',
  status: 429,             // number | null (HTTP status when SDK exposes it)
  reason: 'parse_error' | 'sum_mismatch' | 'monotonic_violation' | 'empty_response' | 'validation' | 'exception' | null,
  rawResponse: '…',        // string, first 4 KB. null when call threw before any body.
}
```

**New on-disk artifact:** `<app.getPath('userData')>/error-logs/error-log-<ISO-timestamp>.jsonl`. One JSON object per line; only entries whose `at` falls within `[callStartedAt, callStoppedAt]` are written. No file is written if zero entries fell in the window.

**New DOM contract ([index.html](index.html) + [src/renderer.js](src/renderer.js)):**

- `<button data-tab="logs">` tab in `.settings-modal__tabs` nav.
- `<section data-tab-content="logs" id="settingsTabLogs">` panel.
- Within the panel: `#errorLogList` (`<ul>` of `.log-row`), `#errorLogClearBtn`, `#errorLogRevealBtn`, `#errorLogEmpty` (empty-state hint).

None of the existing IPC channels or DOM ids are renamed. The provider-factory `source` parameter is additive (optional with a default).

---

## Potential overlaps with other in-flight plans

Coordinator should check whether any of the ~10 parallel plans also touch the following:

- **[src/main.js](src/main.js)** — large file (3.7k lines); any plan adding IPC handlers, modifying Start/Stop pipelines, or adjusting the `settings:test-provider` handler at `:2523-2541` will overlap. This plan adds three `ipcMain.handle` registrations and hooks the existing Stop path; both are isolated edits but live in the same file.
- **[src/preload.js](src/preload.js)** — any plan adding a new `window.gemini.*` namespace or a new entry in `RENDERER_EVENTS` (currently `:272-289`). This plan appends `'logs:entry'` and adds a new `logs` sub-object inside the existing `gemini` bridge.
- **[src/renderer.js](src/renderer.js)** — any plan adding a new Settings tab or extending the Settings modal flow at `:4231-4590`. This plan adds a tab handler but does NOT change the tab-switch logic; conflict surface is minimal.
- **[index.html](index.html)** — any plan adding/removing Settings tabs. This plan inserts one new `<button>` before `</nav>` at `:639` and one new `<section>` before the closing `</div>` of `.settings-modal__body` at `:1388`. Other tabs are untouched.
- **[src/providers/index.js](src/providers/index.js)** — any plan adding a new provider (would add a `case` to `getProvider()`) or changing the `generateContent` / `testConnection` interface. This plan extends the factory signature with an optional `source` and wraps the returned instance, so changes to the underlying provider classes do not conflict, but a plan that also wraps `getProvider()` would.
- **[src/providers/gemini.js](src/providers/gemini.js), [src/providers/anthropic.js](src/providers/anthropic.js), [src/providers/openai.js](src/providers/openai.js)** — this plan does NOT modify these files (instrumentation is at the factory layer). Listed for awareness only: if another plan extends `friendlyError(err)` to surface `.status` / `.headers`, that change would be complementary and could be merged before or after this plan with no conflict.
- **[src/coach.js](src/coach.js), [src/facts-scanner.js](src/facts-scanner.js), [src/quick-fix.js](src/quick-fix.js), [src/summary.js](src/summary.js)** — any plan rewriting the catch blocks or the retry loops will overlap. This plan's edits are surgical: a single new keyword argument on each `getProvider(...)` call, plus a single new `errorLog.append({...})` line in `recordFailure` (quick-fix) and the JSON-parse `catch` (facts-scanner).
- **[src/index.css](src/index.css)** — any styling-overhaul plan (e.g., a continuation of the Liquid Glass refactor that finishes splitting `index.css` into component files). This plan adds ~40 lines of `.log-row*` rules; if `index.css` has been split by the time this plan runs, the rules belong in `src/styles/settings.css` (or a new `src/styles/error-log.css`).
- **[src/settings.js](src/settings.js)** — this plan does NOT add a `settings.json` block. If a future plan introduces an Error Log retention preference, that goes through the Phase 5 (`general`) extension point per the existing roadmap. Listed for awareness only.

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-read this plan.

1. **All AI-call error capture flows through `src/error-log.js`.** No consumer file writes directly to a log file or maintains its own buffer. The single seam keeps the ring/IPC/file-flush logic in one place.
2. **The provider-factory instrumentation is the primary capture point.** Consumer files only call `errorLog.append(...)` for the specific non-throw warning paths (currently: `recordFailure` in quick-fix, JSON-parse fail in facts-scanner). Don't sprinkle `errorLog.append` calls into every catch block — the wrapper already covers those.
3. **The `LogEntry.source` field is the contract for the renderer's filter UI** (future work, but the rows already render the source pill). Allowed values are fixed at: `'coach' | 'facts-scanner' | 'quick-fix' | 'summary' | 'provider-test' | 'unknown'`. Adding a new source requires updating `src/error-log.js` and the renderer pill styles together.
4. **The ring buffer is bounded at 500 entries.** When full, the oldest entry is dropped before the new one is appended. This keeps memory usage predictable across a multi-hour call.
5. **On-disk file flush is per-call only.** Provider-test entries (which happen outside a call window) appear in the live UI but are never written to a `.jsonl` file. Entries whose `at` falls outside `[callStartedAt, callStoppedAt]` are excluded from the flush.
6. **`rawResponse` is truncated to 4 KB before storage.** Both the in-memory entry and the file row are truncated. This prevents a malformed multi-MB response from blowing up the buffer or the file.
7. **No transcript content is stored unless it appears verbatim in the SDK error message.** The log is failure metadata — provider, model, status, error string, raw response body. The instrumentation does NOT capture `userMessage` or `systemInstruction` even though they're available at the wrapper.
8. **The Error Log tab is markup-driven.** Renderer code adds row elements and wires the Clear / Reveal buttons; it does NOT teach the tab-switch logic about `'logs'`. The existing `selectSettingsTab(tabId)` picks the new tab up via `querySelectorAll('[data-tab-content]')`.

---

## Task 1: Create `src/error-log.js`

**Goal:** Stand up the module that owns the ring buffer, the IPC broadcast helper, the per-call file flush, and a `markCallStart()` / `markCallStop()` lifecycle. Nothing wired yet — the file exists with the API the rest of the plan will consume.

**Files:**

- Create: `src/error-log.js`

- [ ] **Step 1: Create `src/error-log.js` with the full API surface.**

Expected exports (CommonJS / ESM style consistent with the rest of `src/*.js` — match what `src/settings.js` uses, which is ESM `export function`):

  - `append(entry)` — push an entry onto the ring (truncates `rawResponse` to 4 KB, generates `id` and `at` if missing), broadcasts `logs:entry` via the registered sender.
  - `getAll(opts?)` — snapshot of the current ring (newest-first).
  - `clear()` — empty the ring.
  - `markCallStart()` — record the current timestamp as `callStartedAt`.
  - `markCallStop()` — record the current timestamp as `callStoppedAt`, then synchronously call `flushCallToFile()`. Returns the path that was written, or `null` if nothing was flushed.
  - `flushCallToFile()` — write all entries with `at >= callStartedAt && at <= callStoppedAt` to `userData/error-logs/error-log-<ISO>.jsonl`. Returns the file path or `null`.
  - `registerSender(sendFn)` — main.js calls this once with its `send(channel, payload)` helper so the module can broadcast without depending on the BrowserWindow directly.
  - `getFolderPath()` — returns the absolute folder path (used by `logs:reveal-folder`).

- [ ] **Step 2: Verify it imports cleanly.**

Add a temporary `import * as errorLog from './error-log.js';` to the top of `src/main.js` and start the app. Confirm no module-resolution error in the main-process console. Then remove the temporary import — Task 4 will add the real one.

- [ ] **Step 3: Commit.**

```bash
git add src/error-log.js
git commit -m "feat(error-log): scaffold ring buffer + flush-to-file module

Adds src/error-log.js with append/getAll/clear/markCallStart/
markCallStop/flushCallToFile/registerSender/getFolderPath. Ring
buffer capped at 500 entries; rawResponse truncated to 4 KB.
flushCallToFile() writes to userData/error-logs/error-log-<ts>.jsonl
when entries fall within the call window. No callers yet — wiring
lands in subsequent commits."
```

---

## Task 2: Instrument the provider factory

**Goal:** Extend `getProvider(name, { apiKey, model, source })` in [src/providers/index.js](src/providers/index.js) so the returned instance auto-captures throws from `generateContent` and `testConnection` into the error log. No consumer file changes yet — the wrapper is transparent to existing callers that don't pass `source` (they get an `'unknown'`-tagged entry).

**Files:**

- Modify: `src/providers/index.js`

- [ ] **Step 1: Add a small wrapper inside `getProvider()`.**

After constructing the underlying instance, return a proxy object that:

  - Exposes `name` and `model` (read from the instance).
  - Wraps `generateContent(args)`: records `start = Date.now()`, calls the real method, on throw appends an entry with `level: 'error'`, `source`, `provider: name`, `model`, `durationMs: Date.now() - start`, `message: err?.message || String(err)`, `status: err?.status ?? null`, `reason: 'exception'`, `rawResponse: extractRawBody(err)`, then rethrows.
  - Wraps `testConnection()` the same way.

`extractRawBody(err)` is a local helper that reads `err.response?.body`, `err.error?.body`, or `err.body` when present (Anthropic, OpenAI, and Gemini SDKs differ); falls back to `null`. Truncate to 4 KB before returning (the ring also truncates as a safety net, but doing it at the boundary keeps the entry compact in transit).

- [ ] **Step 2: Verify the wrapper is transparent for the success path.**

Start the app, hit Start, watch the coach tick produce suggestions for ~10 seconds. No regression — the wrapper only adds a try/catch and a timing read.

- [ ] **Step 3: Verify the wrapper captures the failure path.**

Temporarily set `GEMINI_API_KEY=invalid` (or break the configured key in Settings → Providers). Hit Start. Expected:

  - Coach tick fails on the next cycle.
  - `src/error-log.js`'s ring contains a new entry with `source: 'unknown'` (consumers haven't been updated yet — Task 3), `provider: 'gemini'`, `level: 'error'`, a non-null `status` if the SDK surfaced one, and `message` matching the SDK error.
  - You can confirm via DevTools → Sources → main process by reading `globalThis.errorLog?.getAll()` (or by temporarily logging `errorLog.getAll()` in the IPC handler added in Task 4).

- [ ] **Step 4: Commit.**

```bash
git add src/providers/index.js
git commit -m "feat(providers): instrument getProvider() with error-log capture

Wraps the returned provider instance so generateContent() and
testConnection() time the call, catch exceptions, append an entry
to src/error-log.js with provider/model/status/durationMs/rawResponse,
then rethrow. source defaults to 'unknown' until consumers are
updated in the next commit. The wrapper is transparent on success."
```

---

## Task 3: Pass `source` from consumers and add direct warn-path logging

**Goal:** Tag every existing provider call site with its `source`, and add `errorLog.append({ level: 'warn', … })` calls in the two non-throw warning paths that the wrapper can't catch.

**Files:**

- Modify: `src/coach.js` (provider construction site)
- Modify: `src/facts-scanner.js` (provider construction + JSON-parse fail at `:578`)
- Modify: `src/quick-fix.js` (provider construction + `recordFailure(...)` at `:792-830`)
- Modify: `src/summary.js` (provider construction site)

- [ ] **Step 1: Add `source: 'coach'` to the `getProvider(...)` call in [src/coach.js](src/coach.js).**

The call sits in the Coach class constructor or wherever the provider is built. Locate by grepping for `getProvider(` in `src/coach.js`. Pass `source: 'coach'` in the options object alongside `apiKey` and `model`.

- [ ] **Step 2: Add `source: 'facts-scanner'` and the direct warn append in [src/facts-scanner.js](src/facts-scanner.js).**

Two edits:

  - In the provider construction (search for `getProvider(`), add `source: 'facts-scanner'`.
  - In the JSON-parse `catch` around `:578` (currently `console.warn('[facts-scanner] roundtrip threw:', …)` adjacent area — read the file to confirm the exact line), add an `errorLog.append({ level: 'warn', source: 'facts-scanner', provider, model, reason: 'parse_error', message: err?.message, rawResponse: raw })` call. Keep the existing `console.warn` — the new line supplements it, doesn't replace it.

- [ ] **Step 3: Add `source: 'quick-fix'` and the direct warn appends in [src/quick-fix.js](src/quick-fix.js).**

Two edits:

  - In the provider construction (search for `getProvider(`), add `source: 'quick-fix'`.
  - In `recordFailure(reason, entries, rawPayload)` at `:792-830`, add an `errorLog.append({ level: 'warn', source: 'quick-fix', provider, model, reason, message: reason, rawResponse: rawPayload })` call. The function already receives the right context — this is a one-line addition. Keep the existing `console.warn` and the `stale: true` IPC broadcast unchanged.

- [ ] **Step 4: Add `source: 'summary'` to the `getProvider(...)` call in [src/summary.js](src/summary.js).**

Single edit. The summary's existing `catch` at `:267-271` will surface through the wrapper automatically.

- [ ] **Step 5: Verify each source tag flows through.**

Run the app with an invalid key. Trigger each consumer:

  - Coach: starts on Start, ticks at 1.5s. Confirm `source: 'coach'`.
  - Facts scanner: ticks at 12s. Confirm `source: 'facts-scanner'`.
  - Quick-fix: requires a fact to have been written. Either let one through naturally or temporarily seed `coachContext.factsSheet.entries` in DevTools. Confirm `source: 'quick-fix'`.
  - Summary: press Stop. Confirm `source: 'summary'`.

- [ ] **Step 6: Commit.**

```bash
git add src/coach.js src/facts-scanner.js src/quick-fix.js src/summary.js
git commit -m "feat(consumers): tag provider calls with source; log warn paths

Adds source='coach'|'facts-scanner'|'quick-fix'|'summary' to each
getProvider(...) call so the wrapper from the previous commit can
tag entries correctly.

Also adds errorLog.append({ level: 'warn', ... }) to the two
non-throw warning paths the wrapper can't catch:
  - facts-scanner.js JSON parse fail (preserved console.warn)
  - quick-fix.js recordFailure (preserved console.warn + stale IPC)"
```

---

## Task 4: Wire IPC handlers and the Stop hook in `src/main.js`

**Goal:** Register `logs:load` / `logs:clear` / `logs:reveal-folder` invoke handlers, register the `errorLog` sender (so `errorLog.append` can broadcast `logs:entry` to the renderer), pass `source: 'provider-test'` to the existing `settings:test-provider` handler, and hook the existing Start/Stop pipeline to call `errorLog.markCallStart()` / `errorLog.markCallStop()`.

**Files:**

- Modify: `src/main.js`

- [ ] **Step 1: Import the module and register the sender.**

At the top of `src/main.js` (near the other `src/*.js` imports), add `import * as errorLog from './error-log.js';`. Inside `createWindow()`, after `mainWindowRef = mainWindow;`, call `errorLog.registerSender(send);` (the `send(channel, payload)` helper already exists at `:1962-1966`).

- [ ] **Step 2: Add the three `ipcMain.handle` registrations inside `registerIpcHandlers()`.**

Place these next to the existing `settings:*` registrations (around `:2484-2660`):

  - `ipcMain.handle('logs:load', (_event, opts) => errorLog.getAll(opts || {}));`
  - `ipcMain.handle('logs:clear', () => errorLog.clear());`
  - `ipcMain.handle('logs:reveal-folder', async () => { const { shell } = require('electron'); await shell.openPath(errorLog.getFolderPath()); });`

- [ ] **Step 3: Pass `source: 'provider-test'` to the existing test-provider handler.**

In the `settings:test-provider` handler at `:2523-2541`, the `getProvider(provider, { apiKey, model })` call becomes `getProvider(provider, { apiKey, model, source: 'provider-test' })`. The handler's existing `try/catch` continues to return `{ ok, message }` to the renderer — the wrapper's append is silent (no rethrow needed because the wrapper rethrows by default).

- [ ] **Step 4: Hook Start and Stop.**

Locate the existing Start handler (the one that opens the Deepgram session and arms the coach/scanner/quick-fix timers — grep for `coachContext` initialization or for the `gemini:start` IPC handler). Add `errorLog.markCallStart();` immediately after the call's state is initialised but before the provider work begins.

Locate the existing Stop handler. Add `errorLog.markCallStop();` after the existing cleanup and after the summary scheduling at `:3091-3109`. This ensures any summary-related errors that fire during Stop are included in the flush window.

- [ ] **Step 5: Verify each IPC channel.**

In DevTools console (renderer side, once preload is wired in Task 5):

  - `await window.gemini.logs.load()` returns an array.
  - `await window.gemini.logs.clear()` returns `undefined` and a subsequent `load()` returns `[]`.
  - `await window.gemini.logs.revealFolder()` opens Finder at `userData/error-logs/`.

For Start/Stop, do a 5-second test call with a broken key. After Stop, look for `error-log-<ts>.jsonl` in `userData/error-logs/` and confirm it contains the in-window entries.

- [ ] **Step 6: Commit.**

```bash
git add src/main.js
git commit -m "feat(main): wire error-log IPC + Start/Stop flush hook

Registers errorLog as the broadcast sender via send(channel,payload).
Adds logs:load, logs:clear, logs:reveal-folder invoke handlers next
to the existing settings:* handlers.

settings:test-provider now passes source='provider-test' to
getProvider() so test-button errors appear in the live log
(but are excluded from per-call file flushes by markCallStart/Stop
window filtering).

Start hook calls errorLog.markCallStart(); Stop hook calls
errorLog.markCallStop() after summary scheduling so summary errors
land in the flushed file."
```

---

## Task 5: Expose the logs API through `src/preload.js`

**Goal:** Surface `window.gemini.logs.{ load, clear, revealFolder }` and `window.gemini.onLogsEntry(cb)` to the renderer, following the existing preload patterns.

**Files:**

- Modify: `src/preload.js`

- [ ] **Step 1: Add `'logs:entry'` to `RENDERER_EVENTS`.**

The array sits at `:272-289`. Append `'logs:entry'` to the list so the existing `subscribe(channel)` helper validates against it.

- [ ] **Step 2: Expose the new methods inside the existing `contextBridge.exposeInMainWorld('gemini', { ... })` block.**

Add the `logs` sub-object alongside `settings` and the other groups:

  - `logs: { load: (opts) => ipcRenderer.invoke('logs:load', opts || {}), clear: () => ipcRenderer.invoke('logs:clear'), revealFolder: () => ipcRenderer.invoke('logs:reveal-folder') }`

Add the subscribe helper next to `onSettingsChanged` (`:531-560` area):

  - `onLogsEntry: subscribe('logs:entry'),`

- [ ] **Step 3: Restart the main process and verify.**

Type `rs` (preload changes require restart). In renderer DevTools:

  - `window.gemini.logs.load` is a function.
  - `window.gemini.onLogsEntry` is a function.
  - `window.gemini.logs.load().then(console.log)` resolves to an array.

- [ ] **Step 4: Commit.**

```bash
git add src/preload.js
git commit -m "feat(preload): expose window.gemini.logs.* + onLogsEntry

Adds 'logs:entry' to RENDERER_EVENTS so the existing subscribe()
helper accepts it. Exposes window.gemini.logs.{load, clear,
revealFolder} via ipcRenderer.invoke, and window.gemini.onLogsEntry
via the subscribe helper. All entries sit inside the existing
'gemini' bridge — no new namespace."
```

---

## Task 6: Add the Settings tab markup in `index.html`

**Goal:** Insert the Error Log tab button and panel so the markup-driven tab switcher (`src/renderer.js:4578-4590`) picks it up without code changes.

**Files:**

- Modify: `index.html`

- [ ] **Step 1: Add the tab button.**

Insert between `:639` (the last existing `<button>` — Help tab) and `:640` (the closing `</nav>` of `.settings-modal__tabs`):

```html
<button
  type="button"
  class="settings-modal__tab"
  data-tab="logs"
  role="tab"
  aria-selected="false"
  aria-controls="settingsTabLogs"
>Error Log</button>
```

- [ ] **Step 2: Add the panel.**

Insert between `:1388` (the closing `</section>` of the Help panel) and `:1389` (the closing `</div>` of `.settings-modal__body`):

```html
<section
  id="settingsTabLogs"
  class="settings-tab"
  data-tab-content="logs"
  role="tabpanel"
  aria-label="Error Log"
  hidden
>
  <div class="settings-section">
    <h4 class="settings-section__heading">Error log</h4>
    <p class="settings-section__subtitle">
      Recent failures from the AI providers. Cleared when you quit the app.
      A copy of each call's failures is saved on Stop.
    </p>
    <div class="data-action">
      <div class="data-action__info">
        <span id="errorLogCount">0 entries this session</span>
      </div>
      <div class="data-action__controls">
        <button type="button" id="errorLogRevealBtn">Open saved logs folder</button>
        <button type="button" id="errorLogClearBtn">Clear</button>
      </div>
    </div>
    <ul id="errorLogList" class="error-log-list" aria-live="polite"></ul>
    <p id="errorLogEmpty" class="error-log-empty">No failures recorded.</p>
  </div>
</section>
```

- [ ] **Step 3: Verify the tab switcher.**

HMR reloads. Open Settings. Click the new "Error Log" tab. Expected:

  - Tab button gets `aria-selected="true"`.
  - Panel becomes visible (no `hidden` attribute).
  - Other tabs hide as expected.
  - Empty-state text shows because no entries exist yet (Task 7 wires the list).

- [ ] **Step 4: Commit.**

```bash
git add index.html
git commit -m "feat(html): add Error Log tab to Settings modal

Inserts a <button data-tab='logs'> in .settings-modal__tabs and a
matching <section data-tab-content='logs' id='settingsTabLogs'> in
.settings-modal__body. The existing data-driven tab switcher in
renderer.js:4578 picks it up via querySelectorAll without code
changes.

Panel includes the Clear / Open saved logs folder action row, the
#errorLogList <ul>, an entry-count span, and the #errorLogEmpty
fallback. Styles land in the next commit."
```

---

## Task 7: Wire the Error Log tab in `src/renderer.js`

**Goal:** On Settings open (or first activation of the Error Log tab), fetch the snapshot via `window.gemini.logs.load()` and render the rows. Subscribe to `window.gemini.onLogsEntry` for live tail. Wire Clear and Reveal folder buttons.

**Files:**

- Modify: `src/renderer.js`

- [ ] **Step 1: Add module-scoped element references.**

Near the existing settings-modal element bindings (search for `settingsTabProviders` or `settingsModal`), add references to `#errorLogList`, `#errorLogEmpty`, `#errorLogCount`, `#errorLogClearBtn`, `#errorLogRevealBtn`.

- [ ] **Step 2: Render a single log row.**

Add a helper `renderLogRow(entry)` that returns an `<li class="log-row" data-level="<error|warn>">`:

  - Top line: timestamp (`new Date(entry.at).toLocaleTimeString()`), level pill, source pill, provider + model, message (truncated to ~120 chars).
  - Expandable details block (`<div class="log-row__details" hidden>`): full message, status, durationMs, reason, rawResponse (truncated with a "(truncated)" suffix if 4 KB).
  - Click handler on the row that toggles the `hidden` attribute on the details block and an `.is-expanded` class on the row for styling.

- [ ] **Step 3: Hydrate the list on Settings open and on tab activation.**

In the existing Settings open path (search for `selectSettingsTab` or for where the modal is shown), after the tab is selected, if the active tab is `'logs'`, call `window.gemini.logs.load().then(entries => populate(entries))`. The `populate` helper clears `#errorLogList`, appends a row per entry (newest first), updates `#errorLogCount` text, and toggles `#errorLogEmpty` visibility based on `entries.length === 0`.

- [ ] **Step 4: Subscribe to live entries.**

In the same renderer-init area as the other `window.gemini.on*` subscriptions, register:

```js
window.gemini.onLogsEntry((entry) => {
  // Prepend the row to #errorLogList; bump #errorLogCount; hide #errorLogEmpty.
});
```

The subscription stays active across Settings open/close — the UI just doesn't see it until the user opens the Error Log tab.

- [ ] **Step 5: Wire the Clear and Reveal buttons.**

  - `errorLogClearBtn.addEventListener('click', async () => { await window.gemini.logs.clear(); /* clear DOM; show empty state; reset count */ });`
  - `errorLogRevealBtn.addEventListener('click', () => { window.gemini.logs.revealFolder(); });`

- [ ] **Step 6: Verify end-to-end.**

  1. Configure a valid key. Start a call. Let it run ~5 seconds. Stop.
  2. Open Settings → Error Log. Should show the snapshot (likely empty if no errors).
  3. Break the key. Start a new call. Open Settings → Error Log. Watch new rows appear in real-time as the coach/facts-scanner/quick-fix tick and fail.
  4. Stop. A new file lands in `userData/error-logs/`. Click "Open saved logs folder" — Finder opens.
  5. Click "Clear" — in-memory list empties; on-disk files untouched.

- [ ] **Step 7: Commit.**

```bash
git add src/renderer.js
git commit -m "feat(renderer): render Error Log tab with live tail

On Settings open, fetches the snapshot via window.gemini.logs.load()
and renders one .log-row per entry (newest first). Subscribes to
window.gemini.onLogsEntry for real-time updates while the tab is
visible.

Each row shows timestamp, level, source, provider+model, and a
truncated message. Clicking the row toggles a details panel with
status, durationMs, reason, and the (4 KB-capped) rawResponse.

Clear button calls logs.clear() and resets the DOM. Open-folder
button calls logs.revealFolder() which opens Finder at
userData/error-logs/."
```

---

## Task 8: Add `.log-row*` styles to `src/index.css`

**Goal:** Style the row list, the level/source pills, and the expand-on-click details panel so the tab matches the rest of the Settings UI.

**Files:**

- Modify: `src/index.css`

- [ ] **Step 1: Append the new rules.**

At the end of `src/index.css`, add a `/* ── Error log ── */` section with:

  - `.error-log-list` — `list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px;`
  - `.log-row` — padded row, subtle background, hover treatment, `cursor: pointer`.
  - `.log-row[data-level='error']` — red left-edge accent bar (3px) or red text on the level pill.
  - `.log-row[data-level='warn']` — amber accent.
  - `.log-row__meta` — flex row with `gap: 8px`, holds timestamp + pills + message.
  - `.log-row__level`, `.log-row__source`, `.log-row__provider` — small uppercase pills (reuse `.captured__heading`-like typography).
  - `.log-row__message` — truncates with `text-overflow: ellipsis`.
  - `.log-row__details` — pre-wrapped `<code>`-style block, hidden by default, padded when shown.
  - `.log-row.is-expanded .log-row__details` — `display: block`.
  - `.error-log-empty` — italic tertiary fg, centered.

Match the existing CSS variable naming convention used elsewhere in `index.css` (the file may or may not have been split into tokens.css per the Liquid Glass plan; if it has, place these rules in the same file as the Settings modal rules and reference the existing variables).

- [ ] **Step 2: Verify visual appearance.**

Reload. Trigger a few errors. Confirm:

  - Each row reads cleanly with the level/source pills aligned.
  - Hover state distinguishes the row.
  - Click expands the details panel inline; click again collapses.
  - Empty state shows correctly when the list is cleared.

- [ ] **Step 3: Commit.**

```bash
git add src/index.css
git commit -m "feat(styles): style the Error Log tab

Adds .error-log-list flex column with one .log-row per entry.
Each row has a subtle bg, a left-edge accent bar coloured by
[data-level] (red error / amber warn), and small uppercase pills
for level, source, and provider+model.

Clicking a row toggles .is-expanded which reveals .log-row__details
(monospace block with status, durationMs, reason, and the
(truncated) rawResponse). Empty-state copy lives in
.error-log-empty."
```

---

## Task 9: Verify the manual test plan

**Goal:** End-to-end exercise of the Error Log feature. Catch anything missed by component-level checks.

No files are modified in this task unless a check fails. Each failed check requires a follow-up commit on the appropriate file.

- [ ] **Step 1: Live capture during a call.**

  - [ ] Configure a valid provider key.
  - [ ] Press Start. Let coach/facts-scanner/quick-fix run for ~30 seconds. Stop. Open Settings → Error Log. Expected: empty list (no failures).
  - [ ] Break the configured key (set Settings → Providers → key to garbage). Press Start. Within 1-2 seconds, the coach tick should fail; within 12 seconds the facts scanner should fail. Open Settings → Error Log mid-call. Confirm rows appear in real-time.
  - [ ] Each row shows level, source (`coach` / `facts-scanner` / etc.), provider, model, and a non-empty message. The status field in the expanded details panel matches the SDK's HTTP status when known.

- [ ] **Step 2: Per-call file flush.**

  - [ ] After Stop, check `userData/error-logs/` (use the Reveal button). A file named `error-log-<ISO-timestamp>.jsonl` should exist for the just-finished call.
  - [ ] Open the file. Each line is valid JSON. The first/last lines bound the call window — entries before Start or after Stop are excluded.
  - [ ] Start a brand-new call with a valid key. Let it run with no failures. Stop. Confirm NO new `.jsonl` file is written (the empty-window guard).

- [ ] **Step 3: Provider-test entries.**

  - [ ] In Settings → Providers, click the Test button on a provider whose key is garbage. The Test button surfaces its inline error as before.
  - [ ] Open Settings → Error Log. A new row with `source: 'provider-test'` appears.
  - [ ] Stop the (running, if any) call. Confirm the `.jsonl` for that call does NOT include the provider-test entry (because the test happened outside the `[markCallStart, markCallStop]` window).

- [ ] **Step 4: Ring buffer behavior.**

  - [ ] Trigger >500 errors (cheat: temporarily set the coach tick to 100ms with a broken key, or hand-call `errorLog.append({...})` 600 times via the main-process REPL). Confirm the ring drops the oldest entries — `window.gemini.logs.load()` returns at most 500.

- [ ] **Step 5: Clear and Reveal.**

  - [ ] Clear button: empties the in-memory ring AND the UI. The on-disk `.jsonl` files are unaffected.
  - [ ] Reveal button: opens Finder at `userData/error-logs/` even when the folder doesn't exist yet (the helper should create it on first append).

- [ ] **Step 6: A11y and regression.**

  - [ ] Tab through the Error Log tab: each button is reachable; rows are reachable (or labelled correctly if non-interactive).
  - [ ] Reduce-motion ON: no animations on row appearance or detail expand.
  - [ ] The existing Start/Stop functional regression still passes (Enter toggles, Cmd+W closes, summary modal opens on Stop).
  - [ ] No regression in the other Settings tabs (Providers Test still works; Coach toggles still save).

- [ ] **Step 7: Fix anything broken.**

For each failing check, fix the issue in the appropriate file and commit it as a focused follow-up. Common things to look for:

  - `source` not flowing through → check the wrapper in `src/providers/index.js` reads `source` from the options object.
  - `rawResponse` always `null` → confirm `extractRawBody(err)` checks the right paths for each SDK.
  - File not written on Stop → confirm `markCallStop()` is called AFTER summary scheduling so the summary's potential failure still falls inside the window.
  - Live tail rows missing → confirm `'logs:entry'` is in `RENDERER_EVENTS` and `onLogsEntry` is registered before the first error fires.

- [ ] **Step 8: Final commit (only if Steps 1-6 found nothing wrong).**

If every check passes without changes, no commit needed — the previous 8 task commits already encode the work. Stop here.

---

## Final state — what the engineer should hand back

When this plan is done:

- A new `src/error-log.js` module owns the ring buffer + file flush.
- The provider factory in `src/providers/index.js` auto-captures `generateContent` / `testConnection` errors with `status`, `rawResponse`, and `durationMs`.
- Every consumer (`src/coach.js`, `src/facts-scanner.js`, `src/quick-fix.js`, `src/summary.js`) passes its `source` tag. Quick-fix's `recordFailure` and facts-scanner's JSON-parse fail also call `errorLog.append({ level: 'warn', … })` directly.
- `src/main.js` registers `logs:load`, `logs:clear`, `logs:reveal-folder` IPC handlers; the Start/Stop pipeline calls `markCallStart` / `markCallStop`; `settings:test-provider` passes `source: 'provider-test'`.
- `src/preload.js` exposes `window.gemini.logs.{ load, clear, revealFolder }` and `window.gemini.onLogsEntry`.
- `index.html` has the new tab button + panel; the existing data-driven tab switcher in `src/renderer.js` picks them up without code changes.
- `src/renderer.js` renders rows, subscribes to live entries, wires Clear and Reveal.
- `src/index.css` styles the rows, pills, and expandable details.
- Per-call `error-log-<ts>.jsonl` files land in `userData/error-logs/`.

## Pointers for follow-up work (out of scope here)

- A source-filter dropdown in the Error Log tab.
- A retention setting under Settings → General (Phase 5 hook) to auto-prune old `.jsonl` files.
- A "Copy entry as JSON" right-click on each row.
- A Slack/webhook destination for live forwarding.
- Capturing successful calls behind a Settings toggle for deeper diagnostics.

These all extend the same files this plan touches; reach for them when the scope is approved.
