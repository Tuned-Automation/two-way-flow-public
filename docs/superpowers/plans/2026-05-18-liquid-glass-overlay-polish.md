# Liquid Glass Overlay Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a Soft-Frosted Liquid-Glass aesthetic to the existing three-column rubric coach overlay, refactor `src/index.css` into token-driven component CSS files, and add macOS-native polish (vibrancy, accent-color sync, resize, Cmd+Shift+H fade, a11y media queries).

**Architecture:** Vanilla JS + CSS (no framework). Electron's `vibrancy: 'hud'` provides the native NSVisualEffectView material; a Soft Frosted CSS layer tints it. Design tokens (CSS custom properties) drive every color/radius/blur/motion value. Eight small component CSS files replace one monolithic `index.css`. Window becomes resizable (min 580 × 440, default 720 × 580).

**Tech Stack:** Electron 42, Vite 5 (HMR), vanilla JS, CSS custom properties, `@google/genai` (unchanged), macOS only.

**Spec:** `docs/superpowers/specs/2026-05-18-liquid-glass-overlay-polish-design.md` — source of truth for visual details. This plan implements that spec.

---

## Pre-flight

Before starting:

- [ ] **App starts cleanly today.** Run `npm start`. App opens at 720 × 440 with rec controls in a top header. No console errors about missing DOM elements.
- [ ] **You're on macOS.** `vibrancy: 'hud'` doesn't render on Linux/Windows.
- [ ] **You're on a clean working tree** (`git status` shows clean) or OK throwing away in-progress work.
- [ ] **`.env` has `GEMINI_API_KEY`** if you want to exercise recording. Visual styling work doesn't require it — pressing Start without a key will surface an error in the drawer, which is a valid path to test.

Once `npm start` is running, HMR auto-reloads CSS and HTML changes. **Main-process changes** (anything in `src/main.js` or `src/preload.js`) require typing `rs` in the npm-start terminal to restart, or quitting Electron and restarting `npm start`.

---

## File map

```
NEW files (created by this plan):
  src/styles/tokens.css         — :root design tokens
  src/styles/reset.css          — html/body baseline + .sr-only + scrollbars
  src/styles/coach.css          — #coach shell, .coach__body grid, drag region
  src/styles/rail.css           — .rail-column, #rubricSwitcher, #pillarRail, .pillar*
  src/styles/active-pillar.css  — #activePillar, header/body/footer, .checklist, .item, .flag-row, .ticker, .suggestion
  src/styles/captured.css       — #capturedPane, .captured__*
  src/styles/footer.css         — .coach__footer, speakers, timer, recToggle, icon buttons
  src/styles/drawer.css         — #transcriptDrawer, .drawer__*, slide animation

MODIFIED files:
  index.html                    — replace <body> contents per spec §5.1
  src/main.js                   — vibrancy, resize+min dims, accent IPC, Cmd+Shift+H fade
  src/preload.js                — subscribe to system:accent, expose window.system.onAccent
  src/renderer.js               — swap CSS imports, add onAccent listener, fix renderTranscriptDrawer timing

DELETED:
  src/index.css                 — replaced by the eight files above
```

---

## Architecture invariants

These hold across every task. If a step contradicts one of these, stop and re-read the spec.

1. **No hardcoded colors / radii / motion timings in component CSS files.** Every visual value comes from a token in `tokens.css`. The one exception is `box-shadow` and `transition` rgba helpers that the tokens layer can't usefully express.
2. **The renderer's element ids and class names are an immutable contract.** Don't rename `.pillar`, `.item`, `.flag-row__bar`, `#activePillarBody`, etc. — `src/renderer.js` queries / constructs them by exact name.
3. **`#transcriptDrawer` is positioned absolutely over `.coach__body`**, NOT inside it.
4. **Drag region lives on `.coach__footer` only** — body has none so window edges stay clickable for resize.
5. **The HUD stays dark regardless of macOS appearance.** Don't add a `prefers-color-scheme: light` branch.

---

## Task 1: Set up the eight empty CSS files and rewire imports

**Goal:** Get the new file structure in place without changing visual output. Old `index.css` is deleted; renderer imports the eight new (empty) files.

**Files:**

- Create: `src/styles/tokens.css`, `src/styles/reset.css`, `src/styles/coach.css`, `src/styles/rail.css`, `src/styles/active-pillar.css`, `src/styles/captured.css`, `src/styles/footer.css`, `src/styles/drawer.css`
- Modify: `src/renderer.js:1`
- Delete: `src/index.css`

- [ ] **Step 1: Create each of the eight CSS files with a one-line header comment.**

For each new file, the content is just:

```css
/* tokens.css — :root design tokens */
```

Replace the filename per file. The single header gives Vite a non-empty file to ship and lets the engineer find their place at a glance.

- [ ] **Step 2: Update `src/renderer.js:1` to import the eight new files.**

Find this line at the top of `src/renderer.js`:

```js
import './index.css';
```

Replace it with:

```js
import './styles/tokens.css';
import './styles/reset.css';
import './styles/coach.css';
import './styles/rail.css';
import './styles/active-pillar.css';
import './styles/captured.css';
import './styles/footer.css';
import './styles/drawer.css';
```

- [ ] **Step 3: Delete `src/index.css`.**

```bash
rm "src/index.css"
```

- [ ] **Step 4: Verify the app boots without errors.**

Start (or wait for HMR to reload) `npm start`. Expected:

- App launches.
- Renderer console has no "Failed to load module specifier" errors for the new CSS files (Vite ships them empty).
- The overlay is **completely unstyled** — black text on light background, all elements visible as a vertical wireframe. This is correct: we removed all styles but the renderer is still building DOM.

If you see a 404 for any of the eight files, the path is wrong (check `./styles/...` not `/styles/...`).

- [ ] **Step 5: Commit.**

```bash
git add src/styles/ src/renderer.js
git rm src/index.css
git commit -m "refactor(styles): split index.css into 8 empty component files

Adds src/styles/{tokens,reset,coach,rail,active-pillar,captured,footer,drawer}.css
as the new structure. All files contain only header comments; subsequent
commits fill them in.

Renderer imports the new files in source order. index.css is deleted.

App renders unstyled at this commit — intermediate state."
```

---

## Task 2: Fill `tokens.css` with design tokens

**Goal:** Define every CSS custom property the rest of the styles will reference. Self-contained — does not need any other file to work.

**Files:**

- Modify: `src/styles/tokens.css`

- [ ] **Step 1: Replace `src/styles/tokens.css` with the full token definitions.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * tokens.css — design tokens for the Liquid Glass overlay.
 *
 * Every color, radius, blur, and motion value used by component CSS
 * lives here as a CSS custom property. To re-skin the overlay (e.g.
 * add a light mode later), only this file changes.
 *
 * `--system-accent` is set to a neutral fallback here. The main process
 * overrides it at runtime via systemPreferences.getAccentColor() — see
 * src/main.js / src/preload.js / the window.system.onAccent listener in
 * src/renderer.js. The fallback covers the brief window between page
 * load and the IPC firing.
 * ───────────────────────────────────────────────────────────────────── */

:root {
  /* Surfaces */
  --surface-glass-tint: rgba(28, 28, 30, 0.55);
  --surface-solid: rgba(28, 28, 30, 0.95);
  --surface-inset: rgba(255, 255, 255, 0.04);
  --surface-control: rgba(255, 255, 255, 0.10);
  --surface-control-hover: rgba(255, 255, 255, 0.06);

  /* Borders */
  --border-hairline: rgba(255, 255, 255, 0.12);
  --border-inset: rgba(255, 255, 255, 0.07);

  /* Foreground */
  --fg-primary: rgba(255, 255, 255, 0.95);
  --fg-secondary: rgba(255, 255, 255, 0.65);
  --fg-tertiary: rgba(255, 255, 255, 0.35);

  /* Accents (Apple system colors) */
  --accent-active: #34c759;
  --accent-active-fg: #062313;
  --accent-warn: #ff9f0a;
  --accent-danger: #ff453a;

  /* System accent (overridden by main process at runtime) */
  --system-accent: rgba(255, 255, 255, 0.4);

  /* Radii */
  --radius-card: 14px;
  --radius-inner: 10px;
  --radius-control: 6px;
  --radius-pill: 999px;

  /* Material */
  --blur-card: 18px;
  --saturate-card: 180%;

  /* Motion */
  --motion-fast: 120ms;
  --motion-medium: 220ms;
  --motion-pulse: 1400ms;
}

