# Per-Surface Transparency Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a friendly Appearance-tab editor that lets the user select one of four overlay surfaces (Coach card, Transcript pane, Captured column, Suggestion card), tune three live sliders for outline / body / text alpha, save the current values into one of three renameable preset slots, and preview the result in a second draggable BrowserWindow next to the main overlay.

---

## Goal

Today the overlay has hard-coded alpha values baked into 25+ `rgba(...)` literals across `src/index.css`. Operators can't dial individual surfaces up or down to fit their screen-share / privacy / readability needs. This plan replaces the literals with a settings-driven alpha system, adds the editor UI plus a live-preview window, and saves three reusable presets so common setups (e.g. "Day" / "Night" / "Demo") are one click away.

## Architecture

Each controllable surface (`.coach`, `.transcript-pane`, `.captured`, `.suggestion`) gets three CSS custom properties (`--surface-<name>-{outline,body,text}-alpha`, raw 0.0–1.0 numerics) that the existing rules read via `color-mix(in srgb, <base> calc(var(...) * 100%), transparent)`. The renderer writes those vars on every `input` event for instant live preview and debounces the same values into `appearance.transparency.*` via the existing `settings:save` IPC. A second `BrowserWindow` (`preview_window`, configured via a new Forge/Vite renderer entry) loads `preview.html` — a static mock of the overlay — and subscribes to the existing `settings:changed` broadcast so every slider nudge re-skins both windows in lock-step. Three named preset slots live under `appearance.transparencyPresets.slotN.{name,values}` and are loaded / saved via the same settings IPC.

## Tech Stack

Electron 42, Vite 5 (HMR), Electron Forge `plugin-vite` (multi-renderer mode), vanilla JS, CSS `color-mix(in srgb, …)`, existing `electron`/`ipcRenderer` plumbing. No new dependencies.

## Spec

n/a — plan is self-contained.

---

## Pre-flight

- [ ] **App starts cleanly today.** Run `npm start`. Overlay opens at the configured size in the top-right of the primary display. No console errors about missing DOM elements.
- [ ] **You're on a clean working tree** (`git status` shows clean) or OK throwing away in-progress work.
- [ ] **You can open the Settings modal.** Click the gear icon in the overlay header → confirm the modal opens to the Providers tab and the Appearance tab is reachable. The new transparency UI will live below the existing speaker-label colour grid in that tab.
- [ ] **You're on macOS for the visual verification passes.** The `hasShadow: false` workaround in `src/main.js:1795-1816` (and the corresponding behaviour we'll mirror in the preview window) is macOS-specific. Functionality works on other platforms; only the shadow-edge cosmetics differ.

Once `npm start` is running, HMR auto-reloads CSS / HTML / renderer changes. **Main-process changes** (`src/main.js`, `src/preload.js`, `forge.config.js`, or any `vite.*.config.mjs`) require typing `rs` in the npm-start terminal to restart, or quitting Electron and restarting `npm start`.

---

## File map

```
NEW files (created by this plan):
  preview.html                    — static mock of the overlay surfaces, loaded by the preview window
  src/preview-renderer.js         — preview-window renderer: applies CSS vars from settings:changed
  vite.preview.config.mjs         — Vite config for the second renderer entry (mirrors vite.renderer.config.mjs)

MODIFIED files:
  src/settings.js                 — extend DEFAULT_SETTINGS.appearance with `transparency` + `transparencyPresets`
  src/index.css                   — refactor the 4 target surfaces to drive alpha from --surface-*-{outline,body,text}-alpha via color-mix
  index.html                      — add the transparency editor section under #settingsTabAppearance
  src/renderer.js                 — slider wiring, live CSS-var application helper, preset CRUD, debounced save, settings:changed re-application
  src/main.js                     — createPreviewWindow(), previewWindowRef lifecycle, appearance:open-preview / close-preview IPC handlers, broadcast plumbing to the preview window
  src/preload.js                  — expose api.appearance.openPreview() / closePreview() and let the preview-renderer subscribe to settings:changed
  forge.config.js                 — add a second renderer entry (name: 'preview_window') in the plugin-vite config

DELETED:
  (none)
```

---

## Public / shared interface impact

- **Settings schema additions (`src/settings.js`).** New keys under `appearance`:
  - `appearance.transparency.{coach,transcript,captured,suggestion}.{outline,body,text}` — numeric `0..1` alpha.
  - `appearance.transparencyPresets.{slot1,slot2,slot3}.name` — string label, renameable.
  - `appearance.transparencyPresets.{slot1,slot2,slot3}.values` — same shape as `appearance.transparency`.
  These are additive — `deepMerge` in `src/settings.js:406` back-fills on load, so no schema bump. Export / Import / Reset already iterate the appearance subtree so they round-trip the new fields for free (`src/settings.js:1050-1146`).
- **New IPC channels (main ↔ renderer).**
  - `appearance:open-preview` (invoke) — lazy-create + show + focus the preview window. Returns `{ ok: true }`.
  - `appearance:close-preview` (invoke) — destroy if open. Returns `{ ok: true }`.
