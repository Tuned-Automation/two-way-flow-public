# Session Cost Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every call session to local disk with start/end timestamps, duration, per-component token usage, and an estimated USD cost, then surface the log as a new "Usage" tab inside the existing Settings modal.

---

## Goal

Give the user a concrete, per-session cost record so they can see what each sales call actually costs across the six billable components running concurrently (Gemini Live audio, Deepgram STT, Coach LLM, Summary LLM, Facts Scanner, Quick-Fix). Persisting one record per session unlocks future invoice reconciliation, monthly trend views, and per-prospect cost analysis without changing how the live overlay behaves.

## Architecture

A new main-process module owns the on-disk store (one JSON file under `app.getPath('userData')`, same hand-rolled pattern as `src/settings.js`). Each of the four text-provider classes is extended to return `usage` alongside `text`/`toolCalls`; the Gemini Live `usageMetadata` callback and Deepgram per-channel audio seconds are captured at the WebSocket layer. The Coach, Summary, Facts Scanner, and Quick-Fix call sites forward usage into a `coachContext.usage` accumulator. On `gemini:stop`, the accumulator + pricing table produces a session record that's appended to the store. A new Settings tab (`#settingsTabUsage`) reads the store via `sessions:list` IPC and renders a chronological list.

## Tech Stack

Electron 42, vanilla JS, no new dependencies — reuses the existing `fs`-backed JSON store pattern from `src/settings.js`. Pricing is a static hardcoded table in `src/pricing.js`.

## Spec

n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **App starts cleanly today.** Run `npm start`. Overlay opens, Start records a session, Stop emits a summary modal.
- [ ] **You're on a clean working tree** (`git status` shows only the files you plan to touch).
- [ ] **`.env` has at least `GEMINI_API_KEY` + `DEEPGRAM_API_KEY`** so you can record a real session end-to-end and verify the cost record is non-zero. Coach calls also need whichever provider key matches `defaultProvider` in settings.
- [ ] **You've read `src/settings.js`** — the new `src/session-history.js` module mirrors its read/write/cache pattern and reuses its directory-creation helper.
- [ ] **You know which existing settings tab the new Usage tab should sit between.** This plan slots it between General and Help (last position before Help). Confirm with the user if a different position is preferred.

Main-process changes (anything in `src/main.js`, `src/preload.js`, `src/providers/*.js`, the new modules) require typing `rs` in the npm-start terminal to restart, or quitting Electron and restarting `npm start`. CSS / `index.html` / `src/renderer.js` changes hot-reload.

---

## File map

```
NEW files (created by this plan):
  src/session-history.js        — JSON store: load/append/list/clear, schema versioning, file path resolution
  src/pricing.js                — Per-provider, per-model pricing table + computeCost(usage) helper
  src/usage-accumulator.js      — Tracks per-session usage across all six components (lives on coachContext)

MODIFIED files:
  src/providers/anthropic.js    — Return { toolCalls, text, usage: { inputTokens, outputTokens, model, provider:'anthropic' } }
  src/providers/gemini.js       — Return { toolCalls, text, usage: { inputTokens, outputTokens, model, provider:'gemini' } }
  src/providers/openai.js       — Return { toolCalls, text, usage: { inputTokens, outputTokens, model, provider:'openai' } }
  src/providers/index.js        — Update the universal-interface block comment to document the new `usage` field
  src/gemini-session.js         — Capture audio-in / audio-out / text-out token counts from usageMetadata callback
  src/deepgram-session.js       — Track per-channel connected-seconds for billing minutes calculation
  src/coach.js                  — Forward provider.generateContent().usage into the accumulator after each tick
  src/summary.js                — Forward provider.generateContent().usage into the accumulator after the summary call
  src/facts-scanner.js          — Forward provider.generateContent().usage into the accumulator after each scan
  src/quick-fix.js              — Forward provider.generateContent().usage into the accumulator after each roll
  src/main.js                   — Wire accumulator into coachContext, finalize+persist a SessionRecord in gemini:stop,
                                  register sessions:list / sessions:clear / sessions:export IPC handlers
  src/preload.js                — Expose window.sessions.{ list, clear, export } via contextBridge
  index.html                    — Add #settingsTabUsage button (line ~600 area) and matching
                                  <section data-tab-content="usage"> panel inside #settingsModal
  src/renderer.js               — Wire the new tab: open/render on selectSettingsTab('usage'),
                                  call window.sessions.list(), render rows, wire export/clear buttons
  src/index.css                 — Styles for .usage-row, .usage-header, .usage-totals, .usage-breakdown

DELETED:
  (none)
```

---

## Public / shared interface impact

**New IPC channels (renderer → main, request-response):**

- `sessions:list` — returns `SessionRecord[]` (newest first)
- `sessions:clear` — wipes the on-disk store, returns `{ ok: true, removed: number }`
- `sessions:export` — returns `{ json: string, csv: string }` for the renderer to hand to a native save dialog

**Modified universal provider interface (`src/providers/index.js` JSDoc block comment, lines 9–13):**

Before:

```text
generateContent({ systemInstruction, tools, history, userMessage })
  → Promise<{ toolCalls: Array<{ name, args }>, text: string }>
```

After:

```text
generateContent({ systemInstruction, tools, history, userMessage })
  → Promise<{
      toolCalls: Array<{ name, args }>,
      text: string,
      usage: { provider, model, inputTokens, outputTokens } | null,
    }>
```

Every consumer of `generateContent()` — `src/coach.js`, `src/summary.js`, `src/facts-scanner.js`, `src/quick-fix.js` — already destructures `{ toolCalls, text }`; they will now also destructure `usage` and forward it to the accumulator. The `usage` field is `null`-tolerant so providers that don't return it (or future ones) don't crash callers.

**New persisted schema** — `~/Library/Application Support/Two Way Flow/sessions.json` (or platform equivalent):