/* When macOS Reduce Transparency is on, swap the glass tint for a
   solid surface and disable backdrop-filter. Component CSS reads
   --surface-glass-tint, so flipping it here propagates everywhere. */
@media (prefers-reduced-transparency: reduce) {
  :root {
    --surface-glass-tint: var(--surface-solid);
    --blur-card: 0px;
    --saturate-card: 100%;
  }
}
```

- [ ] **Step 2: Verify HMR picks up the file.**

Save the file with `npm start` running. The terminal should show `[vite] hmr update /src/styles/tokens.css`. The overlay won't visually change yet (no component CSS uses the tokens), but the file should be valid CSS — open DevTools → Elements → `:root` and confirm the variables are listed.

- [ ] **Step 3: Commit.**

```bash
git add src/styles/tokens.css
git commit -m "feat(styles): add design tokens for liquid glass overlay

Defines surface, border, fg, accent, radius, material, and motion tokens.
Includes a prefers-reduced-transparency override that swaps the glass
tint for the solid surface."
```

---

## Task 3: Fill `reset.css` with baseline and utilities

**Goal:** Set up html/body, drag region behavior, screen-reader-only utility, and scrollbar styling so every scroll container gets a consistent thin scrollbar.

**Files:**

- Modify: `src/styles/reset.css`

- [ ] **Step 1: Replace `src/styles/reset.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * reset.css — html/body baseline + utilities.
 *
 * The drag region is intentionally NOT on body. It lives only on
 * .coach__footer (see footer.css) so window edges stay free for
 * resize. Buttons and interactive elements still opt out below as
 * belt-and-braces.
 * ───────────────────────────────────────────────────────────────────── */

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: transparent; /* lets NSVisualEffectView show through */
  color: var(--fg-primary);
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial,
    sans-serif;
  font-size: 12.5px;
  line-height: 1.4;
  -webkit-user-select: none;
  user-select: none;
  cursor: default;
  overflow: hidden;
}

/* Interactive elements opt out of drag regions so clicks pass through.
   Combined with the footer-only drag region, this is belt-and-braces. */
button,
input,
a,
[data-no-drag],
.no-drag {
  -webkit-app-region: no-drag;
}

/* Visually hidden but accessible to screen readers — used inside icon
   buttons whose visible content is only an SVG. */
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

/* Consistent thin scrollbars for every scroll container in the app.
   Firefox uses scrollbar-width/color; WebKit uses ::-webkit-scrollbar.
   Apply to elements that opt in via `overflow: auto` — selectors below
   target the four scroll containers we actually have. */
#pillarRail,
#activePillarBody,
#capturedPane,
#transcriptDrawer {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}

#pillarRail::-webkit-scrollbar,
#activePillarBody::-webkit-scrollbar,
#capturedPane::-webkit-scrollbar,
#transcriptDrawer::-webkit-scrollbar {
  width: 6px;
}

#pillarRail::-webkit-scrollbar-thumb,
#activePillarBody::-webkit-scrollbar-thumb,
#capturedPane::-webkit-scrollbar-thumb,
#transcriptDrawer::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 3px;
}
```

- [ ] **Step 2: Verify HMR picks up the file.**

App is still mostly unstyled, but the body text should now be white-ish (`--fg-primary`) instead of black. Selecting body text should fail (`user-select: none`). The system cursor should be the arrow even over body text.

- [ ] **Step 3: Commit.**

```bash
git add src/styles/reset.css
git commit -m "feat(styles): add reset.css with html/body baseline + scrollbars

Sets transparent body bg so NSVisualEffectView shows through later.
Removes drag region from body so window edges stay free for resize.
Adds .sr-only utility for icon-button labels.
Adds consistent thin scrollbar styling for the four scroll containers."
```

---

## Task 4: Rewrite `index.html` per spec §5.1

**Goal:** Replace the current HEADER + BODY + FOOTER layout (with rec controls in the header) with the new BODY + FOOTER layout (rec controls in the footer), the three-section active pillar, the rubric switcher above the rail, and inline SVG icons for the speaker mic, transcript, minimize, and close buttons.

The renderer.js doesn't care where elements live in the DOM — it queries by id. The classnames it creates as children also stay the same. So this is purely a markup move.

**Files:**

- Modify: `index.html` (full replacement of `<body>` contents)

- [ ] **Step 1: Replace the contents of `<body>` in `index.html`.**

Open `index.html`. Replace everything between `<body>` and `</body>` (inclusive of all current children but exclusive of the `<script>` tag at the bottom of body) with the markup below. Keep the `<script type="module" src="/src/renderer.js"></script>` line — that one stays.

```html
    <main id="coach" data-status="idle">

      <div class="coach__body">

        <div class="rail-column">
          <button id="rubricSwitcher" class="rubric-switcher" type="button"
                  title="Switch rubric (coming soon)"
                  aria-label="Switch rubric — currently Tuned Automation">
            <span class="rubric-switcher__icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                   stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <rect x="2.5" y="2.5" width="11" height="11" rx="2"/>
                <path d="M2.5 6h11M6 2.5v11"/>
              </svg>
            </span>
            <span class="rubric-switcher__chevron" aria-hidden="true">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
                   stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <path d="M2 3l2 2 2-2"/>
              </svg>
            </span>
          </button>

          <div class="rail-column__divider" aria-hidden="true"></div>

          <div id="pillarRail" role="tablist" aria-label="Rubric pillars"></div>
        </div>

        <section id="activePillar" class="active-pillar"
                 role="tabpanel" aria-label="Active pillar checklist">
          <div id="activePillarHeader" class="active-pillar__header-slot"></div>
          <div id="activePillarBody" class="active-pillar__body" aria-live="polite"></div>
          <div id="activePillarFooter" class="active-pillar__footer">
            <p id="transcriptTicker" class="ticker" aria-live="polite" hidden></p>
            <div id="coachSuggestion" class="suggestion" role="region"
                 aria-label="Suggested next question" hidden></div>
          </div>
        </section>

        <aside id="capturedPane" class="captured" aria-label="Captured fields"></aside>

      </div>

      <footer class="coach__footer">
        <div class="footer__speakers" role="group" aria-label="Speakers">
          <span class="speaker" data-id="you" data-active="false">
            <span class="speaker__mic" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                   stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <rect x="6" y="2" width="4" height="8" rx="2"/>
                <path d="M3.5 8a4.5 4.5 0 009 0M8 12.5v2"/>
              </svg>
            </span>
            <span class="speaker__name">You</span>
          </span>
          <span class="speaker" data-id="other" data-active="false">
            <span class="speaker__mic" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                   stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <rect x="6" y="2" width="4" height="8" rx="2"/>
                <path d="M3.5 8a4.5 4.5 0 009 0M8 12.5v2"/>
              </svg>
            </span>
            <span class="speaker__name">Other</span>
          </span>
        </div>

        <div class="footer__timer-wrap">
          <span id="recIndicator" aria-hidden="true"></span>
          <span id="recTimer">00:00</span>
        </div>

        <button id="recToggle" type="button" class="rec-toggle"
                aria-label="Start recording" title="Start / stop (Enter)">Start</button>

        <div class="footer__icons">
          <button id="transcriptToggle" class="icon-btn" type="button"
                  aria-label="Show transcript" aria-expanded="false"
                  aria-controls="transcriptDrawer">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"
                 stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M3 4h10M3 8h10M3 12h6"/>
            </svg>
            <span class="sr-only">Show transcript</span>
          </button>
          <button id="minButton" class="icon-btn" type="button"
                  aria-label="Minimize" title="Minimize">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"
                 stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M4 8h8"/>
            </svg>
          </button>
          <button id="closeButton" class="icon-btn" type="button"
                  aria-label="Close" title="Close (⌘W)">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"
                 stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
      </footer>

      <section id="transcriptDrawer" class="drawer" hidden aria-label="Live transcript">
        <div id="transcriptList" class="drawer__list" hidden></div>
        <p id="transcriptPending" class="drawer__pending" hidden></p>
        <p id="transcriptError" class="drawer__error" hidden role="alert"></p>
      </section>
    </main>
    <script type="module" src="/src/renderer.js"></script>
