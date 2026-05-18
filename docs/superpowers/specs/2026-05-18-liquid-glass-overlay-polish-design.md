# Liquid Glass Overlay Polish — Design Spec

- **Date:** 2026-05-18 (rev. 2 — scope expanded from small overlay to three-column coach)
- **Author:** taylor (assisted)
- **Project:** 2-Way Flow (Tuned Automation Discovery Call Coach)
- **Status:** Approved, ready for implementation plan
- **Scope:** Build the missing `index.html` + component CSS to match the existing `src/renderer.js` three-column coach renderer, applying a Soft-Frosted Liquid-Glass aesthetic with native macOS vibrancy. Add resize support, system-accent sync, and a11y media-query support. No new screens.

## 1. Context

`2-Way Flow` is a frameless, transparent, always-on-top Electron overlay that streams microphone audio to the Gemini Live API. During exploratory work, `src/renderer.js`, `src/coach.js`, and `src/rubric.js` were rewritten into a **three-column real-time discovery-call coach**: a left rail of 14 pillar buttons, a centre "active pillar" pane showing either checklist items or live coaching flags, and a right captured-fields pane that the AI fills in as the call progresses. The active pillar column has three rows — header (pillar name + counter), scrolling body (checklist or flag-rows), and pinned footer (live transcript ticker + the AI coach's "ask next" suggestion card). A bottom window footer holds rec controls (speaker pills, timer, Start/Stop, transcript/minimize/close icons). A rubric-switcher placeholder pill sits above the rail (current rubric is "Tuned Automation"; click is wired but currently no-op). A transcript drawer overlays the body when toggled.

The renderer establishes hard contracts. It queries elements by exact id (`#coach`, `#pillarRail`, `#activePillar`, `#activePillarHeader`, `#activePillarBody`, `#activePillarFooter`, `#transcriptTicker`, `#coachSuggestion`, `#capturedPane`, `#rubricSwitcher`, `#recToggle`, `#recTimer`, `#recIndicator`, `#minButton`, `#closeButton`, `#transcriptToggle`, `#transcriptDrawer`, `#transcriptList`, `#transcriptPending`, `#transcriptError`) and renders children using exact classes (`.pillar` / `.pillar__glyph` / `.pillar__dot`, `.active-pillar__header` / `.active-pillar__title` / `.active-pillar__counter` / `.active-pillar__empty`, `.checklist`, `.item` / `.item__tick` / `.item__label`, `.flag-row` / `.flag-row__bar` / `.flag-row__body` / `.flag-row__title` / `.flag-row__kind` / `.flag-row__evidence`, `.captured__group` / `.captured__heading` / `.captured__pair` / `.captured__label` / `.captured__value` / `.captured__value--empty`, `.suggestion__label` / `.suggestion__pillar` / `.suggestion__question` / `.suggestion__rationale`, `.drawer__line`, `.speaker`, `.coach__body`, `.coach__footer`). It also reads `state.transcript` and toggles `#transcriptTicker.hidden`, `#coachSuggestion.hidden`, `#transcriptDrawer.hidden`, plus `bodyEl.style.visibility` / `footerEl.style.opacity` when the drawer opens.

The committed `index.html` and `src/index.css` already wire up the right element ids, classes, and broad structure to satisfy the renderer — but the layout puts rec controls in a top header (this spec moves them to the bottom footer per the approved mockup), styling uses a single monotone palette (this spec introduces Apple system green/orange/red + Soft Frosted glass over native macOS vibrancy), CSS is a single monolithic file (this spec splits by component), and there's no resize support, accent-color sync, or a11y-media-query handling. The functional renderer logic (rec timer, scoring pipeline, ticker, suggestion card, drawer toggle, audio worklet, IPC) is unchanged by this spec except for two surgical additions in `renderer.js` documented in §7.3 and §8.4.

## 2. Goals

- Build a complete `index.html` that satisfies the `renderer.js` DOM contract.
- Apply a Soft-Frosted Liquid-Glass aesthetic uniformly across all components.
- Native `NSVisualEffectView` material under the card via Electron `vibrancy: 'hud'`, with a tinted CSS glass layer on top.
- All visual values (color, radii, blur, motion) extracted into design tokens (`:root` CSS custom properties).
- macOS accessibility settings (`prefers-reduced-motion`, `prefers-reduced-transparency`) respected automatically.
- macOS user's accent color drives focus rings, kept in sync via `systemPreferences.getAccentColor()`.
- Window is resizable with sensible minimums (580 × 440); a default size of 720 × 580 anchored top-right.
- Stay vanilla JS + CSS. No React, no Tailwind, no framework.

## 3. Non-goals

- Cross-platform parity. macOS-only. Linux / Windows makers remain in `forge.config.js` but the design assumes macOS.
- Light-mode adaptation. The HUD stays dark regardless of macOS appearance. Architecture is forward-compatible.
- Window size or position persistence between launches.
- Compact / collapsed modes at small widths.
- User-draggable column dividers.
- New screens, settings panels, transcript history.
- Traffic-light window controls.
- Haptic feedback (not available on macOS via Electron).
- App icon / dock icon design.

## 4. Visual & material spec

### 4.1 The Soft Frosted recipe

CSS layer applied to `#coach`, on top of the native vibrancy:

```css
background: var(--surface-glass-tint);     /* rgba(28, 28, 30, 0.55) */
backdrop-filter: blur(var(--blur-card)) saturate(var(--saturate-card));
border: 1px solid var(--border-hairline);
border-radius: var(--radius-card);
box-shadow:
  0 8px 28px rgba(0, 0, 0, 0.35),
  inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
```

The 0.55 tint is intentionally low because `NSVisualEffectView` does work underneath. The 0.5px inset hairline gives the "edge of glass" feel without a heavy border.

### 4.2 Design tokens (`src/styles/tokens.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--surface-glass-tint` | `rgba(28, 28, 30, 0.55)` | Card background tint over vibrancy |
| `--surface-solid` | `rgba(28, 28, 30, 0.95)` | Fallback when reduce-transparency is on |
| `--surface-inset` | `rgba(255, 255, 255, 0.04)` | Transcript region inner surface, flag-row bg |
| `--surface-control` | `rgba(255, 255, 255, 0.10)` | Selected pillar bg, button neutral bg |
| `--surface-control-hover` | `rgba(255, 255, 255, 0.06)` | Hover state on icon buttons / pillars |
| `--border-hairline` | `rgba(255, 255, 255, 0.12)` | Card outer border |
| `--border-inset` | `rgba(255, 255, 255, 0.07)` | Column dividers, captured pair dividers |
| `--fg-primary` | `rgba(255, 255, 255, 0.95)` | Titles, transcript body, captured values |
| `--fg-secondary` | `rgba(255, 255, 255, 0.65)` | Item labels, captured labels, secondary text |
| `--fg-tertiary` | `rgba(255, 255, 255, 0.35)` | Empty values, headings, idle icon buttons |
| `--accent-active` | `#34c759` | Apple system green — listening, rec, complete |
| `--accent-warn` | `#ff9f0a` | Apple system orange — pillar in_progress dot |
| `--accent-danger` | `#ff453a` | Apple system red — error, red flags |
| `--accent-active-fg` | `#062313` | High-contrast fg on green Stop button |
| `--system-accent` | `rgba(255, 255, 255, 0.4)` | Focus ring fallback; overridden at runtime by main process |
| `--radius-card` | `14px` | Card corner |
| `--radius-inner` | `10px` | Flag-row, transcript region |
| `--radius-control` | `6px` | Pillar bg, icon button, focus ring rounding |
| `--radius-pill` | `999px` | Speaker pills, Stop button, rec indicator |
| `--blur-card` | `18px` | Backdrop blur amount |
| `--saturate-card` | `180%` | Backdrop saturation boost |
| `--motion-fast` | `120ms` | Existing micro-transitions |
| `--motion-medium` | `220ms` | Show/hide fades, drawer animation |
| `--motion-pulse` | `1400ms` | Listening / rec-indicator pulse cycle |

State color migration vs. current literals: `#4ade80` → `#34c759` (green), `#f87171` → `#ff453a` (red), gain explicit warn `#ff9f0a` for the in_progress pillar dot.

### 4.3 Typography

No font change. The existing `-apple-system, BlinkMacSystemFont, …` stack already resolves to SF Pro on macOS.

| Use | Size | Weight | Notes |
| --- | --- | --- | --- |
| Active pillar title | 15 px | 600 | Letter-spacing -0.1 px |
| Active pillar counter | 11 px | 400 | Tabular numerals |
| Pillar glyph | 14 px | 600 | Single-character monogram |
| Item label / flag title | 12.5 px | 500 | Body line-height 1.4 |
| Flag-row evidence | 11.5 px | 400 italic | Secondary fg |
| Flag-row kind badge | 9.5 px | 700 uppercase | Letter-spacing 0.04 em |
| Captured heading | 9.5 px | 700 uppercase | Letter-spacing 0.06 em, tertiary fg |
| Captured label | 11.5 px | 400 | Secondary fg |
| Captured value | 12 px | 500 | Primary fg, tabular where appropriate |
| Timer (`#recTimer`) | 12 px | 500 | Tabular numerals |
| Stop button | 12 px | 600 | Pill button on accent-active |
| Speaker pill | 10.5 px | 500 | Tabular if number ever added |

## 5. UI component spec

### 5.1 HTML structure (the `renderer.js` contract)

Replaces the current `index.html` `<body>` content entirely:

```html
<main id="coach" data-status="idle">

  <div class="coach__body">

    <div class="rail-column">
      <button id="rubricSwitcher" class="rubric-switcher" type="button"
              title="Switch rubric (coming soon)" aria-label="Switch rubric — currently Tuned Automation">
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

      <div id="pillarRail" role="tablist" aria-label="Rubric pillars">
        <!-- renderer.makePillarButton() appends 14 buttons. Renderer's
             `railEl.replaceChildren(...PILLARS.map(makePillarButton))` replaces
             only this element's children, so rubricSwitcher is safe outside.
          <button class="pillar" data-id="…" data-selected="…" data-status="…"
                  aria-label="…" title="…">
            <span class="pillar__glyph">▶</span>
            <span class="pillar__dot" aria-hidden="true"></span>
          </button>
        -->
      </div>
    </div>

    <section id="activePillar" class="active-pillar"
             role="tabpanel" aria-label="Active pillar checklist">
      <!-- Three pinned/scrolling rows. The header and footer are pinned;
           the body is the only scrolling region. -->
      <div id="activePillarHeader" class="active-pillar__header-slot">
        <!-- renderer replaces children with:
             .active-pillar__header (h2.active-pillar__title + span.active-pillar__counter) -->
      </div>
      <div id="activePillarBody" class="active-pillar__body" aria-live="polite">
        <!-- renderer replaces children with EITHER:
               ul.checklist of li.item[data-covered] > span.item__tick + span.item__label
             OR div.checklist of div.flag-row[data-severity] > span.flag-row__bar + div.flag-row__body
                                                                ( span.flag-row__title (> span.flag-row__kind + text)
                                                                + span.flag-row__evidence )
             OR p.active-pillar__empty for empty states -->
      </div>
      <div id="activePillarFooter" class="active-pillar__footer">
        <p id="transcriptTicker" class="ticker" aria-live="polite" hidden></p>
        <div id="coachSuggestion" class="suggestion" role="region"
             aria-label="Suggested next question" hidden></div>
      </div>
    </section>

    <aside id="capturedPane" class="captured" aria-label="Captured fields">
      <!-- renderer replaces children with sections per group:
        <section class="captured__group">
          <h3 class="captured__heading">Revenue</h3>
          <div class="captured__pair">
            <span class="captured__label">Revenue</span>
            <span class="captured__value">$2.4M ARR</span>
          </div>
          (empty value: <span class="captured__value captured__value--empty">—</span>)
        </section>
      -->
    </aside>

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
      <button id="minButton" class="icon-btn" type="button" aria-label="Minimize" title="Minimize">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M4 8h8"/>
        </svg>
      </button>
      <button id="closeButton" class="icon-btn" type="button" aria-label="Close"
              title="Close (⌘W)">
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
```

Key contract points:

- `#transcriptDrawer` is a sibling of `.coach__body` and `.coach__footer`, NOT a child of either. `renderer.js` toggles `bodyEl.style.visibility` and `footerEl.style.opacity` when the drawer opens, so the drawer must be positioned absolutely over the body region (top: 0, left: 0, right: 0, bottom: 52px relative to `#coach`).
- The `transcriptToggle` button has both an inline SVG and a `<span class="sr-only">` because `renderer.js` does `transcriptToggleEl.querySelector('span:last-child').textContent = state.transcriptOpen ? 'Hide transcript' : 'Show transcript'` — the span is the source of truth the renderer mutates, the SVG is decorative.
- `#rubricSwitcher` lives **outside** `#pillarRail`, in a shared `.rail-column` flex wrapper. The renderer's `railEl.replaceChildren(...)` would otherwise wipe it out. The shared `.rail-column` flex container holds `#rubricSwitcher` at top, then `#pillarRail` filling the rest.
- The renderer's `coach.__body` selector (`document.querySelector('.coach__body')`) still picks up the body div, so the visibility toggle still works.
- The active pillar `<section>` keeps its three child slots: `#activePillarHeader` (replaced on every `renderActivePillar()`), `#activePillarBody` (replaced on every render, only this scrolls), `#activePillarFooter` (statically holds `#transcriptTicker` and `#coachSuggestion`, both `hidden` by default and individually toggled by `renderTicker()` / `renderCoachSuggestion()`).

### 5.2 Window shell (`#coach`)

- `display: grid`, `grid-template-rows: 1fr 52px` (body fills, footer fixed).
- `position: relative` so `#transcriptDrawer` can absolutely cover the body.
- Soft Frosted material per §4.1.
- `overflow: hidden` (drawer animation is contained).
- `data-status` attribute drives outer state. See §5.10.

### 5.3 Left rail column (`.rail-column` wrapper)

The left column is **52 px wide** and is itself a flex container:

```css
.rail-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border-inset);
  padding: 8px 0 0;
}
```

Top-to-bottom contents:

1. **Rubric switcher pill** (`#rubricSwitcher.rubric-switcher`) — fixed 28 px tall, full column width minus 8 px horizontal margin (so `margin: 0 4px`), `border-radius: var(--radius-control)`, transparent default, `var(--surface-control-hover)` on hover. Renders a grid icon + small chevron. `padding: 4px 6px; display: flex; align-items: center; justify-content: space-between; color: var(--fg-tertiary);`. Cursor: pointer. `-webkit-app-region: no-drag`. Click is wired in the renderer but does nothing currently — log `console.log('[ui] rubric picker pressed (placeholder)');` in the renderer's existing pattern (mirrors the existing `minButton` placeholder). Tooltip on hover: "Switch rubric (coming soon)". `.rubric-switcher__icon` and `.rubric-switcher__chevron` are `display: inline-flex` containers for the inline SVGs, `color: currentColor` so they inherit the parent's text color (which changes on hover).
2. **Hairline divider** (`.rail-column__divider`, a `<div aria-hidden="true">` placed between the switcher and the rail in the HTML) — 1 px tall, full column width minus 12 px horizontal margin (so `margin: 6px 6px`), `background: var(--border-inset)`.
3. **`#pillarRail`** — fills remaining vertical space (`flex: 1 1 auto; min-height: 0`). `display: flex; flex-direction: column; gap: 4px; padding: 4px 6px 10px;`. `overflow-y: auto` (thin scrollbar). At min-height 440 px, ~9–10 of 14 pillars fit; user scrolls to reach the rest.

Add `<div class="rail-column__divider" aria-hidden="true"></div>` between `#rubricSwitcher` and `#pillarRail` in the HTML (not shown in the §5.1 snippet — add it during implementation).

Each `.pillar` is 40 × 36 px with `border-radius: var(--radius-control)`, transparent default, `var(--surface-control-hover)` on hover, `var(--surface-control)` when `data-selected="true"`. Selected pillars additionally show a 2.5 px left-edge bar in `var(--accent-active)`, positioned at `left: -7px; top: 8px; bottom: 8px; border-radius: 999px`.

`.pillar__glyph` is centred via `display: grid; place-items: center` and uses the per-pillar single-character monogram from `rubric.js` (e.g. `▶`, `⊕`, `◇`).

`.pillar__dot` is absolutely positioned bottom-right (`right: 4px; bottom: 4px`), 6×6 px circle, color depends on `data-status`: idle = transparent, in_progress = `var(--accent-warn)`, complete = `var(--accent-active)`.

The rail (and rubric switcher) is NOT in the drag region — drag lives in the footer only (§5.9).

### 5.4 Active pillar column (`#activePillar.active-pillar`)

Three vertical rows: pinned header, scrolling body, pinned footer. Only the body scrolls so the ticker + Ask-next card never get pushed off-screen by a long checklist.

```css
#activePillar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;          /* grid children with overflow children need this */
}
```

#### 5.4.1 Header slot (`#activePillarHeader.active-pillar__header-slot`)

- `padding: 12px 16px 4px`.
- Renderer fills it with one `<div class="active-pillar__header">` that's `display: flex; align-items: baseline; justify-content: space-between; gap: 8px`.
- `.active-pillar__title` (h2 element) per §4.3.
- `.active-pillar__counter` per §4.3 — small pill with `padding: 2px 8px; border-radius: var(--radius-pill); background: var(--surface-inset); color: var(--fg-tertiary); font-variant-numeric: tabular-nums`.

#### 5.4.2 Body (`#activePillarBody.active-pillar__body`)

- `flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 16px 10px`.
- Selectable text (`-webkit-user-select: text`) for users who want to copy a flag's evidence quote.
- Renderer fills with the `.checklist` element (regular pillar → ul of `.item`s, live_signals pillar → div of `.flag-row`s) OR `<p class="active-pillar__empty">No checklist items…</p>` for empty states. `.active-pillar__empty`: `margin: 0; font-size: 12px; font-style: italic; color: var(--fg-tertiary)`.

#### 5.4.3 Footer slot (`#activePillarFooter.active-pillar__footer`)

- `padding: 8px 16px 10px; border-top: 1px solid var(--border-inset); background: rgba(255, 255, 255, 0.02); display: flex; flex-direction: column; gap: 6px`.
- When **both** children are `hidden`, the footer collapses chrome: use `:not(:has(> :not([hidden])))` to set `border-top-color: transparent; background: transparent; padding: 0`. This avoids a dead band at the bottom of the column when there's nothing to show.

#### 5.4.4 Live transcript ticker (`#transcriptTicker.ticker`)

A single-line italic ticker that shows the most recent transcript text — latest committed turn + any in-flight partial — trimmed to ~140 chars from the right so the newest words stay visible.

- `margin: 0; font-size: 11px; color: var(--fg-tertiary); font-style: italic; line-height: 1.35`.
- `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl` so overflow ellipsis appears on the left side (keeping newest characters visible). Inner span (rendered by renderer) gets `direction: ltr; unicode-bidi: bidi-override` to undo the rtl for text reading.

Renderer's `renderTicker()` is unchanged — it sets `tickerEl.hidden = true` when there's no text, otherwise sets `tickerEl.hidden = false` and replaces children with `<span>{trimmed}</span>`.

#### 5.4.5 Coach suggestion / "Ask next" card (`#coachSuggestion.suggestion`)

A small card surfacing the AI coach's recommended next question.

- `display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: var(--radius-inner); background: var(--surface-inset); border: 1px solid var(--border-inset)`.
- `.suggestion__label`: `font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-tertiary); display: flex; align-items: center; gap: 6px`. Renderer puts an inner `<span>Ask next</span>` (always present when card is visible) and optionally a `<span class="suggestion__pillar">· {pillar.short}</span>` showing which pillar the suggestion came from.
- `.suggestion__pillar`: `color: var(--fg-secondary); font-weight: 500; text-transform: none; letter-spacing: 0`.
- `.suggestion__question` (the actual question): `margin: 0; font-size: 12.5px; color: var(--fg-primary); line-height: 1.4; font-weight: 500`.
- `.suggestion__rationale` (optional explanation, if the model returned one): `font-size: 10.5px; color: var(--fg-tertiary); line-height: 1.4`.

Renderer's `renderCoachSuggestion()` is unchanged — it sets `coachSuggestionEl.hidden = true` when state has no suggestion, otherwise replaces children with the label / question / optional rationale spans.

### 5.5 `.item` (checklist mode for regular pillars)

- `display: grid; grid-template-columns: 16px 1fr; align-items: center; gap: 8px`.
- `padding: 7px 8px; border-radius: var(--radius-control); font-size: 12.5px; line-height: 1.4`.
- Uncovered: `color: var(--fg-secondary)`; `.item__tick` is a 14×14 outlined circle with `border: 1.5px solid var(--fg-tertiary)` and transparent text content.
- Covered (`[data-covered='true']`): `color: var(--fg-primary)`; `.item__tick` becomes a filled green circle with white ✓ inside.
- Transitions: tick `background-color` / `border-color` / `color` over `var(--motion-fast)`. Wrapped in `@media (prefers-reduced-motion: no-preference)`.

### 5.6 `.flag-row` (live_signals mode)

- `display: grid; grid-template-columns: 3px 1fr; gap: 8px; padding: 8px 10px 8px 0`.
- `border-radius: var(--radius-inner); background: var(--surface-inset)`.
- `.flag-row__bar`: 3 px wide, full-height, `border-radius: 999px`. Color via `[data-severity]`: red bar = `var(--accent-danger)`, green bar = `var(--accent-active)`.
- `.flag-row__body`: flex column, `gap: 2px`, `min-width: 0`.
- `.flag-row__title`: `display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; color: var(--fg-primary)`.
- `.flag-row__kind`: small uppercase pill badge per §4.3. Background and color vary by severity: red bg `rgba(255, 69, 58, 0.18)` / color `#ff7a72`; green bg `rgba(52, 199, 89, 0.18)` / color `#6cdc8c`.
- `.flag-row__evidence`: per §4.3.

### 5.7 Captured pane (`#capturedPane`)

- 240–320 px wide (grid `minmax(240px, 320px)`), border-left hairline, `padding: 14px 14px; overflow-y: auto; min-width: 0; display: flex; flex-direction: column; gap: 12px`.
- `.captured__group`: flex column, `gap: 4px`.
- `.captured__heading`: per §4.3.
- `.captured__pair`: `display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--border-inset)`. Last pair in a group drops the bottom border.
- `.captured__label` (left) and `.captured__value` (right) per §4.3. Value gets `text-align: right; max-width: 60%; overflow-wrap: anywhere` so long values like `"HubSpot, Mixpanel, Notion"` wrap rather than overflow.
- `.captured__value--empty`: tertiary fg, weight 400.

### 5.8 Transcript drawer (`#transcriptDrawer`)

- `position: absolute; top: 0; left: 0; right: 0; bottom: 52px; padding: 14px 16px; overflow-y: auto`.
- The drawer visually replaces the body, but cannot reuse the parent's `backdrop-filter` (filters don't stack). Use `background: var(--surface-solid)` (rgba(28, 28, 30, 0.95)). This reads as a distinct opaque surface, which is exactly what we want when the body underneath is `visibility: hidden`.
- Slide-up + fade in when `[hidden]` is removed: from `transform: translateY(8px); opacity: 0` to `translateY(0); opacity: 1` over `var(--motion-medium)`, ease-out. Reverse on close. Implemented via a CSS `transition` on `transform` and `opacity` plus the renderer toggling a `.open` class (small renderer change — note as a known dependency below in §8.4).
- `.drawer__line`: `margin: 0 0 6px; font-size: 12.5px; line-height: 1.5; color: var(--fg-primary)`.
- `#transcriptPending`: italic, `var(--fg-secondary)`.
- `#transcriptError`: `var(--accent-danger)`, weight 500, padding 8 px, border-left 2 px solid `var(--accent-danger)`, background `rgba(255, 69, 58, 0.08)`.

