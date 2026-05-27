# Collapsible Top Toolbar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user collapse the entire top toolbar (`.coach__header` — timer, You/Other, AEC, connection pill, version, mode toggle, Start, minimise, close) into a near-invisible 8px reveal strip so the always-on-top overlay stops competing with the screens behind it, with friendly hover/keyboard/click affordances to bring it back when the user needs to interact.

**Goal:** Reduce visual distraction of the always-on-top overlay by making the chrome auto-hide on demand. When collapsed, the overlay becomes mostly transparent ambient information; when the user needs control, the toolbar slides back in. Preserves all current behaviour (drag-to-move, recording, keyboard shortcuts) and adds a persisted user preference for collapse state.

**Architecture:** Pure HTML/CSS/JS additions inside the existing frameless overlay — no new IPC channels, no main-process changes, no window-resize logic. A new top-of-card reveal strip element captures hover-to-reveal and becomes the drag region while collapsed. The existing `.coach__header` gets a translate animation, an `aria-hidden` flip, and a new `data-collapsed` flag on `.coach`. A tiny "ghost status pill" floats above the strip whenever a recording is live so the user keeps awareness of recording state even when the toolbar is hidden. State persists under a new `localStorage` key (`'twf.header.v1'`) — deliberately kept separate from the existing `'twf.layout.v1'` schema so it can be reasoned about (and rolled back) independently.

**Tech Stack:** Vanilla JS + CSS inside the existing Electron 42 / Vite 5 / vanilla-renderer overlay. No new dependencies.

**Spec:** n/a — plan is self-contained.

---

## Pre-flight

Before starting:

- [ ] **App starts cleanly today.** Run `npm start`. Overlay opens at 1100 × 520, top-right of the work area. Header shows timer / You / Other / AEC / version / Signalled-Automated / Start / — / × with no console errors.
- [ ] **You're on a clean working tree** (`git status` shows clean) or you're OK throwing away in-progress work. The pre-existing dirty files listed in the project state (e.g. `M src/index.css`, `M src/renderer.js`, `.vite/build/*`) are NOT this plan's concern — set them aside on a separate branch or stash before starting.
- [ ] **You can see the overlay's full header.** This plan adds a collapse button to that header — if anything is hiding the right side of the controls cluster (e.g. the version pill cluster is overflowing), screenshot before/after to confirm fit.
- [ ] **You have a way to test recording status visuals.** A live recording surfaces the connection-status pill + the new ghost status pill in the collapsed state. A `GEMINI_API_KEY` in `.env` plus an OS mic-permission grant is enough; the visual pieces still work without successful audio capture (status flips idle → starting → error and the indicators are visible).

Once `npm start` is running, HMR auto-reloads CSS and HTML edits. Renderer-only JS changes also hot-reload. Main-process changes are NOT needed by this plan.

---

## File map

```
NEW files (created by this plan):
  (none — every change lands in existing files)

MODIFIED files:
  index.html                         — add reveal strip + collapse button + ghost-pill + mini controls; mark header `aria-hidden`-capable
  src/index.css                      — add styles for `.coach[data-collapsed]`, `.coach__reveal-strip`, `.coach__ghost-pill`, `.coach__mini-controls`; animate `.coach__header` translate
  src/renderer.js                    — add headerCollapsed state, persistence helpers, toggle logic, hover-reveal timer, keyboard shortcut, drag-region handoff, ghost-pill sync; capture refs to new DOM nodes
  src/preload.js                     — no new bridge methods, but add a header-collapse subscription hook for future global-menu integration (optional, see Task 6)

DELETED:
  (none)
```

---

## Public / shared interface impact

- **localStorage schema:** new key `'twf.header.v1'` storing `{ "collapsed": boolean, "pinned": boolean, "schemaVersion": 1 }`. Documented in a doc-block alongside the existing `'twf.layout.v1'` block in `src/renderer.js`. Reads tolerate missing/corrupt values by falling back to defaults (`collapsed: false`, `pinned: true`).
- **DOM ids/classes added (treat as a contract once shipped):**
  - `#coachRevealStrip` — the always-present 8 px reveal strip above the header.
  - `#coachGhostPill` — recording-status ghost pill rendered inside the reveal strip while collapsed.
  - `#coachMiniMinButton`, `#coachMiniCloseButton` — duplicates of `#minButton` / `#closeButton`, only visible while collapsed + hovered.
  - `#headerCollapseBtn` — the chevron (∧) button inside `.coach__controls` that toggles the collapsed state.
  - CSS hook: `.coach[data-collapsed='true']` flips the layout into collapsed mode. `.coach[data-revealing='true']` adds a temporary "hover-revealed" override.