- **Settings broadcast widening.** The existing `settings:changed` broadcast now also reaches the preview window's renderer; payload shape is unchanged, only the subscriber count grows. Existing subscribers (main window renderer) are unaffected.
- **Preload API surface (`src/preload.js`).** Adds `window.api.appearance.openPreview()` and `window.api.appearance.closePreview()` under a new `appearance` namespace. The preview window's preload re-uses `window.api.settings.onChanged` (already exported at `src/preload.js:560`).
- **New CSS variables (`src/index.css`, `:root`).** Twelve new properties: `--surface-coach-{outline,body,text}-alpha`, `--surface-transcript-{outline,body,text}-alpha`, `--surface-captured-{outline,body,text}-alpha`, `--surface-suggestion-{outline,body,text}-alpha`. Anything outside the editor that reads CSS variables today (e.g. `--bg-card`, `--text-strong`) is left intact — the refactor changes how rules compose their alpha, not which variables they reference for hue / family.
- **Forge / Vite entries (`forge.config.js`).** A second renderer entry called `preview_window` is added next to `main_window`. After this lands the constants exposed by `plugin-vite` include `PREVIEW_WINDOW_VITE_DEV_SERVER_URL` and `PREVIEW_WINDOW_VITE_NAME`, which main.js uses to point the preview BrowserWindow at the right asset in both dev (HMR) and packaged builds.

## Potential overlaps with other in-flight plans

Concrete known overlaps in today's batch and the prior batch — coordinator should sequence accordingly.

- **`docs/superpowers/plans/2026-05-18-liquid-glass-overlay-polish.md` — HIGHEST OVERLAP.** That plan deletes `src/index.css` outright and replaces it with eight component CSS files under `src/styles/`. Every file this plan touches (except `src/settings.js`, `forge.config.js`, and the three new files `preview.html` / `src/preview-renderer.js` / `vite.preview.config.mjs`) is also touched by liquid-glass:
  - `src/index.css` — they delete it; we refactor it. Whichever ships second has to re-target the refactor at the new file layout (likely `src/styles/coach.css`, `src/styles/captured.css`, etc., plus a new `--surface-*-alpha` block in `src/styles/tokens.css`).
  - `src/main.js` — they add vibrancy / accent IPC / Cmd+Shift+H fade plumbing in the BrowserWindow options block (~lines 1781–1822); we add a sibling `createPreviewWindow()` immediately after that block (~line 1841) plus `appearance:*` IPC handlers near the existing settings:* handlers (~line 2482). No semantic clash, but the helper layout will collide if both rewrite the same `createWindow()` site.
  - `src/preload.js` — they add `window.system.onAccent` / `setReduceMotion`; we add `window.api.appearance.openPreview/closePreview`. Different namespaces, safe to merge.
  - `src/renderer.js` — they swap CSS imports (line 1) and add accent listener / drawer-timing fix; we add ~200 lines of slider + preset wiring near the existing tag-colour block (`src/renderer.js:5322-5388`). Safe to merge with a diff conflict on the import section.
  - **Coordinator action:** sequence these two plans. Easiest is to ship liquid-glass first, then re-target this plan's `src/index.css` edits onto the new `src/styles/` layout. The CSS-variable concept this plan introduces drops naturally into liquid-glass's `tokens.css` block.

- **`docs/superpowers/plans/2026-05-27-session-cost-tracking.md` — HIGH OVERLAP.** Both plans modify the same five files in the main settings-modal area:
  - `src/main.js` — they register `sessions:list / sessions:clear / sessions:export` IPC handlers next to the existing settings:* block (~line 2482) and finalize a session record inside the `gemini:stop` handler. We register `appearance:open-preview / appearance:close-preview` IPC handlers in the same neighbourhood. No textual overlap if both append to the handler block, but if the file is rewritten near the existing settings:* block expect a conflict at the seam.
  - `src/preload.js` — they expose a new `window.sessions.{ list, clear, export }` namespace; we expose `window.api.appearance.{ openPreview, closePreview }`. Different namespaces, low risk.
  - `index.html` — they add a `#settingsTabUsage` button to the modal nav and a sibling `<section data-tab-content="usage">` panel; we add a new section inside the existing `#settingsTabAppearance` panel (no nav change). Different sub-trees; safe to merge.
  - `src/renderer.js` — they wire `selectSettingsTab('usage')` + render usage rows; we wire the transparency editor inside the existing Appearance tab handler. Disjoint code paths.
  - `src/index.css` — they add `.usage-row / .usage-header / .usage-totals / .usage-breakdown` rules at the end of the file; we refactor existing rules on `.coach / .transcript-pane / .captured / .suggestion` and append new `.transparency-*` rules. If theirs lands first, our refactor is unaffected (their additions are in different selectors). If ours lands first, their appends merge cleanly.
  - **Coordinator action:** either order is safe; the merge points are appends or sub-tree additions, not in-place rewrites. Recommend the smaller plan (this one) ships first to minimise the rebase blast radius for the larger session-cost plan.

- **`docs/superpowers/plans/2026-05-27-coach-reformulate-cap-pivot.md` — LOW OVERLAP.** Touches `src/main.js` and `src/coach.js` only. The main.js edits are concentrated in disjoint regions from ours: `coachContext` shape (~line 661), `resetCoachContext()` (~line 902), `applyMarkAsked()` (~line 1586), `armReformulateTimer` (~line 1736-1762), and the Coach `{...}` constructor block (~line 2772-2906). Our `createPreviewWindow()` lands at ~line 1841 (between their armReformulateTimer and Coach-constructor regions) and our IPC handlers at ~line 2482 (between their applyMarkAsked and Coach-constructor regions). No line-level conflict expected — same file, disjoint hunks.
  - **Coordinator action:** either order is safe.