### 5.9 Footer (`.coach__footer`)

- 52 px tall, `display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: center; padding: 0 12px`.
- `border-top: 1px solid var(--border-inset); background: rgba(0, 0, 0, 0.15)`.
- `-webkit-app-region: drag` on the footer itself (this is the drag region; the body has none, leaving window edges free for resize).
- Interactive children opt out with `-webkit-app-region: no-drag`.
- `.footer__speakers`: flex with `gap: 6px`.
- `.speaker`: `display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--radius-pill); font-size: 10.5px; font-weight: 500; background: var(--surface-inset); color: var(--fg-tertiary); border: 1px solid transparent`. Active state: green tint bg `rgba(52, 199, 89, 0.15)`, color `var(--accent-active)`, border `rgba(52, 199, 89, 0.35)`.
- `.speaker__mic` (the SVG container span): `display: inline-flex; opacity: 0.85`. SVG `stroke="currentColor"` so it inherits the speaker's color (green when active, tertiary fg when inactive).
- `.footer__timer-wrap`: flex `gap: 6px; align-items: center`.
- `#recIndicator`: 7×7 circle, color depends on `#coach[data-status]`: idle = `var(--fg-tertiary)`, starting = `var(--accent-warn)` with low-opacity halo, listening = `var(--accent-active)` with `box-shadow: 0 0 6px rgba(52, 199, 89, 0.85)` and a `dot-pulse` animation (scale 0.92 ↔ 1.08, opacity 0.7 ↔ 1.0, `var(--motion-pulse)` ease-in-out infinite), error = `var(--accent-danger)`.
- `#recTimer`: per §4.3.
- `#recToggle`: pill button. Idle / error: bg `var(--surface-control)`, color `var(--fg-primary)`. Listening: bg `var(--accent-active)`, color `var(--accent-active-fg)`. Starting: bg `var(--surface-control)`, color `var(--fg-secondary)`, with a small spinning ring glyph (CSS-only — a `::before` with `border-top` and rotation).
- `.footer__icons`: flex `gap: 4px`.
- `.icon-btn`: 26 × 26, transparent bg, `border-radius: var(--radius-control)`, color `var(--fg-tertiary)`. Hover: bg `var(--surface-control-hover)`, color `var(--fg-primary)`. Focus-visible: outline using `var(--system-accent)` per §7.4.