```json
{
  "version": 1,
  "sessions": [
    {
      "id": "2026-05-27T03:14:22.000Z",
      "startedAt": 1748319262000,
      "endedAt": 1748319922000,
      "durationMs": 660000,
      "usage": {
        "geminiLive":   { "model": "gemini-2.5-flash-native-audio-preview-12-2025", "audioInputTokens": 0, "audioOutputTokens": 0, "textOutputTokens": 0 },
        "deepgram":     { "model": "nova-2", "audioMinutes": 22.0 },
        "coach":        { "provider": "anthropic", "model": "claude-sonnet-4-6", "inputTokens": 0, "outputTokens": 0, "calls": 0 },
        "summary":      { "provider": "anthropic", "model": "claude-sonnet-4-6", "inputTokens": 0, "outputTokens": 0, "calls": 0 },
        "factsScanner": { "provider": "gemini",    "model": "gemini-3.5-flash",  "inputTokens": 0, "outputTokens": 0, "calls": 0 },
        "quickFix":     { "provider": "gemini",    "model": "gemini-3.5-flash",  "inputTokens": 0, "outputTokens": 0, "calls": 0 }
      },
      "costUsd": {
        "geminiLive": 0,
        "deepgram": 0,
        "coach": 0,
        "summary": 0,
        "factsScanner": 0,
        "quickFix": 0,
        "total": 0
      },
      "pricingVersion": "2026-05-27"
    }
  ]
}
```

**New CSS classes (broadly shared with the rest of the Settings modal):**

`.usage-row`, `.usage-header`, `.usage-totals`, `.usage-breakdown`, `.usage-empty`, `.usage-cost`, `.usage-actions`. Scoped under `#settingsTabPanelUsage` to avoid leaking.

**No existing IPC channels, no existing schema, and no existing CSS classes are modified.**

---

## Potential overlaps with other in-flight plans

Based on the current uncommitted file list (`M` and `??` in `git status`), **every file this plan touches is also being edited or newly created by other parallel work**. The coordinator should pay close attention to:

- **`src/main.js`** — heavily touched here (IPC registration, `coachContext` mutation, `gemini:stop` handler). Conflicts likely with any plan adding new IPC channels or new `coachContext` fields.
- **`src/preload.js`** — adding a new `window.sessions` namespace. Conflicts likely with any plan adding new preload bridges (e.g. a `window.system` bridge).
- **`src/renderer.js`** — adding a Settings tab handler. Conflicts likely with any plan extending the Settings modal (e.g. Help-tab content, new appearance options).
- **`index.html`** — adding markup inside `#settingsModal`. Conflicts likely with any plan editing the same modal.
- **`src/coach.js`, `src/summary.js`, `src/facts-scanner.js`, `src/quick-fix.js`** — each gets a tiny `result.usage` forward-into-accumulator change at exactly one call site. Conflicts possible with any plan refactoring these files' call paths.
- **`src/providers/anthropic.js`, `gemini.js`, `openai.js`** — each gets the return-shape change. Conflicts possible with any plan modifying the provider abstraction (e.g. streaming, retries, fallback).
- **`src/gemini-session.js`** — adds `usageMetadata` callback handling. Conflicts possible with any plan touching the Live WebSocket lifecycle.
- **`src/deepgram-session.js`** — adds per-channel connected-seconds counters. Conflicts possible with any plan touching Deepgram session state.
- **`src/index.css`** — adds new class rules. **Note:** there is a separate plan (`2026-05-18-liquid-glass-overlay-polish.md`) that DELETES `src/index.css` and replaces it with eight files under `src/styles/`. If that plan lands first, this plan's CSS must instead create a new `src/styles/usage.css` and import it from `src/renderer.js`. Coordinator should sequence accordingly.

If you don't have visibility into which sibling plan touches what, the lowest-risk merge order is: (1) this plan's NEW files alone (provider-interface code change, accumulator, pricing, history store, IPC), then (2) UI files last so any styling-system migration has already settled.

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-read the file map.

1. **The accumulator is the only place per-session usage is mutated.** `coach.js` / `summary.js` / `facts-scanner.js` / `quick-fix.js` call `accumulator.recordLlmCall(component, usage)`; they never reach into `coachContext.usage` directly. Same for `gemini-session.js` (`accumulator.recordLiveAudio(...)`) and `deepgram-session.js` (`accumulator.recordTranscriptionSeconds(channel, seconds)`).
2. **A null/undefined `usage` from a provider is always tolerated.** Don't crash a session because one SDK didn't return usage metadata. Treat missing usage as zero, log a console warning once per session.
3. **Pricing lookups never throw.** `computeCost({ provider, model, inputTokens, outputTokens })` returns `{ usd: 0, matched: false }` for unknown models so we never lose a session record over a model rename. The `matched: false` flag is surfaced in the UI as "estimate unavailable".
4. **The store is append-only at the API layer.** The only mutating IPC is `sessions:clear` (full wipe). Editing or deleting individual sessions is intentionally out of scope; reach for it as a follow-up.
5. **The on-disk store file is small.** A 30-minute session record is ~1.5 KB; 1,000 sessions = ~1.5 MB. Full-file rewrite on every append is acceptable. If the file grows beyond ~10 MB, that's the signal to swap to `better-sqlite3` as a follow-up.
6. **The renderer never imports the pricing table or the store directly.** All access is through IPC so future swaps (sqlite, remote sync, etc.) are renderer-transparent.

---

## Task 1: Scaffold the on-disk store (`src/session-history.js`)

**Goal:** A standalone module that owns the `sessions.json` file lifecycle: load on first access, append, list, clear, save. Mirrors the patterns in `src/settings.js` so the engineer reading both sees the same idioms.

**Files:**

- Create: `src/session-history.js`

- [ ] **Step 1: Create `src/session-history.js` with the full module.**

The module should export:

```js
// Singleton-style API — first call lazy-loads from disk, subsequent
// calls hit the in-memory cache. All file writes go through writeToDisk()
// which mkdir-recursive's the parent.
module.exports = {
  appendSession,      // (record: SessionRecord) => Promise<void>
  listSessions,       // () => Promise<SessionRecord[]> — newest first
  clearAllSessions,   // () => Promise<{ removed: number }>
  sessionsFilePath,   // () => string — for diagnostics
  SCHEMA_VERSION,     // 1
};
```

Internals:

- `sessionsFilePath()` returns `path.join(app.getPath('userData'), 'sessions.json')`.
- `readFromDisk()` returns `{ version: 1, sessions: [] }` if the file is missing or malformed (log the parse error but don't throw — corrupt history shouldn't prevent the app from launching).
- `writeToDisk(state)` uses `fs.writeFileSync` + `mkdirSync({ recursive: true })`. Synchronous like `settings.js` for the same race-avoidance reasons.
- An in-memory `cache` variable holds the parsed object; lazy-loaded on first `loadInternal()` call.
- `appendSession(record)` pushes to `cache.sessions` then writes. No size cap in v1 — invariant #5.