- **Future "Phase 3 Appearance expansion" plan.** The roadmap comment in `src/settings.js:17-21` reserves `V2 accent, V3 opacity, V6 windowSize, V7/V8 windowPosition, V9 alwaysOnTop, V13 railStyle, V14 capturedPaneVisible, V15 suggestionCardStyle, V16 pillarTintsEnabled, V20 summaryGlass` under `appearance.*`. This plan's `appearance.transparency` and `appearance.transparencyPresets` keys are sibling additions and do not collide name-wise, but Task 1 also rewrites the Phase-3 roadmap doc-block. Any other parallel plan touching `appearance.*` defaults / migrations should be sequenced after this one to keep deep-merge defaults consistent. Coordinator should check if any sibling plan is staking out the V3 opacity slot — this plan supersedes that line item.

- **Any plan adding new top-level windows.** Today the app has exactly one `BrowserWindow` (`src/main.js:1781`). This plan adds a second; a future plan adding a third should follow the same `*_window` naming convention in `forge.config.js` to keep the `plugin-vite`-injected constants legible (`MAIN_WINDOW_VITE_*`, `PREVIEW_WINDOW_VITE_*`, etc.).

General hot zones any future parallel plan should be checked against:

- **`src/settings.js`** `DEFAULT_SETTINGS.appearance` (~line 262-267) and the Phase-3 roadmap doc-block (~line 17-21).
- **`src/main.js`** `createWindow` neighbourhood (~line 1776-1841) and the `settings:*` IPC handler block (~line 2482-2660).
- **`src/preload.js`** the `api` object structure (~line 285-422) — any new namespace must avoid colliding with `audio`, `settings`, `dialog`, `appearance` (this plan), `sessions` (session-cost plan), `system` (liquid-glass plan).
- **`src/index.css`** the four target surface selectors `.coach / .transcript-pane / .captured / .suggestion` and their state variants. Anyone changing the box-shadow or border style on these surfaces should review this plan's `color-mix` rules so the alpha refactor still resolves cleanly.
- **`index.html`** the `#settingsTabAppearance` panel (~line 944-989) and the modal tab-nav block (~line 584-640).

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-check.

1. **Default alpha values must equal today's literal alphas** so a fresh install boots visually identical. The Coach card is `rgba(18,20,24,0.9)` today (`src/index.css:60`) → `coach.body = 0.9`. The transcript pane and captured column use `rgba(255,255,255,0.03)` → `body = 0.03`. Etc. Lift the exact existing numbers, don't round.
2. **CSS variables hold raw 0.0–1.0 numerics**, not percentages and not pre-rendered `rgba(...)` strings. The composition happens in CSS via `color-mix(... calc(var(--x) * 100%), ...)`. This keeps the renderer's "live write" path a single `setProperty(name, String(value))` call.
3. **Surface keys in the settings schema match the CSS-variable namespace 1:1** — `coach`, `transcript`, `captured`, `suggestion`. Renaming requires a migration step in `migrateSettings()`.
4. **The preview window is a styling sandbox only.** It never calls into live-session APIs (no Deepgram, no Gemini, no coach state, no microphone access). It loads `preview.html`, subscribes to `settings:changed`, and applies CSS vars. Nothing else.
5. **The preview window NEVER writes settings.** All edits flow from the main window's Appearance tab. The preview is one-way.
6. **Presets store only the transparency subtree**, not the rest of `appearance.*`. Loading a preset writes only into `appearance.transparency` — `appearance.tagColors` and any future appearance keys are untouched.
7. **`hasShadow: false` applies to the preview window too.** The macOS native-shadow ring documented at `src/main.js:1795-1816` is triggered by `frame:false + transparent:true` regardless of which window draws it. Clone the workaround verbatim.
8. **The renderer's element ids and class names are an immutable contract.** Don't rename `.coach`, `.transcript-pane`, `.captured`, `.suggestion`, or the existing settings-modal ids — `src/renderer.js` queries them by exact name and the suggestion-render path constructs the same DOM.

---

## Task 1: Extend the settings schema

**Goal:** Add `appearance.transparency` and `appearance.transparencyPresets` with defaults that exactly match today's literal alphas. Confirm the deep-merge load path picks them up on next boot without a schema bump.

**Files:**

- Modify: `src/settings.js`

- [ ] **Step 1: Add `transparency` and `transparencyPresets` blocks to `DEFAULT_SETTINGS.appearance`** (currently ends at `src/settings.js:267`). Use these exact defaults:

  ```js
  transparency: {
    coach:      { outline: 0,    body: 0.9,  text: 0.94 },
    transcript: { outline: 0.08, body: 0.03, text: 0.94 },
    captured:   { outline: 0.08, body: 0.03, text: 0.66 },
    suggestion: { outline: 0.08, body: 0.10, text: 0.94 },
  },
  transparencyPresets: {
    slot1: { name: 'Day',   values: { coach: { outline: 0,    body: 0.65, text: 0.94 },
                                      transcript: { outline: 0.12, body: 0.08, text: 0.94 },
                                      captured:   { outline: 0.12, body: 0.08, text: 0.78 },
                                      suggestion: { outline: 0.12, body: 0.18, text: 0.94 } } },
    slot2: { name: 'Night', values: { coach: { outline: 0,    body: 0.9,  text: 0.94 },
                                      transcript: { outline: 0.08, body: 0.03, text: 0.94 },
                                      captured:   { outline: 0.08, body: 0.03, text: 0.66 },
                                      suggestion: { outline: 0.08, body: 0.10, text: 0.94 } } },
    slot3: { name: 'Demo',  values: { coach: { outline: 0,    body: 0.4,  text: 1.0  },
                                      transcript: { outline: 0.2,  body: 0.05, text: 1.0  },
                                      captured:   { outline: 0.2,  body: 0.05, text: 0.9  },
                                      suggestion: { outline: 0.2,  body: 0.18, text: 1.0  } } },
  },
  ```

  The `slot2.values` exactly equal the live `transparency` defaults — "Night" is the current look. `slot1` ("Day") biases body alpha up and text alpha up for screen-share legibility. `slot3` ("Demo") punches up borders for screenshots.