```

- [ ] **Step 2: Verify the app boots and the renderer still finds every element.**

HMR will reload. Open DevTools console. Expected:

- **No "Cannot read properties of null" errors** from `renderer.js`. The renderer queries 18+ ids; any missing one breaks at startup.
- 14 pillar buttons appear in the rail (as unstyled `<button>` elements stacked vertically).
- The captured pane renders the 6 groups with empty values (em-dashes).
- Active pillar shows the live_signals title and "No flags yet. Keep going…" empty state.
- Footer renders speakers, timer (00:00), Start button, and three icon buttons.

Visual layout will look BROKEN (no CSS yet) — that's expected. We're verifying the **renderer contract** holds.

If anything errors, the most likely cause is a missing id. Compare your HTML against the spec §5.1 element-by-element.

- [ ] **Step 3: Commit.**

```bash
git add index.html
git commit -m "feat(html): rewrite index.html for new three-column coach layout

Removes the top header (rec/speakers/recToggle/min/close) and moves
those into the bottom footer.

Adds a #rubricSwitcher button + hairline divider above #pillarRail
inside a new .rail-column wrapper (the renderer's replaceChildren
on #pillarRail would otherwise wipe out the switcher).

Adds .rec-toggle class to #recToggle (was .coach__rec-toggle) and
.icon-btn (was .coach__icon-btn) to the three icon buttons.

Replaces emoji glyphs (×, —, ▤) with inline SVGs for crisp scaling.

Active pillar still uses #activePillarHeader / #activePillarBody /
#activePillarFooter; #transcriptTicker and #coachSuggestion remain
hidden by default. Transcript drawer is a sibling of .coach__body /
.coach__footer for absolute-position overlay."
```

---

## Task 5: Update `main.js` for new window dimensions + vibrancy + resize

**Goal:** Resize the window to 720 × 580, add minimum dimensions (580 × 440), enable resize, switch from `transparent: true` to vibrancy-based dark glass material.

**Files:**

- Modify: `src/main.js:19-22, 79-94`

- [ ] **Step 1: Update the window-dimension constants in `src/main.js`.**

Find this block near the top (line 19-21 currently):

```js
const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 440;
const EDGE_MARGIN = 20;
```

Replace with:

```js
const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 580;
const MIN_WIDTH = 580;
const MIN_HEIGHT = 440;
const EDGE_MARGIN = 20;
```

- [ ] **Step 2: Update the `BrowserWindow` options inside `createWindow()`.**

Find this block (line 79-94 currently):

```js
  const mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
```

Replace with:

```js
  const mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x,
    y,
    frame: false,
    transparent: false,                // vibrancy is incompatible with transparent
    vibrancy: 'hud',                   // NSVisualEffectView dark HUD material
    visualEffectState: 'active',       // keep vibrancy when window loses focus
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
```

Note: the `backgroundColor: '#00000000'` line is removed — vibrancy provides the background.

- [ ] **Step 3: Restart the main process.**

Type `rs` in the terminal running `npm start`, or kill it and rerun `npm start`. (HMR doesn't apply to main-process code.)

- [ ] **Step 4: Verify the new window appearance.**

Expected:

- Window opens at 720 × 580 (slightly taller than before), top-right of the screen.
- Window has a dark, vibrant translucent background. If you drag a Finder window or Safari behind the overlay, you should see its content **blur through** the vibrant material — this is `NSVisualEffectView` at work. The effect is subtle without a CSS tint layer on top (Task 6 adds it).
- You can **drag the edges** to resize, and the cursor changes to the appropriate resize cursor at edges/corners.
- You cannot shrink below 580 × 440.

If vibrancy doesn't render (window is opaque black), confirm you removed `transparent: true` and `backgroundColor: '#00000000'`. Both override vibrancy.

- [ ] **Step 5: Commit.**

```bash
git add src/main.js
git commit -m "feat(electron): enable vibrancy + resize on main window

Window: 720x580 default (was 720x440), 580x440 min, resizable.
Switches transparent:true + backgroundColor:#00000000 to vibrancy:'hud'
+ visualEffectState:'active' for native NSVisualEffectView material
that stays vibrant when the window loses focus.

Drops backgroundColor entirely — vibrancy provides the surface."
```

---

## Task 6: Fill `coach.css` with shell, body grid, and drag region

**Goal:** The Soft Frosted CSS layer on top of the native vibrancy. Three-column body grid. Drag region on the footer.

**Files:**

- Modify: `src/styles/coach.css`

- [ ] **Step 1: Replace `src/styles/coach.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * coach.css — window shell and body grid.
 *
 * `#coach` sits on top of the native NSVisualEffectView (enabled in
 * src/main.js via vibrancy:'hud'). The CSS layer tints the vibrant
 * material to "Soft Frosted" with var(--surface-glass-tint) and adds
 * the inset glass-edge hairline.
 *
 * Body grid: 52px rail | flex middle | 240-320 right.
 * Footer: 52px tall, holds rec controls. Drag region lives here.
 * ───────────────────────────────────────────────────────────────────── */

#coach {
  position: relative;
  display: grid;
  grid-template-rows: 1fr 52px;
  height: 100vh;
  background: var(--surface-glass-tint);
  backdrop-filter: blur(var(--blur-card)) saturate(var(--saturate-card));
  -webkit-backdrop-filter: blur(var(--blur-card)) saturate(var(--saturate-card));
  border-radius: var(--radius-card);
  border: 1px solid var(--border-hairline);
  box-shadow:
    0 8px 28px rgba(0, 0, 0, 0.35),
    inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.coach__body {
  display: grid;
  grid-template-columns: 52px minmax(280px, 1fr) minmax(240px, 320px);
  min-height: 0;
  position: relative;
}

.coach__footer {
  -webkit-app-region: drag;            /* drag region lives ONLY here */
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 0 12px;
  border-top: 1px solid var(--border-inset);
  background: rgba(0, 0, 0, 0.15);
}

/* Belt-and-braces opt-out for footer children that need to receive clicks. */
.coach__footer > * {
  -webkit-app-region: no-drag;
}
```

- [ ] **Step 2: Verify the new appearance.**

HMR reloads. Expected:

- Window now reads as a **dark, slightly translucent frosted card** with rounded 14px corners and a faint white hairline border.
- Drag windows behind the overlay → content blurs through visibly.
- Body region splits into three columns: thin left, wide middle, medium right. Children are still unstyled but you can see the grid taking effect.
- Footer is at the bottom, 52 px tall, slightly darker tint.
- Drag the footer with the mouse → window moves. Drag the body → window does NOT move (no drag region there).
- Drag a window edge → window resizes.

- [ ] **Step 3: Commit.**

```bash
git add src/styles/coach.css
git commit -m "feat(styles): apply Soft Frosted glass shell to #coach

Body grid: 52px rail / minmax(280px,1fr) middle / minmax(240px,320px) right.
Footer grid: auto 1fr auto auto (speakers / timer / recToggle / icons).

Drag region lives only on .coach__footer. The body has no drag region
so window edges stay free for resize. Footer children opt out via
.coach__footer > * { -webkit-app-region: no-drag; }."
```

---

## Task 7: Fill `rail.css` with rubric switcher + divider + pillar buttons

**Files:**

- Modify: `src/styles/rail.css`

- [ ] **Step 1: Replace `src/styles/rail.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * rail.css — left column.
 *
 * .rail-column is the 52px flex container that holds:
 *   1. #rubricSwitcher  (28px tall pill, top)
 *   2. .rail-column__divider  (1px hairline)
 *   3. #pillarRail  (fills remaining height, scrolls)
 *
 * The renderer's `railEl.replaceChildren(...)` only wipes #pillarRail
 * — the switcher and divider are safe outside.
 * ───────────────────────────────────────────────────────────────────── */

.rail-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border-inset);
  padding: 8px 0 0;
}

.rubric-switcher {
  -webkit-app-region: no-drag;
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 4px;
  padding: 4px 6px;
  height: 28px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--fg-tertiary);
  cursor: pointer;
  transition: background var(--motion-fast) ease, color var(--motion-fast) ease;
}

.rubric-switcher:hover {
  background: var(--surface-control-hover);
  color: var(--fg-secondary);
}

.rubric-switcher__icon,
.rubric-switcher__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.rail-column__divider {
  height: 1px;
  margin: 6px 6px;
  background: var(--border-inset);
}

#pillarRail {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 6px 10px;
  overflow-y: auto;
}