### 5.10 `#coach[data-status]` outer states

| Status | What changes |
| --- | --- |
| `idle` | Default. Rec indicator tertiary. recToggle says "Start". |
| `starting` | recToggle "Starting…" with spinner; indicator amber. |
| `listening` | Indicator green + pulsing; recToggle "Stop" on green bg; speaker pills can become active per `[data-active]`. |
| `error` | Indicator red. recToggle "Start" on subtly red-tinted bg. `renderer.js` auto-opens the transcript drawer to surface the error message. |

These are all driven by CSS attribute selectors (`#coach[data-status='listening'] #recIndicator { … }`) so the renderer mutating one attribute cascades everywhere.

## 6. File architecture

```
src/
├── styles/
│   ├── tokens.css        ~60 LoC — :root { --vars } + a11y media queries
│   ├── reset.css         ~40 LoC — html/body baseline, .sr-only, .no-drag, scrollbar styling
│   ├── coach.css         ~90 LoC — #coach shell, .rail-column + .coach__body grid + .coach__footer base + drag region
│   ├── rail.css          ~80 LoC — #rubricSwitcher + .rubric-switcher* + .rail-column__divider + #pillarRail + .pillar + .pillar__glyph + .pillar__dot
│   ├── active-pillar.css ~180 LoC — #activePillar + .active-pillar__header-slot/header/title/counter + .active-pillar__body + .active-pillar__empty + .active-pillar__footer + .ticker + .suggestion + .suggestion__* + .checklist + .item* + .flag-row*
│   ├── captured.css      ~60 LoC — #capturedPane.captured + .captured__*
│   ├── footer.css        ~110 LoC — .coach__footer + .footer__speakers + .speaker* + .footer__timer-wrap + #recIndicator + #recTimer + .rec-toggle + .footer__icons + .icon-btn + status-state variants
│   └── drawer.css        ~50 LoC — #transcriptDrawer.drawer + .drawer__line/list/pending/error + slide animation
├── renderer.js           imports the eight style files; adds onAccent listener; updates renderTranscriptDrawer per §8.4
├── main.js               +~30 LoC: vibrancy, accent IPC, fade, resizable + min dims, updated window dimension constants
├── preload.js            +~5 LoC: subscribes to `system:accent`, exposes window.system.onAccent
├── gemini-session.js     unchanged
├── coach.js              unchanged
└── (deleted) index.css
index.html                rewritten to match §5.1
```