- [ ] **Step 2: Update the doc-block at the top of the file** (`src/settings.js:56-100`) to describe the two new keys under the `appearance` entry of the shape comment. Mention that defaults match today's literals so the file is forward-compatible without a schema bump.

- [ ] **Step 3: Update the Phase 3 roadmap comment** at `src/settings.js:17-21` to note that the V3 "opacity" line is now superseded by `appearance.transparency` (per-surface) plus `appearance.transparencyPresets` (named slots).

- [ ] **Step 4: Verify the deep-merge path back-fills on existing settings files.** Delete `~/Library/Application Support/Two Way Flow/settings.json` is overkill — instead, temporarily edit it to remove the new fields, restart the app, then re-open the file and confirm the defaults reappeared without a migration warning. The app should boot visually identical.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/settings.js
  git commit -m "feat(settings): add appearance.transparency + transparencyPresets

  Additive defaults under appearance.transparency.{coach,transcript,captured,
  suggestion}.{outline,body,text} (numeric 0..1) plus three preset slots
  (slot1/slot2/slot3) with renameable labels. Slot2 'Night' exactly matches
  today's literal alphas so a fresh install or a back-filled older settings
  file boots visually identical.

  No schema bump — deep-merge in loadSettings fills missing keys. Export /
  Import / Reset round-trip the new fields automatically via the existing
  appearance.* iteration."
  ```

---

## Task 2: Refactor `src/index.css` to drive alpha from CSS variables

**Goal:** Replace hard-coded `rgba(...)` literals on the four target surfaces with `color-mix(in srgb, <hue> calc(var(--surface-X-Y-alpha) * 100%), transparent)` so every alpha is settings-driven. Defaults under `:root` must produce the same pixel output as today.

**Files:**

- Modify: `src/index.css`

- [ ] **Step 1: Add a new `:root` block defining the twelve alpha variables** at the bottom of the existing `:root` block (`src/index.css:59-82`). Use the same numeric values as Task 1's `DEFAULT_SETTINGS.appearance.transparency` so the CSS-only path (loading the page before settings IPC fires) produces today's look.

  ```css
  /* Per-surface transparency channels (settings-driven).
   * The renderer mirrors these from appearance.transparency on
   * settings:load and overrides them on every slider input. The CSS
   * default values below MUST equal DEFAULT_SETTINGS.appearance.transparency
   * in src/settings.js so a fresh first-paint matches the persisted shape. */
  --surface-coach-outline-alpha: 0;
  --surface-coach-body-alpha: 0.9;
  --surface-coach-text-alpha: 0.94;
  --surface-transcript-outline-alpha: 0.08;
  --surface-transcript-body-alpha: 0.03;
  --surface-transcript-text-alpha: 0.94;
  --surface-captured-outline-alpha: 0.08;
  --surface-captured-body-alpha: 0.03;
  --surface-captured-text-alpha: 0.66;
  --surface-suggestion-outline-alpha: 0.08;
  --surface-suggestion-body-alpha: 0.10;
  --surface-suggestion-text-alpha: 0.94;
  ```

- [ ] **Step 2: Refactor `.coach`** (`src/index.css:158-170`). Change `background: var(--bg-card);` to `background: color-mix(in srgb, rgb(18 20 24) calc(var(--surface-coach-body-alpha) * 100%), transparent);` and adjust `box-shadow` and any border rule to use `--surface-coach-outline-alpha` for outline tinting. The text colour cascades from `body { color: var(--text-strong); }` — shadow the relevant `--text-*` variables inside the surface using `.coach { --text-strong: color-mix(in srgb, rgb(255 255 255) calc(var(--surface-coach-text-alpha) * 100%), transparent); }` so descendants pick it up.

- [ ] **Step 3: Refactor `.transcript-pane`** (rules around `src/index.css:1026-1183`). For every `background: rgba(255,255,255,0.0X);` and `border-color: rgba(255,255,255,0.0X);` rule on this surface and its children (`.transcript-pane__list`, `.transcript-pane__line`, `.transcript-pane__footer`), swap to `color-mix(... calc(var(--surface-transcript-body-alpha) * 100%) ...)` and `color-mix(... calc(var(--surface-transcript-outline-alpha) * 100%) ...)` respectively. Shadow `--text-strong/--text-med/--text-dim/--text-faint` inside `.transcript-pane` scoped to `--surface-transcript-text-alpha`.

- [ ] **Step 4: Refactor `.captured`** (`src/index.css` `.captured` block + children). Same approach as Step 3 but the `*-captured-*` variables. The captured column's text is dimmer by default (`text: 0.66`) so the shadowed `--text-strong` produces today's muted look.

- [ ] **Step 5: Refactor `.suggestion`** (`src/index.css:1439-1700ish`). Apply the same pattern with `*-suggestion-*` variables. Watch for the `data-asked='true'` and the `[data-color='red'|'amber'|'green']` state variants — they apply additional tint over the body; keep the additional tint as a separate `color-mix` composed on top of the per-surface body alpha.

- [ ] **Step 6: Visual diff.** With `npm start` running, take a screenshot of the overlay before and after this task (the latter via `git stash && npm start; screenshot; git stash pop`). Confirm pixels are identical. If a surface looks visibly different, the alpha refactor is mis-mapping a literal — re-verify against the source line.

- [ ] **Step 7: Commit.**

  ```bash
  git add src/index.css
  git commit -m "refactor(css): drive surface alpha from per-surface CSS variables

  The four controllable surfaces — .coach, .transcript-pane, .captured,
  .suggestion — now compose their outline / body / text alpha from
  --surface-<name>-{outline,body,text}-alpha via color-mix. Default values
  in :root match the previous hard-coded rgba() literals exactly, so
  pixel output is identical at this commit.

  Subsequent tasks wire the Appearance tab and the preview window to
  these variables."
  ```

---

## Task 3: Add a second renderer entry (`preview_window`) to Forge + Vite

**Goal:** Stand up the build plumbing so `preview.html` is bundled and served alongside `index.html` with its own HMR endpoint and packaged-asset path. Main.js can then load the preview window via `PREVIEW_WINDOW_VITE_DEV_SERVER_URL` / `PREVIEW_WINDOW_VITE_NAME` constants that `@electron-forge/plugin-vite` injects.

**Files:**

- Modify: `forge.config.js`
- Create: `vite.preview.config.mjs`
- Create: `preview.html` (skeletal placeholder — fleshed out in Task 5)
- Create: `src/preview-renderer.js` (skeletal placeholder — fleshed out in Task 5)

- [ ] **Step 1: Create `vite.preview.config.mjs`** as a sibling of `vite.renderer.config.mjs`:

  ```js
  import { defineConfig } from 'vite';

  // https://vitejs.dev/config
  // Preview-window renderer. Loads preview.html at the project root.
  // Kept separate from vite.renderer.config.mjs so the bundles are
  // fully isolated — the preview never imports the main renderer's
  // heavyweight modules (coach.js, deepgram-session.js, etc.).
  export default defineConfig({
    build: {
      rollupOptions: {
        input: 'preview.html',
      },
    },
  });
  ```

- [ ] **Step 2: Add the new renderer entry to `forge.config.js`'s `plugin-vite.renderer` array** (`forge.config.js:241-246`). After the existing `{ name: 'main_window', config: 'vite.renderer.config.mjs' }` entry, add:

  ```js
  {
    name: 'preview_window',
    config: 'vite.preview.config.mjs',
  },
  ```

- [ ] **Step 3: Create `preview.html`** with a minimal valid skeleton so the build doesn't fail. Task 5 fleshes out the content.

  ```html
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Two Way Flow — Transparency Preview</title>
    </head>
    <body>
      <main class="coach" id="coach" data-status="idle"></main>
      <script type="module" src="/src/preview-renderer.js"></script>
    </body>
  </html>
  ```

- [ ] **Step 4: Create `src/preview-renderer.js`** with a single console.log so the import resolves. Task 5 fleshes out the content.

  ```js
  // Preview window renderer. Subscribes to settings:changed and applies
  // the per-surface transparency CSS variables. Task 5 of the
  // per-surface-transparency-settings plan fleshes out the content.
  console.log('[preview] renderer loaded');
  ```

- [ ] **Step 5: Verify the build picks up the new entry.** Restart `npm start` (type `rs` in the terminal, or quit + restart). The Vite output should list two renderer bundles — `main_window` and `preview_window`. No error about a missing entry. The new window isn't constructed yet, so behaviour is unchanged.

- [ ] **Step 6: Commit.**

  ```bash
  git add forge.config.js vite.preview.config.mjs preview.html src/preview-renderer.js
  git commit -m "build: add preview_window renderer entry for transparency preview

  Adds a second @electron-forge/plugin-vite renderer entry next to
  main_window. The preview window loads preview.html at the project root
  and runs src/preview-renderer.js. Both are stubs at this commit —
  subsequent tasks add the BrowserWindow construction and the mock
  content."
  ```

---

## Task 4: Add `createPreviewWindow()` and IPC handlers in `src/main.js`

**Goal:** Build a second `BrowserWindow` that mirrors the main window's transparency setup but with `alwaysOnTop: false`, smaller default dimensions, and a separate lifecycle. Wire `appearance:open-preview` and `appearance:close-preview` IPC handlers. Tie the preview window's lifetime to the main window so it closes on quit.

**Files:**

- Modify: `src/main.js`

- [ ] **Step 1: Add a `previewWindowRef` module local** near the existing `mainWindowRef` (`src/main.js:1839`). Initialise to `null`.

- [ ] **Step 2: Add `createPreviewWindow()`** below `createWindow()` (`src/main.js:1776-1841`). Clone the BrowserWindow options but with:
  - `width: 480, height: 360, minWidth: 360, minHeight: 280`
  - `alwaysOnTop: false` (we want the user to be able to focus the main settings tab while the preview sits next to it)
  - Position offset to the left of the main window if `mainWindowRef` exists, else top-left of `workArea`
  - `hasShadow: false` — REQUIRED for the same macOS reason documented at `src/main.js:1795-1816`. Copy the comment forward.
  - `loadURL(PREVIEW_WINDOW_VITE_DEV_SERVER_URL)` in dev, `loadFile(path.join(__dirname, ../renderer/${PREVIEW_WINDOW_VITE_NAME}/preview.html))` in packaged builds.

- [ ] **Step 3: Add IPC handlers** alongside the existing `settings:*` handlers (`src/main.js:2482-2660ish`):

  ```js
  ipcMain.handle('appearance:open-preview', () => {
    if (!previewWindowRef || previewWindowRef.isDestroyed()) {
      createPreviewWindow();
    } else {
      if (previewWindowRef.isMinimized()) previewWindowRef.restore();
      previewWindowRef.show();
      previewWindowRef.focus();
    }
    return { ok: true };
  });

  ipcMain.handle('appearance:close-preview', () => {
    if (previewWindowRef && !previewWindowRef.isDestroyed()) {
      previewWindowRef.close();
    }
    return { ok: true };
  });
  ```

- [ ] **Step 4: Broadcast `settings:changed` to the preview window too.** The existing broadcast helper (search for `send('settings:changed'`) currently posts to `mainWindowRef.webContents`. Generalise it to walk every live BrowserWindow's webContents (or specifically also include `previewWindowRef`). Keep the payload shape identical — the preview window's renderer subscribes via the same `onSettingsChanged` plumbing.

- [ ] **Step 5: Close the preview when the main window closes.** Add a `mainWindow.on('closed', ...)` handler (alongside the existing one at `src/main.js:1835-1837`) that destroys `previewWindowRef` if still alive. Also handle `previewWindowRef.on('closed', ...)` to null the ref.

- [ ] **Step 6: Verify.** Restart the app, open DevTools in the main window, run `await window.api.appearance.openPreview()` (will work once Task 6 lands; for now invoke via `ipcRenderer.invoke('appearance:open-preview')` from the main renderer's DevTools console). The preview window should appear empty and transparent. Run `appearance:close-preview` and confirm it disappears. Quit the app — both windows should close cleanly.

- [ ] **Step 7: Commit.**

  ```bash
  git add src/main.js
  git commit -m "feat(main): createPreviewWindow + appearance:*-preview IPC

  Adds a second BrowserWindow (preview_window) configured identically to
  the main overlay (frame:false, transparent:true, hasShadow:false) but
  with alwaysOnTop:false and smaller dimensions. Lifecycle handlers tie
  the preview to the main window so it closes on quit.

  IPC: appearance:open-preview (lazy-create + show + focus),
  appearance:close-preview (destroy if open). The settings:changed
  broadcast now also reaches the preview window's webContents so a
  slider nudge in the main window re-skins the preview live."
  ```

---

## Task 5: Build `preview.html` and `src/preview-renderer.js` content

**Goal:** Fill in the static mock that the preview window displays. The mock renders the four target surfaces with placeholder content — header bar, two transcript lines (YOU / PROSPECT), a suggestion card, and a captured field. The renderer subscribes to `settings:changed` and re-applies the same `--surface-*-alpha` CSS variables as the main window so the preview lives-updates.

**Files:**

- Modify: `preview.html`
- Modify: `src/preview-renderer.js`

- [ ] **Step 1: Replace the stub `preview.html`** with a self-contained mock that reuses the main app's CSS classes (`.coach`, `.transcript-pane`, `.transcript-pane__line`, `.suggestion`, `.captured`). Import `src/index.css` so the styles match. Add a small `preview-header` element with `app-region: drag` so the user can drag the window. Skip the recording dot / start button / timer (purely static).

- [ ] **Step 2: Replace the stub `src/preview-renderer.js`** with a module that:
  1. Subscribes to `window.api.settings.onChanged` (already exposed at `src/preload.js:560`).
  2. On every payload, reads `payload.appearance.transparency` and writes each numeric value via `document.documentElement.style.setProperty('--surface-<surface>-<channel>-alpha', String(value))`.
  3. On first paint, calls `window.api.settings.load()` once and applies the same writes so the preview doesn't flash with stale CSS defaults before the first broadcast.
  4. NEVER calls `window.api.settings.save` or anything else that mutates state. Read-only.

- [ ] **Step 3: Verify live preview.** With both windows open (main + preview), open the Appearance tab → drag any slider (sliders themselves land in Task 8; for now manually drive the main window's CSS var via DevTools: `document.documentElement.style.setProperty('--surface-coach-body-alpha', '0.3')` then call `window.api.settings.save({ appearance: { transparency: { coach: { body: 0.3 } } } })`). The preview window should re-render to match instantly.

- [ ] **Step 4: Commit.**

  ```bash
  git add preview.html src/preview-renderer.js
  git commit -m "feat(preview): static mock + settings:changed subscriber

  preview.html renders the four target surfaces with placeholder content
  reusing the main app's CSS classes. src/preview-renderer.js subscribes
  to settings:changed and applies --surface-*-alpha variables on every
  broadcast. Read-only — never mutates settings."
  ```

---

## Task 6: Expose the preview-window API on the preload bridge

**Goal:** Add `window.api.appearance.openPreview()` and `closePreview()` to the existing contextBridge. Also confirm the preview window's preload (which re-uses `src/preload.js`) correctly exposes `settings.onChanged` and `settings.load` in that context.

**Files:**

- Modify: `src/preload.js`

- [ ] **Step 1: Add a new `appearance` namespace** to the `api` object exposed via `contextBridge.exposeInMainWorld('api', { ... })`. Place it alphabetically (between `audio` and `dialog`, or wherever fits the existing ordering — see `src/preload.js:362` for the `settings` namespace shape as a template).

  ```js
  appearance: {
    openPreview: () => ipcRenderer.invoke('appearance:open-preview'),
    closePreview: () => ipcRenderer.invoke('appearance:close-preview'),
  },
  ```

- [ ] **Step 2: Update the file-level doc-block** (`src/preload.js:79-230ish`) to document the two new channels alongside the existing `settings:*` entries.

- [ ] **Step 3: Verify the preview window has the same preload bridge.** The `webPreferences.preload` in `createPreviewWindow()` (Task 4) points at the same compiled preload.js, so `window.api.settings.onChanged` is automatically available in `src/preview-renderer.js`. Confirm by opening the preview window's DevTools (`mainWindow.webContents.openDevTools` pattern; add a one-line dev helper in main.js if needed) and inspecting `window.api`.

- [ ] **Step 4: Commit.**

  ```bash
  git add src/preload.js
  git commit -m "feat(preload): expose window.api.appearance.{openPreview,closePreview}

  Bridges the two new IPC channels (appearance:open-preview /
  appearance:close-preview) for the Appearance tab. The preview
  window's preload (same file) already gets window.api.settings.*
  for free."
  ```

---

## Task 7: Add the transparency editor UI to the Appearance tab

**Goal:** Build the markup for the surface dropdown, three sliders (outline / body / text), Open Preview button, Reset Surface button, and three preset slot cards. Use the existing settings-modal class patterns so styling drops in for free.

**Files:**

- Modify: `index.html`

- [ ] **Step 1: Locate `#settingsTabAppearance`** at `index.html:944-989`. The existing section ends with the `appearance-actions` reset button. Add a new `<div class="settings-section">` block immediately below the existing `.settings-section` for speaker-label colours.

- [ ] **Step 2: Add the section markup.** Use the same `.settings-section` + `.settings-section__heading` + `.settings-section__subtitle` shape used elsewhere in the modal. Inside:

  - A `.transparency-controls` row with:
    - `<label for="transparencySurface">Surface</label>` + a `<select id="transparencySurface">` containing four options: `coach`, `transcript`, `captured`, `suggestion`. Labels are friendly ("Coach card", "Transcript pane", "Captured column", "Suggestion card").
    - A `<button id="transparencyPreviewBtn" class="modal__btn">Open preview</button>`.
  - A `.transparency-sliders` block with three `<input type="range" min="0" max="100" step="1">` elements (ids `transparencyOutline`, `transparencyBody`, `transparencyText`), each with a label and a read-only numeric badge that mirrors the live value as a percentage.
  - A `.transparency-actions` row with a single `<button id="transparencyResetSurface" class="modal__btn">Reset surface</button>`.
  - A `.transparency-presets` row with three `.transparency-preset` cards, each containing:
    - An `<input class="transparency-preset__name" type="text" maxlength="20">` (editable label).
    - A `<button class="transparency-preset__load">Load</button>`.
    - A `<button class="transparency-preset__save">Save current</button>`.
    - Each card has `data-preset-slot="slot1|slot2|slot3"` so the renderer can identify it without index-counting.

- [ ] **Step 3: Add aria labels and `aria-live="polite"`** on the numeric percentage badges so screen-reader users hear the new value as the user drags. Match the speaker-label section's accessibility conventions (`src/index.css:944-989` shows the patterns).

- [ ] **Step 4: Add minimal styling** in `src/index.css` for `.transparency-controls`, `.transparency-sliders`, `.transparency-actions`, `.transparency-presets`, `.transparency-preset`. Reuse existing tokens / variables — no new ones. Slider track and thumb match the existing `<input type="color">` pickers' visual weight.

- [ ] **Step 5: Verify markup parses and lays out.** Reload (HMR picks up index.html and index.css automatically). Open Settings → Appearance tab → confirm the new section appears below the speaker-label grid. Sliders move but do nothing yet (renderer wiring lands in Task 8).

- [ ] **Step 6: Commit.**

  ```bash
  git add index.html src/index.css
  git commit -m "feat(ui): add transparency editor UI to Appearance tab

  Surface dropdown, three range sliders (outline/body/text), Open
  Preview button, Reset Surface button, and three preset slot cards
  with editable name + Load + Save buttons. Aria labels match the
  modal's existing accessibility conventions.

  No renderer wiring yet — sliders are inert at this commit. Task 8
  wires them to the new CSS vars + settings IPC."
  ```

---

## Task 8: Wire the renderer (sliders, live preview, presets, debounced save)

**Goal:** Hook every control in Task 7's UI to the underlying data flow. Slider `input` events write CSS vars directly for instant live preview AND debounce the same values into `appearance.transparency.*` via `settings.save`. Surface dropdown changes re-hydrate the sliders. Preset Save / Load snapshot or restore the transparency subtree.

**Files:**

- Modify: `src/renderer.js`

- [ ] **Step 1: Add DOM-element refs** near the existing appearance refs (`src/renderer.js:319-322`): `transparencySurfaceEl`, `transparencyOutlineEl`, `transparencyBodyEl`, `transparencyTextEl`, `transparencyPreviewBtnEl`, `transparencyResetSurfaceEl`, plus three `preset*` triplets.

- [ ] **Step 2: Add a `applySurfaceTransparency(surface, channel, value)` helper** that mirrors `applyTagColors` (`src/renderer.js:4501-4502`). Writes `document.documentElement.style.setProperty(`--surface-${surface}-${channel}-alpha`, String(value))`.

- [ ] **Step 3: Add a `queueTransparencySave(surface, partial)` helper** modelled on `queueAppearanceSave` (`src/renderer.js:5322-5337`). 200ms idle debounce, merges multiple channel changes for the same surface, fires `pushSettingsPartial({ appearance: { transparency: { [surface]: partial } } })`.

- [ ] **Step 4: Wire slider input events.** Each slider's `input` handler reads `transparencySurfaceEl.value`, converts the integer 0–100 to a 0.0–1.0 float, calls `applySurfaceTransparency(surface, channel, value)` synchronously for instant feedback, and calls `queueTransparencySave(surface, { [channel]: value })`. Update the read-only numeric badge in the same handler.

- [ ] **Step 5: Wire surface dropdown change.** On `change`, read `appearance.transparency[surface]` from the cached settings object and re-hydrate the three slider values + their numeric badges. Flush any pending debounce for the previous surface first so the user's last edit lands before they switch.

- [ ] **Step 6: Wire the Open Preview button.** Click → `window.api.appearance.openPreview()`. Disable the button while the call is pending; re-enable on resolve. Show a hint "Preview open in a separate window" next to the button while a preview is active (track via a local boolean).

- [ ] **Step 7: Wire the Reset Surface button.** Click → look up `DEFAULT_SETTINGS.appearance.transparency[surface]` (via the renderer's already-imported defaults or a single `await window.api.settings.load()` to read what's on disk as a fallback), re-apply the three CSS vars, re-hydrate the sliders, and fire `pushSettingsPartial` with the defaults for that surface.

- [ ] **Step 8: Wire preset Save.** Click → snapshot the current `appearance.transparency` from the cached settings into `appearance.transparencyPresets.slotN.values`. Single `pushSettingsPartial` call.

- [ ] **Step 9: Wire preset Load.** Click → deep-merge `appearance.transparencyPresets.slotN.values` into `appearance.transparency`, write all twelve CSS vars synchronously for instant feedback, re-hydrate sliders if the user is currently on a surface that changed.

- [ ] **Step 10: Wire preset name editing.** Debounce 400ms (longer than the slider debounce — the user types) and write `appearance.transparencyPresets.slotN.name`. Update the visible label in the card.

- [ ] **Step 11: Re-apply on `settings:changed`.** Extend the existing `onSettingsChanged` subscriber to also call the twelve `setProperty(...)` writes when the broadcast payload includes a transparency block. This is what lets a preset Load from any window (or a future import) flow back into the live overlay.

- [ ] **Step 12: Visual verification.** Open Settings → Appearance, drag a slider, confirm:
  - The main overlay re-skins instantly (no debounce on the visual feedback).
  - The numeric badge updates as you drag.
  - Within 200ms of releasing the slider, settings.json on disk reflects the new value (tail with `watch cat ~/Library/Application\ Support/Two\ Way\ Flow/settings.json`).
  - Click Open Preview → the preview window appears and matches the main window's transparency. Continue dragging — preview re-skins in lock-step.
  - Save current → slot1, drag sliders away, Load slot1 → values snap back.
  - Rename slot1 to "My Setup" → reopen Settings later → label persists.

- [ ] **Step 13: Commit.**

  ```bash
  git add src/renderer.js
  git commit -m "feat(renderer): wire transparency editor sliders + presets

  Sliders write CSS vars synchronously for instant live preview and
  debounce the same values into appearance.transparency via
  settings:save (200ms). Surface dropdown re-hydrates the sliders.
  Open Preview opens the second BrowserWindow.

  Three preset slots: Save snapshots the full transparency subtree,
  Load restores it (also flows to the preview window via the
  existing settings:changed broadcast). Names are inline-editable
  with a 400ms debounce."
  ```

---

## Task 9: Edge-case polish (low-alpha hints, round-trip verification)

**Goal:** Surface the two known foot-guns inline (macOS native-shadow ring at very low outline alpha, illegible text below ~0.4 text alpha) and verify Export / Import / Reset round-trip the new fields cleanly without code changes (the existing helpers iterate `appearance.*` already).

**Files:**

- Modify: `src/renderer.js`
- Modify: `index.html` (small hint elements only)

- [ ] **Step 1: Add a hint container under the Outline slider** (`<p class="transparency-hint" data-channel="outline" hidden>...</p>`) and the renderer toggles `hidden` based on the current value. Wording: "Very low outline alpha may show a faint macOS shadow ring around the surface — this is expected." Threshold: show when `outline < 0.05`.

- [ ] **Step 2: Add a hint container under the Text slider** (`data-channel="text"`). Wording: "Text below 40% alpha may be hard to read." Threshold: show when `text < 0.4`.

- [ ] **Step 3: Verify Export round-trip.** Settings → General → Data → Export. Open the resulting JSON file. Confirm `appearance.transparency` and `appearance.transparencyPresets` are present. Re-import the file — every slot value and renamed label should reappear.

- [ ] **Step 4: Verify Reset round-trip.** Settings → General → Data → Reset (without preserving keys is fine — keys aren't in this plan's scope). After reset, all twelve transparency channels and three preset labels should match DEFAULT_SETTINGS.

- [ ] **Step 5: Verify back-fill on older settings file.** Hand-edit `~/Library/Application Support/Two Way Flow/settings.json` to remove the `transparency` and `transparencyPresets` fields entirely. Restart the app. Open Appearance → the editor should populate from defaults; the settings file on disk should now contain the back-filled fields (written automatically by `loadSettings()` because `deepMerge` populates them and the auto-save path writes back).

- [ ] **Step 6: Commit.**

  ```bash
  git add src/renderer.js index.html
  git commit -m "feat(ui): low-alpha hints + verify settings round-trip

  Adds inline hints under the Outline and Text sliders when their
  values cross a low-alpha threshold (outline < 0.05 may show a
  macOS shadow ring; text < 0.4 hurts legibility). Export / Import /
  Reset round-trip the new appearance.transparency and
  appearance.transparencyPresets fields without code changes — the
  existing helpers iterate appearance.* already.

  Closes the per-surface-transparency-settings plan."
  ```

---