- [ ] **Step 2: Verify the file is well-formed.**

Run `node -e "require('./src/session-history.js')"`. Should exit 0 with no output. If it crashes, fix the require / export shape.

- [ ] **Step 3: Commit.**

```bash
git add src/session-history.js
git commit -m "feat(history): scaffold the per-session JSON store

Lazy-loaded, in-memory-cached, synchronous-write JSON file under
app.getPath('userData')/sessions.json. Schema is { version: 1,
sessions: SessionRecord[] }. Mirrors src/settings.js patterns
(read tolerates missing/corrupt files, write mkdirs the parent)."
```

---

## Task 2: Build the pricing table (`src/pricing.js`)

**Goal:** Single source of truth for the per-provider, per-model rates. A `computeCost()` helper that turns a usage record into USD. Designed to never throw on unknown models.

**Files:**

- Create: `src/pricing.js`

- [ ] **Step 1: Create `src/pricing.js`.**

Hardcoded table with a comment block at the top citing the official pricing pages (Anthropic: https://www.anthropic.com/pricing, Gemini: https://ai.google.dev/pricing, OpenAI: https://openai.com/api/pricing, Deepgram: https://deepgram.com/pricing). Use a flat shape keyed by `provider:model`:

```js
const PRICING_VERSION = '2026-05-27';

const RATES = {
  // Anthropic — per 1M input / output tokens
  'anthropic:claude-sonnet-4-6':  { inputPerM: 3.00,  outputPerM: 15.00 },
  // Gemini — per 1M input / output tokens (text)
  'gemini:gemini-3.5-flash':      { inputPerM: 0.30,  outputPerM: 2.50 },
  // Gemini Live (native audio) — separate keys for audio in / audio out
  'gemini:gemini-2.5-flash-native-audio-preview-12-2025':
                                  { audioInPerM: 3.00, audioOutPerM: 12.00, textOutPerM: 0.60 },
  // OpenAI — per 1M
  'openai:gpt-5.5':               { inputPerM: 1.25,  outputPerM: 10.00 },
  // Deepgram — per minute streaming (Nova-2)
  'deepgram:nova-2':              { perMinute: 0.0058 },
};

function computeCost({ provider, model, inputTokens = 0, outputTokens = 0,
                       audioInputTokens = 0, audioOutputTokens = 0,
                       textOutputTokens = 0, audioMinutes = 0 }) {
  const rate = RATES[`${provider}:${model}`];
  if (!rate) return { usd: 0, matched: false };
  let usd = 0;
  if (rate.inputPerM)     usd += (inputTokens / 1_000_000) * rate.inputPerM;
  if (rate.outputPerM)    usd += (outputTokens / 1_000_000) * rate.outputPerM;
  if (rate.audioInPerM)   usd += (audioInputTokens / 1_000_000) * rate.audioInPerM;
  if (rate.audioOutPerM)  usd += (audioOutputTokens / 1_000_000) * rate.audioOutPerM;
  if (rate.textOutPerM)   usd += (textOutputTokens / 1_000_000) * rate.textOutPerM;
  if (rate.perMinute)     usd += audioMinutes * rate.perMinute;
  return { usd, matched: true };
}

module.exports = { PRICING_VERSION, computeCost, RATES };
```

The numbers above are placeholders that an engineer should verify against the official pricing pages before shipping; the comment at the top of the file must call this out explicitly.

- [ ] **Step 2: Quick sanity check.**

```bash
node -e "const { computeCost } = require('./src/pricing.js'); console.log(computeCost({ provider:'anthropic', model:'claude-sonnet-4-6', inputTokens: 1000000, outputTokens: 100000 }))"
```

Expected output: `{ usd: 4.5, matched: true }` (or whatever the table produces — the point is `matched: true` and a finite USD number).

- [ ] **Step 3: Commit.**

```bash
git add src/pricing.js
git commit -m "feat(pricing): static per-provider/per-model pricing table

Hardcoded RATES indexed by 'provider:model'. computeCost() handles
text tokens, audio in/out tokens (Gemini Live), and per-minute rates
(Deepgram). Returns { usd: 0, matched: false } for unknown models so
unknown models don't lose session records.

NOTE: rates need to be verified against official pricing pages before
shipping — see header comment for URLs."
```

---

## Task 3: Build the accumulator (`src/usage-accumulator.js`)

**Goal:** A single object that lives on `coachContext.usage` and tracks every billable event over the lifetime of one session. Reset on session start, snapshotted on session stop.

**Files:**

- Create: `src/usage-accumulator.js`

- [ ] **Step 1: Create `src/usage-accumulator.js`.**

The factory returns an accumulator with these methods:

```js
function createUsageAccumulator() {
  const state = {
    geminiLive:   { model: null, audioInputTokens: 0, audioOutputTokens: 0, textOutputTokens: 0 },
    deepgram:     { model: null, audioSecondsByChannel: { you: 0, other: 0 } },
    coach:        { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
    summary:      { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
    factsScanner: { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
    quickFix:     { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
  };

  return {
    recordLlmCall(component, usage) {
      if (!usage) return;
      const slot = state[component];
      if (!slot) return;
      slot.provider = usage.provider ?? slot.provider;
      slot.model = usage.model ?? slot.model;
      slot.inputTokens += usage.inputTokens ?? 0;
      slot.outputTokens += usage.outputTokens ?? 0;
      slot.calls += 1;
    },
    recordLiveAudio({ model, audioInputTokens = 0, audioOutputTokens = 0, textOutputTokens = 0 }) {
      state.geminiLive.model = model ?? state.geminiLive.model;
      state.geminiLive.audioInputTokens += audioInputTokens;
      state.geminiLive.audioOutputTokens += audioOutputTokens;
      state.geminiLive.textOutputTokens += textOutputTokens;
    },
    recordTranscriptionSeconds(channel, seconds, model) {
      if (model) state.deepgram.model = model;
      if (state.deepgram.audioSecondsByChannel[channel] != null) {
        state.deepgram.audioSecondsByChannel[channel] += seconds;
      }
    },
    snapshot() {
      // Returns a plain-object copy with Deepgram seconds rolled up to minutes.
      const dgSecs = state.deepgram.audioSecondsByChannel.you
                   + state.deepgram.audioSecondsByChannel.other;
      return {
        geminiLive: { ...state.geminiLive },
        deepgram:   { model: state.deepgram.model, audioMinutes: dgSecs / 60 },
        coach:        { ...state.coach },
        summary:      { ...state.summary },
        factsScanner: { ...state.factsScanner },
        quickFix:     { ...state.quickFix },
      };
    },
  };
}

module.exports = { createUsageAccumulator };
```

- [ ] **Step 2: Add a smoke test.**

```bash
node -e "
const { createUsageAccumulator } = require('./src/usage-accumulator.js');
const a = createUsageAccumulator();
a.recordLlmCall('coach', { provider: 'anthropic', model: 'x', inputTokens: 100, outputTokens: 50 });
a.recordLlmCall('coach', { provider: 'anthropic', model: 'x', inputTokens: 200, outputTokens: 80 });
a.recordTranscriptionSeconds('you', 120, 'nova-2');
a.recordTranscriptionSeconds('other', 120, 'nova-2');
const s = a.snapshot();
console.log(JSON.stringify(s, null, 2));
"
```

Expected: `coach.calls === 2`, `coach.inputTokens === 300`, `deepgram.audioMinutes === 4` (since 240s × 2 channels … wait, the channels run concurrently — total billing seconds = 120 + 120 = 240, audio minutes = 4. Confirm.)

- [ ] **Step 3: Commit.**

```bash
git add src/usage-accumulator.js
git commit -m "feat(usage): per-session usage accumulator

Tracks LLM calls (coach/summary/factsScanner/quickFix), Gemini Live
audio tokens, and Deepgram per-channel connected-seconds. Tolerant
of null/undefined inputs (invariant #2). snapshot() rolls deepgram
seconds up to minutes for the persistence layer."
```

---

## Task 4: Extend each text provider to return `usage`

**Goal:** Three tiny return-shape changes plus a one-line interface-contract update.

**Files:**

- Modify: `src/providers/anthropic.js`
- Modify: `src/providers/gemini.js`
- Modify: `src/providers/openai.js`
- Modify: `src/providers/index.js`

- [ ] **Step 1: Update `src/providers/anthropic.js`.**

At the end of `generateContent()`, after the existing `{ toolCalls, text }` is constructed, also build:

```js
const usage = result?.usage
  ? {
      provider: 'anthropic',
      model: this.model,
      inputTokens: result.usage.input_tokens ?? 0,
      outputTokens: result.usage.output_tokens ?? 0,
    }
  : null;
return { toolCalls, text, usage };
```

- [ ] **Step 2: Update `src/providers/gemini.js`.**

Same shape, using `result?.usageMetadata`:

```js
const usage = result?.usageMetadata
  ? {
      provider: 'gemini',
      model: this.model,
      inputTokens: result.usageMetadata.promptTokenCount ?? 0,
      outputTokens: result.usageMetadata.candidatesTokenCount ?? 0,
    }
  : null;
return { toolCalls, text, usage };
```

- [ ] **Step 3: Update `src/providers/openai.js`.**

```js
const usage = result?.usage
  ? {
      provider: 'openai',
      model: this.model,
      inputTokens: result.usage.prompt_tokens ?? 0,
      outputTokens: result.usage.completion_tokens ?? 0,
    }
  : null;
return { toolCalls, text, usage };
```

- [ ] **Step 4: Update the universal interface block comment in `src/providers/index.js`.**

Lines 9–13 currently document:

```text
generateContent({ systemInstruction, tools, history, userMessage })
  → Promise<{ toolCalls: Array<{ name, args }>, text: string }>
```

Replace with the three-field shape including `usage`. See the "Public / shared interface impact" section above for exact text.

- [ ] **Step 5: Sanity-check at the command line.**

```bash
# Pick whichever provider you have a key for. This is a quick check that
# the new field doesn't break the existing return.
node -e "
(async () => {
  const { getProvider } = require('./src/providers');
  const p = getProvider('anthropic', { apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-4-6' });
  const r = await p.generateContent({ systemInstruction: 'You are a test.', userMessage: 'Say ok.', tools: [], history: [] });
  console.log({ text: r.text, usage: r.usage });
})();
"
```

Expected: `text` is non-empty, `usage` is `{ provider, model, inputTokens, outputTokens }` with non-zero numbers.

- [ ] **Step 6: Commit.**

```bash
git add src/providers/anthropic.js src/providers/gemini.js src/providers/openai.js src/providers/index.js
git commit -m "feat(providers): return token usage from generateContent()

All three providers now return { toolCalls, text, usage } where usage
is { provider, model, inputTokens, outputTokens } or null if the SDK
didn't include usage metadata. Interface block comment updated.

Anthropic reads result.usage.{input_tokens, output_tokens}.
Gemini reads result.usageMetadata.{promptTokenCount, candidatesTokenCount}.
OpenAI reads result.usage.{prompt_tokens, completion_tokens}."
```

---

## Task 5: Forward `usage` from every text-LLM call site into the accumulator

**Goal:** The four call sites that invoke `provider.generateContent()` now destructure `usage` and forward it to the accumulator. Each is a one-line addition.

**Files:**

- Modify: `src/coach.js`
- Modify: `src/summary.js`
- Modify: `src/facts-scanner.js`
- Modify: `src/quick-fix.js`

- [ ] **Step 1: Pass the accumulator into each consumer.**

Each consumer is already constructed via a factory / class in `src/main.js` and given an options bag. Add `usageAccumulator` to each options bag at the construction site (`src/main.js` lines 2768–3008 region — Task 7 covers the main.js wiring). For now, in each module, accept the option and use it.

- [ ] **Step 2: `src/coach.js` — after each `provider.generateContent(...)` resolves.**

In the tick loop, where the result is awaited, add:

```js
const result = await provider.generateContent(/* … */);
if (this.usageAccumulator && result?.usage) {
  this.usageAccumulator.recordLlmCall('coach', result.usage);
}
```

- [ ] **Step 3: `src/summary.js` — same pattern, with `'summary'`.**

- [ ] **Step 4: `src/facts-scanner.js` — same pattern, with `'factsScanner'`.**

- [ ] **Step 5: `src/quick-fix.js` — same pattern, with `'quickFix'`.**

- [ ] **Step 6: Commit.**

```bash
git add src/coach.js src/summary.js src/facts-scanner.js src/quick-fix.js
git commit -m "feat(usage): forward provider usage into the per-session accumulator

Each of the four text-LLM consumers (coach tick, summary, facts scanner,
quick-fix roller) now calls usageAccumulator.recordLlmCall(component,
result.usage) after every successful generateContent() call. Null/
missing usage is tolerated per invariant #2."
```

---

## Task 6: Capture Gemini Live audio tokens + Deepgram seconds at the WebSocket layer

**Goal:** The two always-on WebSocket sessions both have natural per-message hooks. Wire them into the accumulator.

**Files:**

- Modify: `src/gemini-session.js`
- Modify: `src/deepgram-session.js`

- [ ] **Step 1: `src/gemini-session.js` — capture `usageMetadata` from Live messages.**

The Gemini Live SDK emits `usageMetadata` periodically on the WebSocket. Add an option `onUsage(usage)` to the `GeminiSession` constructor options, and call it from the message handler when `message.usageMetadata` is present:

```js
if (message?.usageMetadata && this.onUsage) {
  this.onUsage({
    model: this.model,
    audioInputTokens: message.usageMetadata.promptTokensDetails
      ?.find((d) => d.modality === 'AUDIO')?.tokenCount ?? 0,
    audioOutputTokens: message.usageMetadata.responseTokensDetails
      ?.find((d) => d.modality === 'AUDIO')?.tokenCount ?? 0,
    textOutputTokens: message.usageMetadata.responseTokensDetails
      ?.find((d) => d.modality === 'TEXT')?.tokenCount ?? 0,
  });
}
```

(Exact field shape may differ — engineer should `console.log(message.usageMetadata)` from one live message to confirm the SDK version's field names before writing the parser.)

- [ ] **Step 2: `src/deepgram-session.js` — track per-channel connected seconds.**

The Deepgram SDK exposes connection open / close events on each channel. Track `Date.now()` at open and accumulate on close (and on every interim message as a watchdog in case the close event is missed). Expose `onSecondsTick({ channel, seconds })` as a new option to the constructor; the main process will hand it `accumulator.recordTranscriptionSeconds(channel, seconds, 'nova-2')`.

A simpler alternative: since Deepgram billing is by connected-time and both channels run for the entire session, just compute `audioMinutes = (durationMs / 1000) / 60 * 2` (two channels) inside the accumulator's `snapshot()` method using `coachContext.sessionStartedAt`. This avoids a callback altogether. **Recommended**: take the simpler alternative for v1 (only ~5% accuracy loss from brief reconnect gaps) and leave the per-tick instrumentation as a follow-up.

- [ ] **Step 3: Commit.**

```bash
git add src/gemini-session.js src/deepgram-session.js
git commit -m "feat(usage): capture Gemini Live audio tokens + Deepgram seconds

Gemini Live: GeminiSession now accepts onUsage(usage) and calls it
whenever a message includes usageMetadata. Parses audio in/out and
text out token counts from the modality-detail arrays.

Deepgram: for v1, audio minutes are derived from session duration ×
channel count inside the accumulator snapshot. Per-channel connected-
seconds tracking is left as a follow-up; the 5% accuracy loss from
reconnects is acceptable for a first cut."
```

---

## Task 7: Wire everything together in `src/main.js`

**Goal:** Construct the accumulator on `gemini:start`, attach it to `coachContext`, pass it into every consumer, and on `gemini:stop` finalize a session record and append it to the store.

**Files:**

- Modify: `src/main.js`

- [ ] **Step 1: Import the new modules at the top of `src/main.js`.**

After the existing `require('./providers')` import, add:

```js
const { appendSession, listSessions, clearAllSessions } = require('./session-history.js');
const { computeCost, PRICING_VERSION } = require('./pricing.js');
const { createUsageAccumulator } = require('./usage-accumulator.js');
```

- [ ] **Step 2: Initialize the accumulator in `resetCoachContext()` (around line 901).**

Inside the function body, add `coachContext.usageAccumulator = createUsageAccumulator();`. This way every fresh session gets a fresh accumulator.

- [ ] **Step 3: Pass the accumulator into each consumer at construction time.**

Inside `ipcMain.handle('gemini:start', ...)` (line 2662–3053), where `new Coach({ … })`, `createFactsScanner({ … })`, `createQuickFixRoller({ … })`, and the summary call's options bag are built, add `usageAccumulator: coachContext.usageAccumulator` to each options bag.

Also pass `onUsage: (u) => coachContext.usageAccumulator.recordLiveAudio(u)` into `openGeminiLiveSession({ apiKey, onUsage })` (line 2730 + the function definition lines 1032–1066).

- [ ] **Step 4: Finalize and persist a session record in `gemini:stop`.**

In `ipcMain.handle('gemini:stop', ...)` (line 3055–3104), after `teardownSession()` finishes (line 3060) and before the summary call fires (lines 3091–3094), build and append a session record:

```js
const usageSnapshot = coachContext.usageAccumulator.snapshot();
// Deepgram minutes derived from session duration × 2 channels per Task 6 §3.
usageSnapshot.deepgram.audioMinutes = (durationMs / 1000 / 60) * 2;

const costUsd = {
  geminiLive:   computeCost({ provider: 'gemini', model: usageSnapshot.geminiLive.model, ...usageSnapshot.geminiLive }).usd,
  deepgram:     computeCost({ provider: 'deepgram', model: usageSnapshot.deepgram.model || 'nova-2', audioMinutes: usageSnapshot.deepgram.audioMinutes }).usd,
  coach:        computeCost({ ...usageSnapshot.coach }).usd,
  summary:      computeCost({ ...usageSnapshot.summary }).usd,
  factsScanner: computeCost({ ...usageSnapshot.factsScanner }).usd,
  quickFix:     computeCost({ ...usageSnapshot.quickFix }).usd,
};
costUsd.total = Object.values(costUsd).reduce((a, b) => a + b, 0);

const record = {
  id: new Date(sessionStartedAt).toISOString(),
  startedAt: sessionStartedAt,
  endedAt: sessionStartedAt + durationMs,
  durationMs,
  usage: usageSnapshot,
  costUsd,
  pricingVersion: PRICING_VERSION,
};

try {
  await appendSession(record);
} catch (err) {
  console.warn('[history] failed to persist session record:', err);
}
```

- [ ] **Step 5: Register the three new IPC handlers in `registerIpcHandlers()`.**

After the existing `settings:*` block:

```js
ipcMain.handle('sessions:list', async () => {
  return await listSessions();
});

ipcMain.handle('sessions:clear', async () => {
  return await clearAllSessions();
});

ipcMain.handle('sessions:export', async () => {
  const sessions = await listSessions();
  const json = JSON.stringify(sessions, null, 2);
  // CSV: one row per session with the headline fields. Detailed per-
  // component usage stays in the JSON export.
  const header = 'id,startedAt,endedAt,durationMs,totalUsd,coachUsd,geminiLiveUsd,deepgramUsd,summaryUsd,factsUsd,quickFixUsd\n';
  const rows = sessions.map((s) => [
    s.id, s.startedAt, s.endedAt, s.durationMs,
    s.costUsd.total, s.costUsd.coach, s.costUsd.geminiLive,
    s.costUsd.deepgram, s.costUsd.summary,
    s.costUsd.factsScanner, s.costUsd.quickFix,
  ].join(','));
  return { json, csv: header + rows.join('\n') };
});
```

- [ ] **Step 6: Restart and verify a single end-to-end session writes a record.**

```bash
# After typing `rs` to restart, run a 30-second recording end-to-end.
# Then:
cat "$(node -e "console.log(require('electron').app.getPath('userData'))")/sessions.json"
```

(Or open the file in Finder — `~/Library/Application Support/Two Way Flow/sessions.json` on macOS.)

Expected: a one-element `sessions` array with non-zero `durationMs`, populated `usage.coach.calls`, and a non-zero `costUsd.total`.

- [ ] **Step 7: Commit.**

```bash
git add src/main.js
git commit -m "feat(main): persist a SessionRecord on every gemini:stop

resetCoachContext() now creates a fresh UsageAccumulator. gemini:start
hands it to every text-LLM consumer (Coach, Summary, FactsScanner,
QuickFixRoller) and to the Gemini Live session via onUsage. gemini:stop
snapshots the accumulator, derives Deepgram minutes from duration ×
channel count, runs computeCost() per component, and appends to the
on-disk store via appendSession().

Adds three new IPC handlers: sessions:list, sessions:clear,
sessions:export (JSON + CSV)."
```

---

## Task 8: Expose the renderer-side API through `src/preload.js`

**Goal:** A new `window.sessions` bridge with three thin methods. Mirrors the existing `window.api.settings.*` bridge for shape consistency.

**Files:**

- Modify: `src/preload.js`

- [ ] **Step 1: Add the bridge.**

After the existing `contextBridge.exposeInMainWorld('api', { settings: { … } })` block (or wherever sibling bridges live), add:

```js
contextBridge.exposeInMainWorld('sessions', {
  list:   () => ipcRenderer.invoke('sessions:list'),
  clear:  () => ipcRenderer.invoke('sessions:clear'),
  export: () => ipcRenderer.invoke('sessions:export'),
});
```

- [ ] **Step 2: Restart and verify the bridge is exposed.**

In DevTools console, type `window.sessions`. Should print an object with `list`, `clear`, `export` functions.

- [ ] **Step 3: Commit.**

```bash
git add src/preload.js
git commit -m "feat(preload): expose window.sessions.{list,clear,export}

Thin bridge over the three sessions:* IPC channels. No state held in
preload — all calls are stateless ipcRenderer.invoke()s."
```

---

## Task 9: Add the Usage tab markup to `index.html`

**Goal:** A new tab button + matching tab content panel inside the existing `#settingsModal`. Slotted between General and Help.

**Files:**

- Modify: `index.html`

- [ ] **Step 1: Add the tab button.**

Find the existing tab buttons inside `#settingsModal` (lines ~592–639). Between the General tab button and the Help tab button, insert:

```html
<button class="settings-tab" type="button" role="tab"
        id="settingsTabUsage" data-tab="usage"
        aria-controls="settingsTabPanelUsage" aria-selected="false">
  Usage
</button>
```

- [ ] **Step 2: Add the tab content panel.**

After the existing General tab content `<section>` and before the Help tab content `<section>`, insert:

```html
<section id="settingsTabPanelUsage" class="settings-tab-panel" role="tabpanel"
         data-tab-content="usage" aria-labelledby="settingsTabUsage" hidden>

  <header class="usage-header">
    <h2>Session log</h2>
    <p class="usage-header__sub">
      Every recording is logged locally with timestamps, tokens, and an
      estimated cost. Stored in <code>sessions.json</code> under your app data
      folder.
    </p>
  </header>

  <div class="usage-totals" id="usageTotals" aria-live="polite">
    <!-- Populated by renderer: total sessions, total cost across all -->
  </div>

  <div class="usage-actions">
    <button type="button" id="usageExportButton">Export…</button>
    <button type="button" id="usageClearButton" class="danger">Clear history…</button>
  </div>

  <ol class="usage-list" id="usageList" aria-label="Sessions, newest first">
    <!-- Populated by renderer with .usage-row entries -->
  </ol>

  <p class="usage-empty" id="usageEmpty" hidden>
    No sessions logged yet. Start a recording — the first cost record
    will appear here when you stop it.
  </p>
</section>
```

- [ ] **Step 3: Verify the modal still opens and the new tab button is visible.**

HMR reloads. Click the settings gear → modal opens → "Usage" tab button appears between General and Help. Clicking it shows the empty `<ol>` (no rows yet — renderer wiring lands in Task 10).

- [ ] **Step 4: Commit.**

```bash
git add index.html
git commit -m "feat(html): add Usage tab to the settings modal

Adds #settingsTabUsage button (role='tab', aria-controls=
#settingsTabPanelUsage) between General and Help. Adds the matching
<section data-tab-content='usage'> with a header, totals slot,
export/clear action buttons, an empty <ol id='usageList'>, and a
hidden empty-state paragraph. Renderer wiring follows in the next
commit."
```

---

## Task 10: Wire the renderer — render rows, handle export & clear

**Goal:** When the user opens the Usage tab, call `window.sessions.list()`, render rows, wire the two action buttons.

**Files:**

- Modify: `src/renderer.js`

- [ ] **Step 1: Add element refs.**

Near the other settings-modal element refs (around line 240), add:

```js
const usageTotalsEl  = document.getElementById('usageTotals');
const usageListEl    = document.getElementById('usageList');
const usageEmptyEl   = document.getElementById('usageEmpty');
const usageExportEl  = document.getElementById('usageExportButton');
const usageClearEl   = document.getElementById('usageClearButton');
```

- [ ] **Step 2: Add a `renderUsageTab()` function.**

```js
async function renderUsageTab() {
  const sessions = await window.sessions.list();

  if (sessions.length === 0) {
    usageListEl.hidden = true;
    usageEmptyEl.hidden = false;
    usageTotalsEl.textContent = '';
    return;
  }
  usageListEl.hidden = false;
  usageEmptyEl.hidden = true;

  const totalUsd = sessions.reduce((a, s) => a + (s.costUsd?.total ?? 0), 0);
  const totalMinutes = sessions.reduce((a, s) => a + (s.durationMs / 60000), 0);
  usageTotalsEl.textContent =
    `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ` +
    `${totalMinutes.toFixed(0)} min · $${totalUsd.toFixed(2)} total`;

  usageListEl.replaceChildren(...sessions.map(renderUsageRow));
}

function renderUsageRow(record) {
  const li = document.createElement('li');
  li.className = 'usage-row';
  const startStr = new Date(record.startedAt).toLocaleString();
  const endStr   = new Date(record.endedAt).toLocaleTimeString();
  const durMin   = (record.durationMs / 60000).toFixed(1);
  const totalUsd = (record.costUsd?.total ?? 0).toFixed(4);

  li.innerHTML = `
    <div class="usage-row__head">
      <span class="usage-row__when">${startStr}</span>
      <span class="usage-row__duration">${durMin} min · ended ${endStr}</span>
      <span class="usage-row__cost">$${totalUsd}</span>
    </div>
    <details class="usage-row__details">
      <summary>Breakdown</summary>
      <table class="usage-breakdown">
        <tr><td>Coach</td>        <td>${record.usage.coach.calls} calls</td> <td>${record.usage.coach.inputTokens}/${record.usage.coach.outputTokens} tok</td> <td>$${record.costUsd.coach.toFixed(4)}</td></tr>
        <tr><td>Summary</td>      <td>${record.usage.summary.calls} calls</td> <td>${record.usage.summary.inputTokens}/${record.usage.summary.outputTokens} tok</td> <td>$${record.costUsd.summary.toFixed(4)}</td></tr>
        <tr><td>Facts</td>        <td>${record.usage.factsScanner.calls} calls</td> <td>${record.usage.factsScanner.inputTokens}/${record.usage.factsScanner.outputTokens} tok</td> <td>$${record.costUsd.factsScanner.toFixed(4)}</td></tr>
        <tr><td>Quick-Fix</td>    <td>${record.usage.quickFix.calls} calls</td> <td>${record.usage.quickFix.inputTokens}/${record.usage.quickFix.outputTokens} tok</td> <td>$${record.costUsd.quickFix.toFixed(4)}</td></tr>
        <tr><td>Gemini Live</td>  <td>—</td> <td>${record.usage.geminiLive.audioInputTokens}/${record.usage.geminiLive.audioOutputTokens} audio tok</td> <td>$${record.costUsd.geminiLive.toFixed(4)}</td></tr>
        <tr><td>Deepgram</td>     <td>—</td> <td>${record.usage.deepgram.audioMinutes.toFixed(1)} min</td> <td>$${record.costUsd.deepgram.toFixed(4)}</td></tr>
      </table>
    </details>
  `;
  return li;
}
```

- [ ] **Step 3: Trigger `renderUsageTab()` when the user opens the tab.**

Find `selectSettingsTab(tabId)` (around line 4580). Add a branch:

```js
if (tabId === 'usage') {
  renderUsageTab();
}
```

Also call `renderUsageTab()` once after a session ends (subscribe to the existing `summary:ready` event, or simpler — just refresh next time the user opens the tab).

- [ ] **Step 4: Wire the Export and Clear buttons.**

```js
usageExportEl.addEventListener('click', async () => {
  const { json, csv } = await window.sessions.export();
  // Reuse the existing dialog:save IPC pattern from summary.js.
  // For v1: copy json to clipboard so the user has a copy without
  // adding another native-dialog IPC. CSV variant can be a follow-up.
  await navigator.clipboard.writeText(json);
  // Show toast / inline confirmation — simplest is updating button text.
  const orig = usageExportEl.textContent;
  usageExportEl.textContent = 'Copied JSON to clipboard';
  setTimeout(() => { usageExportEl.textContent = orig; }, 1500);
});

usageClearEl.addEventListener('click', async () => {
  if (!confirm('Delete all session logs? This cannot be undone.')) return;
  await window.sessions.clear();
  await renderUsageTab();
});
```

(Engineer judgement: if there's already a native-Save-dialog helper used by the summary modal, prefer that pattern over clipboard. Clipboard is the safe v1 default.)

- [ ] **Step 5: Verify end-to-end.**

Restart, record a short session, stop, open Settings → Usage tab. Expected:

- Totals line: "1 session · N min · $X.XXXX total"
- One row in the list with start time, duration, end time, total cost
- Expanding the row's "Breakdown" reveals per-component table

Click Clear → confirm → list empties, totals clear. Record another session, verify it appears.

- [ ] **Step 6: Commit.**

```bash
git add src/renderer.js
git commit -m "feat(renderer): wire the Usage settings tab

renderUsageTab() pulls window.sessions.list(), populates the totals
line + the <ol> with one .usage-row per session (newest first).
Each row has a summary line (when / duration / total cost) and a
collapsed <details> Breakdown table with per-component tokens
and USD figures.

Export copies the JSON payload to the clipboard for v1 (a future
follow-up will route through a native Save dialog like the summary
modal does).

Clear prompts via native confirm() then wipes the store and
re-renders."
```

---

## Task 11: Style the Usage tab

**Goal:** The new tab visually matches the rest of the Settings modal.

**Files:**

- Modify: `src/index.css` (or `src/styles/usage.css` if the Liquid Glass plan has already landed — see overlaps note above)

- [ ] **Step 1: Add `.usage-*` classes.**

Match the typography, spacing, and surface treatments used elsewhere in `#settingsModal`. Sketch:

```css
.usage-header h2 { font-size: 14px; margin: 0 0 4px; }
.usage-header__sub { font-size: 11px; color: var(--fg-tertiary, rgba(255,255,255,0.5)); margin: 0; }

.usage-totals {
  margin: 12px 0;
  padding: 8px 12px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  background: var(--surface-inset, rgba(255,255,255,0.04));
  border-radius: 8px;
}

.usage-actions { display: flex; gap: 8px; margin-bottom: 12px; }
.usage-actions .danger { color: var(--accent-danger, #ff453a); }

.usage-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.usage-row {
  padding: 8px 12px;
  background: var(--surface-inset, rgba(255,255,255,0.04));
  border-radius: 8px;
}

.usage-row__head {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  align-items: baseline;
  font-size: 12px;
}

.usage-row__when { font-weight: 500; }
.usage-row__duration { color: var(--fg-tertiary, rgba(255,255,255,0.5)); font-size: 11px; }
.usage-row__cost { font-variant-numeric: tabular-nums; font-weight: 600; }

.usage-row__details summary { cursor: pointer; font-size: 11px; color: var(--fg-tertiary, rgba(255,255,255,0.5)); padding: 6px 0 4px; }

.usage-breakdown {
  width: 100%;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  border-collapse: collapse;
}
.usage-breakdown td { padding: 2px 8px 2px 0; }
.usage-breakdown td:last-child { text-align: right; }

.usage-empty {
  margin: 24px 0;
  font-size: 11.5px;
  color: var(--fg-tertiary, rgba(255,255,255,0.5));
  text-align: center;
  font-style: italic;
}
```

- [ ] **Step 2: Verify visual.**

Open Settings → Usage. Confirm rows render legibly in the modal, the expandable Breakdown is readable, the action buttons are clearly distinguished (Clear is danger-tinted).

- [ ] **Step 3: Commit.**

```bash
git add src/index.css
git commit -m "feat(styles): style the Usage settings tab

Adds .usage-header, .usage-totals, .usage-actions, .usage-list,
.usage-row, .usage-row__head, .usage-row__details, .usage-breakdown,
and .usage-empty. Uses the existing --surface-inset / --fg-tertiary
tokens where available, with fallbacks for the un-tokenized case."
```

---

## Task 12: End-to-end verification

**Goal:** Walk through a real session and confirm the record makes sense.

No files are modified in this task unless a check fails.

- [ ] **Step 1: Clean slate.**

Delete `~/Library/Application Support/Two Way Flow/sessions.json` to start fresh.

- [ ] **Step 2: Record a short session (~60–120 seconds) end-to-end.**

Press Start, talk for ~1 minute (mention monetary facts so the Facts Scanner fires), press Stop.

- [ ] **Step 3: Verify the on-disk record.**

```bash
cat ~/Library/Application\ Support/Two\ Way\ Flow/sessions.json | python3 -m json.tool
```

Expected:

- One element in `sessions`.
- `durationMs` ≈ 60_000 (or whatever you recorded).
- `usage.coach.calls` > 0 (one per tick, so ~40 for a 60s session at 1500ms ticks).
- `usage.summary.calls` = 1.
- `usage.factsScanner.calls` > 0 if you mentioned numbers.
- `usage.geminiLive.audioInputTokens` > 0 (continuous audio in).
- `usage.deepgram.audioMinutes` ≈ duration × 2 / 60.
- `costUsd.total` is a non-zero decimal.

- [ ] **Step 4: Verify the Usage tab UI.**

Open Settings → Usage. Confirm:

- Totals line is correct.
- One row appears with the right start time and duration.
- Expanding Breakdown shows non-zero numbers for each component.

- [ ] **Step 5: Verify Export.**

Click Export → button text changes to "Copied JSON to clipboard". Paste somewhere; confirm it's valid JSON matching the on-disk file.

- [ ] **Step 6: Verify Clear.**

Click Clear → confirm → list empties → on-disk file's `sessions` array becomes empty.

- [ ] **Step 7: Run a second session.**

Verify it appears in the list when the tab reloads (close and reopen Settings, or click the Usage tab again).

- [ ] **Step 8: Negative-path checks.**

- [ ] **Unknown model**: temporarily set `defaultProvider` to a model not in `pricing.js` (or hand-edit `pricing.js` to remove an entry), record a session, confirm the record still saves with `costUsd.coach = 0` and no crash. Restore pricing.js.
- [ ] **No API key for one provider**: set `defaultProvider` to a provider whose key is empty, record a session, confirm the session record still appears (the Coach calls will have failed but Deepgram + Live audio still ran).
- [ ] **Corrupt on-disk file**: stop the app, replace `sessions.json` contents with `garbage`, restart, open Settings → Usage. Expected: empty list (the loader tolerated the parse error) and a console warning. Recording a new session should overwrite the file with valid JSON.

- [ ] **Step 9: If any check fails, fix and re-verify before claiming done.**

Each fix gets its own focused commit. No final wrap-up commit needed if Steps 1–8 all pass without changes.

---

## Final state — what the engineer should hand back

When this plan is done:

- A `sessions.json` file under the app's userData directory contains one record per session ever run since this feature shipped.
- Each record has start / end timestamps, duration, per-component token usage (Coach + Summary + Facts + Quick-Fix + Gemini Live audio + Deepgram), per-component USD cost, total USD cost, and the pricing-table version used.
- The Settings modal has a new "Usage" tab between General and Help showing a chronological list of sessions, totals at the top, and Export / Clear actions.
- Every provider's `generateContent()` returns `{ toolCalls, text, usage }`; the four LLM call sites forward usage into the accumulator; the Gemini Live `usageMetadata` callback feeds the accumulator; Deepgram minutes are derived from session duration × channel count.
- Pricing is hardcoded in `src/pricing.js` with comment headers pointing to the official rate pages.
- Three new IPC channels (`sessions:list`, `sessions:clear`, `sessions:export`) and one new preload bridge (`window.sessions.*`) are the only new public surface.

## Pointers for follow-up work (out of scope here)

- Native Save-dialog Export (mirror `summary:save` in `src/main.js` rather than copying JSON to clipboard).
- CSV export wired into the native Save dialog.
- Per-channel Deepgram seconds (more accurate than the duration × 2 approximation).
- Pricing-table versioning + a "your old sessions were costed with version X" note in the UI when the table is bumped.
- Per-prospect / per-day aggregations (the persisted shape already supports it).
- Hard cap or auto-prune at N MB of history (invariant #5 — swap to better-sqlite3 when it matters).
- Filter / search inside the Usage tab.
- Live cost meter while recording (the planned `general.liveCostMeter` setting at `src/settings.js:29`).

These all build on the storage / accumulator / IPC layer this plan ships; reach for them as separate plans.