.pillar {
  -webkit-app-region: no-drag;
  position: relative;
  appearance: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 36px;
  margin: 0 auto;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--fg-secondary);
  cursor: pointer;
  transition: background var(--motion-fast) ease, color var(--motion-fast) ease;
}

.pillar:hover {
  background: var(--surface-control-hover);
  color: var(--fg-primary);
}

.pillar[data-selected='true'] {
  background: var(--surface-control);
  color: var(--fg-primary);
}

/* Selected pillar accent bar — sits in the column-edge gutter. */
.pillar[data-selected='true']::before {
  content: '';
  position: absolute;
  left: -7px;
  top: 8px;
  bottom: 8px;
  width: 2.5px;
  background: var(--accent-active);
  border-radius: 999px;
}

.pillar__glyph {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
}

.pillar__dot {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}

.pillar[data-status='in_progress'] .pillar__dot {
  background: var(--accent-warn);
}

.pillar[data-status='complete'] .pillar__dot {
  background: var(--accent-active);
}

/* Focus ring uses the macOS user's accent color (synced via IPC). */
.rubric-switcher:focus-visible,
.pillar:focus-visible {
  outline: 2px solid var(--system-accent);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Verify the rail renders correctly.**

HMR reloads. Expected:

- Top of the left column: small rubric switcher pill with grid icon + chevron, dim tertiary fg color. Hover lightens it.
- Below: thin horizontal hairline.
- Below: 14 vertical pillar buttons. Each is 40 × 36 with a centered single-character glyph.
- The selected pillar (default `live_signals`) has a slight background tint AND a green 2.5 px vertical bar in the column-edge gutter to its left.
- Right edge of the column has a hairline border.
- Hover a non-selected pillar → background lightens.
- Click a different pillar → selection moves (active pillar pane should update too, but since active pillar isn't styled yet, you'll see the unstyled DOM swap).

- [ ] **Step 3: Commit.**

```bash
git add src/styles/rail.css
git commit -m "feat(styles): style the left rail column

.rail-column wraps the rubric switcher, divider, and #pillarRail in a
flex column. Right edge gets a hairline border.

.rubric-switcher is a 28px-tall pill with hover treatment.

.pillar buttons are 40x36 with centered glyph, hover lightens bg,
[data-selected='true'] adds a 2.5px green accent bar in the gutter
via ::before.

.pillar__dot status indicator uses --accent-warn (in_progress) and
--accent-active (complete)."
```

---

## Task 8: Fill `active-pillar.css` with header / body / footer + ticker + suggestion + checklist + flag rows

**Goal:** This is the biggest CSS file. It styles the entire middle column: pinned header (pillar title + counter), scrolling body (checklist or flag rows), pinned footer (ticker + "Ask next" card).

**Files:**

- Modify: `src/styles/active-pillar.css`

- [ ] **Step 1: Replace `src/styles/active-pillar.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * active-pillar.css — center column.
 *
 * Three vertical rows: pinned header, scrolling body, pinned footer.
 * The renderer fills the header and body on every renderActivePillar()
 * call; the footer's children (#transcriptTicker, #coachSuggestion)
 * are statically present in HTML and individually toggle their own
 * `hidden` attribute.
 *
 * Two body modes:
 *   Regular pillar:  <ul.checklist><li.item[data-covered]>
 *   live_signals:    <div.checklist><div.flag-row[data-severity]>
 * Both use class .checklist so the body's vertical rhythm is consistent.
 * ───────────────────────────────────────────────────────────────────── */

#activePillar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.active-pillar__header-slot {
  padding: 12px 16px 4px;
}

.active-pillar__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.active-pillar__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.1px;
  color: var(--fg-primary);
}

.active-pillar__counter {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--fg-tertiary);
  background: var(--surface-inset);
  border-radius: var(--radius-pill);
}

.active-pillar__body {
  -webkit-user-select: text;
  user-select: text;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 16px 10px;
}

.active-pillar__empty {
  margin: 0;
  font-size: 12px;
  font-style: italic;
  color: var(--fg-tertiary);
}

/* ─── Footer slot (ticker + suggestion) ─────────────────────────────── */

.active-pillar__footer {
  -webkit-user-select: text;
  user-select: text;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 16px 10px;
  border-top: 1px solid var(--border-inset);
  background: rgba(255, 255, 255, 0.02);
}

/* When both children are hidden, collapse the chrome so we don't leave
   a dead band at the bottom of the column. */
.active-pillar__footer:not(:has(> :not([hidden]))) {
  border-top-color: transparent;
  background: transparent;
  padding: 0;
}

/* Single-line live transcript ticker — RTL trick keeps newest chars
   visible on overflow; inner span flips back to LTR for reading. */
.ticker {
  margin: 0;
  font-size: 11px;
  color: var(--fg-tertiary);
  font-style: italic;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
}

.ticker > span {
  direction: ltr;
  unicode-bidi: bidi-override;
}

/* "Ask next" coach suggestion card. */
.suggestion {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  background: var(--surface-inset);
  border: 1px solid var(--border-inset);
  border-radius: var(--radius-inner);
}

.suggestion__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-tertiary);
}

.suggestion__pillar {
  color: var(--fg-secondary);
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

.suggestion__question {
  margin: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg-primary);
  line-height: 1.4;
}

.suggestion__rationale {
  font-size: 10.5px;
  color: var(--fg-tertiary);
  line-height: 1.4;
}

/* ─── Checklist (regular pillar) ────────────────────────────────────── */

.checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 8px;
  align-items: center;
  padding: 7px 8px;
  border-radius: var(--radius-control);
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--fg-secondary);
  transition:
    color var(--motion-fast) ease,
    background var(--motion-fast) ease;
}

.item__tick {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--fg-tertiary);
  border-radius: 50%;
  font-size: 9px;
  font-weight: 800;
  color: transparent;
  transition:
    background-color var(--motion-fast) ease,
    border-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}

.item__label {
  white-space: normal;
}

.item[data-covered='true'] {
  color: var(--fg-primary);
}

.item[data-covered='true'] .item__tick {
  background: var(--accent-active);
  border-color: var(--accent-active);
  color: #fff;
}

/* ─── Flag rows (live_signals pillar) ───────────────────────────────── */

.flag-row {
  display: grid;
  grid-template-columns: 3px 1fr;
  gap: 8px;
  padding: 8px 10px 8px 0;
  background: var(--surface-inset);
  border-radius: var(--radius-inner);
}

.flag-row__bar {
  border-radius: 999px;
  background: var(--fg-tertiary);
}

.flag-row[data-severity='red'] .flag-row__bar {
  background: var(--accent-danger);
}

.flag-row[data-severity='green'] .flag-row__bar {
  background: var(--accent-active);
}

.flag-row__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.flag-row__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg-primary);
}

.flag-row__kind {
  padding: 1px 5px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: var(--radius-control);
}

.flag-row[data-severity='red'] .flag-row__kind {
  color: #ff7a72;
  background: rgba(255, 69, 58, 0.18);
}

.flag-row[data-severity='green'] .flag-row__kind {
  color: #6cdc8c;
  background: rgba(52, 199, 89, 0.18);
}

.flag-row__evidence {
  font-size: 11.5px;
  font-style: italic;
  color: var(--fg-secondary);
  line-height: 1.4;
}
```

- [ ] **Step 2: Verify the active pillar pane renders correctly.**

HMR reloads. Expected (default selected pillar is `live_signals`):

- Active pillar header shows "Live Signals" title + small pill counter on the right showing "0 fired".
- Body shows empty state: italic tertiary text "No flags yet. Keep going — the coach is listening."
- Footer slot is collapsed (no border-top visible) because `transcriptTicker` and `coachSuggestion` are both hidden.

Click any other pillar (e.g., the discovery one). Expected:

- Header updates to the pillar name + "0 of N" counter.
- Body shows the checklist of items, each with an outlined circle tick and secondary fg text.

To verify the covered state without recording, edit `src/renderer.js` temporarily to seed a covered item, OR start a recording and let the AI cover one. (Optional — visual styling is verifiable by reading the CSS.)

- [ ] **Step 3: Commit.**

```bash
git add src/styles/active-pillar.css
git commit -m "feat(styles): style the active pillar column

Three-row flex layout: pinned header, scrolling body, pinned footer.

Header: large title + small pill counter (tabular numerals).
Body: checklist of .item (regular pillar) OR .flag-row (live_signals).
Footer: .ticker (RTL trick for newest-chars-visible overflow) and
.suggestion card (Ask next pattern with pillar context + rationale).

.item__tick animates from outlined circle (uncovered) to filled green
circle with white check (covered) over --motion-fast.

.flag-row uses a 3px left-edge bar in --accent-danger or --accent-active
based on [data-severity]. .flag-row__kind badge uses tinted bg per
severity (red rgba(255,69,58,0.18) / green rgba(52,199,89,0.18)).

.active-pillar__footer collapses chrome via :not(:has(> :not([hidden])))
when both ticker and suggestion are hidden."
```

---

## Task 9: Fill `captured.css`

**Files:**

- Modify: `src/styles/captured.css`

- [ ] **Step 1: Replace `src/styles/captured.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * captured.css — right column.
 *
 * Renders 6 captured-field groups vertically. Each group has a small
 * uppercase heading and a list of label/value pairs separated by
 * hairline dividers. Empty values show an em-dash in tertiary fg.
 * ───────────────────────────────────────────────────────────────────── */

#capturedPane {
  -webkit-user-select: text;
  user-select: text;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px;
  min-width: 0;
  border-left: 1px solid var(--border-inset);
  overflow-y: auto;
}

.captured__group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.captured__heading {
  margin: 0 0 2px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-tertiary);
}

.captured__pair {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-inset);
}

.captured__pair:last-child {
  border-bottom: 0;
}

.captured__label {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--fg-secondary);
}

.captured__value {
  flex: 0 1 auto;
  max-width: 60%;
  text-align: right;
  overflow-wrap: anywhere;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-primary);
}

.captured__value--empty {
  color: var(--fg-tertiary);
  font-weight: 400;
}
```

- [ ] **Step 2: Verify the captured pane renders correctly.**

Expected:

- Right column has a hairline left border separating it from the active pillar.
- Six groups stack vertically with 12 px gap between them.
- Each group: small uppercase heading + 1-3 label/value pairs.
- Label is left-aligned (secondary fg), value is right-aligned (primary fg) or em-dash if empty (tertiary fg).
- Hairline dividers between pairs within a group.

- [ ] **Step 3: Commit.**

```bash
git add src/styles/captured.css
git commit -m "feat(styles): style the captured pane

Flex column with 6 groups. Each pair: label (secondary, left) +
value (primary, right). Hairline divider between pairs, dropped on
last child. Empty values use --captured__value--empty (tertiary fg)."
```

---

## Task 10: Fill `footer.css` with speakers, timer, recToggle, icon buttons, and status states

**Files:**

- Modify: `src/styles/footer.css`

- [ ] **Step 1: Replace `src/styles/footer.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * footer.css — bottom footer with all the rec controls.
 *
 * The footer is the drag region (set in coach.css). Children opt out
 * with -webkit-app-region: no-drag (applied broadly via coach.css's
 * .coach__footer > * { no-drag } selector, then specifically here
 * for belt-and-braces).
 *
 * Visual states driven by #coach[data-status]:
 *   idle      — neutral recToggle, indicator tertiary, no animation
 *   starting  — recToggle dimmed, indicator amber
 *   listening — green recToggle ("Stop"), indicator green + pulsing
 *   error     — recToggle danger-tinted, indicator red
 * ───────────────────────────────────────────────────────────────────── */

.footer__speakers {
  display: flex;
  gap: 6px;
}

.speaker {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--fg-tertiary);
  background: var(--surface-inset);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  transition:
    background var(--motion-fast) ease,
    color var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}

.speaker[data-active='true'] {
  background: rgba(52, 199, 89, 0.15);
  color: var(--accent-active);
  border-color: rgba(52, 199, 89, 0.35);
}

.speaker__mic {
  display: inline-flex;
  opacity: 0.85;
}

.footer__timer-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-self: center;
}

#recIndicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-tertiary);
  transition:
    background var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease;
}

#recTimer {
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--fg-secondary);
}

.rec-toggle {
  -webkit-app-region: no-drag;
  appearance: none;
  padding: 5px 14px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-primary);
  background: var(--surface-control);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition:
    background var(--motion-fast) ease,
    color var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}

.rec-toggle:hover {
  background: rgba(255, 255, 255, 0.14);
}

/* ─── Status states ─────────────────────────────────────────────────── */

#coach[data-status='listening'] #recIndicator {
  background: var(--accent-active);
  box-shadow: 0 0 6px rgba(52, 199, 89, 0.85);
}

#coach[data-status='listening'] .rec-toggle {
  background: var(--accent-active);
  color: var(--accent-active-fg);
  border-color: transparent;
}

#coach[data-status='listening'] .rec-toggle:hover {
  background: #2bb24f;       /* slight darken of --accent-active */
}

#coach[data-status='starting'] #recIndicator {
  background: var(--accent-warn);
  box-shadow: 0 0 4px rgba(255, 159, 10, 0.6);
}

#coach[data-status='starting'] .rec-toggle {
  color: var(--fg-secondary);
  cursor: progress;
}

#coach[data-status='error'] #recIndicator {
  background: var(--accent-danger);
  box-shadow: 0 0 4px rgba(255, 69, 58, 0.6);
}

#coach[data-status='error'] .rec-toggle {
  background: rgba(255, 69, 58, 0.12);
  border-color: rgba(255, 69, 58, 0.35);
  color: var(--accent-danger);
}

/* Listening pulse on the rec indicator. */
@media (prefers-reduced-motion: no-preference) {
  #coach[data-status='listening'] #recIndicator {
    animation: rec-pulse var(--motion-pulse) ease-in-out infinite;
  }
}

@keyframes rec-pulse {
  0%, 100% { transform: scale(0.92); opacity: 0.75; }
  50%      { transform: scale(1.08); opacity: 1; }
}

/* ─── Icon buttons (transcript / minimize / close) ──────────────────── */

.footer__icons {
  display: flex;
  gap: 4px;
}

.icon-btn {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--fg-tertiary);
  cursor: pointer;
  transition:
    background var(--motion-fast) ease,
    color var(--motion-fast) ease;
}

.icon-btn:hover {
  background: var(--surface-control-hover);
  color: var(--fg-primary);
}

/* Focus ring uses the macOS user's accent color. */
.icon-btn:focus-visible,
.rec-toggle:focus-visible,
.speaker:focus-visible {
  outline: 2px solid var(--system-accent);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Verify the footer renders correctly.**

Expected:

- Footer holds (left to right): two speaker pills (muted gray), timer pill with a tertiary dot + 00:00 monospace, large "Start" pill button, three small icon buttons (transcript / minimize / close).
- Hovering an icon button gives it a subtle bg fill.
- Hovering "Start" button lightens it slightly.

Press **Enter** (or click Start) to begin recording. Expected:

- Status flips to listening: rec indicator becomes green + pulsing (visible 1.4 s breathing animation), Start button becomes green with dark text "Stop", "You" speaker pill tints green when you speak.

Press **Enter** again to stop. Status returns to idle.

If you don't have a GEMINI_API_KEY, the transition will go idle → starting → error, surfacing an error message via the drawer (covered by Task 11). The states themselves still work — observe the colors.

- [ ] **Step 3: Commit.**

```bash
git add src/styles/footer.css
git commit -m "feat(styles): style the bottom footer rec controls

Speakers: muted gray pills, active state tints green.
Timer: tabular numerals + 7px dot indicator (driven by [data-status]).
recToggle: pill button. Idle = neutral, listening = green w/ dark fg,
starting = dimmed w/ progress cursor, error = danger-tinted.

Icon buttons: 26x26 ghost buttons with hover bg + fg lift.

Rec indicator pulses (scale 0.92<->1.08, opacity 0.75<->1, 1.4s) when
status='listening', gated on prefers-reduced-motion."
```

---

## Task 11: Fill `drawer.css` and update `renderer.js` for the drawer animation timing

**Goal:** Style the transcript drawer that overlays the body when toggled. Update `renderTranscriptDrawer()` in the renderer to flip `hidden` and `.open` class in the right order so the slide-up animation works.

**Files:**

- Modify: `src/styles/drawer.css`
- Modify: `src/renderer.js:448-484`

- [ ] **Step 1: Replace `src/styles/drawer.css` with the full content.**

```css
/* ─────────────────────────────────────────────────────────────────────
 * drawer.css — live transcript drawer.
 *
 * Positioned absolutely over .coach__body. The renderer toggles
 * [hidden] for screen readers and the .open class for the animation.
 * See renderer.js renderTranscriptDrawer() for the open/close ordering
 * that makes the slide-up animation work cleanly.
 *
 * Surface is --surface-solid because backdrop-filter doesn't stack
 * — we want a distinct opaque surface that visually replaces the body
 * (which is set to visibility: hidden by the renderer while the
 * drawer is open).
 * ───────────────────────────────────────────────────────────────────── */

#transcriptDrawer {
  -webkit-app-region: no-drag;
  -webkit-user-select: text;
  user-select: text;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 52px;             /* sits above the footer */
  padding: 14px 16px;
  background: var(--surface-solid);
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--fg-primary);
  transform: translateY(8px);
  opacity: 0;
  pointer-events: none;
}