`renderer.js` replaces the existing `import './index.css';` line with:

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

The 8-file split is intentional: each file maps to a "logical UI surface" that maintains its own state in `renderer.js`, and the line counts above keep every file under ~200 LoC. If consolidation feels right at implementation time, an acceptable fallback is four files: `tokens.css`, `reset.css`, `coach.css` (shell + footer + drawer + reset), `panels.css` (rail + active-pillar + captured) — but the implementation plan will follow the 8-file split because each file maps cleanly to one task and is easier to review independently.

## 7. Electron / native integration

### 7.1 `main.js` — BrowserWindow

Existing `createWindow()` constants at top of file:

```js
const WINDOW_WIDTH = 720;       // was 380
const WINDOW_HEIGHT = 580;      // was 600
const MIN_WIDTH = 580;          // new
const MIN_HEIGHT = 440;         // new
const EDGE_MARGIN = 20;         // unchanged
```

`BrowserWindow` options change:

```js
const mainWindow = new BrowserWindow({
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  minWidth: MIN_WIDTH,           // NEW
  minHeight: MIN_HEIGHT,         // NEW
  x, y,
  frame: false,
  transparent: false,            // CHANGED from true; vibrancy and transparent are exclusive
  vibrancy: 'hud',               // NEW: dark NSVisualEffectView material
  visualEffectState: 'active',   // NEW: stay vibrant on focus loss
  alwaysOnTop: true,
  resizable: true,               // CHANGED from false
  hasShadow: false,              // CSS shadow only
  skipTaskbar: false,
  webPreferences: { preload: path.join(__dirname, 'preload.js') },
});
```