- **Keyboard shortcut:** new global-to-the-window `Cmd/Ctrl+Shift+T` toggles `headerCollapsed`. Does NOT use Electron `globalShortcut` — purely a renderer `keydown` listener (so it doesn't conflict with other apps).
- **Drag region:** the drag-region contract changes — when collapsed, `-webkit-app-region: drag` shifts from `.coach__header` to `#coachRevealStrip`. Header keeps drag-region in expanded mode. This needs to be documented in the same block-comment that currently lives at `src/index.css:215-225`.
- **IPC channels / event names:** none added, none changed.

---

## Potential overlaps with other in-flight plans

The coordinator should check these specifically — this plan touches three of the most-edited files in the repo:

- **`index.html`** — any plan that restructures the header (e.g. liquid-glass refactor, settings panel additions, new badges) will collide on the `.coach__header` markup we're modifying.
- **`src/index.css`** — same. Especially anything that splits `index.css` into per-component files (e.g. the older `2026-05-18-liquid-glass-overlay-polish.md` plan does exactly this and is still un-landed based on the current presence of `src/index.css`). If that plan ships first, this plan must be reworked to land its styles inside `src/styles/coach.css`. If this plan ships first, the split plan will need to absorb the new `[data-collapsed]` rules at the right component-file granularity.
- **`src/renderer.js`** — central file. Any plan touching DOM refs at the top of the file, header state, persistence, or keydown handlers will likely conflict. We add ~5 new DOM ref captures (around `src/renderer.js:104-114`), a new state field (`state.headerCollapsed` / `state.headerPinned`), and a new keydown branch at `src/renderer.js:6242-6295`.
- **localStorage layout schema (`'twf.layout.v1'`)** — we deliberately use a separate key (`'twf.header.v1'`) to avoid migration risk. But if a parallel plan also adds a new top-level layout key, the coordinator should pick consistent naming.
- **Global keyboard shortcuts** — `Cmd/Ctrl+Shift+T` is what this plan claims. Any parallel plan adding a shortcut should pick something different (the existing `Cmd/Ctrl+Shift+H` toggles whole-window visibility from `src/main.js:3710-3717`).
- **Cmd+Shift+H fade behaviour** — `docs/superpowers/plans/2026-05-18-liquid-glass-overlay-polish.md` Task 13 reworks that shortcut. If that plan lands first, this plan's `Cmd+Shift+T` shortcut needs to keep parity with the fade pattern (i.e. animate the header collapse with the same `prefers-reduced-motion` gate). No code overlap, but a behavioural consistency check.
- **Always-on-top / mouse-events / opacity** — none of those Electron APIs are touched by this plan. Any plan that adds `setIgnoreMouseEvents` or `setOpacity` for click-through experimentation will be fully independent.

If the coordinator can't determine overlap from the file list alone, the resolution rule is: this plan's CSS/HTML additions are deliberately scoped to NEW class/id names, so they will only conflict on the few existing selectors we modify (`.coach`, `.coach__header`, `.coach__controls`).

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-think.

1. **Reveal must always be accessible.** No keyboard or visual flow may leave the user with no way to bring the toolbar back. The reveal strip is always present (even at 0 opacity), the keyboard shortcut always works, and `Cmd+M` / `Cmd+W` (macOS menu) and tray icon paths are unchanged.
2. **Drag region must always exist somewhere on the visible card.** When collapsed: `#coachRevealStrip` is the drag region. When expanded: `.coach__header` is the drag region. Never both — exactly one element holds `-webkit-app-region: drag` at any moment.
3. **Ghost status pill is purely informational.** No click target, no `<button>`, no hover behaviour beyond opacity. It's a visual breadcrumb that the tool is still working while collapsed.
4. **State persists; default is uncollapsed.** First-launch users see the full toolbar — discoverability beats minimalism. Once a user collapses, the preference sticks across launches.
5. **All header animations gated on `prefers-reduced-motion: no-preference`.** Collapse / reveal / ghost-pill fade-in all use CSS transitions wrapped in the media-query guard. Reduce-motion gets a snap.
6. **The mini window controls in the reveal strip route through the same IPC as the header buttons.** Single source of truth for `window:minimize` and `window:close` — no diverging code paths.
7. **No main-process changes.** This plan stays entirely in the renderer + HTML + CSS. If a follow-up wants to also shrink the window on collapse, that's a separate plan with its own IPC channel and main-process resize logic.

---

## Task 1: State, persistence, and DOM refs

**Goal:** Get the plumbing in place before touching any visuals. Add the new state fields, a persistence read/write pair, a doc-block describing the new schema, and capture refs to the DOM nodes that Task 2 will introduce.

**Files:**

- Modify: `src/renderer.js` (state block, DOM refs near `src/renderer.js:104-114`, persistence helpers near `src/renderer.js:37-51`)

- [ ] **Step 1: Add the persistence-key constant and a doc-block describing the schema.**

In `src/renderer.js`, near the existing `COACH_MODE_LS_KEY` declaration around `src/renderer.js:37`, add:

```js
/* ─── Header collapse state (separate from 'twf.layout.v1') ──────────
 * Persists whether the user wants the top toolbar hidden between
 * launches. Kept out of 'twf.layout.v1' so it can be reasoned about
 * (and migrated / rolled back) independently of the pane-sizing schema.
 *
 * Shape:
 *   {
 *     "collapsed":     boolean,   // user wants chrome hidden
 *     "pinned":        boolean,   // when true and collapsed=false, the
 *                                 //   header stays open and ignores
 *                                 //   the hover-leave auto-collapse
 *                                 //   timer. Default true (no auto-
 *                                 //   collapse for first-launch users).
 *     "schemaVersion": 1
 *   }
 *
 * Reads tolerate missing/corrupt values and fall back to
 * { collapsed: false, pinned: true }. Writes are fire-and-forget;
 * a private-mode localStorage failure falls back silently.
 * ─────────────────────────────────────────────────────────────────── */
const HEADER_STATE_LS_KEY = 'twf.header.v1';
const HEADER_STATE_DEFAULT = Object.freeze({
  collapsed: false,
  pinned: true,
  schemaVersion: 1,
});
```

- [ ] **Step 2: Add `loadHeaderState()` and `persistHeaderState()` helpers right below.**

```js
function loadHeaderState() {
  try {
    const raw = localStorage.getItem(HEADER_STATE_LS_KEY);
    if (!raw) return { ...HEADER_STATE_DEFAULT };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1) {
      return {
        collapsed: parsed.collapsed === true,
        pinned: parsed.pinned !== false,   // default true for back-compat
        schemaVersion: 1,
      };
    }
  } catch { /* corrupt JSON or private mode */ }
  return { ...HEADER_STATE_DEFAULT };
}

function persistHeaderState(next) {
  try {
    localStorage.setItem(HEADER_STATE_LS_KEY, JSON.stringify({
      collapsed: next.collapsed === true,
      pinned: next.pinned !== false,
      schemaVersion: 1,
    }));
  } catch { /* private mode */ }
}
```

- [ ] **Step 3: Add the state fields to the main `state` object.**

Find the `state` object declaration in `src/renderer.js`. Add these alongside the other UI-state fields (next to `state.coachMode` is a sensible neighbour):

```js
  headerCollapsed: false,   // current visible state (mirrors persisted value)
  headerPinned: true,       // disables auto-collapse-on-mouseleave when true
  headerRevealing: false,   // transient: hover-revealed while collapsed
  headerRevealTimer: null,  // setTimeout handle for the leave-grace period
```

(Replace the line above by inserting these inside the `const state = { ... }` object literal, not at module scope.)

- [ ] **Step 4: Add DOM ref captures for the five new elements Task 2 will create.**

Right after the existing block at `src/renderer.js:104-114` that captures `coachEl`, `recTimerEl`, etc., add:

```js
const coachRevealStripEl = document.getElementById('coachRevealStrip');
const coachGhostPillEl = document.getElementById('coachGhostPill');
const coachMiniMinButtonEl = document.getElementById('coachMiniMinButton');
const coachMiniCloseButtonEl = document.getElementById('coachMiniCloseButton');
const headerCollapseBtnEl = document.getElementById('headerCollapseBtn');
```

(These will be `null` until Task 2 lands. That's fine — Task 4 guards every use with `if (el)`.)

- [ ] **Step 5: Commit.**

```bash
git add src/renderer.js
git commit -m "feat(header): add headerCollapsed state + 'twf.header.v1' schema

Adds the persistence key, doc-block, load/persist helpers, four new
fields on the state object (headerCollapsed, headerPinned,
headerRevealing, headerRevealTimer), and captures DOM refs for the
five new elements that Task 2 will introduce. No behavioural change
yet — the refs are all null until Task 2 lands."
```

---

## Task 2: HTML — reveal strip, collapse button, ghost pill, mini controls

**Goal:** Add the four new DOM nodes that the rest of the plan will style and animate. Strictly markup-only; no behaviour wired yet.

**Files:**

- Modify: `index.html`

- [ ] **Step 1: Add `#coachRevealStrip` as the first child of `<main class="coach">`.**

Find the opening `<main class="coach" id="coach">` line in `index.html` (around `index.html:7-15` based on the resize-grip's position there). Insert this block as the very first child, BEFORE the existing `<header class="coach__header">`:

```html
        <div id="coachRevealStrip" class="coach__reveal-strip" aria-hidden="true">
          <div id="coachGhostPill" class="coach__ghost-pill" hidden>
            <span class="coach__ghost-pill__dot" aria-hidden="true"></span>
            <span id="coachGhostPillTimer" class="coach__ghost-pill__timer">00:00</span>
          </div>
          <div class="coach__mini-controls" aria-hidden="true">
            <button id="coachMiniMinButton" type="button"
                    class="coach__mini-icon-btn" tabindex="-1"
                    aria-label="Minimise" title="Minimise">—</button>
            <button id="coachMiniCloseButton" type="button"
                    class="coach__mini-icon-btn" tabindex="-1"
                    aria-label="Close" title="Close (⌘W)">×</button>
          </div>
        </div>
```

`tabindex="-1"` keeps these mini buttons out of the tab order while collapsed (they're visual duplicates of the header buttons, which are the canonical tab targets). They become focusable via mouse only.

- [ ] **Step 2: Add the chevron-collapse button inside `.coach__controls`.**

Find the `.coach__controls` block in `index.html` (around lines 130-195 based on the prior exploration). Insert the new button as the FIRST child of `.coach__controls`, before the existing `#settingsButton`:

```html
          <button id="headerCollapseBtn" type="button" class="coach__icon-btn"
                  aria-label="Hide toolbar" title="Hide toolbar (⌘⇧T)"
                  aria-controls="coach" aria-expanded="true">
            <span aria-hidden="true">∧</span>
          </button>
```

`aria-controls="coach"` + `aria-expanded` lets assistive tech announce the relationship: this button controls the visibility of the coach's chrome. Task 4 keeps `aria-expanded` in sync with `state.headerCollapsed` (inverted: `true` when not collapsed).

- [ ] **Step 3: Verify the HTML parses and renderer still mounts.**

HMR reloads. Expected:

- App boots, no "Cannot read properties of null" from the renderer (Task 1's new DOM refs are now resolved).
- An 8 px-tall transparent strip is at the top of the card. Not visible yet (no styles), but inspect in DevTools and confirm `#coachRevealStrip` is the first child of `.coach`.
- A new `∧` icon button appears at the LEFT of the controls cluster (just before the settings cog). Clicking it does nothing yet.
- The mini-min and mini-close buttons exist in the DOM but render unstyled (raw `—` and `×` characters somewhere in the strip area).

- [ ] **Step 4: Commit.**

```bash
git add index.html
git commit -m "feat(header): add reveal strip + ghost pill + mini controls + collapse btn

Inserts #coachRevealStrip as the first child of .coach, containing a
hidden #coachGhostPill (recording dot + timer for collapsed-state
status awareness) and #coachMiniMinButton / #coachMiniCloseButton
duplicates routed through the same IPC channels as the header buttons.

Adds #headerCollapseBtn (∧) as the leftmost child of .coach__controls
with aria-controls=coach + aria-expanded=true.

No styles or behaviour wired yet — Tasks 3 and 4 follow."
```

---

## Task 3: CSS — collapsed layout, reveal strip, ghost pill, mini controls, transitions

**Goal:** Style every visual state of the collapse feature: expanded (no change to current visuals), collapsed (header translated out + reveal strip surfaced), and revealing (hover-revealed override). Gate all animations on `prefers-reduced-motion`.

**Files:**

- Modify: `src/index.css`

- [ ] **Step 1: Add the reveal-strip + ghost-pill + mini-controls block at the end of the Header section.**

Find the existing Header section in `src/index.css` (the one starting at the comment "─── Header ────" around `src/index.css:213-225`). After the last `.coach__header` rule (and before the next major section), add:

```css
/* ─── Collapse mode: reveal strip + ghost pill + mini controls ──────
 *
 * The reveal strip is always present at the top of `.coach` (above
 * the header). In expanded mode it's an invisible 0-height spacer.
 * In collapsed mode it becomes 8 px tall, hosts the drag region,
 * surfaces an optional ghost status pill, and reveals mini window-
 * controls on hover.
 *
 * The collapse animation lives on `.coach__header` itself (translateY
 * + opacity + height). The strip stays put.
 *
 * Drag-region contract (mirrors the doc-block on `.coach__header`):
 *   - .coach[data-collapsed='false']  → drag on .coach__header (existing)
 *   - .coach[data-collapsed='true']   → drag on #coachRevealStrip
 *   - Buttons inside either region opt out via the universal no-drag
 *     selector at src/index.css:111-117.
 * ─────────────────────────────────────────────────────────────────── */

.coach__reveal-strip {
  position: relative;
  height: 0;
  overflow: visible;             /* ghost-pill can extend below the strip */
  -webkit-app-region: no-drag;   /* drag-region attached in collapsed mode only */
  pointer-events: none;          /* dead-band when expanded so it doesn't
                                    eat clicks on the header underneath */
}

.coach[data-collapsed='true'] .coach__reveal-strip {
  height: 8px;
  -webkit-app-region: drag;
  pointer-events: auto;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.coach[data-collapsed='true'][data-revealing='true'] .coach__reveal-strip {
  /* While the user is hover-revealing, the strip stops being the drag
   * region — the now-visible header takes that role. */
  -webkit-app-region: no-drag;
}

/* Subtle handle indicator centred horizontally on the strip — only
 * visible while collapsed AND hovered. Helps users find the affordance. */
.coach[data-collapsed='true'] .coach__reveal-strip::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 32px;
  height: 3px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  opacity: 0;
  transition: opacity 160ms ease;
  pointer-events: none;
}

.coach[data-collapsed='true'] .coach__reveal-strip:hover::after {
  opacity: 0.7;
}

/* ─── Ghost status pill ─── */

.coach__ghost-pill {
  position: absolute;
  top: 50%;
  left: 12px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 2px 6px;
  font-size: 10px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.3px;
  color: rgba(255, 255, 255, 0.55);
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-pill);
  white-space: nowrap;
  pointer-events: none;          /* informational only — never clickable */
  opacity: 0;
}

.coach[data-collapsed='true'] .coach__ghost-pill:not([hidden]) {
  opacity: 1;
}

.coach__ghost-pill__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-red);
  box-shadow: 0 0 4px rgba(248, 113, 113, 0.7);
}

/* ─── Mini window controls (—, ×) in the reveal strip ─── */

.coach__mini-controls {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease;
}

.coach[data-collapsed='true'] .coach__reveal-strip:hover .coach__mini-controls {
  opacity: 0.85;
  pointer-events: auto;
}

.coach__mini-icon-btn {
  -webkit-app-region: no-drag;
  appearance: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  border: 0;
  border-radius: 50%;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 0;
  transition: background 120ms ease, color 120ms ease;
}

.coach__mini-icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.9);
}
```

- [ ] **Step 2: Add the collapsed-header rules.**

Append immediately below the Step 1 block:

```css
/* ─── Collapsed header animation ─────────────────────────────────────
 *
 * When .coach[data-collapsed='true'], the header is translated up by
 * its own height and faded out. The element keeps `display: grid` so
 * focus / tab order isn't disrupted — `aria-hidden` on the header
 * element (set by the renderer) handles the screen-reader story.
 * Pointer events are disabled to prevent invisible buttons from
 * eating clicks against the body below.
 *
 * When hover-revealing (data-revealing='true'), the translate reverts
 * to 0 without changing the data-collapsed flag — that way the
 * persisted preference doesn't flip every time the user peeks.
 * ─────────────────────────────────────────────────────────────────── */

.coach[data-collapsed='true'] .coach__header {
  transform: translateY(-100%);
  opacity: 0;
  pointer-events: none;
}

.coach[data-collapsed='true'][data-revealing='true'] .coach__header {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: no-preference) {
  .coach__header {
    transition:
      transform 220ms cubic-bezier(0.32, 0.72, 0, 1),
      opacity 180ms ease;
  }

  .coach__ghost-pill {
    transition: opacity 200ms ease 60ms;  /* slight delay so it appears
                                              after the header animates out */
  }
}

/* Subtle 1px hairline at the top of the card when collapsed so the
   window edge is still legible against transparent desktops. */
.coach[data-collapsed='true'] {
  /* The card already has a 1px hairline border via .coach { ... }; no
     change here unless verification reveals an edge-contrast issue.
     If it does, override the border-top-color in this rule. */
}
```

- [ ] **Step 3: Update the existing `.coach__header` block to acknowledge the new transform origin.**

The existing rule at `src/index.css:215-225` already has the right properties; we just need to confirm `transform-origin` defaults are fine (`top` for a `translateY(-100%)` animation works regardless of origin since we're translating not scaling, but `transform-origin: top` makes the intent explicit). Modify the existing block from:

```css
.coach__header {
  -webkit-app-region: drag;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
}
```

To:

```css
.coach__header {
  -webkit-app-region: drag;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
  transform-origin: top;
  will-change: transform, opacity;
}

.coach[data-collapsed='true'] .coach__header,
.coach[data-collapsed='true'][data-revealing='true'] .coach__header {
  /* When the header is collapsed, the body's gridded child layout
     should still see "no header above me" — but we keep display:grid
     for tab-order continuity. The translate handles the visual. */
}

/* Drag-region handoff: when collapsed, the header itself is no-drag
   (it's translated out of view, and even if revealing, the strip's
   sibling drag region is the one we want active). The reveal strip's
   own drag-region rule above sets `app-region: drag` in collapsed mode. */
.coach[data-collapsed='true'] .coach__header {
  -webkit-app-region: no-drag;
}
```

The empty block in the middle is intentional documentation — it tells the next reader "yes, we considered toggling display here, and chose not to." Feel free to delete the empty rule before commit if it offends.

- [ ] **Step 4: Visually verify each state by manually toggling the data attribute in DevTools.**

(HMR will have reloaded by now. The `#headerCollapseBtn` doesn't toggle anything yet — Task 4 wires it.)

In DevTools, find the `<main id="coach">` element. Add the attribute `data-collapsed="true"`. Expected:

- Header smoothly slides up and fades out over ~220 ms.
- The 8 px reveal strip appears at the top with a faint 1 px bottom hairline.
- Hover the strip → a tiny 32 × 3 px white handle indicator fades in at the centre, the mini `—` `×` buttons fade in at the right (85 % opacity). Cursor turns into a window-drag cursor over the strip.

Remove `data-collapsed`. Expected:

- Header smoothly slides back into view, strip collapses to 0 height again.

Add `data-collapsed="true"` again, then add `data-revealing="true"`. Expected:

- Header slides back into view BUT `data-collapsed` is still true. This is the "hover peek" state Task 4 will drive.

Open DevTools → Elements → click `<main id="coach">`. Manually set `#coachGhostPill[hidden]` to false. Expected:

- Tiny pill with a red dot + `00:00` appears on the LEFT of the reveal strip.

Pin the inspector off-screen and move the cursor over the strip / non-strip regions to confirm hit-testing makes sense — clicks should NOT pass through the strip when collapsed (so the mini-controls can receive them), but the body below the strip should accept clicks normally.

- [ ] **Step 5: Reduce-motion verification.**

System Settings → Accessibility → Display → Reduce Motion ON. Toggle the `data-collapsed` attribute again in DevTools. Expected: header snaps in/out with no transition.

Revert Reduce Motion to OFF before continuing.

- [ ] **Step 6: Commit.**

```bash
git add src/index.css
git commit -m "feat(header): style collapsed mode, reveal strip, ghost pill, mini controls

Adds .coach[data-collapsed='true'] state that translates the header up
+ opacity 0 with a 220ms ease-out transition (gated on prefers-reduced-
motion).

#coachRevealStrip is 0 height in expanded mode (dead-band that doesn't
intercept clicks) and 8px tall in collapsed mode, hosting the drag
region, a centred handle indicator on hover, mini window controls on
hover, and the optional ghost status pill.

.coach[data-revealing='true'] overrides the translate to 0 without
flipping data-collapsed — the hover-peek state.

Drag region handoff documented inline. Mini buttons are 16x16 ghost
controls at 0.85 opacity on hover.

No behaviour wired yet — Task 4 follows."
```

---

## Task 4: JavaScript — toggle logic, hover-reveal, keyboard shortcut, drag-region handoff, ghost-pill sync

**Goal:** Wire up everything Task 2 / Task 3 set up. The collapse button toggles state; the strip's mouseenter/mouseleave drives the hover-reveal; `Cmd/Ctrl+Shift+T` toggles via keyboard; the mini buttons route to the same IPC as the header buttons; the ghost pill mirrors `recTimerEl`'s contents while collapsed + recording.

**Files:**

- Modify: `src/renderer.js`

- [ ] **Step 1: Add a `setHeaderCollapsed()` mutator near the existing UI-state setters.**

Locate a sensible spot — somewhere near `applyCoachMode()` around `src/renderer.js:3898-3922` is a good neighbour. Add:

```js
function setHeaderCollapsed(next, { persist = true } = {}) {
  const collapsed = next === true;
  if (state.headerCollapsed === collapsed) return;

  state.headerCollapsed = collapsed;
  coachEl.dataset.collapsed = String(collapsed);

  // Always clear the transient reveal state on an explicit collapse change.
  state.headerRevealing = false;
  coachEl.removeAttribute('data-revealing');

  // Keep the header's aria-hidden in sync. Buttons inside an aria-
  // hidden region are not announced — that's exactly the behaviour we
  // want for screen-reader users while collapsed. The visual focus
  // ring is also suppressed by the translate transform.
  const headerEl = coachEl.querySelector('.coach__header');
  if (headerEl) headerEl.setAttribute('aria-hidden', String(collapsed));

  // The collapse button's aria-expanded mirrors the inverse — true
  // when the toolbar IS expanded.
  if (headerCollapseBtnEl) {
    headerCollapseBtnEl.setAttribute('aria-expanded', String(!collapsed));
    headerCollapseBtnEl.setAttribute(
      'aria-label',
      collapsed ? 'Show toolbar' : 'Hide toolbar',
    );
    headerCollapseBtnEl.setAttribute(
      'title',
      collapsed ? 'Show toolbar (⌘⇧T)' : 'Hide toolbar (⌘⇧T)',
    );
  }

  // Ghost-pill visibility is jointly gated by collapsed-state AND
  // recording-status. renderGhostPill() handles the combination.
  renderGhostPill();

  if (persist) {
    persistHeaderState({
      collapsed,
      pinned: state.headerPinned,
    });
  }
}
```

- [ ] **Step 2: Add a `renderGhostPill()` helper that keeps the ghost pill in sync.**

Place it next to `renderTimer()` around `src/renderer.js:1377-1382`:

```js
function renderGhostPill() {
  if (!coachGhostPillEl) return;
  const isRecording = state.status === 'listening' || state.status === 'starting';
  const shouldShow = state.headerCollapsed && isRecording;
  coachGhostPillEl.hidden = !shouldShow;
  if (shouldShow) {
    const timerEl = document.getElementById('coachGhostPillTimer');
    if (timerEl) timerEl.textContent = recTimerEl.textContent;
  }
}
```

Then update `renderTimer()` to also update the ghost pill's timer text on each tick:

```js
function renderTimer() {
  const ms = state.recordingStartedAt
    ? Date.now() - state.recordingStartedAt
    : 0;
  recTimerEl.textContent = formatTimer(ms);
  const ghostTimer = document.getElementById('coachGhostPillTimer');
  if (ghostTimer) ghostTimer.textContent = recTimerEl.textContent;
}
```

Update `setStatus()` (around `src/renderer.js:1112-1137`) to also call `renderGhostPill()` so the pill appears/disappears when recording starts/stops:

```js
// at the end of setStatus(), alongside the existing renderConnectionStatus() call:
  if (typeof renderGhostPill === 'function') renderGhostPill();
```

- [ ] **Step 3: Wire the collapse button.**

Add near the existing `minButtonEl.addEventListener` at `src/renderer.js:5777`:

```js
if (headerCollapseBtnEl) {
  headerCollapseBtnEl.addEventListener('click', () => {
    setHeaderCollapsed(!state.headerCollapsed);
  });
}
```

- [ ] **Step 4: Wire the hover-reveal logic on the reveal strip.**

Add right below the collapse-button wiring:

```js
/* Hover-reveal: while collapsed, hovering the reveal strip or the
 * (now-revealed) header keeps the chrome visible. Leaving for >300ms
 * collapses it again. The grace period prevents the toolbar from
 * flickering when the cursor briefly exits to click something. */
const HEADER_REVEAL_LEAVE_MS = 300;

function startHeaderReveal() {
  if (!state.headerCollapsed) return;
  if (state.headerRevealTimer) {
    clearTimeout(state.headerRevealTimer);
    state.headerRevealTimer = null;
  }
  state.headerRevealing = true;
  coachEl.dataset.revealing = 'true';
}

function scheduleHeaderRevealEnd() {
  if (!state.headerCollapsed || !state.headerRevealing) return;
  if (state.headerRevealTimer) clearTimeout(state.headerRevealTimer);
  state.headerRevealTimer = setTimeout(() => {
    state.headerRevealing = false;
    coachEl.removeAttribute('data-revealing');
    state.headerRevealTimer = null;
  }, HEADER_REVEAL_LEAVE_MS);
}

if (coachRevealStripEl) {
  coachRevealStripEl.addEventListener('mouseenter', startHeaderReveal);
  coachRevealStripEl.addEventListener('mouseleave', scheduleHeaderRevealEnd);
}

const headerEl = coachEl.querySelector('.coach__header');
if (headerEl) {
  headerEl.addEventListener('mouseenter', startHeaderReveal);
  headerEl.addEventListener('mouseleave', scheduleHeaderRevealEnd);
}
```

- [ ] **Step 5: Wire the keyboard shortcut.**

Find the existing renderer keydown handler around `src/renderer.js:6242-6295`. Add a new branch for `Cmd/Ctrl+Shift+T` before the existing `Enter` branch:

```js
  // Cmd/Ctrl+Shift+T toggles the persisted header-collapse state.
  // Distinct from Cmd/Ctrl+Shift+H (whole-window hide) so users can
  // chord the two independently — show window but hide toolbar, etc.
  if (
    (e.key === 'T' || e.key === 't') &&
    e.shiftKey &&
    (e.metaKey || e.ctrlKey) &&
    !e.altKey
  ) {
    e.preventDefault();
    setHeaderCollapsed(!state.headerCollapsed);
    return;
  }
```

- [ ] **Step 6: Wire the mini window-control buttons.**

Add alongside the existing `minButtonEl` / `closeButtonEl` listeners:

```js
if (coachMiniMinButtonEl) {
  coachMiniMinButtonEl.addEventListener('click', () => {
    window.gemini.window.minimize();
  });
}

if (coachMiniCloseButtonEl) {
  coachMiniCloseButtonEl.addEventListener('click', async () => {
    if (state.status === 'listening' || state.status === 'starting') {
      await stopCapture();
    }
    await window.gemini.window.close();
  });
}
```

These are intentional duplicates of the existing handlers — keep them in sync if either ever changes.

- [ ] **Step 7: Restore persisted state at boot.**

Find the renderer's "apply persisted state at boot" block — there's an existing pattern around the coach-mode restoration at `src/renderer.js:50-60` and pane sizing. Add a corresponding header-state restore call after the renderer has finished defining `setHeaderCollapsed`:

```js
/* Restore persisted header collapse state. Default is uncollapsed +
 * pinned (no auto-collapse) so first-launch users see the full
 * toolbar — discoverability beats minimalism. */
const persistedHeader = loadHeaderState();
state.headerPinned = persistedHeader.pinned;
if (persistedHeader.collapsed) {
  setHeaderCollapsed(true, { persist: false });
}
```

This should run AFTER the initial DOM-ref captures (Task 1 Step 4) and `setHeaderCollapsed` has been defined. A safe place is right after the existing coach-mode restore.

- [ ] **Step 8: Verify end-to-end.**

HMR reloads. Expected:

- Click `∧` in the header → header slides out (220 ms), reveal strip surfaces at top, `aria-expanded` flips to `false`, `aria-label` updates to "Show toolbar", `localStorage 'twf.header.v1'` now reads `{"collapsed":true,"pinned":true,"schemaVersion":1}`.
- Hover the reveal strip → header slides back in (`data-revealing='true'` on `.coach`). Move cursor away → after 300 ms, header slides back out.
- Hover the strip, then move into the header itself (so you're in the now-revealed header), then move away → header collapses again after 300 ms. The strip→header continuity should feel seamless (no flicker).
- Click `∧` again (now showing as `∧` rotated visually because we'll add that in verification, OR still showing as `∧` if we don't rotate — either is fine) → header slides back into permanent visible position, `localStorage` updates.
- `Cmd/Ctrl+Shift+T` toggles the same as the button click.
- Hover the reveal strip while collapsed → mini `—` `×` appear at 85 % opacity. Click `—` → window minimises. Click `×` → app quits.
- Start a recording (Enter or click Start, full toolbar). Collapse the header (∧). Expected: a tiny ghost pill appears on the LEFT of the reveal strip with a pulsing red dot and a ticking `00:00` timer.
- Stop the recording while collapsed → ghost pill disappears.
- Reload the app (Cmd+R or quit-restart) → collapsed state persists across launches.

If any of the above fails, the most common causes are (a) a `null` DOM ref because Task 2's HTML didn't land in the right spot, (b) the `state.headerCollapsed` check inside `setHeaderCollapsed` short-circuiting on the initial restore (fix: call it with `persist: false` for the restore path — which we do), (c) the reveal-strip's `pointer-events: none` from CSS step 1 not flipping to `auto` in collapsed mode (verify the `data-collapsed='true'` selector hits).

- [ ] **Step 9: Commit.**

```bash
git add src/renderer.js
git commit -m "feat(header): wire collapse toggle, hover-reveal, shortcut, ghost pill

setHeaderCollapsed(next, { persist = true }) mutator handles the
data-collapsed attribute, aria-expanded/aria-hidden bookkeeping, the
ghost-pill re-render, and the persistence write.

Hover-reveal: mouseenter on #coachRevealStrip or .coach__header sets
data-revealing='true'. mouseleave schedules a 300ms timeout to clear
it. Re-entry within the grace period cancels the timeout.

Keyboard shortcut: Cm/Ctrl+Shift+T toggles via the same mutator,
distinct from Cmd/Ctrl+Shift+H (whole-window hide).

Mini controls route to the same window:minimize / window:close IPC
channels as the header buttons — intentional duplicate handlers.

Ghost pill renders when state.headerCollapsed && recording. Timer
text mirrors recTimerEl on every tick. Hidden in idle / error.

Boot-time restore loads from 'twf.header.v1', applies via
setHeaderCollapsed(true, { persist: false }) when collapsed=true."
```

---

## Task 5: Accessibility polish — focus management, screen reader announcement, reduce-motion parity

**Goal:** Make the feature feel native to screen-reader users and keyboard-only users. The visual implementation is done; this task tightens the a11y story.

**Files:**

- Modify: `src/renderer.js` (focus moves + sr-only live region)
- Modify: `src/index.css` (focus-visible ring on collapse button, sr-only utility if not already present)

- [ ] **Step 1: Add an sr-only live region for state change announcements.**

In `index.html`, add a screen-reader-only live region as a sibling of `#coachRevealStrip` at the top of `<main id="coach">`:

```html
        <div id="coachHeaderStateLive" class="sr-only" aria-live="polite"
             aria-atomic="true"></div>
```

(Or, if a `.sr-only` utility class doesn't yet exist in `src/index.css`, add it inline as a fallback: `style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);"` — but prefer the class.)

- [ ] **Step 2: Add the `.sr-only` utility class to `src/index.css` if missing.**

Search for `.sr-only` in `src/index.css`. If it's already there, skip this step. If not, add it to the utilities section near the top:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 3: Announce the state change.**

In `src/renderer.js`'s `setHeaderCollapsed()` (added in Task 4 Step 1), append before the `persistHeaderState` call:

```js
  const live = document.getElementById('coachHeaderStateLive');
  if (live) {
    live.textContent = collapsed ? 'Toolbar hidden.' : 'Toolbar shown.';
  }
```

- [ ] **Step 4: Move focus sensibly when collapsing via the collapse button.**

If the collapse button is what flipped the state, the user's focus is on `#headerCollapseBtn` — which is now inside an `aria-hidden` region and translated off-screen. Move focus to a sensible target.

In `setHeaderCollapsed()`, append after the live-region update:

```js
  if (collapsed && document.activeElement === headerCollapseBtnEl) {
    // Collapse via the button → focus moves to the reveal strip so the
    // user can keep tabbing forward into the body. The strip is given
    // a temporary tabindex; cleared in the next state change.
    if (coachRevealStripEl) {
      coachRevealStripEl.setAttribute('tabindex', '-1');
      coachRevealStripEl.focus({ preventScroll: true });
    }
  } else if (!collapsed) {
    coachRevealStripEl?.removeAttribute('tabindex');
    // Returning focus to the collapse button after re-expanding feels
    // natural for keyboard users — they invoked the shortcut, they
    // see the button reappear, focus lands there.
    headerCollapseBtnEl?.focus({ preventScroll: true });
  }
```

- [ ] **Step 5: Add a focus-visible ring to the collapse button (if not already inherited).**

The existing `.coach__icon-btn:focus-visible` rule at `src/index.css:728-731` already covers it. No new CSS needed; just verify in DevTools by tabbing.

- [ ] **Step 6: Verify with VoiceOver / keyboard.**

(macOS) Cmd+F5 to start VoiceOver. Tab into the app. Expected:

- Tab order reaches `#headerCollapseBtn` and announces "Hide toolbar, button, expanded" (or similar based on the user's locale).
- Activate (VO+Space or Enter) → header collapses. The polite live region announces "Toolbar hidden." Focus moves to the reveal strip (which announces nothing additional — it's `aria-hidden="true"` for screen readers).
- Cmd+Shift+T from anywhere → header expands. Live region announces "Toolbar shown." Focus lands on the collapse button (now reading "Show toolbar, button, collapsed" — wait, that's backwards. Re-check: `aria-expanded` should be `true` when expanded. Verify the label matches by hand if VoiceOver phrasing is unclear.)
- Reduce Motion ON → all four header transitions snap (collapse, expand, ghost pill fade, mini controls fade).

- [ ] **Step 7: Commit.**

```bash
git add index.html src/index.css src/renderer.js
git commit -m "feat(a11y): announce header collapse state + move focus sensibly

Adds #coachHeaderStateLive (sr-only, aria-live='polite', atomic) so
VoiceOver / NVDA / Narrator users hear 'Toolbar hidden.' / 'Toolbar
shown.' on every state change.

Adds .sr-only utility class if not already present.

Focus management: collapsing via #headerCollapseBtn moves focus to
the reveal strip (so Tab continues forward into the body). Expanding
returns focus to #headerCollapseBtn so keyboard users see the
expected target.

Existing .coach__icon-btn:focus-visible rule already covers the
collapse button — no new focus-ring CSS needed."
```

---

## Task 6: Optional — surface collapse state to main process (only if a future feature needs it)

**Goal:** Wire a minimal observability hook from renderer → main so future menu-bar items or tray-context-menu entries can show "Show toolbar" / "Hide toolbar" reflecting the current state. This is OPTIONAL — skip if there's no immediate consumer.

**Files:**

- Modify: `src/preload.js` (expose `window.gemini.window.onHeaderStateChange(callback)` or a sender)
- Modify: `src/renderer.js` (fire the IPC on every state change)
- Modify: `src/main.js` (only if a consumer exists — e.g. tray menu item)

Decision criterion: only do this task if you're about to add a tray-menu / native-menu item that reads the state. Otherwise the renderer is the single source of truth and there's no need to leak it across the IPC boundary. **If you skip this task, the rest of the plan is complete.**

- [ ] **Step 1 (only if proceeding): Add the IPC sender to preload.**

In `src/preload.js`, add a method to the existing `window` namespace:

```js
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    quit: () => ipcRenderer.invoke('window:quit'),
    // Renderer informs main of the header-collapse state. Used by the
    // future tray context menu to label its 'Show toolbar' / 'Hide
    // toolbar' item correctly without having to poll the renderer.
    setHeaderCollapsed: (value) =>
      ipcRenderer.send('window:setHeaderCollapsed', Boolean(value)),
  },
```

- [ ] **Step 2: Fire the IPC from `setHeaderCollapsed()`.**

In `src/renderer.js`'s `setHeaderCollapsed()`, append after the persistence call:

```js
  window.gemini?.window?.setHeaderCollapsed?.(collapsed);
```

(The `?.` chain tolerates the case where the preload hasn't been updated yet — useful during the staged rollout.)

- [ ] **Step 3: Add a no-op receiver in main (consumers wire later).**

In `src/main.js`, inside `registerIpcHandlers()`, add:

```js
  // Mirror of the renderer's header-collapse state. Stored only as a
  // module-level variable for future menu / tray consumers. No
  // side-effects today.
  ipcMain.on('window:setHeaderCollapsed', (_event, value) => {
    headerCollapsedInRenderer = Boolean(value);
  });
```

And at module scope alongside the other `let` declarations:

```js
let headerCollapsedInRenderer = false;
```

Future consumers (a tray-menu item, a native-menu accelerator label) read this variable and update themselves.

- [ ] **Step 4: Commit (only if you executed steps 1-3).**

```bash
git add src/preload.js src/renderer.js src/main.js
git commit -m "feat(header): expose collapse state to main for future menu consumers

Adds window.gemini.window.setHeaderCollapsed(boolean) preload sender
and the matching ipcMain.on('window:setHeaderCollapsed') receiver.
Main stores the value in a module-level variable that future tray /
native-menu items can read to label their 'Show toolbar' entry.

No behavioural change today — purely observability scaffolding for
plans that will wire the tray / app menu next."
```

---

## Task 7: Manual test pass

**Goal:** Walk the full feature end-to-end. Catch anything the per-task verification missed.

No source files modified unless a check fails. Each failed check is a follow-up commit on the appropriate file.

- [ ] **Step 1: Discoverability.**

- [ ] Fresh launch (delete `localStorage` for the app, or use a private profile) → header is fully visible. `∧` button is the leftmost child of the controls cluster, with the right tooltip.
- [ ] Tooltip reads "Hide toolbar (⌘⇧T)" on hover.

- [ ] **Step 2: Toggle paths.**

- [ ] Click `∧` → header collapses with a smooth slide animation.
- [ ] Press `Cmd/Ctrl+Shift+T` (with focus anywhere in the app, but not in an `<input>` / `<textarea>`) → header collapses / expands.
- [ ] Persistence: collapse, reload (Cmd+R in DevTools, OR full app quit / restart) → state is restored.
- [ ] First-launch with no localStorage entry → defaults to expanded.

- [ ] **Step 3: Hover-reveal.**

- [ ] While collapsed, hover the top 8 px of the card → header slides back in smoothly. Tiny centred handle indicator visible.
- [ ] Move cursor down into the now-revealed header → stays revealed.
- [ ] Move cursor out of both regions → 300 ms later, header collapses again.
- [ ] Quick mouse-flicker over the strip (in for 100 ms, out for 50 ms, back in) → no flicker; the timer cancels on re-entry.

- [ ] **Step 4: Mini controls.**

- [ ] While collapsed + hovered, mini `—` `×` appear at 85 % opacity at the right edge of the strip.
- [ ] Click mini `—` → window minimises. Reopen via dock / tray.
- [ ] Click mini `×` → app quits (matching the existing header `×` behaviour). Restart to continue testing.
- [ ] Mini buttons are NOT in the tab order (Tab through the app — they're skipped).
- [ ] When the strip is not hovered, mini buttons are invisible AND not clickable (pointer-events `none`).

- [ ] **Step 5: Ghost status pill.**

- [ ] Start a recording with the header expanded → ghost pill is not visible (only matters while collapsed).
- [ ] Collapse the header while recording → ghost pill fades in on the LEFT of the strip, with a pulsing red dot + ticking `00:00` timer.
- [ ] Ghost pill timer matches the header's `#recTimer` to the second.
- [ ] Stop recording while collapsed → ghost pill fades out.
- [ ] Ghost pill never accepts clicks — even hovering it doesn't change the cursor (pointer-events `none`).

- [ ] **Step 6: Drag region.**

- [ ] Collapsed, no hover → drag the 8 px strip → window moves. Drag the body → window does NOT move.
- [ ] Collapsed, hovered (header revealed) → drag the visible header → window moves. Drag the strip → window does NOT move (strip's drag region yields to header's via the `[data-revealing='true']` override).
- [ ] Expanded → drag the header → window moves (existing behaviour, unchanged).
- [ ] All other regions (body, captured pane, drawer) remain non-draggable.

- [ ] **Step 7: A11y.**

- [ ] Reduce Motion ON → all four transitions (header collapse, ghost pill fade, mini controls fade, handle indicator fade) snap. Cmd+Shift+T still works.
- [ ] VoiceOver: tab to `#headerCollapseBtn` → announces "Hide toolbar" / "Show toolbar" with the correct `aria-expanded` state. Activating triggers the polite live region: "Toolbar hidden." / "Toolbar shown."
- [ ] Tab order while collapsed: `#headerCollapseBtn` is inside an `aria-hidden` region — should NOT be tabbable. Tab should jump to the first body element. (The mini buttons are `tabindex="-1"` so they're skipped too.)
- [ ] Tab order while expanded: collapse button is the first tab stop in the controls cluster.

- [ ] **Step 8: Functional regression — nothing else broke.**

- [ ] Start / Stop recording still toggles via Enter or click.
- [ ] Signalled / Automated mode toggle still persists across launches.
- [ ] Settings cog (⚙) still opens the settings modal.
- [ ] Header `—` and `×` (the originals, while expanded) still work.
- [ ] AEC badge / connection pill / version pill / coach mode toggle / Start button / timer all render correctly in expanded mode.
- [ ] Resizing the window from the gutter edges still works (collapsed and expanded).
- [ ] `Cmd/Ctrl+Shift+H` still hides/shows the whole window — unchanged from before.

- [ ] **Step 9: Fix anything broken.**

Each failure gets its own focused commit on the file responsible. No "Final" commit if the test plan passes cleanly — the Task 1-5 (and optionally 6) commits already encode the work. `git status` should be clean.

---

## Final state — what the engineer should hand back

- A new `∧` button appears as the leftmost child of `.coach__controls` in the existing header.
- Clicking it (or pressing Cmd/Ctrl+Shift+T) smoothly slides the entire `.coach__header` out of view, leaving an 8 px reveal strip at the top of the card.
- While collapsed, hovering the strip reveals: (a) the header itself (via a transient `data-revealing` flag, with the persisted preference unchanged), (b) a small centred handle indicator, (c) mini `—` `×` window controls at the right edge.
- While collapsed AND a recording is active, a small red-dotted "ghost pill" with the live timer floats subtly on the left of the strip — purely informational.
- The drag region moves between `.coach__header` (expanded) and `#coachRevealStrip` (collapsed) so the window remains draggable in either mode.
- State persists under `localStorage 'twf.header.v1'` with `{ collapsed, pinned, schemaVersion: 1 }`.
- Reduce-motion / VoiceOver / keyboard navigation all behave correctly.
- No main-process changes; no new IPC channels (unless Task 6's optional observability hook is implemented).
- No window-resize logic — when collapsed, the body claims the freed vertical space.

## Pointers for follow-up work (out of scope here)

- Programmatic window shrink on collapse (new `window:setBounds` IPC + main-process resize logic).
- Auto-collapse during a live recording after N seconds of inactivity (opt-in setting).
- Per-status visual differentiation on the ghost pill (e.g. amber dot during `starting`, red while `error`).
- Tray context-menu "Show toolbar" / "Hide toolbar" entry (consumes Task 6's observability hook).
- Right-click on the collapse button → menu with "Pin toolbar open" / "Auto-hide after 5s of inactivity" options.
- Migrate `'twf.header.v1'` into `'twf.layout.v1'` once enough adjacent layout state accumulates to justify a unified schema (would touch the existing schema's doc-block at `src/renderer.js:326-393`).