#transcriptDrawer.open {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: no-preference) {
  #transcriptDrawer {
    transition:
      transform var(--motion-medium) ease-out,
      opacity var(--motion-medium) ease-out;
  }
}

.drawer__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drawer__line {
  margin: 0;
  color: var(--fg-primary);
}

.drawer__pending {
  margin: 8px 0 0;
  font-style: italic;
  color: var(--fg-secondary);
}

.drawer__list:not([hidden]) + .drawer__pending:not([hidden]) {
  padding-top: 8px;
  border-top: 1px solid var(--border-inset);
}

.drawer__error {
  margin: 0;
  padding: 8px 10px;
  background: rgba(255, 69, 58, 0.08);
  border-left: 2px solid var(--accent-danger);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  color: var(--accent-danger);
  font-weight: 500;
}
```

- [ ] **Step 2: Update `renderTranscriptDrawer()` in `src/renderer.js` to handle the open/close timing.**

Find this block in `src/renderer.js` (currently around line 448-484):

```js
function renderTranscriptDrawer() {
  // Visibility of the drawer container.
  transcriptDrawerEl.hidden = !state.transcriptOpen;
  transcriptToggleEl.setAttribute('aria-expanded', String(state.transcriptOpen));
  const labelSpan = transcriptToggleEl.querySelector('span:last-child');
  if (labelSpan) {
    labelSpan.textContent = state.transcriptOpen ? 'Hide transcript' : 'Show transcript';
  }

  if (!state.transcriptOpen) return;
```

Replace the single-line `transcriptDrawerEl.hidden = !state.transcriptOpen;` (and only that line) with the open/close ordering block. The full surrounding function becomes:

```js
function renderTranscriptDrawer() {
  // Drawer visibility — hidden controls screen-reader access, .open class
  // controls the slide-up animation. Order matters: on open, clear
  // [hidden] first then add .open on the next frame so the transition
  // has an initial state to animate from. On close, remove .open first
  // so the element animates out, then set [hidden] after the animation
  // finishes. Re-open during close is guarded by checking transcriptOpen
  // inside the timeout callback.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ANIM_MS = 220;

  if (state.transcriptOpen) {
    transcriptDrawerEl.hidden = false;
    if (reduceMotion) {
      transcriptDrawerEl.classList.add('open');
    } else {
      requestAnimationFrame(() => transcriptDrawerEl.classList.add('open'));
    }
  } else {
    transcriptDrawerEl.classList.remove('open');
    if (reduceMotion) {
      transcriptDrawerEl.hidden = true;
    } else {
      setTimeout(() => {
        if (!state.transcriptOpen) transcriptDrawerEl.hidden = true;
      }, ANIM_MS);
    }
  }

  transcriptToggleEl.setAttribute('aria-expanded', String(state.transcriptOpen));
  const labelSpan = transcriptToggleEl.querySelector('span:last-child');
  if (labelSpan) {
    labelSpan.textContent = state.transcriptOpen ? 'Hide transcript' : 'Show transcript';
  }

  if (!state.transcriptOpen) return;
```

Leave the rest of `renderTranscriptDrawer()` (everything from `if (state.errorMessage) {` to the trailing `}` of the function) untouched.

- [ ] **Step 3: Verify the drawer opens and closes smoothly.**

HMR reloads. Click the transcript icon button (lines icon) in the footer. Expected:

- Drawer slides up from 8 px below + fades in over 220 ms.
- Drawer is a solid dark panel covering the body (you can't see the rail / active pillar / captured).
- Footer dims to 50% opacity (this is done by the renderer's existing `footerEl.style.opacity = '0.5'` line).
- Drawer shows "Show transcript" → "Hide transcript" on the button label.

Click again. Expected:

- Drawer fades out + slides down over 220 ms.
- Body becomes visible again, footer returns to full opacity.

Verify quick toggling (click open, click close immediately): no flash, no stuck-open state.

- [ ] **Step 4: Commit.**

```bash
git add src/styles/drawer.css src/renderer.js
git commit -m "feat(transcript): slide-up animation for the transcript drawer

CSS: drawer starts at translateY(8px) opacity:0; .open class flips it to
translateY(0) opacity:1 over --motion-medium ease-out. Background is
--surface-solid because backdrop-filter doesn't stack.

Renderer renderTranscriptDrawer() updated: on open, clears [hidden]
then RAFs the .open class so transition has an initial state. On close,
removes .open then setTimeout(220ms) to set [hidden]. Reduce-motion
skips both timing steps. Re-open during close is guarded by checking
state.transcriptOpen inside the timeout callback."
```

---

## Task 12: Wire up macOS system accent color sync

**Goal:** Mirror the user's macOS accent color (System Settings → Appearance → Accent color) into `--system-accent` via IPC so focus rings match the user's preference.

**Files:**

- Modify: `src/main.js` (add accent sender + listener)
- Modify: `src/preload.js` (expose `window.system.onAccent`)
- Modify: `src/renderer.js` (subscribe to `onAccent` and write the CSS variable)

- [ ] **Step 1: Add the accent sender in `src/main.js`.**

Find the `createWindow()` function in `src/main.js`. After the line `mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });` (currently around line 97), add this block before the dev/prod URL branch:

```js
  // Mirror the macOS user's accent color into the renderer as
  // --system-accent. Re-fires whenever the user changes the accent
  // in System Settings → Appearance.
  const sendAccent = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const raw = systemPreferences.getAccentColor() || '';
    if (!raw) return;
    mainWindow.webContents.send('system:accent', `#${raw}`);
  };

  mainWindow.webContents.on('did-finish-load', sendAccent);

  const onAccentChanged = () => sendAccent();
  systemPreferences.on('accent-color-changed', onAccentChanged);
  mainWindow.on('closed', () => {
    systemPreferences.removeListener('accent-color-changed', onAccentChanged);
  });