### 7.2 Always-dark decision

The HUD stays dark regardless of macOS appearance. macOS's own HUDs (volume slider, brightness picker, AirPlay menu) follow the same pattern. The green status indicator has markedly better contrast against dark vibrancy. Light-mode adaptation can be added later by swapping vibrancy to `'fullscreen-ui'` and providing a light token set.

### 7.3 System accent color sync

```js
const sendAccent = () => {
  const hex = `#${systemPreferences.getAccentColor()}`;
  send('system:accent', hex);
};

mainWindow.webContents.on('did-finish-load', sendAccent);
systemPreferences.on('accent-color-changed', sendAccent);
```

`preload.js` adds:

```js
contextBridge.exposeInMainWorld('system', {
  onAccent: subscribe('system:accent'),
});
```

(reusing the existing `subscribe()` helper at the top of `preload.js`).

`renderer.js` subscribes once at module init:

```js
window.system.onAccent((hex) => {
  document.documentElement.style.setProperty('--system-accent', hex);
});
```

### 7.4 Cmd+Shift+H show / hide fade

The existing global shortcut handler in `main.js` calls `w.show()` / `w.hide()` directly. New behavior:

- On hide: animate `setOpacity` from 1 → 0 over `var(--motion-medium)` (220 ms), then `hide()`.
- On show: `setOpacity(0)`, `show()`, animate 0 → 1.
- If the renderer reports `prefers-reduced-motion: reduce` (forwarded via IPC at first load), skip the animation and snap.

Implementation uses `setInterval` at ~16 ms per frame for a linear opacity ramp; no easing library.

### 7.5 Drag region

`-webkit-app-region: drag` moves from `<body>` to `.coach__footer` only. The body has no drag region — leaving the window edges free for the now-enabled resize cursors. Interactive footer children (speaker pills, recToggle, icon buttons) keep `-webkit-app-region: no-drag`.

### 7.6 Resize cursor affordance

With `frame: false; resizable: true`, macOS still renders invisible resize regions at the window edges and corners. No custom resize grip needed. macOS shows the appropriate diagonal/horizontal/vertical resize cursor on hover.

## 8. Behavior & accessibility

### 8.1 `prefers-reduced-motion`

All transitions live inside `@media (prefers-reduced-motion: no-preference)` blocks. When macOS Reduce Motion is on:
- No `transition` properties active.
- `#recIndicator` does not pulse.
- `.item__tick` snaps between states without animation.
- `#transcriptDrawer` opens/closes without slide.
- Cmd+Shift+H snaps the window in/out instead of fading.