```

`systemPreferences` is already imported at the top of the file. The unused-import warning we've been getting goes away once this lands.

- [ ] **Step 2: Expose the listener through `src/preload.js`.**

Find the `contextBridge.exposeInMainWorld('gemini', { ... })` block in `src/preload.js`. After it, add a new bridge:

```js
contextBridge.exposeInMainWorld('system', {
  onAccent: subscribe('system:accent'),
});
```

The `subscribe()` helper is already defined at the top of preload.js — reuse it.

- [ ] **Step 3: Add the listener in `src/renderer.js`.**

Find the block of `window.gemini.on*` subscriptions near the bottom of `src/renderer.js` (around line 761). Add this right after the last `window.gemini.on*` line and before the `/* ── User input ─────` comment:

```js
window.system.onAccent((hex) => {
  if (typeof hex !== 'string') return;
  document.documentElement.style.setProperty('--system-accent', hex);
});
```

- [ ] **Step 4: Restart the main process and verify.**

Type `rs` in the npm-start terminal (main.js + preload.js changes require restart).

Once restarted:

- Open DevTools → Elements → click on `<html>` → Computed → search for `--system-accent`. Should show the current macOS accent color (e.g., `#0a84ff` for blue, `#bf5af2` for purple, etc.).
- Tab to focus the recToggle or an icon button. Expected: focus ring color matches your macOS accent.
- Open System Settings → Appearance → change the accent color. Within ~1 sec the renderer's `--system-accent` updates and any focused control's ring color changes live.

- [ ] **Step 5: Commit.**

```bash
git add src/main.js src/preload.js src/renderer.js
git commit -m "feat(electron): sync macOS user's accent color to --system-accent

main.js: sends system:accent IPC on did-finish-load AND on
systemPreferences 'accent-color-changed'. Listener is cleaned up
on window 'closed'.

preload.js: exposes window.system.onAccent via the existing
subscribe() helper, on a fresh 'system' namespace (separate from
'gemini' for transcripts / scoring).

renderer.js: writes the received hex string to --system-accent on
:root. Focus rings (.icon-btn, .rec-toggle, .speaker, .pillar,
.rubric-switcher) inherit this token."
```

---

## Task 13: Cmd+Shift+H fade animation in `main.js`

**Goal:** When the user hides / shows the overlay via the global shortcut, fade rather than snap. Respect `prefers-reduced-motion` (snap if reduced).

The renderer already runs in the main window, so we can use `mainWindow.setOpacity(...)` directly. Reduce-motion detection lives in the renderer — we ping it via IPC at first paint.

**Files:**

- Modify: `src/main.js` (replace the Cmd+Shift+H handler; add reduced-motion sync)
- Modify: `src/preload.js` (add `system:reduceMotion` listener for renderer-to-main)
- Modify: `src/renderer.js` (forward reduce-motion state to main on init + on media-query change)

- [ ] **Step 1: Add reduced-motion forwarding from renderer to main.**

This needs the `let` at module scope (so the Cmd+Shift+H handler in `app.whenReady` can read it) and the IPC handler inside `registerIpcHandlers()`. Two snippets, two places.

**1a.** In `src/main.js`, add the module-level state near the other module-level `let` declarations (currently around line 31 — `let liveSession = null;`, `let coachSession = null;`, etc.). Place it after `let mainWindowRef = null;`:

```js
let reduceMotionInRenderer = false;
```

**1b.** In `src/main.js`, inside `registerIpcHandlers()`, near the other `ipcMain.on(...)` handler (the `gemini:audio` one, currently around line 266), add:

```js
ipcMain.on('system:reduceMotion', (_event, value) => {
  reduceMotionInRenderer = Boolean(value);
});
```

Verify the variable is visible to both the IPC handler (function scope of `registerIpcHandlers`) and the Cmd+Shift+H handler (function scope of the `app.whenReady` callback). Both inner scopes can read/write the module-level `let` via closure.

- [ ] **Step 2: Expose the reverse channel in `src/preload.js`.**

In the `contextBridge.exposeInMainWorld('system', { ... })` block (added in Task 12), add a new method:

```js
contextBridge.exposeInMainWorld('system', {
  onAccent: subscribe('system:accent'),
  setReduceMotion: (value) => ipcRenderer.send('system:reduceMotion', Boolean(value)),
});
```

(Both methods sit in the same `exposeInMainWorld` call — just append the second key.)

- [ ] **Step 3: Wire the renderer to forward its reduce-motion state.**

In `src/renderer.js`, add near the other `window.system.onAccent(...)` listener:

```js
// Forward reduce-motion preference to main so it can match window
// fade behavior. Fires on init and whenever the preference changes.
const reduceMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const pushReduceMotion = () => {
  window.system.setReduceMotion(reduceMotionQuery.matches);
};
pushReduceMotion();
reduceMotionQuery.addEventListener('change', pushReduceMotion);
```

- [ ] **Step 4: Add fade helpers at module scope, then replace the Cmd+Shift+H handler.**

The fade helpers must live at module scope so the `app.on('will-quit', ...)` handler (which is also at module scope) can call `cancelFade()` on shutdown.

**4a.** In `src/main.js`, add this block at module scope — directly below `let reduceMotionInRenderer = false;` from step 1a:

```js
// Cmd+Shift+H fade machinery. Module-scoped so will-quit can cancel
// any in-flight fade on app shutdown.
const FADE_MS = 220;
const FADE_STEPS = 14;          // ~16ms per step
let fadeTimer = null;

function cancelFade() {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

function fadeWindow(w, from, to, onDone) {
  cancelFade();
  const step = (to - from) / FADE_STEPS;
  let i = 0;
  fadeTimer = setInterval(() => {
    i += 1;
    const value = i >= FADE_STEPS ? to : (from + step * i);
    try { w.setOpacity(value); } catch { /* destroyed */ }
    if (i >= FADE_STEPS) {
      cancelFade();
      if (onDone) onDone();
    }
  }, Math.round(FADE_MS / FADE_STEPS));
}
```

**4b.** Find this block in `src/main.js` (currently around line 313-318, inside `app.whenReady`):

```js
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const w = mainWindowRef;
    if (!w || w.isDestroyed()) return;
    if (w.isVisible()) w.hide();
    else w.show();
  });