### 8.2 `prefers-reduced-transparency`

```css
@media (prefers-reduced-transparency: reduce) {
  #coach {
    background: var(--surface-solid);
    backdrop-filter: none;
  }
}
```

OS-level `vibrancy` stays set but is fully covered by the opaque CSS surface. No main-process change required.

### 8.3 `#recIndicator` pulse

Wrapped in `[data-status='listening']` and the reduced-motion query:

```css
@media (prefers-reduced-motion: no-preference) {
  #coach[data-status='listening'] #recIndicator {
    animation: rec-pulse var(--motion-pulse) ease-in-out infinite;
  }
}

@keyframes rec-pulse {
  0%, 100% { transform: scale(0.92); opacity: 0.75; }
  50% { transform: scale(1.08); opacity: 1; }
}
```

### 8.4 Transcript drawer animation

Requires a small renderer change: in addition to toggling `hidden`, toggle a `.open` class on `#transcriptDrawer`. The `[hidden]` attribute is preserved for accessibility (screen readers skip it when closed), and the `.open` class drives the visual animation.

CSS:

```css
#transcriptDrawer {
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
    transition: transform var(--motion-medium) ease-out,
                opacity var(--motion-medium) ease-out;
  }
}
```

Renderer change in `renderTranscriptDrawer()` — the existing logic that sets `transcriptDrawerEl.hidden = !state.transcriptOpen` is replaced with this exact ordering:

```js
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ANIM_MS = 220; // mirrors --motion-medium

if (state.transcriptOpen) {
  // Open: clear `hidden` first so the element is in the layout, then
  // add `.open` on the next frame so the transition has an initial
  // state to animate from.
  transcriptDrawerEl.hidden = false;
  if (REDUCE_MOTION) {
    transcriptDrawerEl.classList.add('open');
  } else {
    requestAnimationFrame(() => transcriptDrawerEl.classList.add('open'));
  }
} else {
  // Close: remove `.open` first so the element animates out, then
  // set `hidden` after the transition finishes (or immediately if
  // motion is reduced).
  transcriptDrawerEl.classList.remove('open');
  if (REDUCE_MOTION) {
    transcriptDrawerEl.hidden = true;
  } else {
    setTimeout(() => {
      if (!state.transcriptOpen) transcriptDrawerEl.hidden = true;
    }, ANIM_MS);
  }
}
```

The `if (!state.transcriptOpen)` guard inside the timeout handles the user opening the drawer again before the close animation completes.

Everything else inside `renderTranscriptDrawer()` (the error / list / pending rendering and `transcriptDrawerEl.scrollTop = …` line) stays the same.

### 8.5 Focus rings

```css
#pillarRail .pillar:focus-visible,
.icon-btn:focus-visible,
#recToggle:focus-visible,
.speaker:focus-visible,
#transcriptToggle:focus-visible {
  outline: 2px solid var(--system-accent);
  outline-offset: 2px;
  border-radius: var(--radius-control);
}
```

`--system-accent` defaults to `rgba(255, 255, 255, 0.4)` in `tokens.css`; the main process overrides at first paint via the IPC chain in §7.3.

### 8.6 Scrollbars

Each of `#pillarRail`, `#activePillar`, `#capturedPane`, `#transcriptDrawer` may need to scroll. Style for both Firefox (`scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent`) and WebKit (`::-webkit-scrollbar { width: 6px }`, `::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 3px }`). Lives in `reset.css` once, applied via universal-ish selector targeted at our scroll containers.

### 8.7 ARIA / VoiceOver