```

Replace with:

```js
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const w = mainWindowRef;
    if (!w || w.isDestroyed()) return;

    if (w.isVisible()) {
      if (reduceMotionInRenderer) {
        w.hide();
      } else {
        fadeWindow(w, 1, 0, () => {
          if (w.isDestroyed()) return;
          w.hide();
          w.setOpacity(1);   // reset for next show
        });
      }
    } else {
      if (reduceMotionInRenderer) {
        w.show();
        w.setOpacity(1);
      } else {
        w.setOpacity(0);
        w.show();
        fadeWindow(w, 0, 1, null);
      }
    }
  });
```

**4c.** Update the `will-quit` handler near the bottom of `main.js`. Find:

```js
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
```

Replace with:

```js
app.on('will-quit', () => {
  cancelFade();
  globalShortcut.unregisterAll();
});
```

This cancels any in-flight fade interval on shutdown so we don't leak a timer.

- [ ] **Step 5: Restart and verify.**

Type `rs` to restart main.

Test:

- Press **Cmd+Shift+H**. Window fades out over ~220 ms then hides.
- Press **Cmd+Shift+H** again. Window appears at opacity 0 then fades in over ~220 ms.
- Toggle the shortcut rapidly (3-4 times quickly). The window should follow each toggle without getting stuck. Worst case it ends in the wrong state — try once more and it should sync.
- Enable **System Settings → Accessibility → Display → Reduce Motion**, then toggle Cmd+Shift+H. Window should snap (no fade).

- [ ] **Step 6: Commit.**

```bash
git add src/main.js src/preload.js src/renderer.js
git commit -m "feat(electron): fade Cmd+Shift+H show/hide, respect reduce-motion

main.js: fadeWindow() uses setInterval at ~16ms per step to ramp
setOpacity from one value to another over ~220ms. Concurrent fades
cancel via cancelFade(). will-quit cancels too.

Reduce-motion preference is forwarded from the renderer (matchMedia
+ change listener) via window.system.setReduceMotion → 'system:reduceMotion'
IPC. When set, hide/show snap instead of fading."
```

---

## Task 14: A11y media query — listening pulse + transcript drawer + item tick transitions

**Goal:** Make sure every animation is gated on `prefers-reduced-motion: no-preference`. Two CSS files already have this guard (footer.css's pulse, drawer.css's slide), but `active-pillar.css`'s `.item__tick` transition and `.pillar` transitions need the same.

Reduced-transparency is already handled in `tokens.css` (swaps `--surface-glass-tint` to solid).

**Files:**

- Modify: `src/styles/active-pillar.css` (gate `.item` + `.item__tick` transitions)
- Modify: `src/styles/rail.css` (gate `.pillar` + `.rubric-switcher` transitions)
- Modify: `src/styles/footer.css` (gate `.speaker` + `.icon-btn` + `.rec-toggle` + `#recIndicator` transitions)

- [ ] **Step 1: Gate transitions in `src/styles/active-pillar.css`.**

Wrap the `.item` and `.item__tick` transition declarations in a reduce-motion media query. Currently:

```css
.item {
  display: grid;
  /* ... other props ... */
  transition:
    color var(--motion-fast) ease,
    background var(--motion-fast) ease;
}
```

Replace the `transition: ...;` line with nothing — and add this at the end of the file:

```css
/* Gate all hover/state transitions on reduce-motion preference. */
@media (prefers-reduced-motion: no-preference) {
  .item {
    transition:
      color var(--motion-fast) ease,
      background var(--motion-fast) ease;
  }

  .item__tick {
    transition:
      background-color var(--motion-fast) ease,
      border-color var(--motion-fast) ease,
      color var(--motion-fast) ease;
  }
}
```

Remove the `transition` declarations inside the original `.item` and `.item__tick` rules (so the only place transitions live for these elements is inside the reduce-motion guard).

- [ ] **Step 2: Gate transitions in `src/styles/rail.css`.**

Same pattern. Remove the `transition: ...` lines from `.rubric-switcher` and `.pillar` rules. Add at the end:

```css
@media (prefers-reduced-motion: no-preference) {
  .rubric-switcher {
    transition: background var(--motion-fast) ease, color var(--motion-fast) ease;
  }

  .pillar {
    transition: background var(--motion-fast) ease, color var(--motion-fast) ease;
  }
}
```

- [ ] **Step 3: Gate transitions in `src/styles/footer.css`.**

Same. Remove `transition: ...` lines from `.speaker`, `#recIndicator`, `.rec-toggle`, `.icon-btn`. Add at the end:

```css
@media (prefers-reduced-motion: no-preference) {
  .speaker {
    transition:
      background var(--motion-fast) ease,
      color var(--motion-fast) ease,
      border-color var(--motion-fast) ease;
  }

  #recIndicator {
    transition:
      background var(--motion-fast) ease,
      box-shadow var(--motion-fast) ease;
  }

  .rec-toggle {
    transition:
      background var(--motion-fast) ease,
      color var(--motion-fast) ease,
      border-color var(--motion-fast) ease;
  }

  .icon-btn {
    transition:
      background var(--motion-fast) ease,
      color var(--motion-fast) ease;
  }
}
```

(The existing `#coach[data-status='listening'] #recIndicator { animation: rec-pulse ... }` was already inside a reduce-motion-no-preference guard from Task 10 — leave it alone.)

- [ ] **Step 4: Verify behavior under reduce-motion.**

System Settings → Accessibility → Display → Reduce Motion **ON**. HMR reloads.

Expected:

- Hover a pillar: color / bg change snaps instead of fading.
- Click a pillar: selection change snaps.
- Listening indicator: no pulse, just a static green dot.
- Transcript drawer: opens / closes instantly (no slide).
- Item tick: snaps between outlined and filled.
- Cmd+Shift+H: snaps in/out.

Toggle Reduce Motion **OFF** and re-verify everything animates again.

- [ ] **Step 5: Commit.**

```bash
git add src/styles/active-pillar.css src/styles/rail.css src/styles/footer.css
git commit -m "feat(a11y): gate all hover/state transitions on reduce-motion

Wraps .item, .item__tick, .rubric-switcher, .pillar, .speaker,
#recIndicator, .rec-toggle, and .icon-btn transitions inside
@media (prefers-reduced-motion: no-preference) blocks.

Already-gated animations (rec-pulse in footer.css, drawer slide in
drawer.css) untouched.

Reduce-transparency continues to be handled in tokens.css by swapping
--surface-glass-tint to --surface-solid."
```

---

## Task 15: Verify the manual test plan from the spec

**Goal:** Walk through the spec's §9 manual test plan end-to-end. Catch anything missed by component-level checks above.

No files are modified in this task unless a check fails. Each failed check requires a follow-up commit on the appropriate file.

- [ ] **Step 1: Visual checks (do these with `npm start` running).**

Tick each line as you confirm. If a line fails, note it and continue — fix in Step 4.

- [ ] Open Notes / Safari behind the overlay; content visibly blurs through the glass.
- [ ] Resize the window: drag right edge → active pillar grows. Drag right edge inward → active pillar shrinks down to 280 px min, then the window-min kicks in. Captured pane stays in its 240–320 px band. Rail stays 52 px. Footer stays 52 px.
- [ ] Drag the window to minimum size (580 × 440): all panels visible. Rail scrolls if needed.
- [ ] All 14 pillar buttons render with correct glyphs (single text characters, no color emoji).
- [ ] Default selected pillar (`live_signals`) shows the green left-edge accent bar in the gutter and a slight bg tint.
- [ ] Click each other pillar; active pillar pane updates (header counter, body content). Bar moves to the newly selected pillar.
- [ ] Click the rubric switcher pill at top of rail; nothing happens (placeholder). Hover lightens the bg.
- [ ] Listening state: press Start (or Enter), rec indicator pulses green, Stop button is green with dark text, "You" speaker pill tints green when you speak.
- [ ] Live signals view (when flags exist): red flag rows have red bars and red kind badges; green flag rows have green bars and green kind badges.
- [ ] Captured pane shows all 6 groups; populated values appear right-aligned in primary fg, empty values show em-dash in tertiary fg.
- [ ] Footer hover states on the three icon buttons show subtle background fills.
- [ ] Change macOS accent color (System Settings → Appearance); focus a control with Tab; outline updates live to the new accent.
- [ ] Trigger the transcript drawer: it slides up, the body region hides behind it, the footer dims to 0.5 opacity. Close it: slides down.

- [ ] **Step 2: Accessibility checks.**

- [ ] **Reduce Motion ON** (System Settings → Accessibility → Display): no pulse, no item-tick transition, no drawer slide, no fade on Cmd+Shift+H.
- [ ] **Reduce Transparency ON**: card becomes opaque dark surface, vibrancy no longer visible.
- [ ] **VoiceOver** (Cmd+F5): tab through rubric switcher → pillars → footer buttons. Confirm each is announced sensibly with role / state.
- [ ] Trigger an error state (Start with no API key, or unplug from wifi): the alert is announced through the transcript drawer's `role="alert"` error element.

- [ ] **Step 3: Functional regression checks.**

- [ ] **Enter** toggles record start/stop.
- [ ] **Escape** closes the drawer (when open) OR returns to `live_signals` (when on another pillar).
- [ ] **Cmd+W** closes the window cleanly.
- [ ] **Cmd+Shift+H** toggles visibility (with fade unless Reduce Motion is on).
- [ ] **Cmd+Q** quits the app; no orphaned single-instance lock on relaunch (run `npm start` immediately after Cmd+Q; verify the window opens).
- [ ] Mic permission flow on first launch (delete `~/Library/Application Support/2-way-flow` to reset, then `npm start`): permission dialog appears, accept it, recording works.
- [ ] Mic-denied error surfaces in the drawer (deny the OS-level permission, press Start, expect the drawer to auto-open with "Microphone blocked").
- [ ] All three scoring IPC channels still update the UI live: `scoring:flag` adds a `.flag-row` to the live_signals pane, `scoring:item` toggles an `.item` to `[data-covered='true']` and updates the pillar's status dot, `scoring:field` updates a `.captured__value`.

- [ ] **Step 4: Fix anything broken.**

For each failing check above, fix the issue in the appropriate file. Common things to look for:

- Missing token reference (using a hardcoded color): use `tokens.css` value instead.
- Forgot `-webkit-app-region: no-drag` on an interactive child: add it.
- Vibrancy not visible: confirm `transparent: false` and no `backgroundColor` in main.js's BrowserWindow options.
- HMR not picking up: hard-reload with Cmd+R in DevTools, or restart `npm start`.

Each fix gets its own focused commit.

- [ ] **Step 5: Final commit (only if Steps 1-4 found nothing wrong).**

If the entire manual test plan passes without changes, no commit needed — the previous 14 task commits already encode the work. Stop here.

If anything broke and you fixed it in Step 4, each fix should already be a commit (per the per-fix rule above). Verify `git status` is clean.

---

## Final state — what the engineer should hand back

When this plan is done:

- Window opens at 720 × 580, resizable, with NSVisualEffectView dark HUD vibrancy + a Soft Frosted CSS tint on top.
- All eight CSS files exist under `src/styles/` and are referenced from `src/renderer.js`.
- `src/index.css` is deleted; not referenced anywhere.
- `index.html` matches spec §5.1: rubric switcher above rail, 3-section active pillar with ticker + Ask-next card, bottom footer with all rec controls + 3 icon buttons.
- `src/main.js` enables vibrancy, resize+min dimensions, accent-color sync, and Cmd+Shift+H fade.
- `src/preload.js` exposes `window.system.onAccent` and `window.system.setReduceMotion`.
- `src/renderer.js` imports the eight new CSS files, listens for accent updates, forwards reduce-motion preference, and runs the new drawer-open/close timing in `renderTranscriptDrawer()`.
- Reduce-motion + reduce-transparency a11y media queries are honored everywhere.
- Manual test plan from spec §9 passes.

## Pointers for follow-up work (out of scope here)

- Wiring `#minButton` to actually minimize via IPC (placeholder log today).
- Persisting window size + position between launches.
- Compact mode at small widths (collapse captured pane to icons).
- Rubric picker behind the placeholder pill.
- Settings panel for API key / mic device.
- Light-mode adaptation (would only touch `tokens.css` and `main.js` vibrancy material).

These all touch the same files the plan modifies; reach for them when the scope is approved.