- `#pillarRail` is `role="tablist"`, pillars are `role="tab"`, `#activePillar` is `role="tabpanel"` with `aria-live="polite"` (so newly-covered items / new flags announce).
- `#recToggle` aria-label flips between "Start recording" / "Starting" / "Stop recording" — already wired in renderer's `setStatus()`.
- `#transcriptToggle` `aria-expanded` flips with the drawer state (already wired).
- `#transcriptError` is `role="alert"` so any error message is announced.
- `.captured__pair` is decorative but each label/value is real text and keyboard-traversable.

### 8.8 Keyboard shortcuts (existing in renderer.js, retained)

- `Enter` → click `#recToggle` (start/stop recording).
- `Escape` → if drawer open, close it; else if not on `live_signals`, return to `live_signals`.
- `Cmd+W` → close window (system menu).
- `Cmd+Shift+H` → toggle visibility (global shortcut, registered in main.js).

## 9. Manual test plan

### Visual

- Open Notes / Safari behind the overlay; content visibly blurs through the glass.
- Resize the window in all directions; active pillar grows / shrinks, captured pane stays in its 240–320 band, rail stays at 52, footer stays at 52.
- At minimum size 580×440 the rail scrolls vertically to reach hidden pillars; the other panes scroll as needed.
- All 14 pillar buttons render with correct glyphs (single text characters — no colour emoji).
- Selected pillar shows the green left-edge accent bar and bg tint; in-progress pillars show amber dots; complete pillars show green dots.
- Click each pillar; active pillar pane updates (header counter, body content).
- Listening state: rec indicator pulses green; Stop button is green; speaker pill "You" tints green when speaking.
- Live signals view: red flag rows have red bars and red kind badges; green flag rows have green bars and green kind badges.
- Captured pane shows all 6 groups; populated values appear right-aligned, empty values show em-dash in tertiary.
- Footer hover states on the three icon buttons show subtle background fills.
- Change macOS accent color (System Settings → Appearance); focus a control with Tab; outline updates live to the new accent.
- Trigger the transcript drawer; it slides up, the body region visibility hides behind it, the footer dims to 0.5 opacity.

### Accessibility

- Enable Reduce Motion in System Settings → Accessibility → Display. Confirm: no pulse, no item-tick transition, no drawer slide, no fade on Cmd+Shift+H.
- Enable Reduce Transparency. Confirm: card becomes opaque dark surface, vibrancy is no longer visible.
- VoiceOver: tab through pillars → active pillar items → captured fields → footer buttons. Confirm all are announced sensibly with role / state.
- Fire a coaching flag while the drawer is closed; confirm the live region announcement is heard.
- Trigger an error state; confirm the alert is announced.

### Functional (regression — must still work)

- `Enter` toggles record start/stop.
- `Escape` closes the drawer, or returns to `live_signals`.
- `Cmd+W` closes the window cleanly.
- `Cmd+Shift+H` toggles visibility (with fade unless Reduce Motion is on).
- `Cmd+Q` quits the app; no orphaned single-instance lock on relaunch.
- Mic permission flow on first launch works; mic-denied error surfaces in the drawer.
- All three scoring IPC channels (`scoring:flag`, `scoring:item`, `scoring:field`) update the UI live.

## 10. Open questions / future work

Deliberately deferred:

- **Window size + position persistence between launches.** Trivially adds via `electron-store` or simple JSON in `app.getPath('userData')`. Not yet wanted.
- **Compact mode at small widths.** A `[data-compact]` attribute on `#coach` could collapse the captured pane to icon-only or hide it entirely below e.g. 540 px width. Out of scope for now.
- **User-draggable column dividers.** Would require an extra ResizeObserver + drag-handle CSS. Out of scope.
- **Light-mode adaptation.** Architecture supports it; not implemented now.
- **Settings panel** (API key UI, mic device picker). Second BrowserWindow when introduced; would add `src/styles/settings.css` consuming the same tokens.
- **Transcript history / search / export.** Persistent storage; not scoped.
- **App icon / dock icon** design.
- **Category scoring** (`record_category_score` tool, per `rubric.js` extension comment). When added, the new pillar header content would consume the same tokens.
- **Traffic-light window controls.** Only if user feedback shows the custom × is missed.

## 11. Implementation summary

- **Create:** `src/styles/tokens.css`, `src/styles/reset.css`, `src/styles/coach.css`, `src/styles/rail.css`, `src/styles/active-pillar.css`, `src/styles/captured.css`, `src/styles/footer.css`, `src/styles/drawer.css`.
- **Rewrite:** `index.html` per §5.1.
- **Delete:** `src/index.css`.
- **Modify:**
  - `src/main.js` — add vibrancy + visualEffectState, accent IPC (`system:accent` send + listen), Cmd+Shift+H fade animation, `resizable: true`, `minWidth: 580`, `minHeight: 440`, update WINDOW_HEIGHT constant from 440 to 580.
  - `src/preload.js` — subscribe to `system:accent`, expose `window.system.onAccent`.
  - `src/renderer.js` — replace `import './index.css'` with the eight new imports; add `window.system.onAccent` listener at module init; replace the existing single-line `transcriptDrawerEl.hidden = !state.transcriptOpen` inside `renderTranscriptDrawer()` with the open/close ordering described in §8.4.

Estimated total: ~670 lines added across eight new CSS files, ~110 lines added/changed across main / preload / renderer / index.html, ~760 lines deleted (old `index.css`).
