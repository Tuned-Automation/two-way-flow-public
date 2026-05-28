import './index.css';
import {
  PILLARS,
  PILLARS_BY_ID,
  ITEMS,
  ITEMS_BY_PILLAR,
  ITEMS_BY_ID,
  FIELDS_BY_ID,
  CAPTURED_FIELDS,
  FIELD_GROUPS,
  FLAGS_BY_ID,
  SUGGESTION_SENTINEL_ITEM_IDS,
} from './rubric.js';

/** Rubric declaration index — lets us sort runtime collections (e.g.
 *  the Logged pillar's item list) into stable rubric order. */
const ITEM_DECLARATION_INDEX = Object.fromEntries(
  ITEMS.map((it, i) => [it.id, i]),
);

/* ── Coach history behaviour ───────────────────────────────────────── */
const COACH_HISTORY_MAX = 50;

/* v2.5 redesign: coach interaction mode.
 *
 *   'signalled' (default) — coach never auto-suggests; rep drives via
 *                           the three ask buttons or Skip.
 *   'automated'           — same as signalled, plus a pause-triggered
 *                           nudge when both speakers go quiet for ≥6s.
 *
 * Persisted in localStorage under `coach.mode`. Read once at startup
 * and applied to the toggle UI; written every time the user flips
 * the toggle. Forwarded to main via window.gemini.setCoachMode on
 * session start AND on every flip so the pause detector stays in
 * sync without restarting the session.
 */
const COACH_MODE_LS_KEY = 'coach.mode';
const COACH_MODE_DEFAULT = 'signalled';
const VALID_COACH_MODES = new Set(['signalled', 'automated']);

function readSavedCoachMode() {
  try {
    const v = localStorage.getItem(COACH_MODE_LS_KEY);
    return VALID_COACH_MODES.has(v) ? v : COACH_MODE_DEFAULT;
  } catch {
    return COACH_MODE_DEFAULT;
  }
}

function persistCoachMode(mode) {
  try { localStorage.setItem(COACH_MODE_LS_KEY, mode); } catch { /* private mode */ }
}

/** Set of sentinel item ids the coach can emit for non-rubric
 *  suggestions. Currently only 'freeform.deeper' (Deeper-kind asks
 *  whose natural follow-up doesn't map to any rubric item). The
 *  renderer treats these as opaque — no pillar lookup, no rubric
 *  badge — so the suggestion card still renders the question + anchor
 *  quote without crashing on a failed ITEMS_BY_ID lookup. */
const SUGGESTION_SENTINEL_SET = new Set(SUGGESTION_SENTINEL_ITEM_IDS);

/**
 * Renderer entry — transcript-first rubric coach overlay.
 *
 * Pipeline when "listening":
 *   getUserMedia → MediaStreamAudioSourceNode
 *     ├─ AnalyserNode  → speaker-activity heuristic (RMS threshold)
 *     └─ AudioWorkletNode (pcm-worklet) → IPC → Gemini Live
 *
 * Inbound IPC:
 *   gemini:*  — transcripts (now always-visible in the middle column),
 *               errors
 *   scoring:flag       → state.flags
 *   scoring:item-state → state.itemStates[itemId]   (4-state lifecycle:
 *                          pending / in_progress / covered / logged)
 *   scoring:field      → state.capturedFields[fieldId]
 *   coach:tick-start / coach:tick-end → state.coachThinking
 *
 * Outbound IPC (renderer → main):
 *   coach:skip   — seller pressed → at the live edge of suggestion history
 *   coach:boost  — seller clicked a logged item; resurface it as next
 *
 * Layout (v2):
 *   - Left rail: pillar icons (clicking opens the rail overlay).
 *   - Middle: always-visible transcript scroll buffer + suggestion pinned
 *     at the bottom + thinking-dot.
 *   - Right: captured fields (unchanged).
 *   - Slide-over rail overlay sits above the transcript pane (hidden by
 *     default; opens on pillar click, closes on Esc / backdrop click).
 *
 * Rendering is one-way: render functions are pure over `state`. Anything
 * that mutates `state` calls the relevant render fn at the end.
 */

const PCM_WORKLET_URL = './pcm-worklet.js';

/** RMS thresholds for "is the user speaking" — calibrated for normal voice. */
const SPEAKER_RMS_ON = 0.04;
const SPEAKER_RMS_OFF_AFTER_MS = 600;
const LEVEL_GAIN = 3;

/* ── DOM refs ──────────────────────────────────────────────────────── */

const coachEl = document.getElementById('coach');
const coachBodyEl = document.querySelector('.coach__body');
const recIndicatorEl = document.getElementById('recIndicator'); // eslint-disable-line no-unused-vars
const recTimerEl = document.getElementById('recTimer');
const speakerEls = Array.from(document.querySelectorAll('.speaker'));
const aecBadgeEl = document.getElementById('aecBadge');
const connectionStatusEl = document.getElementById('connectionStatus');
const versionBadgeEl = document.getElementById('versionBadge');
const recToggleEl = document.getElementById('recToggle');
const minButtonEl = document.getElementById('minButton');
const closeButtonEl = document.getElementById('closeButton');
const railEl = document.getElementById('pillarRail');
const transcriptPaneEl = document.getElementById('transcriptPane');
const transcriptListEl = document.getElementById('transcriptList');
const transcriptErrorEl = document.getElementById('transcriptError');
const transcriptFooterEl = document.querySelector('.transcript-pane__footer');

/* "Stick to bottom" follow behaviour for the transcript list.
 *
 * Classic chat-app pattern: new lines auto-scroll to the bottom ONLY
 * if the user is already "near" the bottom. If they scroll up to
 * read earlier turns, we freeze the view; scrolling back near the
 * bottom resumes the follow.
 *
 *   stickToBottomTranscript — module-scope flag. true = follow the
 *                             live edge; false = the user has
 *                             scrolled away and we leave the view
 *                             alone.
 *
 *   STICK_TO_BOTTOM_THRESHOLD_PX — distance-from-bottom under which
 *                                  the listener flips the flag
 *                                  back on. 80px ≈ ~3 lines, generous
 *                                  enough that a small upward nudge
 *                                  doesn't break the follow.
 *
 * Wiring (see snapTranscriptToBottomIfStuck + the one-time listener
 * mount just below renderTranscriptPane):
 *   - scroll listener on transcriptListEl  →  recomputes the flag
 *     on every user scroll. Programmatic scrollTop writes also
 *     bounce through this listener, but they always re-confirm
 *     distance ≈ 0 so the flag stays true.
 *   - ResizeObserver on transcriptListEl   →  re-snaps to the bottom
 *     whenever the visible height changes (drawer drag, captured
 *     splitter, window resize). If we WERE stuck we stay stuck;
 *     otherwise the existing scroll position is preserved.
 *   - clearScoringState                    →  resets the flag to
 *     true on session start/reset so a fresh call begins in follow
 *     mode regardless of where the previous session ended up.
 */
let stickToBottomTranscript = true;
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;
const coachSuggestionEl = document.getElementById('coachSuggestion');
const coachThinkingDotEl = document.getElementById('coachThinkingDot');
const capturedPaneEl = document.getElementById('capturedPane');
const capturedTooltipEl = document.getElementById('capturedTooltip');

/* v3 resizable panes (see plan: resizable_internal_panes_4bf4f174):
 * three splitter <div>s flank the rail / transcript / captured grid
 * tracks on .coach__body, plus one inside .transcript-pane between
 * the list and the pinned drawer footer. mountSplitter() below wires
 * pointer-drag, dblclick reset, and keyboard nudge for each. */
const splitterRailEl = document.getElementById('splitterRail');
const splitterCapturedEl = document.getElementById('splitterCaptured');
const splitterDrawerEl = document.getElementById('splitterDrawer');
/* Strategy A / Work-stream C: Quick-fix rollup card.
 *
 * Lives at the top of #capturedPane in index.html (rather than being
 * built lazily) so the renderer can manage its visibility + content
 * without having to splice it in/out of the captured pane's
 * replaceChildren flow. Populated by renderQuickFix() on every
 * scoring:quick-fix IPC; hidden when no rollup is available. */
const quickFixEl = document.getElementById('quickFix');
const railOverlayEl = document.getElementById('railOverlay');
const railOverlayHeaderEl = document.getElementById('railOverlayHeader');
const railOverlayBodyEl = document.getElementById('railOverlayBody');

/* Speaker-bleed hint banner (one-shot per session). See the
 * recentDedupDrops doc-block below for the trigger logic. */
const dedupHintBannerEl = document.getElementById('dedupHintBanner');
const dedupHintDismissEl = document.getElementById('dedupHintDismiss');

/* Phase 4: Screen Recording permission modal. */
const permissionModalEl = document.getElementById('permissionModal');
const permissionRetryBtnEl = document.getElementById('permissionRetry');
const permissionContinueBtnEl = document.getElementById('permissionContinue');
const permissionOpenSettingsBtnEl = document.getElementById('permissionOpenSettings');

/* v2.5 redesign: coach interaction mode toggle + ask buttons. */
const coachModeToggleEl = document.getElementById('coachModeToggle');
const coachModeBtnEls = coachModeToggleEl
  ? Array.from(coachModeToggleEl.querySelectorAll('.mode-toggle__btn'))
  : [];
const askBtnEls = Array.from(document.querySelectorAll('.ask-btn'));

/* Phase 5: post-call summary modal. */
const summaryModalEl = document.getElementById('summaryModal');
const summaryDurationEl = document.getElementById('summaryDuration');
const summaryCloseXEl = document.getElementById('summaryCloseX');
const summaryTabEls = Array.from(document.querySelectorAll('.summary-modal__tab'));
const summaryPanelEls = {
  scorecard: document.getElementById('summaryPanelScorecard'),
  facts: document.getElementById('summaryPanelFacts'),
  transcript: document.getElementById('summaryPanelTranscript'),
  debrief: document.getElementById('summaryPanelDebrief'),
};
const summaryCopyJsonEl = document.getElementById('summaryCopyJson');
const summaryCopyMdEl = document.getElementById('summaryCopyMd');
const summarySaveEl = document.getElementById('summarySave');
const summaryCloseEl = document.getElementById('summaryClose');
const summaryToastEl = document.getElementById('summaryToast');

/* Settings modal (v3 — six tabs after Phase 1 of the Settings
 * expansion: Providers / Audio / Appearance / Coach / General /
 * Help). The form is auto-saved on idle / blur / segmented click —
 * no Save button. Lookup is by id / data-attribute so the renderer
 * keeps working as long as the markup contract holds. Audio and Help
 * tabs are intentionally empty stubs in Phase 1; General hosts the
 * Data subsection (export / import / reset).
 *
 * Element lookups
 *   - settingsModalEl                 the <dialog>
 *   - settingsModalCloseEl            the × button
 *   - settingsTabEls                  the 6 tab buttons (Providers /
 *                                     Audio / Appearance / Coach /
 *                                     General / Help)
 *   - settingsTabContentEls           the 6 <section data-tab-content>
 *                                     panels they switch between
 *   - settingsDefaultProviderEl       the segmented control wrapper
 *   - settingsProviderCardEls         the 3 .provider-card articles
 *   - PROVIDER_IDS                    canonical id list — order
 *                                     matters only for keyboard nav
 *                                     across the segmented buttons.
 */
const PROVIDER_IDS = ['anthropic', 'gemini', 'openai'];

const settingsButtonEl = document.getElementById('settingsButton');
const settingsModalEl = document.getElementById('settingsModal');
const settingsModalCloseEl = document.getElementById('settingsModalClose');
const settingsTabEls = Array.from(document.querySelectorAll('.settings-modal__tab'));
const settingsTabContentEls = Array.from(
  document.querySelectorAll('.settings-modal [data-tab-content]'),
);
const settingsDefaultProviderEl = document.getElementById('settingsDefaultProvider');
const settingsDefaultProviderBtnEls = settingsDefaultProviderEl
  ? Array.from(settingsDefaultProviderEl.querySelectorAll('.provider-segmented__btn'))
  : [];
const settingsProviderCardEls = Array.from(
  document.querySelectorAll('.provider-card[data-provider]'),
);

/* Coach tab — behaviour toggles (renamed from "Advanced" in schema
 * v3). Both default OFF; the renderer reads the persisted values out
 * of settingsCache on first modal open and re-renders the drawer
 * whenever they change. */
const settingsCoachTrackEl = document.getElementById('coachTrackQuestionState');
const settingsCoachAutoReformulateEl = document.getElementById('coachAutoReformulate');

/* Audio tab (Phase 2) — capture device pickers, AEC/NS/AGC toggles,
 * Deepgram model select, hide-AEC-badge toggle, and the
 * "applies on next Start" hint. The autosave helpers below wire
 * each control to its `audio.*` field path; the dropdown populators
 * (enumerateDevices + listAudioSources) hydrate on first modal open
 * and on Refresh-button clicks.
 *
 * Caveats live in code comments adjacent to each control:
 *   - Mic device ID: getUserMedia falls back to OS default if the
 *     persisted device unplugs. See micPickerPopulate().
 *   - AEC toggle: Chromium command-line force-switches in
 *     [src/main.js](src/main.js) lines 72–76 may override
 *     `echoCancellation: false` on some platforms. The toggle's
 *     sub-text surfaces this.
 *   - Deepgram model: NOT hot-swappable mid-call; the WS query
 *     string bakes at connect time. The applyHint surfaces this. */
const audioMicSelectEl = document.getElementById('audioMicDevice');
const audioMicRefreshBtnEl = document.getElementById('audioMicRefresh');
const audioSysSourceSelectEl = document.getElementById('audioSysSource');
const audioSysRefreshBtnEl = document.getElementById('audioSysRefresh');
const audioAecEl = document.getElementById('audioAec');
const audioNoiseSuppressionEl = document.getElementById('audioNoiseSuppression');
const audioAutoGainControlEl = document.getElementById('audioAutoGainControl');
const audioDeepgramModelEl = document.getElementById('audioDeepgramModel');
const audioHideAecBadgeEl = document.getElementById('audioHideAecBadge');
const audioApplyHintEl = document.getElementById('audioApplyHint');

/* General → Data subsection (Phase 1: Reset / Export / Import).
 * Refs are eager so the wiring below can register listeners
 * unconditionally — missing elements simply skip via the
 * instanceof guards. */
const settingsExportBtnEl = document.getElementById('settingsExportBtn');
const settingsExportIncludeKeysEl = document.getElementById('settingsExportIncludeKeys');
const settingsImportBtnEl = document.getElementById('settingsImportBtn');
const settingsResetBtnEl = document.getElementById('settingsResetBtn');

/* Reset confirmation dialog (#settingsResetConfirm) — siblings of
 * #settingsModal so showModal() puts them on the top layer above. */
const settingsResetConfirmEl = document.getElementById('settingsResetConfirm');
const settingsResetCancelEl = document.getElementById('settingsResetCancel');
const settingsResetConfirmBtnEl = document.getElementById('settingsResetConfirmBtn');
const settingsResetPreserveKeysEl = document.getElementById('settingsResetPreserveKeys');

/* Import preview dialog (#settingsImportPreview). The renderer
 * populates the source path, error message, and diff body before
 * showing it. */
const settingsImportPreviewEl = document.getElementById('settingsImportPreview');
const settingsImportSourceEl = document.getElementById('settingsImportSource');
const settingsImportErrorEl = document.getElementById('settingsImportError');
const settingsImportDiffEl = document.getElementById('settingsImportDiff');
const settingsImportCancelEl = document.getElementById('settingsImportCancel');
const settingsImportApplyEl = document.getElementById('settingsImportApply');

/* Appearance tab — speaker-label colour pickers + reset. Refs are
 * captured eagerly because the initial-render path applies the
 * persisted colours BEFORE the user ever opens the modal (see the
 * `ensureSettingsLoaded()` call at the bottom of this file). The
 * DEFAULT_TAG_* constants must match
 * DEFAULT_SETTINGS.appearance.tagColors in src/settings.js. */
const appearanceColorYouEl = document.getElementById('appearanceColorYou');
const appearanceColorOtherEl = document.getElementById('appearanceColorOther');
const appearanceResetBtnEl = document.getElementById('appearanceResetBtn');
const DEFAULT_TAG_YOU = '#f0f0f0';
const DEFAULT_TAG_OTHER = '#c7d2fe';

/* ── Per-surface transparency editor (Appearance tab) ──────────────
 *
 * Four controllable overlay surfaces, each with three numeric
 * alpha channels (outline / body / text) backed by a CSS variable
 * (--surface-<surface>-<channel>-alpha) consumed by src/index.css's
 * color-mix(...) rules. Sliders drive CSS vars synchronously for
 * live preview and queue a 200 ms debounced settings.save into
 * appearance.transparency.* for persistence.
 *
 * DEFAULT_TRANSPARENCY MUST stay in sync with
 * DEFAULT_SETTINGS.appearance.transparency in src/settings.js. The
 * renderer reads these for the Reset Surface button so the user
 * doesn't pay an IPC roundtrip for "snap this surface back to
 * default" — values are identical to what main would write anyway.
 */
const TRANSPARENCY_SURFACES = ['coach', 'transcript', 'captured', 'suggestion'];
const TRANSPARENCY_CHANNELS = ['outline', 'body', 'text'];
const DEFAULT_TRANSPARENCY = {
  coach:      { outline: 0,    body: 0.9,  text: 0.94 },
  transcript: { outline: 0.08, body: 0.03, text: 0.94 },
  captured:   { outline: 0.08, body: 0.03, text: 0.66 },
  suggestion: { outline: 0.08, body: 0.10, text: 0.94 },
};
const DEFAULT_TRANSPARENCY_PRESETS = {
  slot1: { name: 'Day' },
  slot2: { name: 'Night' },
  slot3: { name: 'Demo' },
};

const transparencySurfaceEl = document.getElementById('transparencySurface');
const transparencyPreviewBtnEl = document.getElementById('transparencyPreviewBtn');
const transparencyResetSurfaceEl = document.getElementById('transparencyResetSurface');
const transparencySliderEls = {
  outline: document.getElementById('transparencyOutline'),
  body: document.getElementById('transparencyBody'),
  text: document.getElementById('transparencyText'),
};
const transparencyValueEls = {
  outline: document.getElementById('transparencyOutlineValue'),
  body: document.getElementById('transparencyBodyValue'),
  text: document.getElementById('transparencyTextValue'),
};
const transparencyPresetEls = Array.from(
  document.querySelectorAll('.transparency-preset[data-preset-slot]'),
);
/** Track whether the preview window is currently open. Toggled
 *  optimistically on Open / Close clicks; reset on IPC failure. */
let transparencyPreviewOpen = false;

/* ── Layout persistence (v3 — resizable panes) ────────────────────
 *
 * Per-device display preference, NOT exportable settings — a wide-
 * monitor user's 600px captured pane is wrong on a 13" laptop, so
 * pane sizes deliberately do NOT round-trip through src/settings.js.
 * Stored under localStorage `twf.layout.v1`; bumping to v2 in a
 * future plan lets us drop saved values cleanly if the shape
 * changes.
 *
 * Shape:
 *   {
 *     railWidth: number,             // px on .coach__body --rail-w
 *     capturedWidth: number,         // px on .coach__body --captured-w
 *     drawerHeight: number | null,   // px on .transcript-pane
 *                                    // --drawer-h; null = "auto"
 *     lastNonZeroDrawerHeight: number // saved separately so a new
 *                                    // coach:suggestion can auto-
 *                                    // pop the drawer back open
 *                                    // when the user collapsed it
 *                                    // to 0 — explicit user ask:
 *                                    // don't miss new suggestions.
 *   }
 *
 * Clamp ranges (kept in sync with the .coach__body grid-template-
 * columns rule in src/index.css):
 *
 *   --rail-w        60–240px   (default 60; collapsed icons; >~140px
 *                                reveals .pillar__label via a
 *                                container query on .rail)
 *   --captured-w    160–dyn    (default 200; dyn-max =
 *                                bodyWidth − rail − 360 − 8)
 *   --drawer-h      0–280px    (default unset = auto / content-driven)
 */
const LAYOUT_STORAGE_KEY = 'twf.layout.v1';
const LAYOUT_DEFAULTS = Object.freeze({
  railWidth: 60,
  capturedWidth: 200,
});
const RAIL_W_MIN = 60;
const RAIL_W_MAX = 240;
const CAPTURED_W_MIN = 160;
const TRANSCRIPT_W_FLOOR = 360;
const COL_SPLITTER_SLACK = 8; // 2 col-splitters × 4px
const DRAWER_H_MIN = 0;
const DRAWER_H_MAX = 280;
/* Minimum visible transcript-list height the drawer is allowed to
 * crowd down to. Pairs with the `max-height: calc(100% - 80px)`
 * cap on .transcript-pane__footer in src/index.css — both numbers
 * MUST stay in sync. ~80px ≈ 3 lines of transcript + the 4px row
 * splitter, which is the minimum the user can still read while
 * keeping the drawer pinned at the bottom. */
const DRAWER_LIST_MIN_H = 80;
/* Epsilon for "the drawer is effectively collapsed" — anything ≤1px
 * counts as 0 so a hairline rounded-down value still triggers the
 * auto-pop on the next coach:suggestion. */
const DRAWER_COLLAPSE_EPSILON = 1;

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLayout(patch) {
  const next = { ...loadLayout(), ...patch };
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / disabled — non-fatal, sizes just won't persist */
  }
}

/* Apply BEFORE first paint to avoid a width flash on boot. Runs
 * synchronously here (script is type=module mounted at end of body
 * so all referenced DOM nodes exist). The CSS defaults on
 * .coach__body / .transcript-pane already render an indistinguishable
 * layout if no values are stored. */
(function applyLayoutFromStorage() {
  if (!coachBodyEl) return;
  const saved = loadLayout();
  if (Number.isFinite(saved.railWidth)) {
    const v = Math.max(RAIL_W_MIN, Math.min(RAIL_W_MAX, saved.railWidth));
    coachBodyEl.style.setProperty('--rail-w', `${v}px`);
  }
  if (Number.isFinite(saved.capturedWidth)) {
    /* Lower clamp only here; the dynamic upper clamp depends on the
     * live body width which isn't reliable pre-paint, so we let the
     * splitter re-clamp on its first drag. */
    const v = Math.max(CAPTURED_W_MIN, saved.capturedWidth);
    coachBodyEl.style.setProperty('--captured-w', `${v}px`);
  }
  if (transcriptPaneEl && Number.isFinite(saved.drawerHeight)) {
    const v = Math.max(DRAWER_H_MIN, Math.min(DRAWER_H_MAX, saved.drawerHeight));
    transcriptPaneEl.style.setProperty('--drawer-h', `${v}px`);
  }
})();

/* Single-call splitter mounter. One DOM element per seam, identical
 * mechanic for col-resize and row-resize.
 *
 * Behaviour:
 *   - pointerdown  → snapshot start coord + start px, setPointerCapture,
 *                    data-dragging='true' so the hover tint stays locked.
 *   - pointermove  → compute delta (× invert), clamp to [min, max()],
 *                    write the css var on targetEl.
 *   - pointerup    → release capture, persist.
 *   - dblclick     → reset to resetPx (or remove the var when
 *                    resetPx is null, restoring "auto" behaviour for
 *                    --drawer-h).
 *   - keydown      → ArrowKeys ±16px (Shift ×4), Home/End → min/max.
 *
 * `getCurrentPx()` returns the LIVE px (read from DOM rather than
 * the css var) so dragging always starts from what the user sees,
 * even when the var is unset ("auto" drawer height) or being shaped
 * by the container.
 *
 * `max` can be a callable: the captured splitter's upper bound
 * depends on .coach__body.clientWidth − rail − transcript_floor − two
 * col-splitter widths, all computed on each drag step.
 *
 * `invert` reverses the drag direction so the wiring stays
 * consistent: ArrowRight / ArrowDown always means "move the
 * separator that direction" — for the rail splitter that grows
 * --rail-w; for the captured splitter that shrinks --captured-w;
 * for the drawer splitter that shrinks --drawer-h. */
function mountSplitter({
  el,
  axis, // 'col' | 'row'
  cssVar, // '--rail-w' | '--captured-w' | '--drawer-h'
  targetEl, // .coach__body for col, .transcript-pane for row
  min,
  max,
  invert,
  resetPx, // number | null (null = remove var → auto / content-driven)
  persistKey, // 'railWidth' | 'capturedWidth' | 'drawerHeight'
  getCurrentPx,
}) {
  if (!el || !targetEl) return;

  const resolveMax = () => (typeof max === 'function' ? max() : max);
  const clamp = (v) => Math.max(min, Math.min(resolveMax(), v));

  function writePx(px) {
    const rounded = Math.round(px);
    targetEl.style.setProperty(cssVar, `${rounded}px`);
    el.setAttribute('aria-valuenow', String(rounded));
  }

  function persist(px) {
    const rounded = Math.round(px);
    const patch = { [persistKey]: rounded };
    /* Track the user's last expanded drawer height so a fresh
     * coach:suggestion can auto-pop the drawer back open when it's
     * currently collapsed to 0 — explicit user ask: don't miss new
     * suggestions because the drawer is hidden. See
     * autoPopDrawerIfCollapsed() below. */
    if (cssVar === '--drawer-h' && rounded > DRAWER_COLLAPSE_EPSILON) {
      patch.lastNonZeroDrawerHeight = rounded;
    }
    saveLayout(patch);
  }

  /* Initial ARIA attributes — min/max are stable, valuenow is
   * written on every drag / reset / nudge. For callable maxes
   * we hand back a stable absolute ceiling per axis (rather than
   * the live dynamic value) so AT sees a meaningful range; the
   * drawer needs its own branch now that its `max` is a function. */
  el.setAttribute('aria-valuemin', String(min));
  const ariaMax = typeof max === 'function'
    ? (cssVar === '--drawer-h' ? DRAWER_H_MAX : RAIL_W_MAX)
    : max;
  el.setAttribute('aria-valuemax', String(ariaMax));
  const initial = getCurrentPx?.() ?? 0;
  if (Number.isFinite(initial)) el.setAttribute('aria-valuenow', String(Math.round(initial)));

  let startCoord = 0;
  let startPx = 0;
  let activePointerId = null;

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    activePointerId = ev.pointerId;
    try { el.setPointerCapture(ev.pointerId); } catch { /* swallow */ }
    el.dataset.dragging = 'true';
    startCoord = axis === 'col' ? ev.clientX : ev.clientY;
    startPx = typeof getCurrentPx === 'function' ? getCurrentPx() : 0;
    ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== activePointerId) return;
    const cur = axis === 'col' ? ev.clientX : ev.clientY;
    const rawDelta = cur - startCoord;
    const delta = invert ? -rawDelta : rawDelta;
    writePx(clamp(startPx + delta));
  });

  function endDrag(ev) {
    if (ev.pointerId !== activePointerId) return;
    activePointerId = null;
    el.removeAttribute('data-dragging');
    try { el.releasePointerCapture(ev.pointerId); } catch { /* swallow */ }
    const live = typeof getCurrentPx === 'function' ? getCurrentPx() : 0;
    persist(live);
  }
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  el.addEventListener('dblclick', () => {
    if (resetPx === null || resetPx === undefined) {
      /* Drawer-only path: remove the var so the footer falls back to
       * its content-driven height ("auto" per the user decision). */
      targetEl.style.removeProperty(cssVar);
      saveLayout({ [persistKey]: null });
      el.removeAttribute('aria-valuenow');
      return;
    }
    const v = clamp(resetPx);
    writePx(v);
    persist(v);
  });

  el.addEventListener('keydown', (ev) => {
    const big = ev.shiftKey ? 64 : 16;
    if (ev.key === 'Home') {
      writePx(min);
      persist(min);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'End') {
      const m = resolveMax();
      writePx(m);
      persist(m);
      ev.preventDefault();
      return;
    }
    let raw = 0;
    if (axis === 'col') {
      if (ev.key === 'ArrowRight') raw = +big;
      else if (ev.key === 'ArrowLeft') raw = -big;
    } else {
      if (ev.key === 'ArrowDown') raw = +big;
      else if (ev.key === 'ArrowUp') raw = -big;
    }
    if (raw === 0) return;
    ev.preventDefault();
    const delta = invert ? -raw : raw;
    const current = typeof getCurrentPx === 'function' ? getCurrentPx() : 0;
    const next = clamp(current + delta);
    writePx(next);
    persist(next);
  });
}

/* Captured-pane dynamic upper bound. Re-computed on every drag / End
 * keystroke. Floor = TRANSCRIPT_W_FLOOR + two col-splitters; the
 * remainder goes to the captured pane. With WINDOW_MIN_WIDTH=960 in
 * src/main.js this guarantees a comfortable max of >=540 even at the
 * window floor. */
function dynamicCapturedMax() {
  if (!coachBodyEl) return 600;
  const bodyW = coachBodyEl.clientWidth || 0;
  const railW = Number.parseFloat(getComputedStyle(coachBodyEl).getPropertyValue('--rail-w')) || RAIL_W_MIN;
  const m = bodyW - railW - TRANSCRIPT_W_FLOOR - COL_SPLITTER_SLACK;
  return Math.max(CAPTURED_W_MIN, m);
}

/* Rail dynamic upper bound mirrors the captured logic, but the rail
 * has a hard CSS cap at RAIL_W_MAX so it's just the lesser of the
 * two. Keeps the rail from eating the transcript when the user pulls
 * it very wide on a narrow window. */
function dynamicRailMax() {
  if (!coachBodyEl) return RAIL_W_MAX;
  const bodyW = coachBodyEl.clientWidth || 0;
  const capturedW = Number.parseFloat(getComputedStyle(coachBodyEl).getPropertyValue('--captured-w')) || LAYOUT_DEFAULTS.capturedWidth;
  const m = bodyW - capturedW - TRANSCRIPT_W_FLOOR - COL_SPLITTER_SLACK;
  return Math.max(RAIL_W_MIN, Math.min(RAIL_W_MAX, m));
}

/* Drawer dynamic upper bound. The static DRAWER_H_MAX (=280) is a
 * sane absolute ceiling on tall windows, but on a short window the
 * footer would still push past the visible pane bottom if we let
 * the user drag past `paneHeight - DRAWER_LIST_MIN_H`. This is
 * exactly the same bound enforced by the
 * `max-height: calc(100% - 80px)` rule on .transcript-pane__footer
 * in src/index.css — having it in BOTH places means: the splitter
 * never lets the user *try* to push the drawer past the cap (UI
 * feels honest), and the CSS guards against any stale --drawer-h
 * value that was saved when the window was tall. */
function dynamicDrawerMax() {
  if (!transcriptPaneEl) return DRAWER_H_MAX;
  const paneH = transcriptPaneEl.clientHeight || 0;
  const headroom = paneH - DRAWER_LIST_MIN_H;
  return Math.max(DRAWER_H_MIN, Math.min(DRAWER_H_MAX, headroom));
}

/* Live DOM-driven readbacks for "where is the splitter currently".
 * Read the rendered geometry rather than the CSS var so the value
 * is correct even when the var is unset (drawer in its content-
 * driven "auto" state). */
const getRailCurrentPx = () => (railEl ? railEl.getBoundingClientRect().width : LAYOUT_DEFAULTS.railWidth);
const getCapturedCurrentPx = () => (capturedPaneEl ? capturedPaneEl.getBoundingClientRect().width : LAYOUT_DEFAULTS.capturedWidth);
const getDrawerCurrentPx = () => (transcriptFooterEl ? transcriptFooterEl.getBoundingClientRect().height : 0);

mountSplitter({
  el: splitterRailEl,
  axis: 'col',
  cssVar: '--rail-w',
  targetEl: coachBodyEl,
  min: RAIL_W_MIN,
  max: dynamicRailMax,
  invert: false, // drag right grows --rail-w
  resetPx: LAYOUT_DEFAULTS.railWidth,
  persistKey: 'railWidth',
  getCurrentPx: getRailCurrentPx,
});

mountSplitter({
  el: splitterCapturedEl,
  axis: 'col',
  cssVar: '--captured-w',
  targetEl: coachBodyEl,
  min: CAPTURED_W_MIN,
  max: dynamicCapturedMax,
  invert: true, // drag right shrinks --captured-w
  resetPx: LAYOUT_DEFAULTS.capturedWidth,
  persistKey: 'capturedWidth',
  getCurrentPx: getCapturedCurrentPx,
});

mountSplitter({
  el: splitterDrawerEl,
  axis: 'row',
  cssVar: '--drawer-h',
  targetEl: transcriptPaneEl,
  min: DRAWER_H_MIN,
  /* Was the static DRAWER_H_MAX. Switched to a function so the
   * upper bound contracts on short windows — see dynamicDrawerMax
   * doc-block. Pairs with the `max-height: calc(100% - 80px)`
   * rule on .transcript-pane__footer in src/index.css. */
  max: dynamicDrawerMax,
  invert: true, // drag down shrinks --drawer-h
  resetPx: null, // dblclick → remove var → content-driven auto
  persistKey: 'drawerHeight',
  getCurrentPx: getDrawerCurrentPx,
});

/* If the user resizes the window smaller than the saved
 * --drawer-h leaves room for, re-clamp the drawer height to the
 * new dynamic max. Without this, the saved value (eg 280 saved on
 * a 1200px window) would persist into a 440px window, the CSS
 * max-height cap would silently shrink the visible drawer to
 * pane-80, and the next drag-up would feel jumpy (the splitter
 * thinks --drawer-h is 280 but the rendered height is much less).
 * Re-clamping on resize keeps the cssVar honest. The window
 * resize fires plenty during user drags too; the `if (next < cur)`
 * guard makes this a one-way ratchet — we only ever shrink
 * --drawer-h to fit, never auto-grow it. */
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (!transcriptPaneEl) return;
    const cur = getDrawerCurrentPx();
    if (cur <= DRAWER_COLLAPSE_EPSILON) return; // drawer is already collapsed
    const cap = dynamicDrawerMax();
    if (cur > cap) {
      const next = Math.max(DRAWER_H_MIN, cap);
      transcriptPaneEl.style.setProperty('--drawer-h', `${next}px`);
      if (splitterDrawerEl) splitterDrawerEl.setAttribute('aria-valuenow', String(next));
      saveLayout({ drawerHeight: next });
    }
  });
}

/* When a new coach:suggestion IPC lands and the drawer is currently
 * collapsed (drag-shrunk to 0), restore the drawer to the user's
 * last non-zero height so the new suggestion isn't hidden behind a
 * 0px footer. Explicit user decision: don't miss new suggestions
 * because the drawer is hidden. */
function autoPopDrawerIfCollapsed() {
  if (!transcriptPaneEl) return;
  const cur = getDrawerCurrentPx();
  if (cur > DRAWER_COLLAPSE_EPSILON) return; // not collapsed; no-op
  const saved = loadLayout();
  const last = Number.isFinite(saved.lastNonZeroDrawerHeight)
    ? saved.lastNonZeroDrawerHeight
    : null;
  if (last && last > DRAWER_COLLAPSE_EPSILON) {
    const v = Math.max(DRAWER_H_MIN, Math.min(DRAWER_H_MAX, last));
    transcriptPaneEl.style.setProperty('--drawer-h', `${v}px`);
    if (splitterDrawerEl) splitterDrawerEl.setAttribute('aria-valuenow', String(v));
    saveLayout({ drawerHeight: v });
  } else {
    /* No last-non-zero remembered (user collapsed without ever
     * expanding). Fall back to "auto" by removing the var so the
     * footer at least pops to its content-driven natural size. */
    transcriptPaneEl.style.removeProperty('--drawer-h');
    if (splitterDrawerEl) splitterDrawerEl.removeAttribute('aria-valuenow');
    saveLayout({ drawerHeight: null });
  }
}

/* ── State ─────────────────────────────────────────────────────────── */

const state = {
  /** 'idle' | 'starting' | 'listening' | 'error' */
  status: 'idle',

  /* Audio pipeline — shared AudioContext + two independent capture
   * chains (mic + system loopback). Each chain has its own
   * MediaStream, MediaStreamAudioSourceNode, AnalyserNode (for the
   * speaker-activity pill), and AudioWorkletNode (which posts Int16
   * PCM back to the renderer via .port). System audio chain is
   * optional — if getDisplayMedia fails or the user opts for
   * mic-only, the `sys` fields stay null. */
  audioContext: null,
  rafId: null,

  /** Mic chain (channel 1 → salesperson). */
  mic: {
    stream: null,
    source: null,
    analyser: null,
    workletNode: null,
    analyserBuffer: null,
    lastActiveAt: 0,
  },

  /** System audio loopback chain (channel 2 → prospect). Optional. */
  sys: {
    stream: null,
    source: null,
    analyser: null,
    workletNode: null,
    analyserBuffer: null,
    lastActiveAt: 0,
  },

  /* Recording timer */
  recordingStartedAt: null,
  timerInterval: null,

  /* Active speakers (drives header pills). Each channel independently
   * lights up when its RMS crosses SPEAKER_RMS_ON; falls back to false
   * after SPEAKER_RMS_OFF_AFTER_MS of silence on that channel. With
   * dual streams both pills can be active at once during cross-talk. */
  activeSpeakers: { you: false, other: false },

  /* System-audio capture status — drives the permission modal and
   * informs the user when the prospect channel isn't being captured. */
  systemAudioStatus: 'unknown', // 'unknown' | 'capturing' | 'denied' | 'unsupported' | 'mic-only'

  /**
   * Connection-status mirror (E4 / E5). Updated by the
   * `connection:status` IPC subscriber. Drives the header pill.
   *
   *   deepgram   — 'connected' | 'reconnecting' | 'down'
   *   geminiLive — 'connected' | 'reconnecting' | 'down' | 'closed'
   *
   * 'closed' is Gemini-Live-specific — Deepgram is still canonical
   * for transcripts, so a Live close becomes a soft-degrade rather
   * than a fatal error (the renderer's `onClosed` handler in E2
   * keeps the call going). The renderer rolls these up into a
   * worst-of visual: green when both are connected, amber on any
   * reconnecting, red when both are down.
   *
   * Initial 'down' state is replaced by the first IPC broadcast
   * after a session starts (or kept as-is when the user is idle).
   */
  connection: {
    /** @type {'connected'|'reconnecting'|'down'} */
    deepgram: 'down',
    /** @type {'connected'|'reconnecting'|'down'|'closed'} */
    geminiLive: 'down',
  },

  /* Rubric UI
   * ─────────
   * `activePillarId` is the source of truth for the slide-over overlay.
   * null = closed, '<pillarId>' = open and showing that pillar.        */
  activePillarId: null,
  /** pillarId → 'idle' | 'in_progress' | 'complete' */
  pillarStatus: Object.fromEntries(PILLARS.map((p) => [p.id, 'idle'])),
  /** itemId → { state, evidence, confidence, source, at }.
   *  Absence from the map IS the implicit `pending` state. Mirrors
   *  coachContext.itemStates in main.js — fed by `scoring:item-state`. */
  itemStates: new Map(),
  /** fieldId → { value, evidence, at } */
  capturedFields: {},
  /**
   * Strategy A / Work-stream C: Stage-2 rollup mirror. Populated by
   * the `scoring:quick-fix` IPC every time the worker produces a new
   * rollup. Shape: { headlineUsdAnnual, breakdown, assumptions,
   * confidence, currency, updatedAt, stale, error } or null until
   * the first rollup lands. Read by renderQuickFix to populate the
   * static #quickFix card at the top of #capturedPane.
   */
  quickFix: null,
  /**
   * Active facts snapshot the rollup above was computed from.
   * Mirrored from the same IPC payload so the renderer's drill-
   * through (breakdown row click → scroll-to-anchor-quote in the
   * transcript pane) can look up a fact by id without having to
   * mirror the whole factsSheet in renderer state. Reset to [] when
   * a new call starts (clearScoringState).
   *
   * Entry shape mirrors src/main.js → coachContext.factsSheet.entries:
   *   { id, kind, amount, unit, period, basis, quote, recordedAt, supersedes }
   */
  quickFixEntries: [],
  /** Fired live flags in arrival order, deduped by id. */
  flags: [],

  /** Coach suggestion history in arrival order. Capped at COACH_HISTORY_MAX. */
  coachHistory: [], // SuggestionEntry[]
  /** Index into coachHistory of the displayed suggestion. -1 = none yet. */
  coachIndex: -1,
  /**
   * Per-call suggestion-history mirror, fed by `scoring:suggestion-history`
   * IPC (Coach → Track question state). Array of plain objects in
   * arrival order: { id, itemId, questionText, kind, pinnedAt, asked,
   * askedAt, evidence, replaced }. Main is the source of truth; the
   * renderer just keeps a local copy to render the logged-questions
   * drawer.
   *
   * Reset on every Stop (clearScoringState) so a new call starts with
   * an empty list.
   */
  suggestionHistory: [],
  /**
   * Coach behaviour toggles, mirrored from settings.coach. Read on
   * boot via settings:load and refreshed on settings:changed (broadcast
   * by main whenever the user flips a checkbox).
   *
   * Renamed from `state.advanced` in schema v3 to match the new "Coach"
   * tab label. The shape is unchanged — just the parent key moved.
   *
   * Drives:
   *   - Whether the logged-questions drawer applies the green
   *     outline / replaced styling to suggestion-history entries.
   *   - Whether the auto-reformulate checkbox in the Coach tab is
   *     enabled (it only makes sense when track-question-state is on).
   *
   * Both default OFF so the existing pipeline is unchanged.
   */
  coach: {
    trackQuestionState: false,
    autoReformulate: false,
  },
  /** True while a coach tick is in flight — drives the pulsing "thinking"
   *  dot next to the suggestion area. Fed by coach:tick-start / -end IPC. */
  coachThinking: false,
  /** v2.5: 'signalled' | 'automated'. Loaded from localStorage at boot
   *  (default 'signalled'); updated by the header toggle. Forwarded to
   *  main on session start AND on every flip. */
  coachMode: readSavedCoachMode(),

  /**
   * "Cover remaining" queue. Active when the seller clicks the
   * Cover-remaining button at the bottom of the pillar drawer — we
   * fire a `coach:ask-item` for each uncovered item in turn, cycling
   * to the next one whenever the seller dismisses the current pinned
   * suggestion (Skip). Cleared when:
   *   - the queue exhausts (transient "pillar coverage complete"
   *     banner shows), OR
   *   - the seller clicks any of the existing Suggest / Deeper /
   *     Pivot / Recap ask buttons (they're cancelling the queue by
   *     reaching for a different ask), OR
   *   - the session ends (clearScoringState).
   *
   * Shape: { pillarId, items: ItemDef[], index } or null when no
   * queue is active. `items` is captured at queue-start time so
   * mid-queue rubric mutations (e.g. the coach marking an item
   * covered) don't reshuffle the cycle order — the seller's "cover
   * everything that was uncovered when I pressed the button" intent
   * stays stable.
   */
  coverQueue: null,

  /**
   * Always-visible transcript scroll buffer (formerly the drawer).
   *   committed:        Array of finalised lines, each with its
   *                     speaker tag, in arrival order.
   *   pendingBySpeaker: Current in-flight partial per channel. Each
   *                     interim message from main REPLACES the slot
   *                     (Deepgram's interim_results give us the full
   *                     current segment text each time). Cleared on
   *                     the matching `finished` message.
   */
  transcript: {
    committed: [], // Array<{ speaker: 'you'|'other', text: string }>
    pendingBySpeaker: { you: '', other: '' },
  },
  errorMessage: null,

  /* Phase 5: post-call summary modal state. */
  summary: {
    /** Last `summary:ready` payload (null until first stop completes). */
    payload: null,
    /** Currently visible tab. */
    activeTab: 'scorecard',
  },
};

/* ── Cross-channel duplicate suppression (renderer mirror) ─────────────
 *
 * The canonical version of this dedupe lives in main.js
 * (handleDeepgramTranscript). We mirror it here because the renderer
 * also appends to its own committed list — without a matching guard,
 * the UI transcript pane would still show duplicates even though
 * coachContext.transcriptLines in main is clean.
 *
 * Thresholds and resolution rule are intentionally identical to main's
 * so the two views stay in lockstep — see the corresponding doc-block
 * in src/main.js for the rationale on each tuning value and the
 * "always keep PROSPECT, drop YOU" attribution bias.
 */
const RENDERER_CROSS_CHANNEL_WINDOW_MS = 5000;
const RENDERER_CROSS_CHANNEL_DEDUPE_MIN_CHARS = 3;

/** @type {{ you: { text: string, ts: number } | null, other: { text: string, ts: number } | null }} */
const recentRendererCommitBySpeaker = { you: null, other: null };

/* Mirror of main.js's DEBUG_TRANSCRIPT — flip this to `true` in the
 * renderer to log a one-line summary per commit (speaker, KEEP/DROP,
 * which side was dropped, and a 50-char preview). Off by default. */
const DEBUG_TRANSCRIPT = false;

/**
 * Module-scope state for the "speaker bleed detected" UI hint. We
 * count cross-channel drops as a proxy for "the user has speaker
 * bleed" — when enough drops accumulate in a short window we surface
 * a one-time, dismissable banner suggesting headphones. The drop
 * counter ages itself (decrement after 30 s) so a quiet stretch
 * doesn't pile up false positives across an otherwise clean call.
 */
let recentDedupDrops = 0;
let dedupHintShown = false;
const DEDUP_HINT_THRESHOLD = 5;
const DEDUP_DROP_AGE_MS = 30_000;

/** Schedule a decrement of `recentDedupDrops` 30 s after a drop fires
 *  so a brief noisy stretch followed by a quiet period doesn't keep
 *  the counter permanently warm. */
function scheduleDedupDropDecay() {
  setTimeout(() => {
    recentDedupDrops = Math.max(0, recentDedupDrops - 1);
  }, DEDUP_DROP_AGE_MS);
}

function normaliseForMatch(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Length-aware near-identity check. Mirror of main.js's
 *  isNearIdentical(); see the doc-block there for the rationale on
 *  the short-string exact-match gate. Factored out of main for
 *  clarity rather than imported — the renderer and main run in
 *  different processes so they can't share modules. */
function isNearIdentical(a, b) {
  const na = normaliseForMatch(a);
  const nb = normaliseForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // For short strings (≤12 normalised chars), require exact match only.
  // The Jaccard token check is meaningless on 1–2 token strings and
  // would catch unrelated content like "yes" vs "yeah".
  const shortLen = 12;
  if (na.length <= shortLen || nb.length <= shortLen) return false;
  if (na.length >= nb.length && na.includes(nb)) return true;
  if (nb.length >= na.length && nb.includes(na)) return true;
  const ta = new Set(na.split(/\s+/));
  const tb = new Set(nb.split(/\s+/));
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union > 0 && intersection / union >= 0.85;
}

/**
 * Renderer counterpart of main.js's findAndRemoveMatchingLine. Walks
 * backwards through a list of committed entries (`{ speaker, text }`
 * objects here, not prefixed strings) and splices out the most recent
 * entry for `speaker` whose text is near-identical to `committed`.
 * Returns true iff an entry was removed. Used by the PROSPECT-biased
 * dedup path when an incoming PROSPECT commit matches a YOU line
 * we've already shown.
 */
function findAndRemoveMatchingCommitted(list, speaker, committed, maxLookback = 4) {
  const start = list.length - 1;
  const end = Math.max(0, start - maxLookback + 1);
  for (let i = start; i >= end; i--) {
    const entry = list[i];
    if (!entry || entry.speaker !== speaker) continue;
    if (isNearIdentical(entry.text, committed)) {
      list.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Called every time the cross-channel dedup fires a drop. Bumps the
 * rolling counter, schedules its 30 s decay, and (on first crossing
 * of DEDUP_HINT_THRESHOLD per session) surfaces the speaker-bleed
 * hint banner. Idempotent — repeated crossings after the banner has
 * shown are no-ops until clearScoringState() resets the guards.
 *
 * The threshold (5 drops within ~30 s) is a heuristic: roughly the
 * point where the bleed is producing more duplicate fragments than
 * could plausibly be coincidence, but not so high that a noisy
 * 30-second stretch is needed to trip it.
 */
function noteDedupDrop() {
  recentDedupDrops += 1;
  scheduleDedupDropDecay();
  if (recentDedupDrops >= DEDUP_HINT_THRESHOLD && !dedupHintShown) {
    dedupHintShown = true;
    showDedupHintBanner();
  }
}

function showDedupHintBanner() {
  if (!dedupHintBannerEl) {
    // Banner element missing (DOM removed by future redesign?) —
    // fall back to a console warn so the diagnostic isn't completely
    // silent. The dedup itself still works regardless.
    console.warn(
      '[transcript] speaker bleed detected — headphones will significantly improve attribution.',
    );
    return;
  }
  dedupHintBannerEl.hidden = false;
}

function hideDedupHintBanner() {
  if (!dedupHintBannerEl) return;
  dedupHintBannerEl.hidden = true;
}

if (dedupHintDismissEl) {
  dedupHintDismissEl.addEventListener('click', hideDedupHintBanner);
}

/* ── Helpers ───────────────────────────────────────────────────────── */

/** Item lifecycle glyphs. Single source of truth for the checklist
 *  visuals — also reused by the Logged synthetic pillar so the icons
 *  stay consistent. `pending` is the default; the renderer treats an
 *  absent entry in state.itemStates as pending. */
const ITEM_GLYPHS = {
  pending: '○',
  in_progress: '◐', // visual hint while the CSS spinner overlays it
  covered: '✓',
  logged: '↺',
};

/** Look up the current state for an item, defaulting to 'pending' when
 *  absent. Centralised so render fns don't have to repeat the fallback. */
function itemStateFor(itemId) {
  return state.itemStates.get(itemId)?.state || 'pending';
}

/** Enumerate every item currently in `logged` state across all pillars,
 *  in stable rubric order. Used by the Logged synthetic pillar body. */
function loggedItems() {
  const out = [];
  for (const [itemId, entry] of state.itemStates) {
    if (entry?.state === 'logged') out.push({ itemId, entry });
  }
  // Sort by rubric declaration order for stable display. ITEMS_BY_ID
  // doesn't carry an index, so build a quick map.
  out.sort((a, b) => {
    const ai = ITEM_DECLARATION_INDEX[a.itemId] ?? 0;
    const bi = ITEM_DECLARATION_INDEX[b.itemId] ?? 0;
    return ai - bi;
  });
  return out;
}

function setStatus(next) {
  state.status = next;
  coachEl.dataset.status = next;
  // Toggle the rec button label without re-creating it.
  if (next === 'listening') {
    recToggleEl.textContent = 'Stop';
    recToggleEl.setAttribute('aria-label', 'Stop recording');
  } else if (next === 'starting') {
    recToggleEl.textContent = 'Starting…';
    recToggleEl.setAttribute('aria-label', 'Starting');
  } else {
    recToggleEl.textContent = 'Start';
    recToggleEl.setAttribute('aria-label', 'Start recording');
  }
  // Phase 2: the Audio tab's "applies on next Start" hint is gated by
  // the call status — visible while listening / starting, hidden in
  // idle / error. Calling unconditionally here keeps the hint in sync
  // with every transition without an explicit subscriber per state.
  // Forward-declared via hoisting (function declaration further down).
  if (typeof refreshAudioApplyHint === 'function') refreshAudioApplyHint();
  // The connection-status pill is also gated by the call status —
  // hidden in idle, visible during listening / starting. Re-render
  // here so the pill appears / disappears with every status flip
  // without each call site having to remember to invalidate it.
  if (typeof renderConnectionStatus === 'function') renderConnectionStatus();
}

function formatTimer(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * AEC badge — a tiny header indicator that surfaces whether Chromium's
 * AEC3 echo canceller is actually active on the mic capture chain.
 *
 * Driven by the MediaTrackSettings.echoCancellation value the browser
 * reports back from getUserMedia:
 *   - `true`      → green "AEC"     — prospect bleed is being cancelled
 *                                     before reaching Deepgram. This is
 *                                     the happy path.
 *   - `false`     → red   "AEC off" — Chromium refused the constraint
 *                                     (rare; usually a Bluetooth or
 *                                     external USB interface that
 *                                     doesn't support AEC).
 *   - `undefined` → grey  "AEC ?"   — pre-capture, or the browser
 *                                     didn't expose the setting.
 *
 * State is held purely on the DOM (`data-state`) so we don't need a
 * separate render fn — the badge has no other state to track.
 */
function setAecBadgeState(next) {
  if (!aecBadgeEl) return;
  if (next === 'on') {
    aecBadgeEl.dataset.state = 'on';
    aecBadgeEl.textContent = 'AEC';
    aecBadgeEl.title = 'Echo cancellation active — speaker bleed removed before transcription.';
  } else if (next === 'off') {
    aecBadgeEl.dataset.state = 'off';
    aecBadgeEl.textContent = 'AEC off';
    aecBadgeEl.title =
      'Browser refused echo cancellation. Speaker bleed may appear in your transcript — try wired headphones.';
  } else {
    aecBadgeEl.dataset.state = 'unknown';
    aecBadgeEl.textContent = 'AEC ?';
    aecBadgeEl.title = 'Echo cancellation status unknown (not yet capturing, or browser did not report).';
  }
}

/** Map a MediaTrackSettings dict to the badge's three visual states.
 *  Centralised so the mic-capture path and any future re-read (e.g.
 *  after a deviceId switch) both land on the same logic. */
function updateAecBadgeFromSettings(settings) {
  if (settings?.echoCancellation === true) setAecBadgeState('on');
  else if (settings?.echoCancellation === false) setAecBadgeState('off');
  else setAecBadgeState('unknown');
}

/**
 * Paint the `#versionBadge` header pill from main's
 * `app:version` IPC response. Called once at boot from
 * applyInitialVersionBadge() — the version metadata can't change
 * mid-session (Vite defines bake at build start; the runtime git
 * read in dev captures the working-tree state at process boot), so
 * there's no companion subscriber on a main → renderer channel.
 *
 * Visible format:
 *   v1.0.0 · 89f97a8           — clean working tree
 *   v1.0.0 · 89f97a8 (dirty)   — uncommitted edits at process boot
 *   v1.0.0                     — packaged build that lost its SHA
 *                                (or a degraded `git` read in dev)
 *
 * The dirty state flips `data-state` to 'dirty', which the CSS uses
 * to repaint the pill amber. The title tooltip includes the build
 * time in localised form so the user can see at a glance "how old
 * is this build" without leaving the window.
 */
function applyVersionBadge(version) {
  if (!versionBadgeEl) return;
  if (!version || typeof version !== 'object') {
    versionBadgeEl.hidden = true;
    return;
  }

  const pkgVersion = typeof version.pkgVersion === 'string' && version.pkgVersion
    ? version.pkgVersion
    : '0.0.0';
  const gitSha = typeof version.gitSha === 'string' ? version.gitSha : '';
  const gitDirty = version.gitDirty === true;
  const builtAt = typeof version.builtAt === 'number' && version.builtAt > 0
    ? version.builtAt
    : null;

  // Build the visible pill content. Using DOM nodes (not innerHTML)
  // because the SHA + dirty marker have distinct typography via
  // their own classes (.version-badge__sha is monospace,
  // .version-badge__dirty is uppercase) and innerHTML would lose
  // that without manual escaping of the version string anyway.
  versionBadgeEl.replaceChildren();
  versionBadgeEl.appendChild(document.createTextNode(`v${pkgVersion}`));
  if (gitSha) {
    versionBadgeEl.appendChild(document.createTextNode(' · '));
    const shaSpan = document.createElement('span');
    shaSpan.className = 'version-badge__sha';
    shaSpan.textContent = gitSha;
    versionBadgeEl.appendChild(shaSpan);
  }
  if (gitDirty) {
    versionBadgeEl.appendChild(document.createTextNode(' '));
    const dirtySpan = document.createElement('span');
    dirtySpan.className = 'version-badge__dirty';
    dirtySpan.textContent = '(dirty)';
    versionBadgeEl.appendChild(dirtySpan);
  }

  versionBadgeEl.dataset.state = gitDirty ? 'dirty' : 'clean';

  // Tooltip: spell out the dirty-vs-clean meaning and surface the
  // build time as a localised string so the user has an at-a-glance
  // "is this the build I just rebuilt?" answer without opening
  // dev tools.
  const tooltipParts = [`Two Way Flow v${pkgVersion}`];
  if (gitSha) tooltipParts.push(`commit ${gitSha}${gitDirty ? ' + uncommitted edits' : ''}`);
  if (builtAt) {
    try {
      tooltipParts.push(`built ${new Date(builtAt).toLocaleString()}`);
    } catch {
      // Date formatting failure is non-fatal — we just skip the
      // built-at line in the tooltip rather than hiding the pill.
    }
  }
  if (gitDirty) {
    tooltipParts.push(
      'Working tree was dirty when this window started — restart npm start to pick up newer file edits.',
    );
  }
  versionBadgeEl.title = tooltipParts.join('\n');
  versionBadgeEl.hidden = false;
}

/**
 * Fetch the build-version metadata from main and apply it to the
 * header pill. Wrapped in try/catch so a transient IPC failure (or
 * an older packaged main that doesn't ship the `app:version` channel
 * — which would surface here as `getAppVersion` being undefined)
 * leaves the badge hidden instead of throwing during boot.
 *
 * Awaited at the bottom of this file alongside the other initial-
 * render setup, but the function is intentionally fire-and-forget:
 * the rest of the renderer doesn't block on it because the badge is
 * purely informational.
 */
async function applyInitialVersionBadge() {
  if (!versionBadgeEl) return;
  try {
    const version = await window.gemini?.getAppVersion?.();
    applyVersionBadge(version);
  } catch (err) {
    console.warn('[version] getAppVersion failed:', err?.message || err);
    versionBadgeEl.hidden = true;
  }
}

/**
 * Roll the per-transport connection statuses up into a single
 * worst-of pill in the header. The pill has three visual states
 * driven by the data-state attribute:
 *
 *   - 'connected'    (green) — both transports healthy
 *   - 'reconnecting' (amber) — at least one is mid-retry; the other
 *                              may be connected or also reconnecting
 *   - 'down'         (red)   — both transports are down / unavailable
 *
 * The label tracks the worst-of state in human-friendly words ("Live"
 * / "Reconnecting" / "Off") and the title tooltip spells out the
 * per-transport breakdown so the rep can see WHICH side is degraded.
 *
 * Gemini-Live-only 'closed' is treated as 'down' for the rollup —
 * conceptually it means "flag detection is off but the call is OK
 * because Deepgram is still streaming". The renderer's onClosed
 * handler in the E2 decoupling block is what keeps the call alive.
 *
 * Hidden when the call is idle so the pill doesn't surface a stale
 * "Off" between calls. Revealed automatically once any transport
 * transitions out of the idle 'down' default — see the IPC
 * subscriber below.
 */
function renderConnectionStatus() {
  if (!connectionStatusEl) return;
  const dg = state.connection.deepgram;
  const gl = state.connection.geminiLive;

  // Worst-of rollup:
  //   - both connected → 'connected'
  //   - any reconnecting → 'reconnecting'
  //   - everything else → 'down'
  let rollup;
  if (dg === 'connected' && gl === 'connected') rollup = 'connected';
  else if (dg === 'reconnecting' || gl === 'reconnecting') rollup = 'reconnecting';
  else rollup = 'down';

  connectionStatusEl.dataset.state = rollup;
  connectionStatusEl.dataset.deepgram = dg;
  connectionStatusEl.dataset.geminiLive = gl;

  const label = connectionStatusEl.querySelector('.conn-pill__label');
  if (label instanceof HTMLElement) {
    label.textContent =
      rollup === 'connected' ? 'Live'
        : rollup === 'reconnecting' ? 'Reconnecting'
          : 'Off';
  }

  connectionStatusEl.title = formatConnectionTooltip(dg, gl);

  // Hide while the call is idle (both transports 'down' AND the
  // status hasn't been broadcast since reset — i.e. state.status is
  // idle). Shown the moment a transport reports anything other than
  // the default 'down', and stays visible through reconnects so the
  // rep can see the state of an in-flight session.
  const inCall = state.status === 'listening' || state.status === 'starting';
  connectionStatusEl.hidden = !inCall;
}

/** Human-readable tooltip for the connection pill — spells out each
 *  transport so the rep knows which side is degraded when the rollup
 *  reads amber or red. */
function formatConnectionTooltip(deepgram, geminiLive) {
  const labelFor = (status) => {
    switch (status) {
      case 'connected': return 'connected';
      case 'reconnecting': return 'reconnecting';
      case 'closed': return 'dropped (call still streaming via Deepgram)';
      case 'down':
      default: return 'down';
    }
  };
  return `Deepgram: ${labelFor(deepgram)} · Gemini Live: ${labelFor(geminiLive)}`;
}

/* ── Render fns (pure over state) ──────────────────────────────────── */

function renderTimer() {
  const ms = state.recordingStartedAt
    ? Date.now() - state.recordingStartedAt
    : 0;
  recTimerEl.textContent = formatTimer(ms);
}

function renderSpeakers() {
  for (const el of speakerEls) {
    const id = el.dataset.id;
    el.dataset.active = String(Boolean(state.activeSpeakers[id]));
  }
}

function renderRail() {
  // Diff-render: build all buttons once on first call, then only update
  // data attributes on subsequent calls. Cheap enough at 14 buttons.
  if (railEl.children.length !== PILLARS.length) {
    railEl.replaceChildren(...PILLARS.map(makePillarButton));
  }
  for (const el of railEl.children) {
    const id = el.dataset.id;
    const pillar = PILLARS_BY_ID[id];
    el.dataset.selected = String(id === state.activePillarId);
    el.dataset.status = state.pillarStatus[id] || 'idle';
    // v2.5: real pillars get a 3-level coverage rollup
    //   (pending = no items covered → default monotone glyph,
    //    partial = some items covered  → orange glyph,
    //    complete = every item covered → green glyph).
    // Synthetic pillars (live_signals, logged_questions) are
    // excluded — their colour stays as-is.
    if (pillar && !pillar.synthetic) {
      el.dataset.coverage = computePillarCoverage(id);
    }
  }
}

/**
 * Compute the 3-level coverage state for a real pillar, used by the
 * data-coverage attribute on its rail button to drive the glyph colour
 * rollup. Synthetic pillars (live_signals, logged_questions) don't
 * call this — their indicator stays separate.
 *
 * @returns {'pending'|'partial'|'complete'}
 */
function computePillarCoverage(pillarId) {
  const items = ITEMS_BY_PILLAR[pillarId] || [];
  if (items.length === 0) return 'pending';
  let covered = 0;
  for (const it of items) {
    if (itemStateFor(it.id) === 'covered') covered += 1;
  }
  if (covered === 0) return 'pending';
  if (covered >= items.length) return 'complete';
  return 'partial';
}

function makePillarButton(pillar) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pillar';
  btn.dataset.id = pillar.id;
  btn.dataset.selected = String(pillar.id === state.activePillarId);
  btn.dataset.status = state.pillarStatus[pillar.id] || 'idle';
  if (pillar.synthetic) btn.dataset.synthetic = 'true';
  // Default coverage; renderRail recomputes for real pillars after
  // building. Synthetic pillars don't set this attribute.
  if (!pillar.synthetic) btn.dataset.coverage = 'pending';
  btn.setAttribute('aria-label', pillar.name);
  btn.title = pillar.name;

  const glyph = document.createElement('span');
  glyph.className = 'pillar__glyph';
  glyph.textContent = pillar.glyph;
  btn.appendChild(glyph);

  /* v3 resizable panes stretch goal: when the user widens the rail
   * splitter past ~140px the container query on .rail reveals these
   * labels next to the glyph. Always in DOM so the reveal/conceal is
   * pure CSS — no DOM diff, no JS state. Below the threshold the
   * label is `display: none` (also removes it from the a11y tree, so
   * the existing aria-label on the button is the canonical name in
   * collapsed mode). */
  const label = document.createElement('span');
  label.className = 'pillar__label';
  label.textContent = pillar.name;
  btn.appendChild(label);

  // Corner dot is retained ONLY for synthetic pillars (live_signals
  // shows "flags fired", logged_questions shows "items waiting to
  // circle back"). Real pillars use the glyph colour rollup above
  // instead. Per v2.5: REPLACE the per-item dot/badge with glyph colour
  // for real pillars; synthetic pillars stay as they were.
  if (pillar.synthetic) {
    const dot = document.createElement('span');
    dot.className = 'pillar__dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
  }

  btn.addEventListener('click', () => selectPillar(pillar.id));
  return btn;
}

/**
 * Open (or switch) the rail overlay to show a pillar's checklist.
 * Clicking the same pillar that's already open is a no-op; clicking a
 * different pillar swaps the contents without re-running the slide
 * animation. Closing is via Esc or backdrop click.
 */
function selectPillar(id) {
  if (!PILLARS_BY_ID[id]) return;
  state.activePillarId = id;
  renderRail();
  renderRailOverlay();
}

function closePillarOverlay() {
  if (state.activePillarId === null) return;
  state.activePillarId = null;
  renderRail();
  renderRailOverlay();
}

/**
 * Render the slide-over panel content for the currently active pillar.
 * The overlay's open/closed state is driven by `state.activePillarId`
 * via the data-open attribute on the root element — CSS owns the
 * transform and backdrop transitions.
 */
function renderRailOverlay() {
  const pillarId = state.activePillarId;
  const isOpen = pillarId !== null;
  railOverlayEl.dataset.open = String(isOpen);
  railOverlayEl.setAttribute('aria-hidden', String(!isOpen));

  if (!isOpen) return;
  const pillar = PILLARS_BY_ID[pillarId];
  if (!pillar) return;

  // ── header (title + counter + close button) ──────────────────────
  const title = document.createElement('h2');
  title.id = 'railOverlayTitle';
  title.className = 'rail-overlay__title';
  title.textContent = pillar.name;

  const counter = document.createElement('span');
  counter.className = 'rail-overlay__counter';
  if (pillar.id === 'live_signals') {
    counter.textContent = `${state.flags.length} fired`;
  } else if (pillar.id === 'logged_questions') {
    counter.textContent = `${loggedItems().length} pending`;
  } else {
    const items = ITEMS_BY_PILLAR[pillar.id] || [];
    let covered = 0;
    for (const it of items) {
      if (itemStateFor(it.id) === 'covered') covered += 1;
    }
    counter.textContent = `${covered} of ${items.length}`;
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'rail-overlay__close';
  close.setAttribute('aria-label', 'Close pillar');
  close.title = 'Close (Esc)';
  close.textContent = '×';
  close.addEventListener('click', closePillarOverlay);

  railOverlayHeaderEl.replaceChildren(title, counter, close);

  // ── body (depends on which synthetic / real pillar we're showing) ─
  let body;
  if (pillar.id === 'live_signals') body = renderLiveSignalsBody();
  else if (pillar.id === 'logged_questions') body = renderLoggedBody();
  else body = renderChecklistBody(pillar);
  railOverlayBodyEl.replaceChildren(body);
}

/**
 * Render the always-visible transcript list in the middle column.
 *
 * Lines are speaker-labelled (You / Prospect) via the CSS ::before
 * pseudo-element keyed off `data-speaker`. We pass the speaker as a
 * data attribute rather than baking the prefix into the textContent
 * so the colour and casing of the label stays in stylesheet control.
 *
 * In-flight partials (one per speaker channel) render at the bottom
 * in a faint italic style. Auto-scrolls to keep the newest text in
 * view unless the user has manually scrolled up.
 */
function renderTranscriptPane() {
  const { committed, pendingBySpeaker } = state.transcript;
  const pendingYou = pendingBySpeaker.you || '';
  const pendingOther = pendingBySpeaker.other || '';

  if (
    committed.length === 0 &&
    !pendingYou &&
    !pendingOther &&
    !state.errorMessage
  ) {
    const placeholder = document.createElement('p');
    placeholder.className = 'transcript-pane__empty';
    placeholder.textContent = 'Transcript will appear here once the call starts.';
    transcriptListEl.replaceChildren(placeholder);
    transcriptErrorEl.hidden = true;
    return;
  }

  const children = [];
  for (const line of committed) {
    const p = document.createElement('p');
    p.className = 'transcript-pane__line';
    p.dataset.speaker = line.speaker;
    p.textContent = line.text;
    children.push(p);
  }
  if (pendingYou) {
    const p = document.createElement('p');
    p.className = 'transcript-pane__line transcript-pane__line--pending';
    p.dataset.speaker = 'you';
    p.textContent = pendingYou;
    children.push(p);
  }
  if (pendingOther) {
    const p = document.createElement('p');
    p.className = 'transcript-pane__line transcript-pane__line--pending';
    p.dataset.speaker = 'other';
    p.textContent = pendingOther;
    children.push(p);
  }
  transcriptListEl.replaceChildren(...children);

  /* Stick-to-bottom follow: the user's scroll listener (mounted
   * below) maintains stickToBottomTranscript; here we just honour
   * it. The old "recompute nearBottom after replaceChildren" block
   * was unreliable — scrollHeight grew as part of the render so
   * the post-render diff was always too large to trip the
   * threshold. v1.3.0 regression fix. */
  if (stickToBottomTranscript) {
    transcriptListEl.scrollTop = transcriptListEl.scrollHeight;
  }

  if (state.errorMessage) {
    transcriptErrorEl.textContent = state.errorMessage;
    transcriptErrorEl.hidden = false;
  } else {
    transcriptErrorEl.hidden = true;
  }
}

/* One-time listeners + helpers for the stick-to-bottom follow on
 * transcriptListEl. Mounted at module load (file is type=module
 * loaded at end of body so the element exists). */

/** Snap to the bottom if stickToBottomTranscript is currently true.
 * Used by the ResizeObserver below (pane resize, splitter drag,
 * window resize) so a stuck transcript stays stuck when its
 * visible height changes. Renders themselves call this inline at
 * the end of renderTranscriptPane.
 */
function snapTranscriptToBottomIfStuck() {
  if (!transcriptListEl) return;
  if (!stickToBottomTranscript) return;
  transcriptListEl.scrollTop = transcriptListEl.scrollHeight;
}

if (transcriptListEl) {
  transcriptListEl.addEventListener('scroll', () => {
    /* Recompute on every scroll — both user-initiated wheel/drag/
     * trackpad scrolls AND programmatic scrollTop writes from
     * snapTranscriptToBottomIfStuck (those write distance ≈ 0 so
     * the flag stays true). passive: omitted because we don't
     * call preventDefault — Chromium treats omitted-passive on
     * scroll as passive-by-default. */
    const dist =
      transcriptListEl.scrollHeight -
      transcriptListEl.scrollTop -
      transcriptListEl.clientHeight;
    stickToBottomTranscript = dist < STICK_TO_BOTTOM_THRESHOLD_PX;
  });

  /* When the transcript list's visible height changes — splitter
   * drag (drawer or captured), rail-width change, window resize —
   * re-snap to bottom if we were stuck. Without this, growing the
   * drawer or shrinking the captured pane would leave the user
   * looking at stale middle-of-transcript text even though they
   * were following the live edge a moment ago. */
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      snapTranscriptToBottomIfStuck();
    });
    ro.observe(transcriptListEl);
  }
}

/**
 * Render the suggestion at `state.coachIndex` (or hide the card if there
 * isn't one yet). v2.5 redesign:
 *   - Includes an inline Skip pill on the card (rep can dismiss the
 *     suggestion + ask for a new 'next'-kind one in one click).
 *   - Renders the model's `anchorQuote` under the question as
 *     "responding to: …" so the rep can see what the suggestion is
 *     reacting to.
 *   - Handles the 'freeform.deeper' sentinel id (Deeper-kind asks may
 *     not map to a rubric item — we render the question + anchor
 *     without a pillar badge).
 *   - Tags the kind ("Suggest" / "Deeper" / "Pivot" / "Pause nudge") in
 *     place of the static "Ask next" label so the rep can see why the
 *     card appeared.
 *
 * History semantics still work: ←/→ walk through previous suggestions;
 * → at the live edge issues a 'next' ask via skipCoachSuggestion.
 */
function renderCoachSuggestion() {
  const history = state.coachHistory;
  const idx = state.coachIndex;
  if (idx < 0 || idx >= history.length) {
    coachSuggestionEl.hidden = true;
    coachSuggestionEl.replaceChildren();
    return;
  }

  const sug = history[idx];
  const isFreeform = sug.itemId ? SUGGESTION_SENTINEL_SET.has(sug.itemId) : false;
  const item = sug.itemId && !isFreeform ? ITEMS_BY_ID[sug.itemId] : null;
  const pillar = item ? PILLARS_BY_ID[item.pillarId] : null;

  // ── Asked state ────────────────────────────────────────────────────
  // Mirror the drawer's logged-entry--asked styling on the pinned card
  // so the rep gets immediate "the coach saw you ask this" feedback
  // without having to open the Logged drawer.
  //
  // The lookup is keyed by suggestionId (threaded through from main on
  // the coach:suggestion IPC, see onCoachSuggestion above) — one source
  // of truth instead of fuzzy text matching.
  //
  // Reads the entry's `asked` flag directly (not gated on
  // trackQuestionState). The toggle now ONLY controls the AI's auto-
  // detection path — the manual tick button (added alongside this
  // change) is a deliberate rep action that should always result in
  // the green styling regardless of whether the AI's auto-detection
  // is enabled. The AI path stays gated server-side: when the toggle
  // is off the model never fires mark_question_asked, so the only way
  // for `asked` to flip is via the manual click — and in that case
  // the rep explicitly opted in via the button.
  const historyEntry = sug.suggestionId
    ? state.suggestionHistory.find((e) => e.id === sug.suggestionId)
    : null;
  const isAsked = Boolean(historyEntry && historyEntry.asked);

  // --- label row -----------------------------------------------------
  // Kind chip on the left ("Suggest" / "Deeper" / "Pivot" / "Pause"),
  // pillar tag in the middle (or nothing for freeform suggestions),
  // Skip pill on the right.
  const label = document.createElement('div');
  label.className = 'suggestion__label';
  const labelKind = document.createElement('span');
  labelKind.className = 'suggestion__kind';
  labelKind.textContent = labelForKind(sug.kind);
  label.appendChild(labelKind);
  if (pillar) {
    const pillarLabel = document.createElement('span');
    pillarLabel.className = 'suggestion__pillar';
    pillarLabel.textContent = `· ${pillar.short}`;
    label.appendChild(pillarLabel);
  } else if (isFreeform) {
    // Freeform sentinels carry no pillar association. The kind chip
    // already labels the card ("DEEPER" / "RECAP"), so adding a
    // secondary subtitle would be redundant for Recap — only Deeper
    // gets the "Follow-up" hint because the kind name alone is too
    // generic to convey "this is a reply to what they just said".
    if (sug.kind === 'deeper') {
      const pillarLabel = document.createElement('span');
      pillarLabel.className = 'suggestion__pillar';
      pillarLabel.textContent = '· Follow-up';
      label.appendChild(pillarLabel);
    }
  }

  // Mark-as-asked tick. Manual counterpart to the AI's
  // `mark_question_asked` tool — the rep clicks it the moment they
  // ask the suggested question, which flips the history entry to
  // asked=true (greening the card) and signals to main to log the
  // rubric item so the model doesn't resurface the same question on
  // the next tick. Always rendered (independent of trackQuestionState)
  // because the manual click is a deliberate rep action — we don't
  // want the button to silently disappear when the AI-driven
  // detection toggle is off.
  //
  // Idempotency: when the entry is already asked, the click resolves
  // server-side as a no-op AND the renderer short-circuits before
  // firing the IPC so we don't spam main with duplicate clicks /
  // duplicate scoring:item-state broadcasts.
  //
  // Pressed-state styling keys off `data-asked='true'` so the button
  // visually communicates the asked state alongside the parent card's
  // green tint.
  const markAskedBtn = document.createElement('button');
  markAskedBtn.type = 'button';
  markAskedBtn.className = 'suggestion__mark-asked';
  if (sug.suggestionId) markAskedBtn.dataset.suggestionId = sug.suggestionId;
  if (isAsked) {
    markAskedBtn.dataset.asked = 'true';
    markAskedBtn.setAttribute('aria-pressed', 'true');
    markAskedBtn.title = 'Marked as asked';
  } else {
    markAskedBtn.setAttribute('aria-pressed', 'false');
    markAskedBtn.title = 'Mark this question as asked';
  }
  markAskedBtn.setAttribute('aria-label', 'Mark this question as asked');
  if (!sug.suggestionId) {
    // No id means no server-side history entry to flip — disable the
    // control rather than letting the click sail through as a no-op
    // IPC roundtrip. This is a defensive branch; suggestionId is
    // threaded through from main on every fresh suggestion.
    markAskedBtn.disabled = true;
    markAskedBtn.title = 'No tracking id for this suggestion';
  }
  markAskedBtn.innerHTML =
    '<svg class="suggestion__mark-asked-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  markAskedBtn.addEventListener('click', () => {
    if (!sug.suggestionId) return;
    const entry = state.suggestionHistory.find((e) => e.id === sug.suggestionId);
    if (entry?.asked) return;
    window.gemini.markSuggestionAsked?.(sug.suggestionId);
  });
  label.appendChild(markAskedBtn);

  // Inline Skip pill on the active suggestion card. Clicking it
  // dismisses the suggestion AND triggers a fresh ask:
  //   - When a cover-queue is active, advance to the next item in
  //     the queue (a targeted ask) instead of firing a generic
  //     'next' ask. That keeps the queue cycling without the seller
  //     having to re-click Cover-remaining.
  //   - Otherwise fan out to coach:skip → Coach.skip() →
  //     requestSuggestion({ kind: 'next' }), the legacy behaviour.
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'suggestion__skip';
  skipBtn.title = state.coverQueue
    ? 'Skip and move to the next item in the queue'
    : 'Skip and get another suggestion';
  skipBtn.setAttribute('aria-label', 'Skip suggestion');
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', () => {
    if (state.coverQueue) {
      advanceCoverQueue();
    } else {
      window.gemini.skipCoachSuggestion?.();
    }
  });
  label.appendChild(skipBtn);

  // --- question + rationale -----------------------------------------
  const question = document.createElement('p');
  question.className = 'suggestion__question';
  question.textContent = sug.question;

  const children = [label, question];

  // Anchor quote — required-ish per the v2.5 prompt (the coach drops
  // suggestions without one). Surfaces what the suggestion is
  // reacting to. Plain text, muted italic, no chrome.
  if (sug.anchorQuote) {
    const anchor = document.createElement('p');
    anchor.className = 'suggestion__anchor';
    anchor.textContent = `responding to: “${sug.anchorQuote}”`;
    children.push(anchor);
  }

  if (sug.rationale) {
    const rationale = document.createElement('span');
    rationale.className = 'suggestion__rationale';
    rationale.textContent = sug.rationale;
    children.push(rationale);
  }

  // --- nav row -------------------------------------------------------
  const nav = document.createElement('div');
  nav.className = 'suggestion__nav';

  const left = document.createElement('span');
  left.className = 'suggestion__nav-side';
  left.dataset.enabled = String(idx > 0);
  left.textContent = '← prev';
  nav.appendChild(left);

  const position = document.createElement('span');
  position.className = 'suggestion__nav-position';
  const isLive = idx === history.length - 1;
  position.textContent = isLive
    ? `${history.length} of ${history.length} · live`
    : `${idx + 1} of ${history.length}`;
  nav.appendChild(position);

  // Coverage-queue progress hint — only present when a cover queue is
  // active. Sits next to the existing position indicator so the seller
  // can see at a glance how far through the cycle they are. The badge
  // disappears the moment the queue is cleared (completion / cancel).
  if (state.coverQueue) {
    const queue = document.createElement('span');
    queue.className = 'suggestion__queue-progress';
    const human = state.coverQueue.index + 1;
    const total = state.coverQueue.items.length;
    queue.textContent = `Coverage queue · ${human} of ${total}`;
    nav.appendChild(queue);
  }

  const right = document.createElement('span');
  right.className = 'suggestion__nav-side';
  // Right is always available — at the live edge it means "skip / get
  // me a new one"; mid-history it means "step forward".
  right.dataset.enabled = 'true';
  right.textContent = isLive ? 'skip →' : 'next →';
  nav.appendChild(right);

  children.push(nav);

  coachSuggestionEl.replaceChildren(...children);
  // Asked-state styling (CSS keys off the data attribute — see the
  // .suggestion[data-asked='true'] rule in src/index.css mirroring
  // .logged-entry--asked). Toggling rather than setting unconditionally
  // so old DOM doesn't keep a stale data-asked='true' when a fresh
  // un-asked suggestion takes the pin.
  if (isAsked) coachSuggestionEl.dataset.asked = 'true';
  else delete coachSuggestionEl.dataset.asked;
  coachSuggestionEl.hidden = false;
}

/** Human-readable kind label shown in the suggestion card's top-left.
 *  Falls through to 'Suggest' for unknown / legacy entries so older
 *  history items still render sensibly. The CSS upper-cases this in
 *  the card chrome, so e.g. "Recap" surfaces as RECAP. */
function labelForKind(kind) {
  switch (kind) {
    case 'deeper': return 'Deeper';
    case 'pivot':  return 'Pivot';
    case 'pause':  return 'Pause nudge';
    case 'recap':  return 'Recap';
    case 'next':
    default:       return 'Suggest';
  }
}

/**
 * Show / hide the pulsing "thinking" dot next to the suggestion area.
 * Bound to coach:tick-start / coach:tick-end IPC events. The dot is the
 * only visible signal that the coach is between roundtrips — without it
 * a 1.5s pause feels like the app is unresponsive.
 */
function renderCoachThinking() {
  if (!coachThinkingDotEl) return;
  coachThinkingDotEl.hidden = !state.coachThinking;
  coachThinkingDotEl.dataset.active = String(state.coachThinking);
}

/** Push a new live suggestion into history, optionally moving the
 *  viewing index forward if the user was already tracking the live end. */
function pushCoachSuggestion(entry) {
  const wasAtLive =
    state.coachHistory.length === 0 || state.coachIndex === state.coachHistory.length - 1;

  state.coachHistory.push(entry);
  if (state.coachHistory.length > COACH_HISTORY_MAX) {
    const overflow = state.coachHistory.length - COACH_HISTORY_MAX;
    state.coachHistory.splice(0, overflow);
    if (state.coachIndex >= 0) state.coachIndex = Math.max(0, state.coachIndex - overflow);
  }

  if (wasAtLive) state.coachIndex = state.coachHistory.length - 1;
  renderCoachSuggestion();
}

function renderChecklistBody(pillar) {
  const items = ITEMS_BY_PILLAR[pillar.id] || [];
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'rail-overlay__empty';
    p.textContent = 'No checklist items for this pillar.';
    return p;
  }

  const ul = document.createElement('ul');
  ul.className = 'checklist';

  for (const it of items) {
    ul.appendChild(makeChecklistItem(it));
  }

  // "Cover remaining" — fires a queue of targeted asks for every
  // uncovered item in this pillar, cycling through them one at a
  // time. Only surfaces when there are 2+ uncovered items (1 item
  // is just a per-item Ask click). The button sits at the bottom of
  // the drawer beneath the checklist; the queue itself lives on
  // state.coverQueue.
  const uncovered = uncoveredItemsForPillar(pillar.id);
  if (uncovered.length >= 2) {
    const wrap = document.createElement('div');
    wrap.className = 'rail-overlay__footer';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cover-remaining-btn';
    btn.dataset.pillarId = pillar.id;
    btn.title = `Queue questions for all ${uncovered.length} uncovered items in this pillar`;
    btn.textContent = `▶ Cover remaining (${uncovered.length})`;
    btn.addEventListener('click', () => startCoverQueue(pillar.id));
    wrap.appendChild(btn);

    // Return a fragment so the caller's replaceChildren() works
    // without an extra wrapping div in the DOM.
    const frag = document.createDocumentFragment();
    frag.appendChild(ul);
    frag.appendChild(wrap);
    return frag;
  }

  return ul;
}

/**
 * Render a single checklist row in the 4-state visual language:
 *   pending     ○ (empty circle, dim text)
 *   in_progress ◐ + CSS spinner overlay (pulsing)
 *   covered     ✓ (filled tick, line-through label)
 *   logged      ↺ (cycle arrow, amber tint)
 *
 * Evidence quote — if available — surfaces both as the native title
 * tooltip and as an inline reveal underneath the label on hover (the
 * CSS uses `:hover .item__evidence { display: block; }`).
 */
function makeChecklistItem(it) {
  const entry = state.itemStates.get(it.id);
  const itemState = entry?.state || 'pending';

  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.state = itemState;
  // Preserve the legacy `data-covered` selector for any CSS rule that
  // still keys off it during the layout transition. Trivially derived
  // from state — kill once the layout settles.
  li.dataset.covered = String(itemState === 'covered');
  if (entry?.evidence) li.title = entry.evidence;

  const glyph = document.createElement('span');
  glyph.className = 'item__tick';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = ITEM_GLYPHS[itemState] || ITEM_GLYPHS.pending;
  li.appendChild(glyph);

  const labelWrap = document.createElement('span');
  labelWrap.className = 'item__label';

  const label = document.createElement('span');
  label.className = 'item__label-text';
  label.textContent = it.label;
  labelWrap.appendChild(label);

  if (entry?.evidence) {
    const ev = document.createElement('span');
    ev.className = 'item__evidence';
    ev.textContent = `“${entry.evidence}”`;
    labelWrap.appendChild(ev);
  }
  li.appendChild(labelWrap);

  // Per-item targeted-ask button. Only surface on items the seller
  // could plausibly still want a question for — pending OR
  // in_progress. Once an item is covered (asked + answered + moved
  // on) or logged (touched-but-dropped, surfaced by the Logged
  // pillar), the rail's ask button stops being useful: covered
  // items don't need re-asking, and the Logged pillar already
  // offers a boost interaction for circling back.
  if (itemState === 'pending' || itemState === 'in_progress') {
    const askBtn = document.createElement('button');
    askBtn.type = 'button';
    askBtn.className = 'rail__ask-btn';
    askBtn.dataset.itemId = it.id;
    askBtn.title = `Generate a question for: ${it.label}`;
    askBtn.setAttribute('aria-label', `Ask coach for: ${it.label}`);
    askBtn.textContent = '+ Ask';
    askBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      requestCoachAskItem(it.id);
      // Cheap loading hint — the suggestion arrives async on the
      // next coach tick, which can take up to ~1.5s. The 2s timer
      // is a fallback in case the model returns nothing for this
      // item (rare, but possible). The button isn't disabled
      // because the seller might want to re-fire if the first
      // suggestion didn't land cleanly.
      askBtn.dataset.loading = 'true';
      setTimeout(() => { askBtn.dataset.loading = 'false'; }, 2000);
    });
    li.appendChild(askBtn);
  }

  return li;
}

/**
 * Synthetic pillar body for the Logged pillar.
 *
 * Two sources are interleaved:
 *
 *   1. Logged rubric items — anything in `logged` state across the
 *      whole rubric. Rendered as clickable boost buttons (existing
 *      behaviour).
 *   2. Suggestion history — every question the coach has pinned
 *      this call (Advanced → Track question state). Rendered as a
 *      read-only entry; when `trackQuestionState` is on, the entry
 *      gets a green outline + tint if the AI marked it as asked,
 *      and a muted "Reformulated" badge if a newer wording took the
 *      pin. When the toggle is off, the entries still render but
 *      without the colour gating.
 *
 * The suggestion-history block sits below the logged rubric items so
 * the rubric-driven "circle back" affordances stay the primary
 * surface — the history is supplementary context.
 */
function renderLoggedBody() {
  const items = loggedItems();
  const history = state.suggestionHistory;

  if (items.length === 0 && history.length === 0) {
    const p = document.createElement('p');
    p.className = 'rail-overlay__empty';
    p.textContent =
      'No logged questions yet. Items that were touched but not closed out will appear here so you can circle back.';
    return p;
  }

  const frag = document.createDocumentFragment();

  if (items.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'checklist';
    for (const { itemId, entry } of items) {
      const li = renderLoggedRubricItem(itemId, entry);
      if (li) ul.appendChild(li);
    }
    frag.appendChild(ul);
  }

  if (history.length > 0) {
    frag.appendChild(renderSuggestionHistoryBlock(history));
  }

  return frag;
}

/** Build one logged-rubric-item row. Factored out so the renderer
 *  doesn't grow when the drawer body gains additional sources. */
function renderLoggedRubricItem(itemId, entry) {
  const meta = ITEMS_BY_ID[itemId];
  if (!meta) return null;

  const li = document.createElement('li');
  li.className = 'item item--logged';
  li.dataset.state = 'logged';
  if (entry?.evidence) li.title = entry.evidence;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'item__boost';
  button.title = 'Resurface this as the next suggestion';
  button.setAttribute('aria-label', `Boost: ${meta.label}`);
  button.addEventListener('click', () => requestCoachBoost(itemId));

  const glyph = document.createElement('span');
  glyph.className = 'item__tick';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = ITEM_GLYPHS.logged;
  button.appendChild(glyph);

  const labelWrap = document.createElement('span');
  labelWrap.className = 'item__label';

  const pillar = PILLARS_BY_ID[meta.pillarId];
  const pillarTag = document.createElement('span');
  pillarTag.className = 'item__pillar-tag';
  pillarTag.textContent = pillar?.short || meta.pillarId;
  labelWrap.appendChild(pillarTag);

  const label = document.createElement('span');
  label.className = 'item__label-text';
  label.textContent = meta.label;
  labelWrap.appendChild(label);

  if (entry?.evidence) {
    const ev = document.createElement('span');
    ev.className = 'item__evidence';
    ev.textContent = `“${entry.evidence}”`;
    labelWrap.appendChild(ev);
  }

  button.appendChild(labelWrap);
  li.appendChild(button);
  return li;
}

/**
 * Build the suggestion-history block. Each entry renders the
 * question text plus a pillar tag (if the item id maps to a rubric
 * row), plus the asked / replaced badges keyed off the entry's flags.
 *
 * The asked/replaced styling used to be gated on
 * `state.coach.trackQuestionState`, but with the manual tick button
 * (and its always-on click path) the gating was relaxed so the visual
 * tracks the data either path produces. `trackQuestionState` now only
 * controls the AI's auto-detection (server-side gating in coach.js).
 *
 * Asked entries get .logged-entry--asked (green outline + tint),
 * replaced entries get .logged-entry--replaced (muted opacity) plus
 * a "Reformulated" badge.
 *
 * The block heading copy ("Suggested questions" vs "Suggested
 * questions (this call)") still leans on the toggle as a hint about
 * whether AI validation is in play; keeping that copy split because
 * the heading is descriptive context rather than a styling decision.
 */
function renderSuggestionHistoryBlock(history) {
  const wrap = document.createElement('section');
  wrap.className = 'logged-entries';

  const heading = document.createElement('h3');
  heading.className = 'rail-overlay__subheading';
  heading.textContent = state.coach.trackQuestionState
    ? 'Suggested questions'
    : 'Suggested questions (this call)';
  wrap.appendChild(heading);

  // Oldest first reads more naturally as a call log; the array is
  // already in arrival order so we just iterate forwards.
  for (const entry of history) {
    wrap.appendChild(renderSuggestionHistoryEntry(entry));
  }
  return wrap;
}

function renderSuggestionHistoryEntry(entry) {
  const div = document.createElement('div');
  div.className = 'logged-entry';
  // Asked / replaced styling reads the entry's flags directly so the
  // bottom-drawer's pinned card and the left-drawer's logged-questions
  // list stay in lock-step. Used to be gated on trackQuestionState,
  // but that's been relaxed alongside the manual tick button — the
  // toggle now only controls the AI's auto-detection path, while the
  // visual flags reflect the data either path produced.
  if (entry.asked) div.classList.add('logged-entry--asked');
  else if (entry.replaced) div.classList.add('logged-entry--replaced');
  if (entry.evidence) div.title = entry.evidence;

  const meta = entry.itemId && !SUGGESTION_SENTINEL_SET.has(entry.itemId)
    ? ITEMS_BY_ID[entry.itemId]
    : null;
  const pillar = meta ? PILLARS_BY_ID[meta.pillarId] : null;

  if (pillar) {
    const tag = document.createElement('span');
    tag.className = 'logged-entry__pillar-tag';
    tag.textContent = pillar.short || pillar.id;
    div.appendChild(tag);
  }

  const q = document.createElement('span');
  q.className = 'logged-entry__question';
  q.textContent = entry.questionText || '(no question text)';
  div.appendChild(q);

  // Asked / replaced annotations show whenever the entry's flags are
  // set — the trackQuestionState gating used to live here as well but
  // it's been relaxed alongside the manual tick button so the manual
  // path renders its asked badge regardless of the AI-detection toggle.
  if (entry.asked || entry.replaced) {
    const metaRow = document.createElement('span');
    metaRow.className = 'logged-entry__meta';
    const badge = document.createElement('span');
    badge.className = 'logged-entry__badge';
    if (entry.asked) {
      badge.textContent = 'Asked';
      metaRow.appendChild(badge);
      if (entry.evidence) {
        const ev = document.createElement('span');
        ev.className = 'logged-entry__evidence';
        ev.textContent = `“${entry.evidence}”`;
        metaRow.appendChild(ev);
      }
    } else if (entry.replaced) {
      badge.textContent = 'Reformulated';
      metaRow.appendChild(badge);
    }
    div.appendChild(metaRow);
  }

  return div;
}

/**
 * Renderer → main: ask the coach to prioritise an item in the next
 * suggestion. Wired up from clicking a logged item. Fire-and-forget;
 * the response arrives async via `coach:suggestion`.
 */
function requestCoachBoost(itemId) {
  console.log('[coach] boost requested:', itemId);
  window.gemini.boostCoachItem?.(itemId);
}

/**
 * Renderer → main: ask the coach to generate a question for a SPECIFIC
 * rubric item id. Fires from the per-item `+ Ask` button in the pillar
 * drawer and from the "Cover remaining" queue as it cycles through
 * items. Fire-and-forget; the response arrives async via
 * `coach:suggestion` and lands on the suggestion card the usual way.
 */
function requestCoachAskItem(itemId) {
  console.log('[coach] ask-item requested:', itemId);
  window.gemini.askItem?.(itemId);
}

/* ── "Cover remaining" coverage queue ───────────────────────────────
 *
 * When the seller hits the Cover-remaining button at the bottom of a
 * pillar's drawer, we snapshot every uncovered item in that pillar
 * (pending OR in_progress) and cycle through them one at a time. Each
 * advance fires a targeted ask via askItem; the seller can dismiss the
 * resulting suggestion (Skip) to advance to the next, or cancel by
 * reaching for any other ask button (Suggest / Deeper / Pivot / Recap).
 *
 * The queue lives on state.coverQueue (see the state shape doc above).
 * UI signal: a small "Coverage queue · N of M" badge in the suggestion
 * card's nav row, plus a transient banner on completion.
 */

/** Items in `pillar` that are NOT yet covered or logged. The queue
 *  picks from pending + in_progress only — covered/logged items have
 *  already been touched, so the seller doesn't need a fresh question
 *  for them. */
function uncoveredItemsForPillar(pillarId) {
  const items = ITEMS_BY_PILLAR[pillarId] || [];
  return items.filter((it) => {
    const s = itemStateFor(it.id);
    return s === 'pending' || s === 'in_progress';
  });
}

/**
 * Start (or restart) the cover queue for the given pillar. Snapshots
 * the pillar's uncovered items, stashes them on state.coverQueue, and
 * fires the targeted ask for the first item. No-op if the pillar has
 * zero uncovered items.
 */
function startCoverQueue(pillarId) {
  const items = uncoveredItemsForPillar(pillarId);
  if (items.length === 0) return;
  state.coverQueue = { pillarId, items, index: 0 };
  console.log('[coach] cover-queue start:', pillarId, '— items:', items.length);
  requestCoachAskItem(items[0].id);
  renderCoachSuggestion();
}

/**
 * Advance the cover queue by one. If we walk off the end, clear the
 * queue and surface a transient "pillar coverage complete" banner so
 * the seller knows the cycle finished. Called from the Skip handler
 * on the suggestion card AND from the right-arrow keyboard shortcut
 * when at the live edge.
 */
function advanceCoverQueue() {
  const q = state.coverQueue;
  if (!q) return;
  const nextIndex = q.index + 1;
  if (nextIndex >= q.items.length) {
    clearCoverQueue({ showCompletion: true });
    return;
  }
  q.index = nextIndex;
  console.log('[coach] cover-queue advance:', nextIndex + 1, '/', q.items.length);
  requestCoachAskItem(q.items[nextIndex].id);
  renderCoachSuggestion();
}

/**
 * Drop the active queue. Called from (a) advanceCoverQueue when the
 * cycle finishes, (b) any of the other ask buttons (the seller has
 * effectively cancelled by reaching for a different ask), and (c)
 * clearScoringState when the session ends.
 *
 * `showCompletion` shows the transient "pillar coverage complete"
 * banner — set true ONLY when the queue ran to completion naturally.
 * Cancelling early should silently drop the queue.
 */
function clearCoverQueue({ showCompletion = false } = {}) {
  const wasActive = !!state.coverQueue;
  state.coverQueue = null;
  if (wasActive) renderCoachSuggestion();
  if (wasActive && showCompletion) showCoverQueueCompleteBanner();
}

/* Transient "pillar coverage complete" banner. Mirrors the visual
 * register of .dedup-hint but in green to read as a success signal
 * (rather than amber which the dedup-hint uses for a warning). Built
 * lazily via JS so we don't have to touch index.html — the banner
 * only exists in the DOM while it's visible. */
let _coverQueueBannerTimer = null;
function showCoverQueueCompleteBanner() {
  // Tear down any previous instance so a back-to-back completion
  // doesn't double-stack banners.
  hideCoverQueueCompleteBanner();
  const banner = document.createElement('div');
  banner.id = 'coverQueueCompleteBanner';
  banner.className = 'cover-queue-complete';
  banner.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = 'Pillar coverage complete';
  banner.appendChild(msg);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'cover-queue-complete__dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', hideCoverQueueCompleteBanner);
  banner.appendChild(dismiss);
  document.body.appendChild(banner);
  clearTimeout(_coverQueueBannerTimer);
  _coverQueueBannerTimer = setTimeout(hideCoverQueueCompleteBanner, 3500);
}

function hideCoverQueueCompleteBanner() {
  clearTimeout(_coverQueueBannerTimer);
  const el = document.getElementById('coverQueueCompleteBanner');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function renderLiveSignalsBody() {
  if (state.flags.length === 0) {
    const p = document.createElement('p');
    p.className = 'rail-overlay__empty';
    p.textContent = 'No flags yet. Keep going — the coach is listening.';
    return p;
  }

  const wrap = document.createElement('div');
  wrap.className = 'checklist';

  for (const f of state.flags) {
    const row = document.createElement('div');
    row.className = 'flag-row';
    row.dataset.severity = f.severity;

    const bar = document.createElement('span');
    bar.className = 'flag-row__bar';
    bar.setAttribute('aria-hidden', 'true');
    row.appendChild(bar);

    const body = document.createElement('div');
    body.className = 'flag-row__body';

    const titleLine = document.createElement('span');
    titleLine.className = 'flag-row__title';

    const kind = document.createElement('span');
    kind.className = 'flag-row__kind';
    kind.textContent = f.severity === 'red' ? 'Risk' : 'Bonus';
    titleLine.appendChild(kind);

    const name = document.createElement('span');
    name.textContent = f.short;
    titleLine.appendChild(name);

    body.appendChild(titleLine);
    if (f.evidence) {
      const ev = document.createElement('span');
      ev.className = 'flag-row__evidence';
      ev.textContent = `“${f.evidence}”`;
      body.appendChild(ev);
    }
    row.appendChild(body);
    wrap.appendChild(row);
  }

  return wrap;
}

/* ── Captured-pane bullet splitting + recap tooltip ─────────────────── */

/**
 * Decide whether a field value should be split into bullet items and,
 * if so, return the raw split array. Returns null to keep as single line.
 *
 * Trigger: length > 60, OR contains ';', OR comma-space split ≥ 3 items.
 * Split priority:
 *   1. Semicolons — strong sentence boundaries (any count ≥ 2).
 *   2. ", " — only when split produces ≥ 3 items.
 *   3. null  — can't split meaningfully; stay as single line.
 */
function splitIntoBullets(text) {
  const shouldBullet =
    text.length > 60 ||
    text.includes(';') ||
    text.split(', ').length > 2;
  if (!shouldBullet) return null;
  if (text.includes(';')) {
    const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  const commaParts = text.split(', ').map((s) => s.trim()).filter(Boolean);
  if (commaParts.length >= 3) return commaParts;
  return null;
}

/** Strip trailing punctuation and capitalise the first letter. */
function cleanBulletItem(raw) {
  const s = raw.replace(/[;,]+$/, '').trim();
  if (!s.length) return '';
  return s[0].toUpperCase() + s.slice(1);
}

/* ── Quick-fix rollup (Strategy A / Work-stream C) ────────────────
 *
 * Replaces the v1 regex-based "Total potential revenue" block at the
 * top of #capturedPane. Money capture now flows through the
 * `record_meeting_fact` tool (src/coach.js) → structured factsSheet
 * in main → Stage-2 background AI (src/quick-fix.js) → this
 * renderer.
 *
 * Lifecycle
 *   - Main fires `scoring:quick-fix` with { quickFix, entries }
 *     on every Stage-2 roundtrip (success OR fallback-with-stale).
 *   - The subscriber mirrors the payload onto state.quickFix /
 *     state.quickFixEntries and calls renderQuickFix.
 *   - renderQuickFix populates the static #quickFix section in
 *     index.html (no DOM creation outside the existing nodes).
 *
 * Drill-through
 *   - Each breakdown row carries its source fact id. Clicking a row
 *     looks up the fact in state.quickFixEntries, then finds the
 *     transcript line whose text contains the anchor quote, scrolls
 *     to it, and adds .transcript-pane__line--highlight for ~2s.
 *   - Rows with source === 'derived' aren't clickable; the
 *     data-clickable='false' attribute suppresses the hover affordance.
 */

/** Pretty-print a positive dollar amount in compact ($4M / $20K / $750) form.
 *  Kept as a stand-alone helper so the quick-fix card can format
 *  both the headline and per-row amounts identically without
 *  pulling in a number-formatting library. Mirrors the v1 formatMoney
 *  exactly so reps moving from the old rollup don't have to relearn
 *  the abbreviations. */
function formatMoney(amount) {
  if (!Number.isFinite(amount) || amount === 0) return '$0';
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toLocaleString()}`;
}

/**
 * Populate the static #quickFix card from state.quickFix +
 * state.quickFixEntries. Idempotent — safe to call on every
 * scoring:quick-fix IPC even when the rollup hasn't materially
 * changed (the DOM diff is cheap because the card has a fixed
 * structure).
 *
 * Visibility rules:
 *   - state.quickFix === null   → hide entirely (no money facts yet)
 *   - quickFix.error === true   → show "Rollup unavailable" status
 *   - quickFix.stale === true   → show "Rollup paused, retrying…"
 *   - otherwise                 → show the rollup, status hidden
 *
 * The card stays hidden until the FIRST roundtrip completes —
 * surfacing an empty card during the initial debounce would just be
 * noise (the rep can see the existing field grid below).
 */
function renderQuickFix() {
  if (!quickFixEl) return;
  const rollup = state.quickFix;
  if (!rollup) {
    quickFixEl.hidden = true;
    return;
  }
  quickFixEl.hidden = false;

  // Headline + confidence pill
  const headlineEl = quickFixEl.querySelector('.quick-fix__headline');
  const confidenceEl = quickFixEl.querySelector('.quick-fix__confidence');
  if (headlineEl instanceof HTMLElement) {
    headlineEl.textContent = formatMoney(rollup.headlineUsdAnnual)
      + (rollup.currency && rollup.currency !== 'USD' ? ` ${rollup.currency}` : '')
      + ' / year';
  }
  if (confidenceEl instanceof HTMLElement) {
    confidenceEl.textContent = rollup.confidence || 'medium';
    confidenceEl.dataset.level = rollup.confidence || 'medium';
  }

  // Breakdown rows. Each row is clickable when source maps to a real
  // fact id — clicking drills to the anchor quote in the transcript
  // pane (see drillToQuickFixSource below). 'derived' rows aren't
  // clickable because there's no single anchor to scroll to.
  const breakdownEl = quickFixEl.querySelector('.quick-fix__breakdown');
  if (breakdownEl instanceof HTMLElement) {
    breakdownEl.replaceChildren();
    for (const row of rollup.breakdown || []) {
      const li = document.createElement('li');
      li.className = 'quick-fix__row';
      const isDerived = row.source === 'derived';
      li.dataset.clickable = String(!isDerived);
      if (!isDerived) {
        li.dataset.factId = row.source;
        li.title = 'Click to find this in the transcript';
        li.addEventListener('click', () => drillToQuickFixSource(row.source));
      }
      const label = document.createElement('span');
      label.className = 'quick-fix__row-label';
      label.textContent = row.label;
      const amount = document.createElement('span');
      amount.className = 'quick-fix__row-amount';
      amount.textContent = formatMoney(row.amountUsdAnnual);
      li.appendChild(label);
      li.appendChild(amount);
      if (row.notes) {
        const notes = document.createElement('span');
        notes.className = 'quick-fix__row-notes';
        notes.textContent = row.notes;
        li.appendChild(notes);
      }
      breakdownEl.appendChild(li);
    }
  }

  // Assumptions list. Hidden when empty so the card stays tight on
  // call-start (no facts → no assumptions → no empty section).
  const assumptionsEl = quickFixEl.querySelector('.quick-fix__assumptions');
  if (assumptionsEl instanceof HTMLElement) {
    assumptionsEl.replaceChildren();
    for (const text of rollup.assumptions || []) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const li = document.createElement('li');
      li.className = 'quick-fix__assumption';
      li.textContent = text;
      assumptionsEl.appendChild(li);
    }
    assumptionsEl.hidden = !assumptionsEl.children.length;
  }

  // Export button — copies {exportedAt, rollup, entries} JSON to the
  // clipboard so the rep can paste the full Stage-2 rollup + the
  // underlying Stage-1 facts into post-call notes / CRM / Slack.
  //
  // Wired here (not at module init) so the click handler closes over
  // state.quickFix / state.quickFixEntries at click time — and so we
  // can reassign .onclick on every render (rather than
  // addEventListener) to avoid accumulating duplicate handlers across
  // re-renders. The button is hidden when state.quickFix is null
  // (handled implicitly by hiding the whole card at line 1990).
  const exportBtn = quickFixEl.querySelector('.quick-fix__export');
  if (exportBtn instanceof HTMLButtonElement) {
    exportBtn.hidden = false;
    exportBtn.onclick = () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        rollup: state.quickFix,
        entries: state.quickFixEntries || [],
      };
      const json = JSON.stringify(payload, null, 2);
      const flash = (label, status) => {
        exportBtn.dataset.state = status;
        exportBtn.textContent = label;
        setTimeout(() => {
          delete exportBtn.dataset.state;
          exportBtn.textContent = 'Export';
        }, 1500);
      };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(json)
          .then(() => flash('Copied', 'copied'))
          .catch((err) => {
            console.warn('[quick-fix] clipboard write failed:', err);
            flash('Copy failed', 'error');
          });
      } else {
        // Fallback when the clipboard API is unavailable (sandbox
        // restrictions, older Electron). Log the payload so the rep
        // can still grab it from the dev-tools console rather than
        // losing the export entirely.
        console.warn('[quick-fix] clipboard API unavailable; logging JSON instead');
        console.log(json);
        flash('Logged', 'copied');
      }
    };
  }

  // Status pill — visible when the worker is in a degraded state.
  // Two visual variants keyed off data-status:
  //   'error' → red "Rollup unavailable" (3+ consecutive failures)
  //   'stale' → amber "Rollup paused, retrying…" (single failure)
  const statusEl = quickFixEl.querySelector('.quick-fix__status');
  if (statusEl instanceof HTMLElement) {
    if (rollup.error) {
      statusEl.hidden = false;
      statusEl.dataset.status = 'error';
      statusEl.textContent = 'Rollup unavailable. Showing last value.';
    } else if (rollup.stale) {
      statusEl.hidden = false;
      statusEl.dataset.status = 'stale';
      statusEl.textContent = 'Rollup paused, retrying…';
    } else {
      statusEl.hidden = true;
      statusEl.textContent = '';
      delete statusEl.dataset.status;
    }
  }
}

/**
 * Drill from a quick-fix breakdown row back to the moment in the
 * transcript pane where the source fact was stated. Lookup is:
 *
 *   1. Find the fact in state.quickFixEntries by id.
 *   2. Substring-match the fact's quote against each committed line.
 *      First match wins (so the earliest mention wins when the
 *      prospect repeats themselves).
 *   3. Scroll the transcript pane to that line and add the
 *      .transcript-pane__line--highlight class for ~2s so the rep
 *      can see WHY the number is in the total.
 *
 * Failure modes (all silent in the UI):
 *   - Unknown id → no-op (most likely a row that was rendered
 *     before the corresponding entries mirror updated).
 *   - No matching transcript line → no-op (the quote may have been
 *     paraphrased by the model; we don't try fuzzy matching here).
 */
function drillToQuickFixSource(factId) {
  if (!factId || typeof factId !== 'string') return;
  const entry = (state.quickFixEntries || []).find((e) => e && e.id === factId);
  if (!entry || !entry.quote || typeof entry.quote !== 'string') return;
  const needle = entry.quote.trim();
  if (!needle) return;
  const lines = state.transcript.committed || [];
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]?.text || '';
    if (text.includes(needle)) { matchIdx = i; break; }
  }
  if (matchIdx < 0) return;
  // Find the corresponding DOM node — the transcript list renders
  // one <p.transcript-pane__line> per committed line in arrival
  // order, so the same index applies. We grab from the live DOM (not
  // a cached reference) because renderTranscriptPane may have
  // rebuilt the list since the rollup was rendered.
  if (!transcriptListEl) return;
  const lineEls = transcriptListEl.querySelectorAll('.transcript-pane__line:not(.transcript-pane__line--pending)');
  const target = lineEls[matchIdx];
  if (!(target instanceof HTMLElement)) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('transcript-pane__line--highlight');
  setTimeout(() => {
    target.classList.remove('transcript-pane__line--highlight');
  }, 2000);
}

/**
 * Truncate text to ≤ 60 words, preferring to break at the last clause
 * boundary (comma, semicolon, or em-dash) within the first 60 words.
 */
function truncateValueTo60Words(text) {
  const words = text.split(/\s+/);
  if (words.length <= 60) return text;
  const shortened = words.slice(0, 60).join(' ');
  const lastPunct = Math.max(
    shortened.lastIndexOf(','),
    shortened.lastIndexOf(';'),
    shortened.lastIndexOf('—'),
  );
  return lastPunct > 20 ? shortened.slice(0, lastPunct).trim() : shortened;
}

/**
 * Map a captured field id to one of four tooltip template categories.
 * Keyword matching is substring-based, applied to the lowercase field id.
 */
function recapCategory(fieldId) {
  const id = fieldId.toLowerCase();
  if (/pain|problem|gap|challenge/.test(id)) return 'pain';
  if (/decision|who|stakeholder/.test(id)) return 'decision';
  if (/budget|cost|annual|revenue|spend/.test(id)) return 'finance';
  return 'default';
}

/**
 * Build a verbatim spoken-recap sentence the rep can say to the prospect.
 * If the value splits into bullets, they're joined with ", and " before
 * being substituted into the category-specific template.
 */
function buildRecapSentence(fieldId, rawValue) {
  const bullets = splitIntoBullets(rawValue);
  let valueStr;
  if (bullets) {
    const items = bullets
      .map((b) => {
        const c = cleanBulletItem(b);
        return c ? c[0].toLowerCase() + c.slice(1) : '';
      })
      .filter(Boolean);
    if (items.length === 1) valueStr = items[0];
    else if (items.length === 2) valueStr = `${items[0]} and ${items[1]}`;
    else valueStr = `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  } else {
    valueStr = rawValue;
  }
  const v = truncateValueTo60Words(valueStr);
  const vLow = v ? v[0].toLowerCase() + v.slice(1) : v;
  switch (recapCategory(fieldId)) {
    case 'pain':
      return `If I'm hearing you right, you mentioned ${vLow}. Is that a fair summary?`;
    case 'decision':
      return `So if I understand correctly, ${vLow}. Did I get that right?`;
    case 'finance':
      return `Just to make sure I've got this — ${vLow}. Is that in the right ballpark?`;
    default:
      return `You mentioned ${vLow} earlier. Does that still sound accurate?`;
  }
}

let _capturedTooltipTimer = null;

function showCapturedTooltip(el) {
  if (!capturedTooltipEl) return;
  const fieldId = el.dataset.tooltipFieldId;
  const rawValue = el.dataset.tooltipValue;
  if (!fieldId || !rawValue) return;
  // Rebuild tooltip body: primary recap line + optional small italic evidence
  // line. Using child elements (not innerHTML) keeps text safely escaped.
  capturedTooltipEl.replaceChildren();
  const recapEl = document.createElement('div');
  // Allow callers to override the recap sentence per-element (e.g. the
  // revenue-rollup component bullets use a bespoke "potential value"
  // template). Falls back to the standard category-based recap.
  const customRecap = el.dataset.tooltipRecap;
  recapEl.textContent = customRecap || buildRecapSentence(fieldId, rawValue);
  capturedTooltipEl.appendChild(recapEl);
  const evidence = el.dataset.tooltipEvidence;
  if (evidence) {
    const evEl = document.createElement('em');
    evEl.style.display = 'block';
    evEl.style.marginTop = '6px';
    evEl.style.fontSize = '10.5px';
    evEl.style.opacity = '0.7';
    evEl.textContent = `Evidence: "${evidence}"`;
    capturedTooltipEl.appendChild(evEl);
  }
  const rect = el.getBoundingClientRect();
  let top = rect.bottom + 12;
  let left = rect.left;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (left + 320 > vw - 8) left = Math.max(8, vw - 320 - 8);
  if (top + 80 > vh - 8) top = Math.max(8, rect.top - 80 - 12);
  capturedTooltipEl.style.top = `${Math.round(top)}px`;
  capturedTooltipEl.style.left = `${Math.round(left)}px`;
  clearTimeout(_capturedTooltipTimer);
  _capturedTooltipTimer = setTimeout(() => capturedTooltipEl.classList.add('visible'), 200);
}

function hideCapturedTooltip() {
  clearTimeout(_capturedTooltipTimer);
  if (capturedTooltipEl) capturedTooltipEl.classList.remove('visible');
}

function renderCaptured() {
  /** @type {Record<string, HTMLElement[]>} */
  const byGroup = {};
  for (const f of CAPTURED_FIELDS) {
    const captured = state.capturedFields[f.id];

    const pair = document.createElement('div');
    pair.className = 'captured__pair';

    const label = document.createElement('span');
    label.className = 'captured__label';
    label.textContent = f.label;
    pair.appendChild(label);

    // Build value element — bullet list or plain span
    let valueEl;
    if (captured?.value) {
      const bullets = splitIntoBullets(captured.value);
      if (bullets && bullets.length >= 2) {
        valueEl = document.createElement('ul');
        valueEl.className = 'captured__value captured__value--list';
        for (const raw of bullets) {
          const cleaned = cleanBulletItem(raw);
          if (!cleaned) continue;
          const li = document.createElement('li');
          li.textContent = cleaned;
          valueEl.appendChild(li);
        }
      } else {
        valueEl = document.createElement('span');
        valueEl.className = 'captured__value';
        valueEl.textContent = captured.value;
      }
      valueEl.dataset.tooltipFieldId = f.id;
      valueEl.dataset.tooltipValue = captured.value;
      if (captured.evidence) valueEl.dataset.tooltipEvidence = captured.evidence;
      valueEl.addEventListener('mouseenter', () => showCapturedTooltip(valueEl));
      valueEl.addEventListener('mouseleave', hideCapturedTooltip);
    } else {
      valueEl = document.createElement('span');
      valueEl.className = 'captured__value captured__value--empty';
      valueEl.textContent = '—';
    }
    pair.appendChild(valueEl);

    (byGroup[f.group] ||= []).push(pair);
  }

  const out = [];
  for (const groupName of FIELD_GROUPS) {
    const heading = document.createElement('h3');
    heading.className = 'captured__heading';
    heading.textContent = groupName;

    const group = document.createElement('section');
    group.className = 'captured__group';
    group.appendChild(heading);
    for (const pair of byGroup[groupName] || []) group.appendChild(pair);

    out.push(group);
  }

  /* Strategy A / Work-stream C: the legacy regex revenue-rollup block
   * is gone. The quick-fix card now lives at the top of #capturedPane
   * as a static element in index.html (#quickFix) — it's populated
   * separately by renderQuickFix() in response to the scoring:quick-fix
   * IPC, not by this function.
   *
   * We have to preserve the #quickFix element across replaceChildren()
   * calls here. Strategy: snapshot it, replace children, then prepend
   * it back. Cheap because it's a single DOM node we already have a
   * reference to.
   */
  capturedPaneEl.replaceChildren(...out);
  if (quickFixEl) capturedPaneEl.prepend(quickFixEl);
}

function showConnectionError(message) {
  state.errorMessage = message || 'Connection lost';
  renderTranscriptPane();
}

function clearScoringState() {
  state.flags = [];
  state.itemStates = new Map();
  state.capturedFields = {};
  // Strategy A / Work-stream C: wipe the rollup mirror so a previous
  // call's headline + breakdown doesn't linger into the new session.
  // renderQuickFix below renders this as "hidden" when null.
  state.quickFix = null;
  state.quickFixEntries = [];
  state.pillarStatus = Object.fromEntries(PILLARS.map((p) => [p.id, 'idle']));
  state.transcript = {
    committed: [],
    pendingBySpeaker: { you: '', other: '' },
  };
  /* A fresh call should always begin in follow-the-live-edge mode,
   * even if the previous session ended with the user scrolled up.
   * See the stickToBottomTranscript declaration near the
   * transcript element refs for the full pattern. */
  stickToBottomTranscript = true;
  // Drop stale cross-channel dedupe state; a fresh call shouldn't
  // inherit the previous session's last commits.
  recentRendererCommitBySpeaker.you = null;
  recentRendererCommitBySpeaker.other = null;
  // Reset the speaker-bleed counter + one-shot hint guard so the
  // banner can re-surface on the next call if the user is still on
  // speakers. Hint-shown intentionally clears here, not on app boot —
  // we want to remind once per session, not once per process lifetime.
  recentDedupDrops = 0;
  dedupHintShown = false;
  hideDedupHintBanner();
  state.coachHistory = [];
  state.coachIndex = -1;
  state.coachThinking = false;
  // Drop the per-call suggestion-history mirror so the next session
  // starts with a clean drawer. The Coach toggles persist (they're
  // user preferences, not per-call state).
  state.suggestionHistory = [];
  state.errorMessage = null;
  // Drop any in-flight cover-queue cycle silently — a fresh session
  // shouldn't inherit the previous call's queue or show a stale
  // completion banner. hideCoverQueueCompleteBanner() also tears
  // down any visible banner from the previous session.
  state.coverQueue = null;
  hideCoverQueueCompleteBanner();
  // Also clear any lingering "Recap in progress…" pill — if the user
  // hit Stop right after clicking Recap, the safety timer would still
  // be running and could surface a stale pill on the next call.
  hideRecapInProgressPill();
  /* v3 progress overlay: same principle — wipe any in-flight ask
   * button layers + their timers so a fresh session doesn't inherit
   * the previous call's animations or fire a late "failed" tint on
   * a button the user already moved on from. */
  clearAskButtonProgress();
  // Reset the connection-status mirror so a previous session's
  // 'connected' / 'down' doesn't leak into the new session's pill
  // before the first connection:status broadcast lands. Main also
  // resets its mirror in resetCoachContext and broadcasts the empty
  // state, so the two stay in lockstep.
  state.connection = { deepgram: 'down', geminiLive: 'down' };
  renderRail();
  renderRailOverlay();
  renderCaptured();
  renderQuickFix();
  renderTranscriptPane();
  renderCoachSuggestion();
  renderCoachThinking();
}

/* ── Status / pillar progression ──────────────────────────────────── */

function recomputePillarStatus(pillarId) {
  if (pillarId === 'live_signals') {
    state.pillarStatus.live_signals = state.flags.length === 0 ? 'idle' : 'in_progress';
    return;
  }
  if (pillarId === 'logged_questions') {
    // The Logged pillar derives its status from any item currently in
    // `logged` state across the entire rubric.
    const hasLogged = loggedItems().length > 0;
    state.pillarStatus.logged_questions = hasLogged ? 'in_progress' : 'idle';
    return;
  }
  const items = ITEMS_BY_PILLAR[pillarId] || [];
  let covered = 0;
  let touched = 0;
  for (const it of items) {
    const s = itemStateFor(it.id);
    if (s === 'covered') covered += 1;
    if (s !== 'pending') touched += 1;
  }
  if (touched === 0) state.pillarStatus[pillarId] = 'idle';
  else if (covered >= items.length) state.pillarStatus[pillarId] = 'complete';
  else state.pillarStatus[pillarId] = 'in_progress';
}

/* ── Scoring event handlers ────────────────────────────────────────── */

function applyFlag({ id, evidence }) {
  if (typeof id !== 'string') return;
  if (state.flags.some((f) => f.id === id)) return;
  const meta = FLAGS_BY_ID[id];
  if (!meta) {
    console.warn('[scoring] unknown flag id:', id);
    return;
  }
  state.flags.push({
    id,
    evidence: typeof evidence === 'string' ? evidence : '',
    severity: meta.severity,
    short: meta.short,
    desc: meta.desc,
    category: meta.category,
  });
  recomputePillarStatus('live_signals');
  renderRail();
  if (state.activePillarId === 'live_signals') renderRailOverlay();
}

function applyItemStateChange({ itemId, state: nextState, evidence, confidence, source }) {
  if (typeof itemId !== 'string') return;
  if (nextState !== 'in_progress' && nextState !== 'covered' && nextState !== 'logged') return;
  const meta = ITEMS_BY_ID[itemId];
  if (!meta) {
    console.warn('[scoring] unknown item id:', itemId);
    return;
  }

  // Terminal state: once an item is covered, ignore any subsequent
  // demotion. The coach is told this in the prompt, but main also
  // guards — belt-and-braces here too.
  const prev = state.itemStates.get(itemId);
  if (prev?.state === 'covered' && nextState !== 'covered') return;

  state.itemStates.set(itemId, {
    state: nextState,
    evidence: typeof evidence === 'string' ? evidence : '',
    confidence: typeof confidence === 'number' ? confidence : 0,
    source: typeof source === 'string' ? source : 'model',
    at: Date.now(),
  });

  recomputePillarStatus(meta.pillarId);
  // The synthetic Logged pillar's status depends on items across the
  // whole rubric, so it needs to re-evaluate on every transition.
  recomputePillarStatus('logged_questions');
  renderRail();
  if (
    state.activePillarId === meta.pillarId ||
    state.activePillarId === 'logged_questions'
  ) {
    renderRailOverlay();
  }
}

function applyFieldCaptured({ fieldId, value, evidence }) {
  if (typeof fieldId !== 'string' || typeof value !== 'string') return;
  if (!FIELDS_BY_ID[fieldId]) {
    console.warn('[scoring] unknown field id:', fieldId);
    return;
  }
  state.capturedFields[fieldId] = {
    value,
    evidence: typeof evidence === 'string' ? evidence : '',
    at: Date.now(),
  };
  renderCaptured();
}

/* ── Audio capture / speaker activity ────────────────────────────────
 *
 * Each capture chain has its own AnalyserNode. The single rAF tick
 * reads both, computes per-channel RMS, and toggles its speaker pill
 * independently — so during cross-talk both pills can light up at the
 * same time. */

/**
 * Compute RMS for one chain. Returns `null` if the chain isn't
 * initialised. The `level` is RMS * LEVEL_GAIN clipped to [0, 1].
 */
function readChannelLevel(chain) {
  if (!chain.analyser || !chain.analyserBuffer) return null;
  chain.analyser.getByteTimeDomainData(chain.analyserBuffer);
  let sumSquares = 0;
  for (let i = 0; i < chain.analyserBuffer.length; i++) {
    const sample = (chain.analyserBuffer[i] - 128) / 128;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / chain.analyserBuffer.length);
  return Math.min(1, rms * LEVEL_GAIN);
}

/**
 * Per-channel speaker-activity update. Latches the pill on whenever
 * the channel is loud enough, latches off after a quiet period to
 * absorb micro-pauses inside a sentence.
 */
function updateChannelActivity(speaker, level, now) {
  if (level == null) return false;
  const chain = speaker === 'you' ? state.mic : state.sys;
  const wasActive = state.activeSpeakers[speaker];
  let nextActive = wasActive;

  if (level > SPEAKER_RMS_ON) {
    chain.lastActiveAt = now;
    nextActive = true;
  } else if (wasActive && now - chain.lastActiveAt > SPEAKER_RMS_OFF_AFTER_MS) {
    nextActive = false;
  }

  if (nextActive !== wasActive) {
    state.activeSpeakers[speaker] = nextActive;
    return true;
  }
  return false;
}

function tickAnalyser() {
  const now = performance.now();

  const youLevel = readChannelLevel(state.mic);
  const otherLevel = readChannelLevel(state.sys);

  let changed = false;
  if (updateChannelActivity('you', youLevel, now)) changed = true;
  if (updateChannelActivity('other', otherLevel, now)) changed = true;
  if (changed) renderSpeakers();

  state.rafId = requestAnimationFrame(tickAnalyser);
}

/**
 * Build a single capture chain (source → analyser + worklet) on the
 * shared AudioContext. Used twice in startCapture(): once for the mic
 * (channel 1, send via sendMicAudio), once for the system audio
 * loopback (channel 2, send via sendSystemAudio).
 */
function buildCaptureChain({ stream, audioContext, sendChunk }) {
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const workletNode = new AudioWorkletNode(audioContext, 'pcm-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    processorOptions: { targetRate: 16000, frameSamples: 1600 },
  });
  workletNode.port.onmessage = (event) => {
    const buffer = event.data;
    if (buffer && buffer.byteLength > 0) {
      sendChunk(new Uint8Array(buffer));
    }
  };
  source.connect(workletNode);

  return {
    stream,
    source,
    analyser,
    workletNode,
    analyserBuffer: new Uint8Array(analyser.fftSize),
    lastActiveAt: 0,
  };
}

/**
 * Try to open a system-audio loopback stream via the renderer's
 * `getDisplayMedia`. Returns the stream on success or `null` on
 * failure. Failure cases are not raised — the caller is expected to
 * surface the permission modal and continue with mic-only capture.
 *
 * The browser API requires a video track in the request and in the
 * response, but we don't actually want screen pixels. We stop +
 * detach the video tracks immediately so the OS-level screen-capture
 * preview indicator doesn't show.
 */
async function tryOpenSystemAudioStream() {
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    for (const track of displayStream.getVideoTracks()) {
      try { track.stop(); } catch { /* ignore */ }
      displayStream.removeTrack(track);
    }

    if (displayStream.getAudioTracks().length === 0) {
      console.warn('[system-audio] getDisplayMedia returned no audio tracks');
      return null;
    }

    return displayStream;
  } catch (err) {
    console.warn('[system-audio] getDisplayMedia failed:', err?.name || '', err?.message || err);
    return null;
  }
}

async function startCapture() {
  if (state.status === 'listening' || state.status === 'starting') return;
  setStatus('starting');
  clearScoringState();

  // 1. Mic — fail hard if blocked. Without a mic we have nothing to send.
  //
  // AEC3 (Chromium's modern echo canceller) is the load-bearing
  // constraint here when the user is on speakers rather than
  // headphones: it captures the prospect bleed via the system default
  // output as the reference signal and subtracts it from the mic
  // input. Result: channel 1 carries the salesperson's voice only,
  // and the dual-stream pipeline doesn't have to dedup speakers
  // post-hoc. Constraints are expressed as `{ ideal: true }` so a
  // hardware combo that refuses AEC (rare — some Bluetooth / USB
  // interfaces) still yields a working mic stream rather than an
  // OverconstrainedError. The legacy `goog*` hints are harmless on
  // modern Chromium and may help on older versions / odd OS combos.
  //
  // The actual AEC state is read back from MediaTrackSettings after
  // capture (see [audio] mic settings: log below) and surfaced to
  // the user via the AEC badge in the header. If the browser
  // reports echoCancellation=false we light the badge red so the
  // user knows their hardware refused — without this it would be
  // invisible.
  // Phase 2: read user-configurable audio constraints from
  // settingsCache before opening the mic. Defaults are ON so a
  // first-boot user (or any settings file without `audio.*` keys)
  // gets the same Chromium-recommended constraints as pre-Phase-2.
  //
  // The `!== false` shape lets a missing key (e.g. `audio.aec`
  // undefined) default to ON, which matches the explicit
  // `audio.aec: true` default in src/settings.js — a settings file
  // that only partially populates the audio block doesn't accidentally
  // disable AEC.
  //
  // Caveat: Chromium command-line force-switches in
  // [src/main.js](src/main.js) lines 72–76 (WebRtcEchoCanceller3 +
  // the field-trial pin) may override `echoCancellation: false` on
  // some platforms. The Audio tab's AEC toggle sub-text surfaces this.
  // A future change could thread the AEC setting through to app-boot
  // and conditionally apply the switches, but that requires reading
  // settings before `app.whenReady` (achievable, out of Phase 2 scope).
  //
  // Stale device IDs: if `audio.micDeviceId` references a device
  // that's no longer attached (USB unplug, OS reset), getUserMedia
  // throws OverconstrainedError. We catch the failure and retry with
  // an unconstrained device-id so the user gets capture rather than
  // a hard error.
  const audioPrefs = settingsCache?.audio || {};
  const micDeviceId = typeof audioPrefs.micDeviceId === 'string' ? audioPrefs.micDeviceId : '';

  const baseAudioConstraints = {
    echoCancellation: { ideal: audioPrefs.aec !== false },
    noiseSuppression: { ideal: audioPrefs.noiseSuppression !== false },
    autoGainControl: { ideal: audioPrefs.autoGainControl !== false },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    // Chromium legacy hints — harmless on newer versions, helpful
    // on older ones / odd hardware combos. Safe to pass alongside
    // the standard MediaStreamConstraints above. The `goog*` hints
    // track the same on/off as the standard fields so the platform
    // sees a consistent intent.
    googEchoCancellation: { ideal: audioPrefs.aec !== false },
    googAutoGainControl: { ideal: audioPrefs.autoGainControl !== false },
    googNoiseSuppression: { ideal: audioPrefs.noiseSuppression !== false },
    googHighpassFilter: { ideal: true },
    googTypingNoiseDetection: { ideal: true },
  };

  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: micDeviceId
        ? { ...baseAudioConstraints, deviceId: { exact: micDeviceId } }
        : baseAudioConstraints,
      video: false,
    });
  } catch (err) {
    // Specific fallback for stale device IDs — retry without the
    // exact deviceId constraint so the OS default mic still works.
    if (micDeviceId && err?.name === 'OverconstrainedError') {
      console.warn(
        '[mic] persisted micDeviceId no longer attached — falling back to OS default mic',
      );
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: baseAudioConstraints,
          video: false,
        });
      } catch (retryErr) {
        console.error('[mic] getUserMedia retry failed:', retryErr);
        showConnectionError('Microphone blocked. Enable mic access in System Settings.');
        setStatus('idle');
        return;
      }
    } else {
      console.error('[mic] getUserMedia failed:', err);
      showConnectionError('Microphone blocked. Enable mic access in System Settings.');
      setStatus('idle');
      return;
    }
  }

  // Diagnostic: what did the browser actually give us back? AEC and
  // the other audio constraints are advisory — Chromium can refuse
  // any of them based on the underlying hardware. Read the settings
  // immediately so we can confirm the AEC reference signal is being
  // applied at the OS level, and surface the result via the badge.
  const micSettings = micStream.getAudioTracks()[0]?.getSettings() || {};
  console.log('[audio] mic settings:', {
    echoCancellation: micSettings.echoCancellation,
    noiseSuppression: micSettings.noiseSuppression,
    autoGainControl: micSettings.autoGainControl,
    channelCount: micSettings.channelCount,
    sampleRate: micSettings.sampleRate,
    deviceId: micSettings.deviceId?.slice(0, 8),
  });
  updateAecBadgeFromSettings(micSettings);

  // 2. System audio loopback — best-effort. Failure shows the
  //    permission explainer modal but doesn't abort the call.
  //
  // Critically, we do NOT request AEC on this stream. The loopback
  // is already a clean isolated source (the prospect's voice routed
  // through the system mixer); running AEC on it would over-process
  // — there's no "echo" of the user's mic to cancel, and AEC's
  // adaptive filter would chew on phantom references. Keep its
  // constraints whatever tryOpenSystemAudioStream sets (currently
  // `audio: true`, plain).
  const sysStream = await tryOpenSystemAudioStream();
  state.systemAudioStatus = sysStream ? 'capturing' : 'denied';
  if (!sysStream) {
    // Show the explainer modal so the user knows the prospect channel
    // won't be transcribed and can grant access if they want to.
    showPermissionModal();
  } else {
    // Same diagnostic shape as the mic stream — purely for debugging
    // the loopback path. echoCancellation is expected to be
    // undefined / false here because the renderer doesn't request
    // it on getDisplayMedia.
    const sysSettings = sysStream.getAudioTracks()[0]?.getSettings() || {};
    console.log('[audio] sys settings:', {
      echoCancellation: sysSettings.echoCancellation,
      noiseSuppression: sysSettings.noiseSuppression,
      autoGainControl: sysSettings.autoGainControl,
      channelCount: sysSettings.channelCount,
      sampleRate: sysSettings.sampleRate,
      deviceId: sysSettings.deviceId?.slice(0, 8),
    });
  }

  // 3. Start backing sessions (Gemini Live + Deepgram in main).
  // Forward the persisted coach mode BEFORE starting the session so
  // the pause detector picks up the right state from tick zero.
  try { await window.gemini.setCoachMode?.(state.coachMode); } catch { /* non-fatal */ }
  const result = await window.gemini.start();
  if (!result?.ok) {
    micStream.getTracks().forEach((t) => t.stop());
    if (sysStream) sysStream.getTracks().forEach((t) => t.stop());
    showConnectionError(
      result?.error === 'missing_api_key'
        ? 'Missing GEMINI_API_KEY in .env'
        : 'Connection lost',
    );
    setStatus('idle');
    return;
  }

  // 4. Shared AudioContext + worklet module.
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch { /* ignore */ }
  }

  try {
    await audioContext.audioWorklet.addModule(PCM_WORKLET_URL);
  } catch (err) {
    console.error('[mic] failed to load PCM worklet:', err);
    micStream.getTracks().forEach((t) => t.stop());
    if (sysStream) sysStream.getTracks().forEach((t) => t.stop());
    await audioContext.close().catch(() => {});
    await window.gemini.stop();
    showConnectionError('Audio worklet failed to load');
    setStatus('idle');
    return;
  }

  // 5. Two capture chains.
  const micChain = buildCaptureChain({
    stream: micStream,
    audioContext,
    sendChunk: (chunk) => window.gemini.sendMicAudio(chunk),
  });

  let sysChain = null;
  if (sysStream) {
    sysChain = buildCaptureChain({
      stream: sysStream,
      audioContext,
      sendChunk: (chunk) => window.gemini.sendSystemAudio(chunk),
    });
  }

  state.audioContext = audioContext;
  state.mic = micChain;
  state.sys = sysChain || {
    stream: null,
    source: null,
    analyser: null,
    workletNode: null,
    analyserBuffer: null,
    lastActiveAt: 0,
  };

  // Recording timer.
  state.recordingStartedAt = Date.now();
  renderTimer();
  state.timerInterval = setInterval(renderTimer, 250);

  setStatus('listening');
  state.rafId = requestAnimationFrame(tickAnalyser);
}

/**
 * Tear down one capture chain — disconnect nodes, stop tracks. Safe
 * to call with a null / partially-initialised chain (some fields may
 * be missing if construction failed mid-way).
 */
function teardownChain(chain) {
  if (!chain) return;
  if (chain.workletNode) {
    try {
      chain.workletNode.port.onmessage = null;
      chain.workletNode.disconnect();
    } catch { /* ignore */ }
  }
  if (chain.source) {
    try { chain.source.disconnect(); } catch { /* ignore */ }
  }
  if (chain.stream) {
    for (const track of chain.stream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
  }
}

async function stopCapture({ keepError = false } = {}) {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  teardownChain(state.mic);
  teardownChain(state.sys);

  if (state.audioContext) {
    try { await state.audioContext.close(); } catch { /* ignore */ }
  }

  state.audioContext = null;
  state.mic = {
    stream: null,
    source: null,
    analyser: null,
    workletNode: null,
    analyserBuffer: null,
    lastActiveAt: 0,
  };
  state.sys = {
    stream: null,
    source: null,
    analyser: null,
    workletNode: null,
    analyserBuffer: null,
    lastActiveAt: 0,
  };
  state.recordingStartedAt = null;
  state.activeSpeakers = { you: false, other: false };
  state.systemAudioStatus = 'unknown';

  renderSpeakers();
  renderTimer();
  // Drop the AEC badge back to "unknown" once we stop capturing —
  // the on/off state is only meaningful while a mic stream is live.
  setAecBadgeState('unknown');

  try { await window.gemini.stop(); } catch { /* ignore */ }

  // Commit any in-flight partial transcripts so the user keeps the text.
  for (const speaker of /** @type {const} */ (['you', 'other'])) {
    const pending = state.transcript.pendingBySpeaker[speaker];
    if (pending && pending.trim()) {
      state.transcript.committed.push({ speaker, text: pending.trim() });
    }
    state.transcript.pendingBySpeaker[speaker] = '';
  }
  if (!keepError) state.errorMessage = null;

  renderTranscriptPane();
  setStatus('idle');
}

/* ── IPC subscriptions ─────────────────────────────────────────────── */

window.gemini.onTranscript(({ speaker, text, finished }) => {
  // main.js normalises both the Deepgram (canonical) and Gemini
  // (fallback) paths into the same shape:
  //   - `speaker` is always 'you' or 'other'.
  //   - `text` is the FULL current segment text (replace-on-interim
  //     semantics, NOT incremental deltas).
  //   - `finished=true` means "commit this segment and start a new one".
  if (speaker !== 'you' && speaker !== 'other') return;
  if (typeof text !== 'string') return;

  if (finished) {
    const committed = text.trim();
    if (committed) {
      // ── Cross-channel dedupe (PROSPECT-biased, mirrors main.js) ───
      // Bleed almost always flows AI/prospect → mic via speaker
      // playback, so when the same utterance lands on both channels
      // PROSPECT is the trusted side. See main.js's "Attribution
      // bias" doc-block for the full rationale.
      const other = speaker === 'you' ? 'other' : 'you';
      const otherEntry = recentRendererCommitBySpeaker[other];
      const now = Date.now();
      const isDuplicateOfOtherChannel =
        Boolean(otherEntry) &&
        now - otherEntry.ts < RENDERER_CROSS_CHANNEL_WINDOW_MS &&
        committed.length >= RENDERER_CROSS_CHANNEL_DEDUPE_MIN_CHARS &&
        isNearIdentical(committed, otherEntry.text);

      if (speaker === 'you' && isDuplicateOfOtherChannel) {
        // Incoming YOU matches a recent PROSPECT — bleed copy.
        // Drop it; nothing reaches state.transcript.committed.
        state.transcript.pendingBySpeaker[speaker] = '';
        if (DEBUG_TRANSCRIPT) {
          console.log(
            '[transcript] you commit → DROP (matched recent PROSPECT)',
            JSON.stringify(committed.slice(0, 50)),
          );
        }
        noteDedupDrop();
        renderTranscriptPane();
        return;
      }

      if (speaker === 'other' && isDuplicateOfOtherChannel) {
        // Incoming PROSPECT matches a recent YOU line we already
        // displayed. Splice out the YOU entry from the committed
        // list and clear the recent-YOU tracker so the prefix-
        // extension dedupe below doesn't re-anchor on a removed
        // entry. Then fall through to the normal PROSPECT commit
        // flow (push / replace into committed).
        const removed = findAndRemoveMatchingCommitted(
          state.transcript.committed,
          'you',
          committed,
        );
        if (removed) recentRendererCommitBySpeaker.you = null;
        if (DEBUG_TRANSCRIPT) {
          console.log(
            '[transcript] other commit → KEEP, removed prior YOU line:',
            removed,
            JSON.stringify(committed.slice(0, 50)),
          );
        }
        noteDedupDrop();
        // Fall through.
      } else if (DEBUG_TRANSCRIPT) {
        console.log(
          '[transcript]',
          speaker,
          'commit → KEEP',
          JSON.stringify(committed.slice(0, 50)),
        );
      }

      recentRendererCommitBySpeaker[speaker] = { text: committed, ts: now };

      // Prefix-extension dedupe (belt-and-braces — mirrors the same
      // guard in main.js's handleDeepgramTranscript). If two
      // commit-worthy messages fire back-to-back for the same speaker
      // and the second's text begins with the first's, REPLACE the
      // prior entry instead of pushing a duplicate. Bounded lookback
      // skips over short interjections from the other speaker without
      // merging into a stale earlier utterance.
      const list = state.transcript.committed;
      const maxLookback = 4;
      const end = Math.max(0, list.length - maxLookback);
      let lastIdx = -1;
      for (let i = list.length - 1; i >= end; i--) {
        if (list[i] && list[i].speaker === speaker) { lastIdx = i; break; }
      }
      if (lastIdx >= 0 && committed.startsWith(list[lastIdx].text)) {
        list[lastIdx] = { speaker, text: committed };
      } else {
        list.push({ speaker, text: committed });
      }
    }
    state.transcript.pendingBySpeaker[speaker] = '';
  } else {
    state.transcript.pendingBySpeaker[speaker] = text;
  }
  renderTranscriptPane();
});

window.gemini.onTurnComplete(() => {
  // Flush any in-flight partial for both channels — Gemini's turn
  // complete fires on its own VAD rhythm, not Deepgram's, so we belt-
  // and-brace here even when Deepgram owns the transcript.
  let dirty = false;
  for (const speaker of /** @type {const} */ (['you', 'other'])) {
    const pending = state.transcript.pendingBySpeaker[speaker];
    if (pending && pending.trim()) {
      state.transcript.committed.push({ speaker, text: pending.trim() });
      state.transcript.pendingBySpeaker[speaker] = '';
      dirty = true;
    }
  }
  if (dirty) renderTranscriptPane();
});

window.gemini.onError(({ message }) => {
  console.error('[gemini] error:', message);
  showConnectionError(message?.includes('GEMINI_API_KEY') ? message : 'Connection lost');
  if (state.status === 'listening' || state.status === 'starting') {
    stopCapture({ keepError: true });
  } else {
    setStatus('idle');
  }
});

// (Original window.gemini.onClosed handler was removed here in E2.
// The replacement lives further down alongside the connection-status
// subscriber so the soft-degrade decision can read state.connection
// in the same place that updates it. Adding a second onClosed
// subscriber would have fired BOTH handlers in registration order,
// which would call stopCapture() before the soft-degrade branch could
// short-circuit.)

window.gemini.onScoringFlag(({ id, evidence }) => {
  console.log('[scoring] flag:', id);
  applyFlag({ id, evidence });
});

window.gemini.onScoringItemState((payload) => {
  console.log('[scoring] item-state:', payload.itemId, '→', payload.state);
  applyItemStateChange(payload);
});

window.gemini.onScoringField(({ fieldId, value, evidence }) => {
  console.log('[scoring] field:', fieldId, '=', value);
  applyFieldCaptured({ fieldId, value, evidence });
});

/**
 * Strategy A / Work-stream C: Stage-2 rollup mirror.
 *
 * Fired by main on every Stage-2 roundtrip (success OR fallback-
 * with-stale). Payload: { quickFix, entries } where `quickFix` is
 * the rolled-up shape (or null when the sheet is empty) and
 * `entries` is the snapshot of active factsSheet entries the rollup
 * was computed from.
 *
 * We mirror both into renderer state so the drill-through (breakdown
 * row click → scroll to anchor quote in the transcript pane) can
 * look up a fact by id without round-tripping back to main.
 */
window.gemini.onScoringQuickFix?.((payload) => {
  if (!payload || typeof payload !== 'object') return;
  state.quickFix = payload.quickFix || null;
  state.quickFixEntries = Array.isArray(payload.entries) ? payload.entries : [];
  renderQuickFix();
});

window.gemini.onCoachSuggestion(({ itemId, question, rationale, anchorQuote, kind, suggestionId }) => {
  console.log('[coach] suggest:', itemId, '→', question, '(kind:', kind || 'next', ')');
  /* v3 progress overlay: FIFO-complete the oldest in-flight layer
   * for this kind. Safe before pushCoachSuggestion / pill clear — a
   * 'targeted' kind (from the rail's +Ask buttons) will no-op
   * because we never started a layer for it from this code path. */
  const kindForLayer = typeof kind === 'string' ? kind : 'next';
  completeAskProgressLayer(kindForLayer);
  // Recap finished — drop the in-progress pill the click handler
  // surfaced. Safe to call even if no pill is currently shown.
  if (kind === 'recap') hideRecapInProgressPill();
  /* v3 resizable panes: if the user previously dragged the drawer
   * splitter all the way down to 0, restore it to the last non-zero
   * height so this new suggestion is actually visible. Explicit user
   * decision in the resizable-panes plan: a hidden drawer must not
   * eat new suggestions. */
  autoPopDrawerIfCollapsed();
  pushCoachSuggestion({
    itemId: typeof itemId === 'string' ? itemId : null,
    question: typeof question === 'string' ? question : '',
    rationale: typeof rationale === 'string' ? rationale : '',
    anchorQuote: typeof anchorQuote === 'string' ? anchorQuote : '',
    kind: typeof kind === 'string' ? kind : 'next',
    // suggestionId — the canonical id of the history entry registered
    // in main when this suggestion was pinned. Used by renderCoachSuggestion
    // to cross-reference state.suggestionHistory and apply the asked/
    // greened styling on the pinned card the moment mark_question_asked
    // fires. May be null when the bridge is older than this change or
    // a future code path emits a suggestion without registering one.
    suggestionId: typeof suggestionId === 'string' ? suggestionId : null,
    at: Date.now(),
  });
});

/**
 * Advanced → Track question state: full per-call suggestion-history
 * snapshot from main. Replace the local mirror wholesale and re-render
 * the drawer if it's currently the active pillar.
 *
 * Subscribed unconditionally — main only emits when the history
 * actually mutates, and the renderer's drawer styling is gated on
 * the trackQuestionState toggle separately.
 */
window.gemini.onScoringSuggestionHistory?.((payload) => {
  if (!Array.isArray(payload)) return;
  state.suggestionHistory = payload;
  // Repaint the pinned suggestion card so the asked-flip styling
  // catches up the moment the coach fires mark_question_asked. The
  // card's `data-asked` attribute is keyed off the matching
  // suggestionHistory entry — without this re-render the card stays
  // un-greened until the next push (which may never come if the rep
  // doesn't ask for another suggestion).
  renderCoachSuggestion();
  if (state.activePillarId === 'logged_questions') {
    renderRailOverlay();
  }
});

/**
 * Settings change broadcast. Fires whenever main applies a
 * settings:save (including settings:reset and import:apply, which
 * route through the same cache and emit the same broadcast). The
 * renderer initiated saves already get the full shape back via the
 * save promise, but subscribing here is the canonical path so any
 * out-of-band settings mutation propagates without extra plumbing.
 *
 * We deliberately do NOT re-hydrate the whole form here — that would
 * clobber any input the user is actively typing into. The Reset /
 * Import code paths explicitly call applySettingsToForm() after their
 * IPC completes, which is the correct point for a full visual reset.
 * Here we only refresh the coach toggles (drives the drawer styling)
 * and re-render any open drawer that reads them.
 */
window.gemini.onSettingsChanged?.((payload) => {
  if (!payload || typeof payload !== 'object') return;
  settingsCache = payload;
  applyCoachToForm(payload?.coach);
  // V10 hide-AEC-badge applies immediately — settings:changed
  // broadcasts on every save / reset / import, so the badge visibility
  // tracks the persisted preference even when the change came from a
  // path we didn't fire ourselves (e.g. a different window-instance
  // edit in a future multi-window build, or a wholesale import).
  applyAecBadgeVisibility(payload?.audio);
  // Per-surface transparency. Apply CSS vars on every broadcast so a
  // preset Load (from any window, or a future import) re-skins the
  // main overlay live. We DON'T re-hydrate the slider thumbs here —
  // the user may be mid-drag on a slider, and snapping the thumb
  // back to the broadcast value would feel like a fight against the
  // input. The sliders re-hydrate explicitly via the surface
  // dropdown's change handler and on Reset / Import via
  // applySettingsToForm().
  applyTransparencyBlock(payload?.appearance?.transparency);
  // Coach toggle flip mid-call also affects the pinned card's
  // asked-flip styling (gated on trackQuestionState). Repaint so a
  // toggle change immediately neutralises or re-greens the card.
  renderCoachSuggestion();
  if (state.activePillarId === 'logged_questions') {
    renderRailOverlay();
  }
});

window.gemini.onCoachTickStart?.(() => {
  state.coachThinking = true;
  renderCoachThinking();
});

window.gemini.onCoachTickEnd?.(() => {
  state.coachThinking = false;
  renderCoachThinking();
});

/**
 * Connection-status broadcast subscriber. Fired by main on every
 * lifecycle transition for either upstream transport — see
 * setConnectionStatus / broadcastConnectionStatus in src/main.js.
 *
 * Payload shape: { deepgram, geminiLive } where each value is one of
 * the documented enums (see the preload bridge doc-block for the
 * full list). We mirror the snapshot wholesale onto state.connection
 * and re-render the pill — cheap because the render is a few DOM
 * attribute writes plus a label swap.
 *
 * Safely subscribed via the optional-chaining pattern so an older
 * preload bridge without onConnectionStatus doesn't throw.
 */
window.gemini.onConnectionStatus?.((payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (typeof payload.deepgram === 'string') state.connection.deepgram = payload.deepgram;
  if (typeof payload.geminiLive === 'string') state.connection.geminiLive = payload.geminiLive;
  renderConnectionStatus();
});

/**
 * E2: decouple gemini:closed from full call teardown.
 *
 * Before: any Gemini Live close (including the silence-induced
 * timeouts that hit ~36 minutes into long calls) called
 * stopCapture({ keepError: true }) unconditionally — which ended
 * the call even though Deepgram was still streaming the transcript.
 * That's the 36-minute symptom in the test-call notes.
 *
 * After: the close is treated as a soft-degrade when Deepgram is
 * healthy (the rest of the call continues; flag detection is paused
 * until reconnect lands or gives up). Only when BOTH transports are
 * down do we treat the close as fatal and surface the "Connection
 * lost" error.
 *
 * The connection pill in the header (renderConnectionStatus) reflects
 * the degraded state, so the rep sees an amber/red pill rather than a
 * silent loss of flags.
 */
window.gemini.onClosed(() => {
  // Soft-degrade case: Deepgram still streaming, so the call's
  // canonical transcript path is unaffected. Mark Gemini Live as
  // 'closed' (Gemini-specific soft-degrade state) and let the
  // reconnect logic in main do its thing — main will broadcast
  // 'reconnecting' or 'connected' (or eventually 'down') via the
  // connection:status IPC.
  if (state.connection.deepgram === 'connected') {
    state.connection.geminiLive = 'closed';
    renderConnectionStatus();
    return;
  }
  // Both transports are down (or Deepgram was never up). Surface the
  // "Connection lost" error and tear the call down so the rep can
  // restart. This preserves the legacy behaviour for the genuine
  // both-sides-down case.
  if (state.status === 'listening' || state.status === 'starting') {
    showConnectionError('Connection lost');
    stopCapture({ keepError: true });
  }
});

window.gemini.onSummaryReady?.((payload) => {
  console.log('[summary] ready');
  renderSummaryModal(payload);
  showSummaryModal();
});

/* ── Coach mode + ask buttons (v2.5 redesign) ─────────────────────── */

/**
 * Apply the active coach mode to (a) the toggle UI, (b) localStorage,
 * and (c) main (so the pause detector lights up / dims live). Called
 * once at startup with the persisted value and again whenever the user
 * flips the toggle.
 *
 * Persistence happens here rather than at the click handler so a
 * programmatic mode change (e.g. future "respect system focus" hook)
 * goes through the same single source of truth.
 */
function applyCoachMode(mode, { persist = true, notifyMain = true } = {}) {
  if (!VALID_COACH_MODES.has(mode)) return;
  state.coachMode = mode;
  if (persist) persistCoachMode(mode);
  // Toggle UI reflects the new mode regardless of where the change
  // came from (click, programmatic, restoration).
  for (const btn of coachModeBtnEls) {
    const isActive = btn.dataset.mode === mode;
    btn.dataset.active = String(isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
  if (notifyMain) {
    // Fire-and-forget; main is tolerant of receiving the same mode
    // back-to-back (it just stores the value).
    window.gemini.setCoachMode?.(mode);
  }
}

for (const btn of coachModeBtnEls) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode === state.coachMode) return;
    applyCoachMode(mode);
  });
}

/* ── Ask-button progress overlay (v3) ─────────────────────────────
 *
 * See plan: ask_button_progress_overlay_7d3a9f1b. Per-click
 * translucent fill layer on each .ask-btn. Each click stacks ANOTHER
 * layer; FIFO-completes the oldest when the matching coach:suggestion
 * IPC arrives. Stacking gives the rep "two in flight" as a visibly
 * darker shade thanks to alpha compositing of white-at-10% layers.
 *
 * Per-kind durations (USER OVERRIDE — snappier than the plan's
 * 6s / 9s defaults):
 *   next / deeper / pivot  → 4000 ms ease-out to 92%
 *   recap                  → 7000 ms ease-out to 92%
 *
 * Per-kind safety timeout (layer goes red-tinted if no response):
 *   next / deeper / pivot  → 30000 ms
 *   recap                  → 15000 ms  (matches the existing Recap
 *                                       pill's 15s clear)
 *
 * Stack cap: 5 visible layers max. When the user clicks a 6th time
 * while 5 are still active the IPC still fires (the rep wants the
 * request sent) but the visual layer is skipped — see the gate in
 * startAskProgressLayer below.
 *
 * Reduced motion: under prefers-reduced-motion: reduce the entire
 * overlay block in src/index.css is gated off (the @media wraps the
 * .ask-btn__progress rules), and startAskProgressLayer also short-
 * circuits layer DOM creation so no nodes accumulate even though no
 * animation would run. The existing 160ms .ask-btn[data-pulsing]
 * flash and the textual "Recap in progress…" pill carry the
 * affordance under reduced motion. */
const ASK_PROGRESS_DURATION_MS = Object.freeze({
  next: 4000,
  deeper: 4000,
  pivot: 4000,
  recap: 7000,
});
const ASK_PROGRESS_FAIL_MS = Object.freeze({
  next: 30_000,
  deeper: 30_000,
  pivot: 30_000,
  recap: 15_000,
});
const ASK_PROGRESS_STACK_CAP = 5;
const ASK_PROGRESS_SNAP_MS = 150;
const ASK_PROGRESS_HOLD_MS = 250;
const ASK_PROGRESS_FADE_MS = 200;
const ASK_PROGRESS_FAIL_HOLD_MS = 1500;

/* kind → Array<LayerHandle>. LayerHandle = { el, kind, btn, startedAt,
 * failTimer, snapTimer, fadeTimer, removeTimer }. */
const inFlightLayersByKind = new Map();

function isReducedMotionPreferred() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function clearLayerTimers(handle) {
  if (handle.failTimer) clearTimeout(handle.failTimer);
  if (handle.snapTimer) clearTimeout(handle.snapTimer);
  if (handle.fadeTimer) clearTimeout(handle.fadeTimer);
  if (handle.removeTimer) clearTimeout(handle.removeTimer);
  handle.failTimer = handle.snapTimer = handle.fadeTimer = handle.removeTimer = null;
}

function removeLayer(handle) {
  clearLayerTimers(handle);
  if (handle.el && handle.el.parentNode) {
    handle.el.parentNode.removeChild(handle.el);
  }
  handle.el = null;
}

/* Start a new in-flight visual layer on this button. Returns true if
 * a layer was created, false if the stack cap was hit (the caller
 * still fires the IPC either way). */
function startAskProgressLayer(kind, btn) {
  if (!btn) return false;
  /* Reduced-motion path: skip the visual entirely. The CSS @media
   * gate already neutralises any layer that did exist; this guard
   * also avoids polluting inFlightLayersByKind with phantom handles
   * a future visual change might pick up. */
  if (isReducedMotionPreferred()) return false;
  const existing = inFlightLayersByKind.get(kind);
  /* Stack cap: silently skip the visual layer when 5 are already
   * active for this kind. The caller still fires the IPC because the
   * user explicitly wants the request sent — this is the snappiest
   * "I clicked, the request is in flight" feedback we can provide
   * without making the button unreadable behind 6+ stacked tints. */
  if (existing && existing.length >= ASK_PROGRESS_STACK_CAP) return false;

  const el = document.createElement('span');
  el.className = 'ask-btn__progress';
  el.dataset.state = 'active';
  el.dataset.kind = kind;
  el.setAttribute('aria-hidden', 'true');
  btn.appendChild(el);
  /* Force layout so the active-state animation always starts from a
   * resolved scaleX(0) baseline, even when this click follows a
   * rapid-fire previous one that left the previous layer mid-anim. */
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;

  const handle = {
    el,
    kind,
    btn,
    startedAt: Date.now(),
    failTimer: null,
    snapTimer: null,
    fadeTimer: null,
    removeTimer: null,
  };
  if (!existing) inFlightLayersByKind.set(kind, [handle]);
  else existing.push(handle);

  const failMs = ASK_PROGRESS_FAIL_MS[kind] ?? 30_000;
  handle.failTimer = setTimeout(() => failLayer(kind, handle), failMs);
  return true;
}

/* FIFO-complete the oldest in-flight layer for this kind. Called
 * from onCoachSuggestion when the matching IPC arrives. Sequence:
 * snap(150) → hold(250) → fade(200) → remove. Total wind-down ~600ms. */
function completeAskProgressLayer(kind) {
  const layers = inFlightLayersByKind.get(kind);
  if (!layers || layers.length === 0) return;
  const handle = layers.shift();
  if (layers.length === 0) inFlightLayersByKind.delete(kind);
  if (!handle || !handle.el) return;
  clearLayerTimers(handle);

  handle.el.dataset.state = 'completing';
  handle.snapTimer = setTimeout(() => {
    if (!handle.el) return;
    handle.fadeTimer = setTimeout(() => {
      if (!handle.el) return;
      handle.el.dataset.state = 'fading';
      handle.removeTimer = setTimeout(() => removeLayer(handle),
        ASK_PROGRESS_FADE_MS + 50);
    }, ASK_PROGRESS_HOLD_MS);
  }, ASK_PROGRESS_SNAP_MS);
}

/* Failure path. Surfaced by the per-layer 30s / 15s safety timer.
 * Asymmetric on purpose: success is FIFO (we can't tell which click
 * triggered the response), but failure is per-layer (the timer
 * fires on the specific click that timed out). */
function failLayer(kind, handle) {
  const layers = inFlightLayersByKind.get(kind);
  if (!layers || !handle.el) return;
  const idx = layers.indexOf(handle);
  if (idx === -1) return; // already completed via the success path
  layers.splice(idx, 1);
  if (layers.length === 0) inFlightLayersByKind.delete(kind);
  clearLayerTimers(handle);
  handle.el.dataset.state = 'failing';
  /* 350ms = the ask-progress-fail keyframe duration (snap+tint).
   * Then hold the red tint 1500ms so the rep registers the failure,
   * then 200ms fade. */
  handle.removeTimer = setTimeout(
    () => removeLayer(handle),
    350 + ASK_PROGRESS_FAIL_HOLD_MS + ASK_PROGRESS_FADE_MS,
  );
}

/* Wipe every in-flight layer + timer. Hooked into clearScoringState
 * so a fresh session never inherits stale layers from the previous
 * call. Safe to call when no layers exist. */
function clearAskButtonProgress() {
  for (const layers of inFlightLayersByKind.values()) {
    for (const h of layers) removeLayer(h);
  }
  inFlightLayersByKind.clear();
}

/**
 * Wire up the transcript-footer ask buttons. Each fires
 * `window.gemini.askSuggestion(kind)` which lands as a `coach:ask-suggest`
 * IPC in main; main fans it through to `Coach.requestSuggestion({ kind })`
 * which queues a one-shot suggestion opportunity for the next tick.
 *
 * Recap is on a separate IPC channel (`coach:ask-recap`) because its
 * payload is empty — recap is always freeform (item_id =
 * 'freeform.recap'). Same UX otherwise: pulse the button on click and
 * the suggestion arrives async via `coach:suggestion`.
 *
 * Clicking while a suggestion is already pinned is fine — the coach
 * skips the current pin and queues a new request with the new kind
 * (per v2.5 spec: "clicking effectively skips + re-asks with the new
 * kind").
 */
for (const btn of askBtnEls) {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.kind;
    if (kind !== 'next' && kind !== 'deeper' && kind !== 'pivot' && kind !== 'recap') return;
    // Reaching for any of the primary ask buttons cancels an active
    // cover-queue — the seller is steering somewhere else, so we
    // silently drop the cycle (no completion banner). Per the v2.5
    // queue spec: "user can cancel the queue at any time".
    if (state.coverQueue) clearCoverQueue();
    // Cheap visual ack — flash the button so the rep sees that their
    // click registered even if the coach takes a tick to respond.
    btn.dataset.pulsing = 'true';
    setTimeout(() => { btn.dataset.pulsing = 'false'; }, 160);
    /* v3 progress overlay: stack a translucent fill layer that
     * animates while this request is in flight. Returns false when
     * the per-kind 5-layer stack cap was hit; we still fire the IPC
     * either way (explicit user decision in the override notes). */
    startAskProgressLayer(kind, btn);
    if (kind === 'recap') {
      // Surface a "Recap in progress…" pill so the rep knows the
      // click registered and the coach is working — even though D7
      // priority-bypass eliminates queue latency, the provider
      // roundtrip itself can still be a noticeable wait.
      showRecapInProgressPill();
      window.gemini.askRecap?.();
    } else {
      window.gemini.askSuggestion?.(kind);
    }
  });
}

/* ── "Recap in progress…" pill (D8) ─────────────────────────────────
 *
 * Lives as a child of the Recap button (see the data-kind='recap'
 * status span in index.html). The pill makes the residual provider-
 * roundtrip latency visible after D7's priority-bypass eliminates the
 * in-flight queue wait — so a slow tick reads as "still working" not
 * "did my click register?".
 *
 * Lifecycle:
 *   - showRecapInProgressPill()       — fired from the Recap click
 *                                       handler. Reveals the pill and
 *                                       arms a 15s safety timer.
 *   - onCoachSuggestion(kind=='recap') — clears the pill the moment
 *                                       the recap result lands.
 *   - safety timer (15s)              — clears the pill if the
 *                                       recap never arrives (network
 *                                       failure, model error, …) so
 *                                       it doesn't stick forever.
 *
 * Only one in-flight recap at a time — successive clicks reset the
 * timer rather than stack pills.
 */
const RECAP_PILL_SAFETY_MS = 15_000;
let _recapPillTimer = null;
function showRecapInProgressPill() {
  const recapBtn = askBtnEls.find((b) => b.dataset.kind === 'recap');
  if (!recapBtn) return;
  const pill = recapBtn.querySelector('.ask-btn__status[data-kind="recap"]');
  if (!(pill instanceof HTMLElement)) return;
  pill.textContent = 'Recap in progress…';
  pill.hidden = false;
  if (_recapPillTimer) clearTimeout(_recapPillTimer);
  _recapPillTimer = setTimeout(() => {
    _recapPillTimer = null;
    hideRecapInProgressPill();
  }, RECAP_PILL_SAFETY_MS);
}

function hideRecapInProgressPill() {
  if (_recapPillTimer) {
    clearTimeout(_recapPillTimer);
    _recapPillTimer = null;
  }
  const recapBtn = askBtnEls.find((b) => b.dataset.kind === 'recap');
  if (!recapBtn) return;
  const pill = recapBtn.querySelector('.ask-btn__status[data-kind="recap"]');
  if (!(pill instanceof HTMLElement)) return;
  pill.hidden = true;
  pill.textContent = '';
}

/* ── Settings modal ────────────────────────────────────────────────
 *
 * Scope: this scaffold is the foundation a number of upcoming
 * features depend on (provider abstraction, appearance / theming,
 * behaviour toggles). It's intentionally a SHELL — only the Setup
 * tab is interactive; Appearance is a placeholder section that
 * future work will populate.
 *
 * Data flow:
 *   1. On first open, call window.gemini.settings.load(), which IPC's
 *      into main → src/settings.js → reads the JSON file at
 *      userData/settings.json (or seeds defaults).
 *   2. The form is hydrated from the returned object once on first
 *      open (cached afterwards so we don't re-hit the IPC on every
 *      gear click).
 *   3. Save click gathers the form values into a partial and pushes
 *      it via window.gemini.settings.save(partial). The handler in
 *      main deep-merges into the cache, writes the file, and echoes
 *      back the full updated object so we can re-hydrate.
 *
 * Changes apply on the NEXT session — see the comment on
 * registerIpcHandlers('settings:save', …) in src/main.js. Specifically:
 *   - The Coach instance reads its `model` at construction time
 *     (gemini:start handler).
 *   - generateSummary() reads its `model` at the gemini:stop call.
 *   - getApiKey() runs at each session start.
 * Saving mid-call therefore takes effect on the next Start, not on
 * the in-flight session. That's deliberate.
 *
 * Extension points:
 *   - To add a new tab, add a <button class="settings-modal__tab"
 *     data-tab="…"> in index.html alongside a matching
 *     <section data-tab-content="…">. The tab-switch logic picks
 *     them up via querySelectorAll().
 *   - To add a new form field, add it to the Setup tab's section,
 *     add a DOM ref above, and extend applySettingsToForm() +
 *     saveSettingsFromForm() with the field.
 */

/** Cached copy of the most recently loaded settings object. Populated
 *  on first open and refreshed by every save (the IPC handler echoes
 *  the full post-merge shape back). `null` means the form hasn't
 *  been hydrated yet — the renderer lazy-loads on first modal open
 *  to avoid an unnecessary IPC roundtrip at boot.
 *
 *  The cached shape also carries `_envAvailability` from the main
 *  side so the renderer can render the "Using env variable" status
 *  badge without a second roundtrip. See src/main.js' settings:load
 *  handler. */
let settingsCache = null;

/** Per-provider debounce timer + last-flushed-value tracker so we
 *  don't fire a save roundtrip for every keystroke. The flush fires
 *  on idle (after IDLE_SAVE_MS without further typing) or on blur. */
const SETTINGS_IDLE_SAVE_MS = 1000;
const settingsKeyDebounceTimers = Object.create(null);
const settingsKeyLastFlushed = Object.create(null);

/** Per-card timers for hiding the Test result message after 3 s. */
const settingsTestResultTimers = Object.create(null);

/**
 * Hydrate the entire Providers tab from a settings object. Tolerates
 * missing keys — the storage layer always returns a fully-populated
 * v2 shape, but defending against partial / migrating shapes is
 * cheap. Driven by both initial open and post-save echo refresh.
 *
 * Side effects:
 *   - segmented control reflects defaultProvider
 *   - each card's key input reflects providers[id].apiKey
 *   - each card's model select reflects providers[id].defaultModel
 *   - each card's status badge + Test button label reflect the
 *     combined Settings-key / env-var availability
 */
function applySettingsToForm(settings) {
  if (!settings) return;
  const defaultProvider = settings.defaultProvider || 'gemini';
  setDefaultProviderSelection(defaultProvider);

  const envAvail = (settings._envAvailability && typeof settings._envAvailability === 'object')
    ? settings._envAvailability
    : {};

  for (const card of settingsProviderCardEls) {
    const provider = card.dataset.provider;
    if (!provider) continue;
    const config = settings.providers?.[provider] || {};
    const keyInput = card.querySelector(`[data-provider-key="${provider}"]`);
    if (keyInput instanceof HTMLInputElement) {
      const value = typeof config.apiKey === 'string' ? config.apiKey : '';
      keyInput.value = value;
      // Reset password-mode whenever we re-hydrate — switching between
      // settings shouldn't leak a previously-revealed key.
      keyInput.type = 'password';
      const eyeBtn = card.querySelector(`[data-eye-for="${provider}"]`);
      if (eyeBtn instanceof HTMLElement) {
        eyeBtn.setAttribute('aria-pressed', 'false');
        eyeBtn.setAttribute('aria-label', 'Show key');
      }
      // Track the most recent canonical value so the debounced save
      // can short-circuit on noise (e.g. focus/blur with no edit).
      settingsKeyLastFlushed[provider] = value;
    }
    const modelSelect = card.querySelector(`[data-provider-model="${provider}"]`);
    if (modelSelect instanceof HTMLSelectElement) {
      const wanted = typeof config.defaultModel === 'string' && config.defaultModel.length > 0
        ? config.defaultModel
        : modelSelect.options[0]?.value || '';
      // If the stored value isn't in the option list, prepend an entry
      // so the select still shows the user's choice instead of
      // silently coercing to option[0]. Future re-saves persist this.
      if (wanted && !Array.from(modelSelect.options).some((o) => o.value === wanted)) {
        const opt = document.createElement('option');
        opt.value = wanted;
        opt.textContent = wanted;
        modelSelect.appendChild(opt);
      }
      modelSelect.value = wanted;
    }
    refreshProviderStatusBadge(card, settings, envAvail);
  }

  // Appearance tab — speaker-label tag colours. Form sync + live
  // preview both happen here so the first modal open re-paints the
  // pickers correctly and the transcript labels also re-paint if
  // the user's persisted colours differ from the :root defaults.
  const tag = settings.appearance?.tagColors || {};
  const youVal = typeof tag.you === 'string' && tag.you ? tag.you : DEFAULT_TAG_YOU;
  const otherVal = typeof tag.other === 'string' && tag.other ? tag.other : DEFAULT_TAG_OTHER;
  if (appearanceColorYouEl instanceof HTMLInputElement) appearanceColorYouEl.value = youVal;
  if (appearanceColorOtherEl instanceof HTMLInputElement) appearanceColorOtherEl.value = otherVal;
  applyTagColors({ you: youVal, other: otherVal });

  // Appearance tab — per-surface transparency. Apply all twelve CSS
  // vars (so the main overlay re-skins on Reset / Import) and
  // hydrate the editor's sliders + preset cards. Sliders show
  // values for whichever surface the dropdown currently points at;
  // a fresh boot points at 'coach' by default. Hints also re-
  // evaluate so a Reset that crosses the low-alpha threshold
  // re-surfaces the inline warning.
  applyTransparencyBlock(settings.appearance?.transparency || DEFAULT_TRANSPARENCY);
  hydrateTransparencySliders(settings.appearance?.transparency || DEFAULT_TRANSPARENCY);
  hydrateTransparencyPresetCards(settings.appearance?.transparencyPresets);
  if (transparencySurfaceEl instanceof HTMLSelectElement) {
    updateTransparencyHints(transparencySurfaceEl.value);
  }

  applyCoachToForm(settings.coach);
  applyAudioToForm(settings.audio);
}

/**
 * Hydrate the Coach tab toggles from a settings object. Mirrors
 * the value into `state.coach` so the drawer rendering can read
 * it without an extra lookup, and refreshes the dependent-disabled
 * state on the auto-reformulate row.
 *
 * Renamed from `applyAdvancedToForm` in schema v3. The CSS class
 * `.advanced-toggle` is intentionally NOT renamed — it's a UI
 * primitive (a card-shaped checkbox row) and not tied to the tab.
 *
 * Tolerates a missing `coach` field (older settings file or a
 * race during boot) — the deep-merge default fill on the main side
 * should always provide one, but defending here keeps the renderer
 * from crashing if it doesn't.
 */
function applyCoachToForm(coach) {
  const next = {
    trackQuestionState: Boolean(coach?.trackQuestionState),
    autoReformulate: Boolean(coach?.autoReformulate),
  };
  state.coach = next;
  if (settingsCoachTrackEl instanceof HTMLInputElement) {
    settingsCoachTrackEl.checked = next.trackQuestionState;
  }
  if (settingsCoachAutoReformulateEl instanceof HTMLInputElement) {
    settingsCoachAutoReformulateEl.checked = next.autoReformulate;
    settingsCoachAutoReformulateEl.disabled = !next.trackQuestionState;
    // Mirror the disabled state on the card wrapper so CSS can dim
    // the whole row, not just the input. Falls back gracefully if
    // the markup doesn't have the wrapper.
    const wrap = settingsCoachAutoReformulateEl.closest('.advanced-toggle');
    if (wrap instanceof HTMLElement) {
      wrap.dataset.disabled = String(!next.trackQuestionState);
    }
  }
}

/**
 * Hydrate the Audio tab controls from a settings object. Defaults
 * are applied at the field level so a settings file missing
 * `audio.*` (or any individual key) lights up the boot-correct UI:
 *   - dropdowns: persisted ID if present, otherwise the '' default
 *     option ("Default (OS / first screen)")
 *   - constraint toggles: default ON
 *   - Deepgram select: 'nova-3' default
 *   - hide-AEC-badge: default OFF (badge visible)
 *
 * The badge visibility is applied synchronously here too — it's the
 * one immediate-apply control on the tab, so hydration + apply share
 * the same code path (no IPC roundtrip).
 *
 * Device dropdowns are NOT populated here — that's the job of
 * `populateMicDevices()` / `populateSystemAudioSources()`, which run
 * on first modal open + every Refresh-button click. This helper just
 * ensures the persisted `<option>` is selected (or, if it isn't yet
 * an option, gets injected so the user's choice still appears).
 *
 * Tolerates a missing / partial `audio` block — every field has a
 * default and an instanceof guard, so a malformed payload doesn't
 * crash the form.
 */
function applyAudioToForm(audio) {
  const a = audio || {};

  hydrateAudioSelectValue(audioMicSelectEl, a.micDeviceId || '');
  hydrateAudioSelectValue(audioSysSourceSelectEl, a.systemAudioSourceId || '');

  if (audioAecEl instanceof HTMLInputElement) {
    audioAecEl.checked = a.aec !== false;
  }
  if (audioNoiseSuppressionEl instanceof HTMLInputElement) {
    audioNoiseSuppressionEl.checked = a.noiseSuppression !== false;
  }
  if (audioAutoGainControlEl instanceof HTMLInputElement) {
    audioAutoGainControlEl.checked = a.autoGainControl !== false;
  }

  if (audioDeepgramModelEl instanceof HTMLSelectElement) {
    const wanted = typeof a.deepgramModel === 'string' && a.deepgramModel.length > 0
      ? a.deepgramModel
      : 'nova-3';
    // If a user imports a settings file with an unrecognised model id
    // (rolled-out Deepgram tier, typo, etc.), surface it in the
    // dropdown rather than silently coercing back to nova-3. The
    // option label is the raw id since we don't know the model's
    // display name. Future imports of the same id won't double-add
    // because Array.from().some() guards against duplicates.
    if (wanted && !Array.from(audioDeepgramModelEl.options).some((o) => o.value === wanted)) {
      const opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = wanted;
      audioDeepgramModelEl.appendChild(opt);
    }
    audioDeepgramModelEl.value = wanted;
  }

  if (audioHideAecBadgeEl instanceof HTMLInputElement) {
    audioHideAecBadgeEl.checked = a.hideAecBadge === true;
  }

  applyAecBadgeVisibility(a);
}

/**
 * Apply the persisted system-audio / mic device id to a select.
 *
 * If the persisted id isn't in the option list yet (e.g. the device
 * dropdown hasn't been populated yet, or the device is currently
 * unplugged), inject a placeholder `<option>` so the user's choice
 * still renders in the closed state. The placeholder text reflects
 * that the device may not be currently available — when
 * `populateMicDevices()` next runs and finds a live match, that
 * placeholder is removed and the real label takes over.
 *
 * Returning early when the wanted id is '' is intentional — the
 * default ('') option is always the first `<option>` and any
 * `select.value = ''` against an empty-value option works without
 * extra plumbing.
 */
function hydrateAudioSelectValue(select, wantedId) {
  if (!(select instanceof HTMLSelectElement)) return;
  if (!wantedId) {
    select.value = '';
    return;
  }
  const exists = Array.from(select.options).some((o) => o.value === wantedId);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = wantedId;
    opt.textContent = '(saved — refresh to verify)';
    opt.dataset.placeholder = 'true';
    select.appendChild(opt);
  }
  select.value = wantedId;
}

/**
 * Apply V10 — show / hide the AEC badge in the header. Pure DOM
 * toggle. Called from:
 *   - applySettingsToForm() during boot + after Reset / Import
 *     (drives the badge from the persisted preference).
 *   - The hide-AEC-badge checkbox's change handler (immediate-apply,
 *     no waiting for the settings:changed broadcast).
 *   - The onSettingsChanged subscriber so live-broadcast paths
 *     (settings:save / :reset / :import from anywhere) also update.
 *
 * Defends against the badge element being absent so a future
 * refactor that removes the badge entirely doesn't crash this path.
 */
function applyAecBadgeVisibility(audio) {
  if (!(aecBadgeEl instanceof HTMLElement)) return;
  aecBadgeEl.hidden = audio?.hideAecBadge === true;
}

/**
 * Push speaker-label tag colours onto :root as inline CSS variables.
 * Any unspecified slot is left untouched so a single-channel update
 * (just `you` or just `other`) only repaints the one prefix. Called
 * from the initial-render path, the colour pickers' `input` events,
 * and the reset button.
 */
function applyTagColors({ you, other }) {
  const root = document.documentElement;
  if (you) root.style.setProperty('--speaker-color-you', you);
  if (other) root.style.setProperty('--speaker-color-other', other);
}

/**
 * Apply a single per-surface alpha channel onto :root as an inline
 * CSS variable. Called from every slider `input` event (synchronous,
 * for instant live preview) and from preset-load / reset flows.
 *
 * Value is clamped to [0, 1] defensively — color-mix() handles
 * out-of-range percentages gracefully but we want the persisted
 * settings / slider UI / live CSS to all agree on the same number.
 */
function applySurfaceTransparency(surface, channel, value) {
  if (!TRANSPARENCY_SURFACES.includes(surface)) return;
  if (!TRANSPARENCY_CHANNELS.includes(channel)) return;
  if (typeof value !== 'number' || Number.isNaN(value)) return;
  const clamped = Math.max(0, Math.min(1, value));
  document.documentElement.style.setProperty(
    `--surface-${surface}-${channel}-alpha`,
    String(clamped),
  );
}

/**
 * Bulk-apply an `appearance.transparency` block onto :root. Used by
 * the initial-render path, the onSettingsChanged subscriber, and
 * the preset Load handler. Missing surfaces / channels are skipped
 * — the :root defaults in src/index.css then carry their own
 * fallback values.
 */
function applyTransparencyBlock(transparencyBlock) {
  if (!transparencyBlock || typeof transparencyBlock !== 'object') return;
  for (const surface of TRANSPARENCY_SURFACES) {
    const surfaceBlock = transparencyBlock[surface];
    if (!surfaceBlock || typeof surfaceBlock !== 'object') continue;
    for (const channel of TRANSPARENCY_CHANNELS) {
      applySurfaceTransparency(surface, channel, surfaceBlock[channel]);
    }
  }
}

/**
 * Hydrate the three slider inputs + percentage badges for the
 * currently-selected surface from the supplied transparency block.
 * Falls back to DEFAULT_TRANSPARENCY for missing values so the
 * sliders always show a valid 0–100 integer (instead of an empty
 * NaN-driven thumb position).
 */
function hydrateTransparencySliders(transparencyBlock) {
  if (!(transparencySurfaceEl instanceof HTMLSelectElement)) return;
  const surface = transparencySurfaceEl.value;
  if (!TRANSPARENCY_SURFACES.includes(surface)) return;
  const surfaceBlock = (transparencyBlock && transparencyBlock[surface]) || {};
  const defaults = DEFAULT_TRANSPARENCY[surface] || { outline: 0, body: 0, text: 0 };
  for (const channel of TRANSPARENCY_CHANNELS) {
    const raw = typeof surfaceBlock[channel] === 'number'
      ? surfaceBlock[channel]
      : defaults[channel];
    const pct = Math.round(Math.max(0, Math.min(1, raw)) * 100);
    const slider = transparencySliderEls[channel];
    if (slider instanceof HTMLInputElement) slider.value = String(pct);
    const badge = transparencyValueEls[channel];
    if (badge instanceof HTMLElement) badge.textContent = `${pct}%`;
  }
}

/**
 * Hydrate the three preset slot cards' name inputs from a
 * transparencyPresets block. Falls back to the DEFAULT_TRANSPARENCY_PRESETS
 * labels ('Day' / 'Night' / 'Demo') so an empty / missing block
 * still shows readable placeholders rather than empty fields.
 */
function hydrateTransparencyPresetCards(presetsBlock) {
  for (const card of transparencyPresetEls) {
    const slot = card.dataset.presetSlot;
    if (!slot) continue;
    const nameInput = card.querySelector('.transparency-preset__name');
    if (!(nameInput instanceof HTMLInputElement)) continue;
    const persistedName = presetsBlock?.[slot]?.name;
    const fallbackName = DEFAULT_TRANSPARENCY_PRESETS[slot]?.name || `Preset ${slot.slice(-1)}`;
    nameInput.value = typeof persistedName === 'string' && persistedName.length > 0
      ? persistedName
      : fallbackName;
  }
}

/** Update the .provider-card__status badge + Test button label for a
 *  single card based on the current settings + env-var snapshot. */
function refreshProviderStatusBadge(card, settings, envAvail) {
  const provider = card.dataset.provider;
  if (!provider) return;
  const apiKey = settings?.providers?.[provider]?.apiKey;
  const hasKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
  const hasEnv = Boolean(envAvail?.[provider]);

  let status = 'unconfigured';
  let label = 'Not configured';
  if (hasKey) {
    status = 'connected';
    label = 'Connected';
  } else if (hasEnv) {
    status = 'env';
    label = 'Using env variable';
  }

  const badge = card.querySelector('.provider-card__status');
  if (badge instanceof HTMLElement) {
    badge.dataset.status = status;
    badge.textContent = label;
  }

  // Test button reads "Test" once a key is in place (Settings or env),
  // "Connect" otherwise — the user is being told "you can probe this
  // connection right now" vs "you need to wire one up first".
  const testBtn = card.querySelector('.provider-card__test');
  if (testBtn instanceof HTMLElement) {
    testBtn.textContent = (hasKey || hasEnv) ? 'Test' : 'Connect';
  }
}

/** Sync the segmented control's `data-active` + aria-pressed flags. */
function setDefaultProviderSelection(providerId) {
  for (const btn of settingsDefaultProviderBtnEls) {
    const isActive = btn.dataset.provider === providerId;
    btn.dataset.active = String(isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
}

/**
 * Lazy hydration: only call settings.load() once. The promise is
 * awaited inside openSettingsModal() so the form is always populated
 * before showModal() fires.
 *
 * Errors are logged but never thrown — a bad IPC roundtrip should
 * still open the dialog so the user can save fresh values.
 */
async function ensureSettingsLoaded() {
  if (settingsCache) return settingsCache;
  try {
    const fresh = await window.gemini.settings?.load?.();
    if (fresh && typeof fresh === 'object') {
      settingsCache = fresh;
      applySettingsToForm(fresh);
      return fresh;
    }
  } catch (err) {
    console.warn('[settings] load failed:', err?.message || err);
  }
  return null;
}

/** Select a tab inside the settings modal by id. After Phase 1 of
 *  the Settings expansion the valid ids are:
 *    'providers' | 'audio' | 'appearance' | 'coach' | 'general' | 'help'
 *  Toggles `aria-selected` on the tab buttons and `hidden` on the
 *  content sections. The function is markup-driven — it queries the
 *  DOM rather than enforcing the enum here, so future phases can add
 *  more tabs without editing this code. */
function selectSettingsTab(tabId) {
  let matched = false;
  for (const btn of settingsTabEls) {
    const isActive = btn.dataset.tab === tabId;
    btn.setAttribute('aria-selected', String(isActive));
    if (isActive) matched = true;
  }
  if (!matched) return;
  for (const section of settingsTabContentEls) {
    const isActive = section.dataset.tabContent === tabId;
    section.hidden = !isActive;
  }
}

async function openSettingsModal() {
  if (!settingsModalEl) return;
  await ensureSettingsLoaded();
  // Audio tab device pickers: hydrate the dropdown contents on first
  // open. Subsequent opens reuse the populated lists; the Refresh
  // buttons inside the tab let the user force a re-enumerate without
  // closing the modal. populateAudioPickers also re-applies the
  // persisted selection AFTER population, so a freshly-discovered
  // device id matches up with the saved settings.
  if (!audioPickersPopulated) {
    populateAudioPickers().then(() => {
      // After population the persisted ids should now match real
      // <option> entries; re-run the form hydrator so any placeholder
      // "(saved — refresh to verify)" options are replaced with the
      // real device labels.
      if (settingsCache?.audio) applyAudioToForm(settingsCache.audio);
    });
  }
  // Apply-hint visibility: paint once on open so a mid-call settings
  // visit lights up the notice even if no setStatus() transition has
  // fired between the last hide and the open.
  refreshAudioApplyHint();
  selectSettingsTab('providers');
  try {
    settingsModalEl.showModal();
  } catch (err) {
    // showModal() throws if the dialog is already open. Treat as no-op.
    console.warn('[settings] showModal failed:', err?.message || err);
  }
}

function closeSettingsModal() {
  if (!settingsModalEl) return;
  // Force-flush any pending debounced key edits so closing the dialog
  // mid-typing doesn't drop the user's input. Same protection for the
  // appearance debounce — colour pickers can fire `input` right before
  // the user hits Esc. The transparency editor has two debounce paths
  // (sliders + preset-name typing) so both get flushed here too.
  for (const provider of PROVIDER_IDS) flushPendingKeySave(provider);
  flushAppearanceSave();
  flushTransparencySave();
  flushTransparencyPresetNameSaves();
  try { settingsModalEl.close(); } catch { /* not open */ }
}

/**
 * Push a partial settings object via the IPC bridge. Refreshes the
 * cache + form from the echo so any normalisation on the main side
 * is visible immediately. Best-effort: a failed IPC roundtrip is
 * logged but doesn't roll the form back — the form IS the user's
 * intent.
 */
async function pushSettingsPartial(partial) {
  try {
    const fresh = await window.gemini.settings?.save?.(partial);
    if (fresh && typeof fresh === 'object') {
      settingsCache = fresh;
      // Don't re-render the whole form here — the user may still be
      // typing in another card. We only need to update the status
      // badge / test-button label for the provider(s) we just saved.
      const envAvail = (fresh._envAvailability && typeof fresh._envAvailability === 'object')
        ? fresh._envAvailability
        : {};
      for (const card of settingsProviderCardEls) {
        refreshProviderStatusBadge(card, fresh, envAvail);
      }
      // Sync the segmented control as a belt-and-braces — defaulting
      // back to whatever main returned (which equals what we sent).
      if (typeof fresh.defaultProvider === 'string') {
        setDefaultProviderSelection(fresh.defaultProvider);
      }
    }
  } catch (err) {
    console.warn('[settings] save failed:', err?.message || err);
  }
}

/** Save just the default-provider choice — used by the segmented
 *  control. Debounced slightly so a rapid click sequence only fires
 *  the last selection. */
let defaultProviderSaveTimer = null;
function queueDefaultProviderSave(providerId) {
  clearTimeout(defaultProviderSaveTimer);
  defaultProviderSaveTimer = setTimeout(() => {
    pushSettingsPartial({ defaultProvider: providerId });
  }, 250);
}

/** Save just the per-provider API key. Called by the input's debounced
 *  save path; updates the local last-flushed tracker so re-blurring
 *  with the same value doesn't fire another roundtrip. */
function pushProviderKey(provider, value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (settingsKeyLastFlushed[provider] === trimmed) return;
  settingsKeyLastFlushed[provider] = trimmed;
  pushSettingsPartial({
    providers: { [provider]: { apiKey: trimmed } },
  });
}

/** Flush any pending debounced key save immediately. Called on blur
 *  and on modal close. */
function flushPendingKeySave(provider) {
  const timer = settingsKeyDebounceTimers[provider];
  if (!timer) return;
  clearTimeout(timer);
  settingsKeyDebounceTimers[provider] = null;
  const card = settingsProviderCardEls.find((c) => c.dataset.provider === provider);
  const input = card?.querySelector(`[data-provider-key="${provider}"]`);
  if (input instanceof HTMLInputElement) {
    pushProviderKey(provider, input.value);
  }
}

/** Save just the per-provider default model — called on `change` of
 *  the select, which fires on commit (not on every arrow keypress) so
 *  no debounce needed. */
function pushProviderModel(provider, model) {
  pushSettingsPartial({
    providers: { [provider]: { defaultModel: model } },
  });
}

/** Run a connectivity test against a provider. Renders the result
 *  inline next to the Test button for 3 s. Disables the button during
 *  the in-flight roundtrip so a quick double-click doesn't fan out. */
async function runProviderTest(provider) {
  const card = settingsProviderCardEls.find((c) => c.dataset.provider === provider);
  if (!card) return;
  // Flush any pending key save first so the test runs against the
  // value the user just typed, not the previous flushed value.
  flushPendingKeySave(provider);

  const testBtn = card.querySelector('.provider-card__test');
  const resultEl = card.querySelector(`[data-test-result-for="${provider}"]`);
  if (testBtn instanceof HTMLButtonElement) testBtn.disabled = true;
  if (resultEl instanceof HTMLElement) {
    resultEl.hidden = false;
    delete resultEl.dataset.result;
    resultEl.textContent = 'Testing…';
  }

  let result;
  try {
    result = await window.gemini.settings?.testProvider?.(provider);
  } catch (err) {
    result = { ok: false, message: err?.message || String(err) };
  }

  if (resultEl instanceof HTMLElement) {
    if (result?.ok) {
      resultEl.dataset.result = 'ok';
      resultEl.textContent = 'Connected';
    } else {
      resultEl.dataset.result = 'fail';
      resultEl.textContent = result?.message || 'Failed';
    }
    clearTimeout(settingsTestResultTimers[provider]);
    settingsTestResultTimers[provider] = setTimeout(() => {
      resultEl.hidden = true;
      delete resultEl.dataset.result;
    }, 3000);
  }
  if (testBtn instanceof HTMLButtonElement) testBtn.disabled = false;
}

/* ── Generic settings autosave helpers (Phase 1 plumbing) ────────────
 *
 * These are intentionally additive — the existing bespoke wiring
 * (provider key debounce, default-provider toggle, appearance pickers,
 * coach toggles) stays exactly as it was. Phases 2-6 each have several
 * new controls (sliders, dropdowns, file pickers, custom text areas)
 * that don't fit cleanly into the existing one-off handlers. Each new
 * control just needs:
 *
 *   attachDebouncedFieldSave(inputEl, 'coach.tickMs');
 *   attachImmediateFieldSave(selectEl, 'audio.deepgramModel');
 *
 * and the persistence + IPC roundtrip is taken care of.
 *
 * The dotted field path mirrors the settings schema (`coach.tickMs`,
 * `audio.micDeviceId`, …). buildSettingsPartial inflates it into the
 * nested partial that `pushSettingsPartial` already knows how to
 * deep-merge on the main side. */

/**
 * Inflate a dotted field path into a nested partial object suitable
 * for `pushSettingsPartial`. `buildSettingsPartial('coach.tickMs', 1500)`
 * returns `{ coach: { tickMs: 1500 } }`. Returns null for empty/invalid
 * paths.
 */
function buildSettingsPartial(fieldPath, value) {
  if (typeof fieldPath !== 'string' || !fieldPath) return null;
  const segments = fieldPath.split('.').filter(Boolean);
  if (segments.length === 0) return null;
  const root = {};
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    cursor[segments[i]] = {};
    cursor = cursor[segments[i]];
  }
  cursor[segments[segments.length - 1]] = value;
  return root;
}

/**
 * Read a value from a form input. Default behaviour:
 *   - checkbox / radio  → input.checked (boolean)
 *   - number / range    → Number(input.value), or null if not finite
 *   - everything else   → input.value (string)
 *
 * Callers that need a different decode (e.g. a comma-separated list)
 * pass a `getValue` override to the autosave helper.
 */
function readInputValue(input) {
  if (!(input instanceof HTMLElement)) return null;
  const type = input.getAttribute('type');
  if (type === 'checkbox' || type === 'radio') {
    return /** @type {HTMLInputElement} */ (input).checked === true;
  }
  if (type === 'number' || type === 'range') {
    const n = Number(/** @type {HTMLInputElement} */ (input).value);
    return Number.isFinite(n) ? n : null;
  }
  const v = /** @type {HTMLInputElement} */ (input).value;
  return typeof v === 'string' ? v : null;
}

/**
 * Attach an idle-debounced auto-save to a form control. The save
 * fires when the user stops interacting for `idleMs`, or immediately
 * on blur so closing the modal mid-typing still flushes.
 *
 * Options:
 *   idleMs       (1000)        — debounce window
 *   getValue     (readInputValue) — value extractor
 *   eventName    ('input')     — DOM event to listen for
 *   flushOnBlur  (true)        — also flush on blur
 *
 * Returns `{ flush }` so the caller can chain it (e.g. modal-close
 * flush list, similar to flushPendingKeySave).
 */
function attachDebouncedFieldSave(input, fieldPath, options = {}) {
  if (!(input instanceof HTMLElement)) return { flush: () => {} };
  const {
    idleMs = 1000,
    getValue = readInputValue,
    eventName = 'input',
    flushOnBlur = true,
  } = options;

  let timer = null;
  let pending = null;
  let hasPending = false;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!hasPending) return;
    const partial = buildSettingsPartial(fieldPath, pending);
    hasPending = false;
    pending = null;
    if (partial) pushSettingsPartial(partial);
  }

  input.addEventListener(eventName, () => {
    pending = getValue(input);
    hasPending = true;
    if (idleMs <= 0) {
      flush();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, idleMs);
  });

  if (flushOnBlur) {
    input.addEventListener('blur', flush);
  }

  return { flush };
}

/**
 * Immediate-commit variant. Listens on `change` (which only fires on
 * commit for selects / color pickers / checkboxes — unlike `input`
 * which fires continuously) and saves on the same tick. Good for any
 * control where the user's intent is "I've chosen, save now" rather
 * than "I'm in the middle of typing".
 */
function attachImmediateFieldSave(input, fieldPath, options = {}) {
  return attachDebouncedFieldSave(input, fieldPath, {
    ...options,
    idleMs: 0,
    eventName: 'change',
    flushOnBlur: false,
  });
}

/**
 * Open a native Open/Save dialog and return the selected path.
 * Wraps the `dialog:open` / `dialog:save` IPC exposed via the
 * preload bridge.
 *
 * Args:
 *   kind         'open' (default) | 'save'
 *   defaultName  suggested filename (Save only)
 *   defaultPath  pre-populated path (Open / Save)
 *   filters      [{ name, extensions: [...] }] for the dialog
 *   properties   ['openFile' | 'openDirectory' | …] for Open dialogs
 *
 * Returns the selected absolute path string, or null if the user
 * cancelled or the IPC isn't wired (defensive — phases that need this
 * confirm via window.gemini.dialog before using it).
 */
async function pickPathFromDialog({
  kind = 'open',
  defaultName,
  defaultPath,
  filters,
  properties,
} = {}) {
  const bridge = window.gemini?.dialog;
  const fn = kind === 'save' ? bridge?.save : bridge?.open;
  if (typeof fn !== 'function') {
    console.warn('[settings] dialog bridge not available — caller should check first');
    return null;
  }
  try {
    const result = await fn({ defaultName, defaultPath, filters, properties });
    if (!result || result.canceled || !result.filePath) return null;
    return result.filePath;
  } catch (err) {
    console.warn('[settings] dialog pick failed:', err?.message || err);
    return null;
  }
}

/* ── Settings modal event wiring ──────────────────────────────────── */

if (settingsButtonEl) {
  settingsButtonEl.addEventListener('click', () => {
    openSettingsModal();
  });
}

if (settingsModalCloseEl) {
  settingsModalCloseEl.addEventListener('click', closeSettingsModal);
}

// Belt-and-braces: native <dialog>.close() can fire from Esc too. Make
// sure any pending key edits flush on that path as well, and tear down
// any orphaned sub-dialogs (reset-confirm / import-preview) so they
// don't reappear over a closed parent on next open.
if (settingsModalEl) {
  settingsModalEl.addEventListener('close', () => {
    for (const provider of PROVIDER_IDS) flushPendingKeySave(provider);
    flushAppearanceSave();
    if (settingsResetConfirmEl instanceof HTMLDialogElement && settingsResetConfirmEl.open) {
      try { settingsResetConfirmEl.close(); } catch { /* not open */ }
    }
    if (settingsImportPreviewEl instanceof HTMLDialogElement && settingsImportPreviewEl.open) {
      pendingImportJson = null;
      try { settingsImportPreviewEl.close(); } catch { /* not open */ }
    }
  });
}

// Clear stash on import preview's `close` event so any path (Cancel
// button, Esc key, programmatic close) leaves no dangling state.
if (settingsImportPreviewEl instanceof HTMLDialogElement) {
  settingsImportPreviewEl.addEventListener('close', () => {
    pendingImportJson = null;
  });
}

for (const btn of settingsTabEls) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab) selectSettingsTab(tab);
  });
}

// Default-provider segmented control. Each click flips the active
// pill + queues a debounced save. We keep the local highlight optimistic
// so the UI feels instant even if the IPC roundtrip is in flight.
for (const btn of settingsDefaultProviderBtnEls) {
  btn.addEventListener('click', () => {
    const provider = btn.dataset.provider;
    if (!provider || !PROVIDER_IDS.includes(provider)) return;
    setDefaultProviderSelection(provider);
    queueDefaultProviderSave(provider);
  });
}

// Per-card wiring: key input (debounced), eye toggle, Test button,
// model select.
for (const card of settingsProviderCardEls) {
  const provider = card.dataset.provider;
  if (!provider) continue;
  const keyInput = card.querySelector(`[data-provider-key="${provider}"]`);
  if (keyInput instanceof HTMLInputElement) {
    keyInput.addEventListener('input', () => {
      clearTimeout(settingsKeyDebounceTimers[provider]);
      settingsKeyDebounceTimers[provider] = setTimeout(() => {
        settingsKeyDebounceTimers[provider] = null;
        pushProviderKey(provider, keyInput.value);
      }, SETTINGS_IDLE_SAVE_MS);
    });
    keyInput.addEventListener('blur', () => {
      flushPendingKeySave(provider);
    });
  }

  const eyeBtn = card.querySelector(`[data-eye-for="${provider}"]`);
  if (eyeBtn instanceof HTMLElement) {
    eyeBtn.addEventListener('click', () => {
      if (!(keyInput instanceof HTMLInputElement)) return;
      const showing = keyInput.type === 'text';
      keyInput.type = showing ? 'password' : 'text';
      eyeBtn.setAttribute('aria-pressed', String(!showing));
      eyeBtn.setAttribute('aria-label', !showing ? 'Hide key' : 'Show key');
    });
  }

  const testBtn = card.querySelector('.provider-card__test');
  if (testBtn instanceof HTMLElement) {
    testBtn.addEventListener('click', () => {
      runProviderTest(provider);
    });
  }

  const modelSelect = card.querySelector(`[data-provider-model="${provider}"]`);
  if (modelSelect instanceof HTMLSelectElement) {
    modelSelect.addEventListener('change', () => {
      pushProviderModel(provider, modelSelect.value);
    });
  }
}

/* ── Coach tab wiring ────────────────────────────────────────────────
 *
 * Two checkboxes. Both auto-save on change. The auto-reformulate row
 * is dependent — when track-question-state is OFF, auto-reformulate is
 * forced off and disabled, because there's no way to detect "asked
 * vs unasked" without the upstream toggle.
 *
 * Local state mirror is updated synchronously before the IPC fires so
 * the drawer re-renders with the new toggle reflected immediately,
 * regardless of whether the IPC roundtrip lands later. The
 * settings:changed broadcast (from main) is a belt-and-braces
 * second-source — if anything ever modifies settings out-of-band, the
 * subscriber will pull the fresh shape in. */
function pushCoachPartial(partial) {
  pushSettingsPartial({ coach: partial });
}

if (settingsCoachTrackEl instanceof HTMLInputElement) {
  settingsCoachTrackEl.addEventListener('change', () => {
    const next = settingsCoachTrackEl.checked;
    state.coach = { ...state.coach, trackQuestionState: next };
    // When tracking turns off, auto-reformulate becomes pointless;
    // force it off too and update the dependent UI immediately.
    if (!next) {
      state.coach.autoReformulate = false;
      if (settingsCoachAutoReformulateEl instanceof HTMLInputElement) {
        settingsCoachAutoReformulateEl.checked = false;
        settingsCoachAutoReformulateEl.disabled = true;
        const wrap = settingsCoachAutoReformulateEl.closest('.advanced-toggle');
        if (wrap instanceof HTMLElement) wrap.dataset.disabled = 'true';
      }
      pushCoachPartial({ trackQuestionState: false, autoReformulate: false });
    } else {
      if (settingsCoachAutoReformulateEl instanceof HTMLInputElement) {
        settingsCoachAutoReformulateEl.disabled = false;
        const wrap = settingsCoachAutoReformulateEl.closest('.advanced-toggle');
        if (wrap instanceof HTMLElement) wrap.dataset.disabled = 'false';
      }
      pushCoachPartial({ trackQuestionState: true });
    }
    // Re-render the drawer if it's currently open on the logged
    // pillar so the green-outline styling flips immediately.
    if (state.activePillarId === 'logged_questions') {
      renderRailOverlay();
    }
  });
}

if (settingsCoachAutoReformulateEl instanceof HTMLInputElement) {
  settingsCoachAutoReformulateEl.addEventListener('change', () => {
    // The disabled attribute prevents this firing when
    // trackQuestionState is off, but defend anyway in case a future
    // refactor unwires the disabled state.
    if (!state.coach.trackQuestionState) {
      settingsCoachAutoReformulateEl.checked = false;
      return;
    }
    const next = settingsCoachAutoReformulateEl.checked;
    state.coach = { ...state.coach, autoReformulate: next };
    pushCoachPartial({ autoReformulate: next });
  });
}

/* ── Audio tab wiring (Phase 2) ─────────────────────────────────────
 *
 * Seven controls; six save to disk (T1–T5, T14), one applies
 * immediately (V10). All use the generic autosave helpers from the
 * Phase 1 foundation — no bespoke debounce / IPC logic per control.
 *
 * Apply-policy notes:
 *   - Capture / STT controls (T1–T5, T14) bake into getUserMedia /
 *     getDisplayMedia / Deepgram WS at session-open time. Edits mid-
 *     call don't hot-swap; the apply-hint panel calls this out.
 *   - V10 (hideAecBadge) toggles the badge synchronously on save —
 *     pure DOM mutation, no IPC roundtrip needed for the visual.
 *
 * Device-enumeration design:
 *   - Mic devices come from navigator.mediaDevices.enumerateDevices()
 *     in the renderer. Pre-permission-grant the device labels may be
 *     empty strings; we surface the deviceId in that case so the
 *     dropdown isn't blank.
 *   - System-audio sources come from main via the system:list-audio-
 *     sources IPC (desktopCapturer). macOS needs Screen Recording
 *     permission for the list to populate.
 *
 * Populators run on:
 *   - First settings modal open (via openSettingsModal → populate-
 *     AudioPickers, gated by an "already populated this session"
 *     flag so reopening the modal doesn't re-enumerate).
 *   - Every Refresh-button click (forced repopulate).
 *
 * The Refresh button is the user's escape hatch when a device is
 * unplugged / replugged mid-session — they don't need to restart
 * the app for the dropdown to update. */

const AUDIO_FIELDS = {
  mic: 'audio.micDeviceId',
  sysSource: 'audio.systemAudioSourceId',
  aec: 'audio.aec',
  ns: 'audio.noiseSuppression',
  agc: 'audio.autoGainControl',
  model: 'audio.deepgramModel',
  hideAecBadge: 'audio.hideAecBadge',
};

attachImmediateFieldSave(audioMicSelectEl, AUDIO_FIELDS.mic);
attachImmediateFieldSave(audioSysSourceSelectEl, AUDIO_FIELDS.sysSource);
attachImmediateFieldSave(audioAecEl, AUDIO_FIELDS.aec);
attachImmediateFieldSave(audioNoiseSuppressionEl, AUDIO_FIELDS.ns);
attachImmediateFieldSave(audioAutoGainControlEl, AUDIO_FIELDS.agc);
attachImmediateFieldSave(audioDeepgramModelEl, AUDIO_FIELDS.model);
attachImmediateFieldSave(audioHideAecBadgeEl, AUDIO_FIELDS.hideAecBadge);

// V10 hide-AEC-badge — apply visually on every flip BEFORE the IPC
// roundtrip lands. The autosave helper above persists the value; the
// listener below mirrors the change to the DOM immediately so the
// badge disappears / reappears without waiting for the
// `settings:changed` broadcast.
if (audioHideAecBadgeEl instanceof HTMLInputElement) {
  audioHideAecBadgeEl.addEventListener('change', () => {
    applyAecBadgeVisibility({ hideAecBadge: audioHideAecBadgeEl.checked });
  });
}

/** First-open hydration flag. Populators are lazy — there's no point
 *  enumerating devices on app boot when the user might never open
 *  the Audio tab. This flag is reset to false by the Refresh buttons
 *  so a manual refresh forces a re-enumerate even if the cached
 *  populate already ran. */
let audioPickersPopulated = false;

/**
 * Enumerate microphone devices via the browser's
 * `navigator.mediaDevices.enumerateDevices()` API and populate the
 * mic dropdown. Preserves the persisted `audio.micDeviceId`
 * selection if it's still present; if the persisted ID is gone
 * (e.g. USB mic unplugged), the dropdown falls back to "Default
 * (OS-selected mic)" and getUserMedia will use the OS default.
 *
 * Label privacy: before the user has granted mic permission, the
 * browser returns empty `label` strings for security. We surface a
 * fallback "Microphone (deviceId …)" so the dropdown isn't blank.
 * After permission is granted (or after the first successful
 * getUserMedia call) the labels populate normally.
 */
async function populateMicDevices() {
  if (!(audioMicSelectEl instanceof HTMLSelectElement)) return;
  if (!navigator.mediaDevices?.enumerateDevices) {
    console.warn('[audio] enumerateDevices unavailable; mic picker stays default-only');
    return;
  }

  const previousValue = audioMicSelectEl.value;
  // Save the persisted value too in case the previous-value above
  // is on a placeholder option that's about to be cleared.
  const persisted = settingsCache?.audio?.micDeviceId || '';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');

    // Rebuild option list: first the '' default, then one entry per
    // mic. Strip any placeholder option injected by
    // hydrateAudioSelectValue() since we now have real data.
    audioMicSelectEl.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default (OS-selected mic)';
    audioMicSelectEl.appendChild(defaultOpt);

    for (const dev of inputs) {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Microphone (${dev.deviceId.slice(0, 6) || 'unknown'})`;
      audioMicSelectEl.appendChild(opt);
    }

    // Restore selection: prefer the previous (which may equal the
    // persisted), otherwise fall back to persisted, otherwise default.
    const wanted = previousValue || persisted || '';
    const exists = Array.from(audioMicSelectEl.options).some((o) => o.value === wanted);
    audioMicSelectEl.value = exists ? wanted : '';
  } catch (err) {
    console.warn('[audio] mic enumeration failed:', err?.message || err);
  }
}

/**
 * Enumerate desktop audio sources via the main-side IPC and populate
 * the system-audio dropdown. Same fallback semantics as the mic
 * picker — a missing persisted ID degrades to the '' default
 * ("first available screen"), which is the original hardcoded
 * behaviour, so no regression.
 *
 * macOS without Screen Recording perm: the IPC returns an empty
 * list. We render a single "no sources available" disabled option
 * to make the empty state explicit; the existing permission
 * explainer modal handles re-prompting.
 */
async function populateSystemAudioSources() {
  if (!(audioSysSourceSelectEl instanceof HTMLSelectElement)) return;
  if (typeof window.gemini?.system?.listAudioSources !== 'function') {
    console.warn('[audio] system.listAudioSources bridge missing; system-audio picker stays default-only');
    return;
  }

  const previousValue = audioSysSourceSelectEl.value;
  const persisted = settingsCache?.audio?.systemAudioSourceId || '';

  try {
    const result = await window.gemini.system.listAudioSources();
    const sources = Array.isArray(result?.sources) ? result.sources : [];

    audioSysSourceSelectEl.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default (first available screen)';
    audioSysSourceSelectEl.appendChild(defaultOpt);

    if (sources.length === 0) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = result?.permission === 'granted'
        ? '— no sources available —'
        : '— grant Screen Recording to populate —';
      emptyOpt.disabled = true;
      audioSysSourceSelectEl.appendChild(emptyOpt);
    } else {
      for (const src of sources) {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = src.name || src.id;
        audioSysSourceSelectEl.appendChild(opt);
      }
    }

    const wanted = previousValue || persisted || '';
    const exists = Array.from(audioSysSourceSelectEl.options).some((o) => o.value === wanted);
    audioSysSourceSelectEl.value = exists ? wanted : '';
  } catch (err) {
    console.warn('[audio] system-audio enumeration failed:', err?.message || err);
  }
}

/** Convenience: run both populators in parallel. Called on first
 *  Audio-tab open + on either Refresh button click. */
async function populateAudioPickers() {
  audioPickersPopulated = true;
  await Promise.all([populateMicDevices(), populateSystemAudioSources()]);
}

if (audioMicRefreshBtnEl) {
  audioMicRefreshBtnEl.addEventListener('click', () => {
    populateMicDevices();
  });
}

if (audioSysRefreshBtnEl) {
  audioSysRefreshBtnEl.addEventListener('click', () => {
    populateSystemAudioSources();
  });
}

/**
 * Show / hide the "Changes apply on next Start" hint based on the
 * current capture status. Listening + starting both count as
 * "in-call" because edits made during the startup ramp-up don't
 * retroactively change the constraints baked into getUserMedia.
 *
 * Called from setStatus() so every state transition syncs the hint,
 * and from openSettingsModal() so opening the modal mid-call paints
 * the hint correctly even if no transition fired since the modal
 * was last open.
 */
function refreshAudioApplyHint() {
  if (!(audioApplyHintEl instanceof HTMLElement)) return;
  const inCall = state.status === 'listening' || state.status === 'starting';
  audioApplyHintEl.hidden = !inCall;
}

/* ── Appearance tab wiring ───────────────────────────────────────────
 *
 * The two colour pickers fire `input` on every nudge (which is fine —
 * we apply live-preview synchronously and queue the IPC save behind a
 * 200 ms idle debounce so a continuous drag through the spectrum only
 * fires one or two writes at the end). The reset button cancels any
 * pending debounce and flushes the defaults immediately.
 *
 * Both channels are persisted under `appearance.tagColors.{you,other}`
 * — the main-side deepMerge keeps the unchanged channel intact.
 */
const APPEARANCE_IDLE_SAVE_MS = 200;
let appearanceSaveTimer = null;
/** Last partial we queued; merged so a fast `you` then `other` nudge
 *  results in a single roundtrip covering both. */
let appearancePendingPartial = null;

function queueAppearanceSave(partial) {
  appearancePendingPartial = { ...(appearancePendingPartial || {}), ...partial };
  clearTimeout(appearanceSaveTimer);
  appearanceSaveTimer = setTimeout(() => {
    const next = appearancePendingPartial;
    appearancePendingPartial = null;
    appearanceSaveTimer = null;
    pushSettingsPartial({ appearance: { tagColors: next } });
  }, APPEARANCE_IDLE_SAVE_MS);
}

function flushAppearanceSave() {
  if (appearanceSaveTimer) {
    clearTimeout(appearanceSaveTimer);
    appearanceSaveTimer = null;
  }
  const next = appearancePendingPartial;
  appearancePendingPartial = null;
  if (!next) return Promise.resolve();
  // Return the underlying promise so callers (e.g. export) that need
  // the disk to be up-to-date before they read settings can await.
  // Existing fire-and-forget callers (closeSettingsModal) simply
  // ignore the returned value.
  return pushSettingsPartial({ appearance: { tagColors: next } });
}

if (appearanceColorYouEl instanceof HTMLInputElement) {
  appearanceColorYouEl.addEventListener('input', () => {
    const value = appearanceColorYouEl.value;
    applyTagColors({ you: value });
    queueAppearanceSave({ you: value });
  });
}

if (appearanceColorOtherEl instanceof HTMLInputElement) {
  appearanceColorOtherEl.addEventListener('input', () => {
    const value = appearanceColorOtherEl.value;
    applyTagColors({ other: value });
    queueAppearanceSave({ other: value });
  });
}

if (appearanceResetBtnEl) {
  appearanceResetBtnEl.addEventListener('click', () => {
    if (appearanceColorYouEl instanceof HTMLInputElement) {
      appearanceColorYouEl.value = DEFAULT_TAG_YOU;
    }
    if (appearanceColorOtherEl instanceof HTMLInputElement) {
      appearanceColorOtherEl.value = DEFAULT_TAG_OTHER;
    }
    applyTagColors({ you: DEFAULT_TAG_YOU, other: DEFAULT_TAG_OTHER });
    // Cancel any in-flight debounce and write defaults eagerly — the
    // user's intent is "now", not "in 200 ms".
    clearTimeout(appearanceSaveTimer);
    appearanceSaveTimer = null;
    appearancePendingPartial = null;
    pushSettingsPartial({
      appearance: { tagColors: { you: DEFAULT_TAG_YOU, other: DEFAULT_TAG_OTHER } },
    });
  });
}

/* ── Transparency editor wiring ────────────────────────────────────
 *
 * Mirror of the speaker-label wiring above for the per-surface alpha
 * sliders + preset cards. Two debounce paths:
 *
 *   - queueTransparencySave (200 ms, like queueAppearanceSave) for
 *     slider edits. Merges multiple channel changes for the same
 *     surface so a rapid outline-then-body nudge results in a single
 *     IPC roundtrip.
 *
 *   - queueTransparencyPresetNameSave (400 ms, longer than the
 *     slider debounce — the user TYPES into the preset name input,
 *     so we want to wait for them to stop) for preset label edits.
 *
 * The Reset Surface, preset Load, and preset Save Current paths all
 * skip the debounce and fire pushSettingsPartial directly — these
 * are click events with clear "do it now" intent.
 */
const TRANSPARENCY_IDLE_SAVE_MS = 200;
const TRANSPARENCY_PRESET_NAME_IDLE_SAVE_MS = 400;
let transparencySaveTimer = null;
/** Pending partial keyed by surface — `{ coach: { body: 0.7 }, ... }`.
 *  Lets a fast slider-then-surface-switch land all queued edits in a
 *  single save instead of dropping the earlier surface. */
let transparencyPendingPartial = null;

function queueTransparencySave(surface, partial) {
  if (!TRANSPARENCY_SURFACES.includes(surface)) return;
  transparencyPendingPartial = transparencyPendingPartial || {};
  transparencyPendingPartial[surface] = {
    ...(transparencyPendingPartial[surface] || {}),
    ...partial,
  };
  clearTimeout(transparencySaveTimer);
  transparencySaveTimer = setTimeout(() => {
    const next = transparencyPendingPartial;
    transparencyPendingPartial = null;
    transparencySaveTimer = null;
    pushSettingsPartial({ appearance: { transparency: next } });
  }, TRANSPARENCY_IDLE_SAVE_MS);
}

function flushTransparencySave() {
  if (transparencySaveTimer) {
    clearTimeout(transparencySaveTimer);
    transparencySaveTimer = null;
  }
  const next = transparencyPendingPartial;
  transparencyPendingPartial = null;
  if (!next) return Promise.resolve();
  return pushSettingsPartial({ appearance: { transparency: next } });
}

/** Per-slot debounce timers for preset name edits. Map of slot -> timer. */
const transparencyPresetNameTimers = new Map();
function queueTransparencyPresetNameSave(slot, name) {
  if (!slot) return;
  const existing = transparencyPresetNameTimers.get(slot);
  if (existing) clearTimeout(existing);
  transparencyPresetNameTimers.set(
    slot,
    setTimeout(() => {
      transparencyPresetNameTimers.delete(slot);
      pushSettingsPartial({
        appearance: { transparencyPresets: { [slot]: { name } } },
      });
    }, TRANSPARENCY_PRESET_NAME_IDLE_SAVE_MS),
  );
}

function flushTransparencyPresetNameSaves() {
  // Called from closeSettingsModal — if the user typed into a name
  // input and immediately Esc'd, we want the pending typing to
  // persist instead of getting lost on the next modal open.
  for (const [slot, timer] of transparencyPresetNameTimers.entries()) {
    clearTimeout(timer);
    const card = transparencyPresetEls.find((c) => c.dataset.presetSlot === slot);
    if (!card) continue;
    const nameInput = card.querySelector('.transparency-preset__name');
    if (!(nameInput instanceof HTMLInputElement)) continue;
    pushSettingsPartial({
      appearance: { transparencyPresets: { [slot]: { name: nameInput.value } } },
    });
  }
  transparencyPresetNameTimers.clear();
}

/* Slider input handlers. Each slider stores its channel via
 * data-channel, so a single handler covers all three. value is the
 * integer 0–100 from the range input — we convert to 0.0–1.0 for the
 * CSS var + the persisted settings, and keep the integer for the
 * read-only percentage badge. */
function wireTransparencySlider(slider) {
  if (!(slider instanceof HTMLInputElement)) return;
  const channel = slider.dataset.channel;
  if (!TRANSPARENCY_CHANNELS.includes(channel)) return;
  slider.addEventListener('input', () => {
    if (!(transparencySurfaceEl instanceof HTMLSelectElement)) return;
    const surface = transparencySurfaceEl.value;
    if (!TRANSPARENCY_SURFACES.includes(surface)) return;
    const pct = Math.max(0, Math.min(100, Number.parseInt(slider.value, 10) || 0));
    const value = pct / 100;
    applySurfaceTransparency(surface, channel, value);
    const badge = transparencyValueEls[channel];
    if (badge instanceof HTMLElement) badge.textContent = `${pct}%`;
    queueTransparencySave(surface, { [channel]: value });
    updateTransparencyHints(surface);
  });
}
wireTransparencySlider(transparencySliderEls.outline);
wireTransparencySlider(transparencySliderEls.body);
wireTransparencySlider(transparencySliderEls.text);

/* Low-alpha hints — surface the two known foot-guns inline so the
 * user doesn't have to discover them by experiment:
 *
 *   - Outline below 0.05 on a frameless transparent macOS window
 *     can reveal the native NSWindow shadow ring (see the long
 *     hasShadow:false comment in src/main.js's createWindow). With
 *     a settings-driven outline we can't always suppress this; the
 *     hint just tells the user it's expected.
 *
 *   - Text below 0.4 is hard to read on most prospect call
 *     backgrounds (especially light desktops). 0.4 maps to the
 *     existing --text-dim token; below that, body copy starts
 *     disappearing into the surface.
 *
 * Hints are hidden until the slider crosses each threshold, then
 * fade in as a small italic note under the slider track. Toggled
 * by hidden attribute so screen-readers respect the show/hide.
 *
 * Called from:
 *   - Slider input handler (every drag tick).
 *   - Surface dropdown change (after slider re-hydrate).
 *   - Reset Surface button.
 *   - Preset Load handler.
 *   - applySettingsToForm (first modal open + Reset / Import paths).
 */
const TRANSPARENCY_HINT_THRESHOLDS = {
  outline: 0.05,
  text: 0.4,
};

function updateTransparencyHints(surface) {
  if (!TRANSPARENCY_SURFACES.includes(surface)) return;
  const block = settingsCache?.appearance?.transparency?.[surface] || DEFAULT_TRANSPARENCY[surface] || {};
  for (const channel of ['outline', 'text']) {
    const threshold = TRANSPARENCY_HINT_THRESHOLDS[channel];
    // Read the slider's current displayed value rather than the
    // persisted setting — the user might still be dragging mid-
    // debounce, and the hint should track what they SEE.
    const slider = transparencySliderEls[channel];
    let pct;
    if (slider instanceof HTMLInputElement) {
      pct = Number.parseInt(slider.value, 10);
    }
    if (!Number.isFinite(pct)) pct = Math.round((block[channel] ?? 0) * 100);
    const value = pct / 100;
    const hint = document.getElementById(
      channel === 'outline' ? 'transparencyOutlineHint' : 'transparencyTextHint',
    );
    if (hint instanceof HTMLElement) hint.hidden = value >= threshold;
  }
}

/* Surface dropdown — flush any pending debounce for the previous
 * surface so the user's last edit lands BEFORE we switch, then
 * re-hydrate the three sliders + badges from the new surface's
 * current values in the cached settings. */
if (transparencySurfaceEl instanceof HTMLSelectElement) {
  transparencySurfaceEl.addEventListener('change', () => {
    flushTransparencySave();
    const block = settingsCache?.appearance?.transparency || DEFAULT_TRANSPARENCY;
    hydrateTransparencySliders(block);
    updateTransparencyHints(transparencySurfaceEl.value);
  });
}

/* Open / Close preview button. Toggles aria-pressed + the visible
 * label optimistically; on IPC failure we revert. The preview
 * window's `closed` event in main.js also nulls previewWindowRef,
 * but the renderer doesn't subscribe to that signal — if the user
 * closes the preview from its own window chrome (Cmd+W) the button
 * label will stay at "Close preview" until the next open click,
 * which is fine: clicking it just re-opens the window. */
function setTransparencyPreviewBtnState(open) {
  transparencyPreviewOpen = open;
  if (!(transparencyPreviewBtnEl instanceof HTMLButtonElement)) return;
  transparencyPreviewBtnEl.textContent = open ? 'Close preview' : 'Open preview';
  transparencyPreviewBtnEl.setAttribute('aria-pressed', String(open));
}

if (transparencyPreviewBtnEl instanceof HTMLButtonElement) {
  transparencyPreviewBtnEl.addEventListener('click', async () => {
    const targetOpen = !transparencyPreviewOpen;
    transparencyPreviewBtnEl.disabled = true;
    try {
      if (targetOpen) {
        await window.gemini.appearance?.openPreview?.();
      } else {
        await window.gemini.appearance?.closePreview?.();
      }
      setTransparencyPreviewBtnState(targetOpen);
    } catch (err) {
      console.warn('[transparency] preview toggle failed:', err?.message || err);
    } finally {
      transparencyPreviewBtnEl.disabled = false;
    }
  });
}

/* Reset Surface — restore DEFAULT_TRANSPARENCY for whichever
 * surface the dropdown points at. Eager save (no debounce) so the
 * user's intent is honoured immediately. */
if (transparencyResetSurfaceEl instanceof HTMLButtonElement) {
  transparencyResetSurfaceEl.addEventListener('click', () => {
    if (!(transparencySurfaceEl instanceof HTMLSelectElement)) return;
    const surface = transparencySurfaceEl.value;
    if (!TRANSPARENCY_SURFACES.includes(surface)) return;
    const defaults = DEFAULT_TRANSPARENCY[surface];
    for (const channel of TRANSPARENCY_CHANNELS) {
      applySurfaceTransparency(surface, channel, defaults[channel]);
    }
    // Cancel any pending debounce for this surface so the eager save
    // below doesn't get clobbered by the deferred slider partial.
    if (transparencyPendingPartial?.[surface]) {
      delete transparencyPendingPartial[surface];
      if (Object.keys(transparencyPendingPartial).length === 0) {
        transparencyPendingPartial = null;
        clearTimeout(transparencySaveTimer);
        transparencySaveTimer = null;
      }
    }
    hydrateTransparencySliders({ [surface]: defaults });
    updateTransparencyHints(surface);
    pushSettingsPartial({
      appearance: { transparency: { [surface]: defaults } },
    });
  });
}

/* Preset Load — deep-merge slot.values into appearance.transparency
 * via pushSettingsPartial, write the 12 CSS vars synchronously for
 * instant feedback, re-hydrate the sliders for the current surface.
 *
 * Preset Save Current — snapshot the current appearance.transparency
 * from the cache into slot.values. Single IPC.
 *
 * Preset name input — debounced 400 ms (longer than slider — user is
 * typing). */
for (const card of transparencyPresetEls) {
  const slot = card.dataset.presetSlot;
  if (!slot) continue;

  const loadBtn = card.querySelector('.transparency-preset__load');
  const saveBtn = card.querySelector('.transparency-preset__save');
  const nameInput = card.querySelector('.transparency-preset__name');

  if (loadBtn instanceof HTMLButtonElement) {
    loadBtn.addEventListener('click', () => {
      const slotBlock = settingsCache?.appearance?.transparencyPresets?.[slot];
      const values = slotBlock?.values;
      if (!values || typeof values !== 'object') {
        console.warn(`[transparency] preset ${slot} has no values yet`);
        return;
      }
      // Cancel any pending slider debounce — the user just blew away
      // their in-flight edit by loading a preset.
      clearTimeout(transparencySaveTimer);
      transparencySaveTimer = null;
      transparencyPendingPartial = null;
      applyTransparencyBlock(values);
      hydrateTransparencySliders(values);
      if (transparencySurfaceEl instanceof HTMLSelectElement) {
        updateTransparencyHints(transparencySurfaceEl.value);
      }
      pushSettingsPartial({ appearance: { transparency: values } });
    });
  }

  if (saveBtn instanceof HTMLButtonElement) {
    saveBtn.addEventListener('click', () => {
      // Flush any pending slider debounce so the snapshot reflects
      // the user's most recent edit, not the last-saved disk state.
      flushTransparencySave();
      const live = settingsCache?.appearance?.transparency || DEFAULT_TRANSPARENCY;
      // Deep clone so subsequent edits to settingsCache don't
      // mutate the persisted snapshot.
      const snapshot = JSON.parse(JSON.stringify(live));
      pushSettingsPartial({
        appearance: { transparencyPresets: { [slot]: { values: snapshot } } },
      });
    });
  }

  if (nameInput instanceof HTMLInputElement) {
    nameInput.addEventListener('input', () => {
      queueTransparencyPresetNameSave(slot, nameInput.value);
    });
  }
}

/* ── General → Data subsection wiring (Phase 1) ──────────────────────
 *
 * Export / Import / Reset. All three operate on the same settings
 * cache as the per-tab autosave paths, so any in-flight typing in
 * another tab will land via its own flush path; this block doesn't
 * special-case anything beyond closing the parent modal cleanly
 * after a wholesale change.
 *
 * Visual flow:
 *   Reset  : button → #settingsResetConfirm → IPC → re-hydrate form
 *   Export : (read inline checkbox) → IPC → dialog.save → toast/error
 *   Import : button → dialog.open(JSON) → validate IPC → preview modal
 *            → apply IPC on confirm → re-hydrate form
 */

/* Single shared filter for both Save (export) and Open (import) — the
 * canonical extension is .json but we also accept the catch-all so a
 * user who renamed the file can still open it. */
const SETTINGS_JSON_FILTERS = [
  { name: 'JSON', extensions: ['json'] },
  { name: 'All Files', extensions: ['*'] },
];

/* Stash the parsed-but-not-yet-applied import payload between the
 * validate step and the apply step. The renderer is the only place
 * that knows when the user has confirmed the diff, so the JSON string
 * needs to live somewhere across the user's interaction. */
let pendingImportJson = null;

/* ── U22: Reset to defaults ───────────────────────────────────────── */

function openResetConfirm() {
  if (!(settingsResetConfirmEl instanceof HTMLDialogElement)) return;
  // Default the checkbox to checked every time the modal opens. The
  // user's previous choice on a different reset shouldn't bleed across
  // — preserving keys is the safe default and we want the explicit
  // affordance every time.
  if (settingsResetPreserveKeysEl instanceof HTMLInputElement) {
    settingsResetPreserveKeysEl.checked = true;
  }
  try {
    settingsResetConfirmEl.showModal();
  } catch (err) {
    console.warn('[settings:reset] showModal failed:', err?.message || err);
  }
}

function closeResetConfirm() {
  if (!(settingsResetConfirmEl instanceof HTMLDialogElement)) return;
  try {
    settingsResetConfirmEl.close();
  } catch { /* not open */ }
}

async function doResetSettings() {
  const preserveKeys = settingsResetPreserveKeysEl instanceof HTMLInputElement
    ? settingsResetPreserveKeysEl.checked
    : true;
  // Cancel any in-flight debounced saves first so they don't land
  // AFTER the reset and re-introduce stale values. The appearance
  // debounce is the only one with cross-tab reach today; the rest
  // (provider keys, coach toggles) write on commit and don't have a
  // queued state.
  clearTimeout(appearanceSaveTimer);
  appearanceSaveTimer = null;
  appearancePendingPartial = null;

  try {
    const fresh = await window.gemini.settings?.reset?.({ preserveKeys });
    if (fresh && typeof fresh === 'object') {
      settingsCache = fresh;
      // Full re-hydration is the whole point of Reset — we explicitly
      // WANT to clobber every input back to its default value.
      applySettingsToForm(fresh);
      // Also re-apply the live tag colours since they're driven by
      // settings.appearance.tagColors and the user just reset them.
      applyTagColors(fresh.appearance?.tagColors || {
        you: DEFAULT_TAG_YOU,
        other: DEFAULT_TAG_OTHER,
      });
    }
  } catch (err) {
    console.warn('[settings:reset] IPC failed:', err?.message || err);
  } finally {
    closeResetConfirm();
  }
}

if (settingsResetBtnEl instanceof HTMLButtonElement) {
  settingsResetBtnEl.addEventListener('click', openResetConfirm);
}
if (settingsResetCancelEl instanceof HTMLButtonElement) {
  settingsResetCancelEl.addEventListener('click', closeResetConfirm);
}
if (settingsResetConfirmBtnEl instanceof HTMLButtonElement) {
  settingsResetConfirmBtnEl.addEventListener('click', doResetSettings);
}

/* ── U20: Export settings as JSON ─────────────────────────────────── */

async function doExportSettings() {
  const includeKeys = settingsExportIncludeKeysEl instanceof HTMLInputElement
    ? settingsExportIncludeKeysEl.checked
    : false;

  // Flush any pending per-tab debounces so the exported file reflects
  // exactly what the user sees on screen, not the last-persisted shape
  // from before they nudged something.
  for (const provider of PROVIDER_IDS) flushPendingKeySave(provider);
  await flushAppearanceSave();

  let snapshot;
  try {
    snapshot = await window.gemini.settings?.export?.({ includeKeys });
  } catch (err) {
    console.warn('[settings:export] serialise failed:', err?.message || err);
    return;
  }
  if (!snapshot || typeof snapshot.json !== 'string') return;

  try {
    const result = await window.gemini.dialog?.save?.({
      title: 'Export Two Way Flow settings',
      content: snapshot.json,
      defaultName: snapshot.filename,
      defaultPath: snapshot.filename,
      filters: SETTINGS_JSON_FILTERS,
    });
    if (!result || result.canceled) return;
    if (result.error) {
      console.warn('[settings:export] write failed:', result.error);
    }
  } catch (err) {
    console.warn('[settings:export] dialog.save failed:', err?.message || err);
  }
}

if (settingsExportBtnEl instanceof HTMLButtonElement) {
  settingsExportBtnEl.addEventListener('click', doExportSettings);
}

/* ── U21: Import settings from JSON ───────────────────────────────── */

/**
 * Render a one-row-per-block diff between the live settings and the
 * incoming import. Intentionally rough: per-block "Will be updated" /
 * "Unchanged", not a full JSON diff. The renderer's existing live-
 * apply means a fuller diff would mostly read as noise — what the
 * user really wants here is "is this the file I expected, or did I
 * pick the wrong one?".
 *
 * Top-level keys come from a fixed allowlist (the schema's six tabs
 * + the cross-cutting fields) so a third-party file with extra
 * properties doesn't pollute the diff. Schema-version-only changes
 * are surfaced as "Unchanged" because the migration is transparent.
 */
function renderImportDiff(incoming) {
  if (!(settingsImportDiffEl instanceof HTMLElement)) return;
  settingsImportDiffEl.replaceChildren();

  const current = settingsCache || {};
  // Order matches the tab order; `defaultProvider` + `models` live
  // alongside the providers block in the user's mental model.
  const blocks = [
    { key: 'defaultProvider', label: 'Default provider' },
    { key: 'providers', label: 'Providers' },
    { key: 'models', label: 'Models' },
    { key: 'audio', label: 'Audio' },
    { key: 'appearance', label: 'Appearance' },
    { key: 'coach', label: 'Coach' },
    { key: 'general', label: 'General' },
    { key: 'help', label: 'Help' },
  ];

  for (const { key, label } of blocks) {
    const row = document.createElement('div');
    row.className = 'settings-import__diff-row';
    const changed = JSON.stringify(current[key] ?? null) !== JSON.stringify(incoming[key] ?? null);
    row.classList.add(changed ? 'settings-import__diff-row--changed' : 'settings-import__diff-row--same');

    const k = document.createElement('span');
    k.className = 'settings-import__diff-key';
    k.textContent = label;
    row.appendChild(k);

    const v = document.createElement('span');
    v.className = 'settings-import__diff-summary';
    v.textContent = changed
      ? summariseBlockChange(key, current[key], incoming[key])
      : 'Unchanged';
    row.appendChild(v);

    settingsImportDiffEl.appendChild(row);
  }
}

/**
 * Build a short human-readable summary of what changed within one
 * top-level block. Just enough detail to give the user confidence the
 * file is the right one — not a full diff (importing IS a wholesale
 * replace, so "everything in this block will be replaced" is the
 * accurate-but-useless ground truth).
 */
function summariseBlockChange(key, current, incoming) {
  if (key === 'providers') {
    if (!incoming || typeof incoming !== 'object') return 'Will be cleared';
    const diffs = [];
    for (const provider of PROVIDER_IDS) {
      const before = current?.[provider] || {};
      const after = incoming?.[provider] || {};
      const keyChange = (before.apiKey || '') !== (after.apiKey || '');
      const modelChange = (before.defaultModel || '') !== (after.defaultModel || '');
      if (keyChange || modelChange) {
        const parts = [];
        if (keyChange) parts.push(after.apiKey ? 'key set' : 'key cleared');
        if (modelChange) parts.push(`model → ${after.defaultModel || '(default)'}`);
        diffs.push(`${provider} (${parts.join(', ')})`);
      }
    }
    return diffs.length > 0 ? diffs.join('; ') : 'Will be updated';
  }
  if (key === 'defaultProvider') {
    return `${current ?? '(none)'} → ${incoming ?? '(none)'}`;
  }
  if (key === 'appearance') {
    const cYou = current?.tagColors?.you;
    const iYou = incoming?.tagColors?.you;
    const cOther = current?.tagColors?.other;
    const iOther = incoming?.tagColors?.other;
    const parts = [];
    if (cYou !== iYou) parts.push(`you ${cYou} → ${iYou}`);
    if (cOther !== iOther) parts.push(`other ${cOther} → ${iOther}`);
    return parts.length > 0 ? parts.join(', ') : 'Will be updated';
  }
  if (key === 'coach') {
    const tracks = `track ${current?.trackQuestionState ? 'on' : 'off'} → ${incoming?.trackQuestionState ? 'on' : 'off'}`;
    const auto = `auto-reformulate ${current?.autoReformulate ? 'on' : 'off'} → ${incoming?.autoReformulate ? 'on' : 'off'}`;
    return `${tracks}; ${auto}`;
  }
  return 'Will be updated';
}

function openImportPreview({ source, error, incoming }) {
  if (!(settingsImportPreviewEl instanceof HTMLDialogElement)) return;
  if (settingsImportSourceEl instanceof HTMLElement) {
    if (source) {
      settingsImportSourceEl.textContent = `From: ${source}`;
      settingsImportSourceEl.hidden = false;
    } else {
      settingsImportSourceEl.hidden = true;
    }
  }
  if (settingsImportErrorEl instanceof HTMLElement) {
    if (error) {
      settingsImportErrorEl.textContent = error;
      settingsImportErrorEl.hidden = false;
    } else {
      settingsImportErrorEl.hidden = true;
    }
  }
  if (settingsImportApplyEl instanceof HTMLButtonElement) {
    // Hide Apply when the file is invalid — there's nothing safe to
    // commit. The user can still hit Cancel to dismiss.
    settingsImportApplyEl.hidden = Boolean(error);
  }
  if (incoming && !error) {
    renderImportDiff(incoming);
  } else if (settingsImportDiffEl instanceof HTMLElement) {
    settingsImportDiffEl.replaceChildren();
  }
  try {
    settingsImportPreviewEl.showModal();
  } catch (err) {
    console.warn('[settings:import] showModal failed:', err?.message || err);
  }
}

function closeImportPreview() {
  if (!(settingsImportPreviewEl instanceof HTMLDialogElement)) return;
  pendingImportJson = null;
  try {
    settingsImportPreviewEl.close();
  } catch { /* not open */ }
}

async function doStartImport() {
  let openResult;
  try {
    openResult = await window.gemini.dialog?.open?.({
      title: 'Import Two Way Flow settings',
      filters: SETTINGS_JSON_FILTERS,
      readAs: 'utf8',
    });
  } catch (err) {
    console.warn('[settings:import] dialog.open failed:', err?.message || err);
    return;
  }
  if (!openResult || openResult.canceled) return;
  if (openResult.error) {
    openImportPreview({
      source: openResult.filePath,
      error: `Couldn't read that file: ${openResult.error}`,
    });
    return;
  }
  if (typeof openResult.content !== 'string') {
    openImportPreview({
      source: openResult.filePath,
      error: 'File appears to be empty.',
    });
    return;
  }

  pendingImportJson = openResult.content;
  let validation;
  try {
    validation = await window.gemini.settings?.validateImport?.(openResult.content);
  } catch (err) {
    openImportPreview({
      source: openResult.filePath,
      error: `Validation failed: ${err?.message || 'unknown error'}`,
    });
    pendingImportJson = null;
    return;
  }
  if (!validation?.ok) {
    openImportPreview({
      source: openResult.filePath,
      error: validation?.error || 'Not a valid settings export.',
    });
    pendingImportJson = null;
    return;
  }
  openImportPreview({
    source: openResult.filePath,
    incoming: validation.normalised,
  });
}

async function doApplyImport() {
  if (typeof pendingImportJson !== 'string' || !pendingImportJson) {
    closeImportPreview();
    return;
  }
  try {
    const result = await window.gemini.settings?.applyImport?.(pendingImportJson);
    if (result?.ok && result.settings) {
      settingsCache = result.settings;
      applySettingsToForm(result.settings);
      applyTagColors(result.settings.appearance?.tagColors || {
        you: DEFAULT_TAG_YOU,
        other: DEFAULT_TAG_OTHER,
      });
    } else if (result && !result.ok) {
      // Surface inline — keep the preview open so the user sees why.
      openImportPreview({
        error: result.error || 'Import failed.',
      });
      return;
    }
  } catch (err) {
    console.warn('[settings:import] applyImport failed:', err?.message || err);
  } finally {
    closeImportPreview();
  }
}

if (settingsImportBtnEl instanceof HTMLButtonElement) {
  settingsImportBtnEl.addEventListener('click', doStartImport);
}
if (settingsImportCancelEl instanceof HTMLButtonElement) {
  settingsImportCancelEl.addEventListener('click', closeImportPreview);
}
if (settingsImportApplyEl instanceof HTMLButtonElement) {
  settingsImportApplyEl.addEventListener('click', doApplyImport);
}

/* ── User input ────────────────────────────────────────────────────── */

recToggleEl.addEventListener('click', () => {
  if (state.status === 'idle' || state.status === 'error') {
    startCapture();
  } else if (state.status === 'listening') {
    stopCapture();
  }
});

minButtonEl.addEventListener('click', () => {
  // Frameless window has no native chrome — drive the OS minimise via
  // IPC. The user can restore via (a) the menu-bar / system-tray
  // icon, (b) the macOS dock click, or (c) the Cmd/Ctrl+Shift+H
  // global shortcut. We deliberately don't pre-empt the call state
  // here (no auto-stopCapture) — a quick minimise during a live call
  // shouldn't tear down the session.
  window.gemini.window.minimize();
});

closeButtonEl.addEventListener('click', async () => {
  if (state.status === 'listening' || state.status === 'starting') {
    await stopCapture();
  }
  // Single-window overlay-tool semantics: closing the window fully
  // quits the app (main's `window-all-closed` handler is what
  // actually fires `app.quit()`). The IPC route is preferred over
  // the browser-side `window.close()` because the renderer doesn't
  // always have the privilege to close itself (depends on how the
  // window was instantiated), and IPC gives us a single observable
  // point where teardown ordering is enforced in main.
  await window.gemini.window.close();
});

/* ── Permission modal (Phase 4) ────────────────────────────────────── */

/**
 * Show the macOS Screen Recording explainer modal. Called when the
 * renderer's getDisplayMedia request fails (permission denied, no
 * sources available, etc.). The user can:
 *   - Grant access     → re-try getDisplayMedia (which may surface the
 *                        OS prompt, or no-op if already denied).
 *   - Open System Settings → deep link into the Privacy pane.
 *   - Continue with mic only → dismiss; the call already started with
 *                              just the mic chain.
 */
function showPermissionModal() {
  if (!permissionModalEl) return;
  try {
    permissionModalEl.showModal();
  } catch (err) {
    // Calling showModal() on an already-open dialog throws. Ignore.
    console.warn('[permission] showModal failed:', err?.message || err);
  }
}

function closePermissionModal() {
  if (!permissionModalEl) return;
  try {
    permissionModalEl.close();
  } catch { /* not open */ }
}

if (permissionRetryBtnEl) {
  permissionRetryBtnEl.addEventListener('click', async () => {
    closePermissionModal();
    // Retrying only makes sense while a call is being set up or
    // already running. Either way the user has just OK'd the
    // explainer and presumably granted the perm. We try once; if it
    // still fails the user can re-open the modal on the next Start.
    if (state.status !== 'listening' && state.status !== 'starting') {
      console.warn('[permission] grant-access clicked while idle; nothing to retry');
      return;
    }
    const sysStream = await tryOpenSystemAudioStream();
    if (!sysStream || !state.audioContext) {
      state.systemAudioStatus = 'denied';
      showPermissionModal();
      return;
    }
    // Attach the new sys chain to the live AudioContext.
    state.sys = buildCaptureChain({
      stream: sysStream,
      audioContext: state.audioContext,
      sendChunk: (chunk) => window.gemini.sendSystemAudio(chunk),
    });
    state.systemAudioStatus = 'capturing';
    console.log('[permission] system audio capture started after manual grant');
  });
}

if (permissionContinueBtnEl) {
  permissionContinueBtnEl.addEventListener('click', () => {
    state.systemAudioStatus = 'mic-only';
    closePermissionModal();
  });
}

if (permissionOpenSettingsBtnEl) {
  permissionOpenSettingsBtnEl.addEventListener('click', async () => {
    try {
      await window.gemini.openScreenRecordingSettings?.();
    } catch (err) {
      console.warn('[permission] failed to open settings:', err?.message || err);
    }
  });
}

/* ── Summary modal (Phase 5) ───────────────────────────────────────── */

function showSummaryModal() {
  if (!summaryModalEl) return;
  try {
    summaryModalEl.showModal();
  } catch (err) {
    console.warn('[summary] showModal failed:', err?.message || err);
  }
}

function closeSummaryModal() {
  if (!summaryModalEl) return;
  try {
    summaryModalEl.close();
  } catch { /* not open */ }
}

function selectSummaryTab(tab) {
  if (!summaryPanelEls[tab]) return;
  state.summary.activeTab = tab;
  for (const btn of summaryTabEls) {
    const isActive = btn.dataset.tab === tab;
    btn.dataset.active = String(isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }
  for (const [key, panel] of Object.entries(summaryPanelEls)) {
    panel.dataset.active = String(key === tab);
    panel.hidden = key !== tab;
  }
}

/**
 * Populate the summary modal panels from a `summary:ready` payload.
 * The payload shape matches what src/summary.js's generateSummary()
 * returns: { scorecard, factsTable, transcript, debrief, durationMs,
 * asJSON, asMarkdown }.
 */
function renderSummaryModal(payload) {
  if (!payload) return;
  state.summary.payload = payload;

  // Duration badge in the header.
  if (summaryDurationEl) {
    if (payload.durationMs > 0) {
      summaryDurationEl.hidden = false;
      summaryDurationEl.textContent = formatTimer(payload.durationMs);
    } else {
      summaryDurationEl.hidden = true;
    }
  }

  renderSummaryScorecard(payload.scorecard || {});
  renderSummaryFacts(payload.factsTable || {});
  renderSummaryTranscript(payload.transcript || '');
  renderSummaryDebrief(payload.debrief || {});

  // Default to the scorecard tab whenever we surface a new payload —
  // we want the user to see the top-line outcome first.
  selectSummaryTab('scorecard');
}

function renderSummaryScorecard(scorecard) {
  const panel = summaryPanelEls.scorecard;
  if (!panel) return;
  const rows = Object.values(scorecard);
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'summary-panel__empty';
    empty.textContent = 'No scorecard available.';
    panel.replaceChildren(empty);
    return;
  }

  const children = [];
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'scorecard__row';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'scorecard__name';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'scorecard__name-label';
    nameLabel.textContent = row.name;
    nameWrap.appendChild(nameLabel);

    const meta = document.createElement('span');
    meta.className = 'scorecard__name-meta';
    meta.textContent = `${row.covered}/${row.total} covered · ${row.inProgress} in progress · ${row.logged} logged`;
    nameWrap.appendChild(meta);

    rowEl.appendChild(nameWrap);

    const barWrap = document.createElement('div');
    barWrap.className = 'scorecard__bar';

    const track = document.createElement('div');
    track.className = 'scorecard__bar-track';
    const fill = document.createElement('div');
    fill.className = 'scorecard__bar-fill';
    fill.style.setProperty('--pct', String(Math.max(0, Math.min(1, (row.percent || 0) / 100))));
    track.appendChild(fill);
    barWrap.appendChild(track);

    const pct = document.createElement('span');
    pct.className = 'scorecard__bar-pct';
    pct.textContent = `${row.percent || 0}%`;
    barWrap.appendChild(pct);

    rowEl.appendChild(barWrap);
    children.push(rowEl);
  }
  panel.replaceChildren(...children);
}

function renderSummaryFacts(factsTable) {
  const panel = summaryPanelEls.facts;
  if (!panel) return;
  const groupNames = Object.keys(factsTable);
  if (groupNames.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'summary-panel__empty';
    empty.textContent = 'No facts were captured during this call.';
    panel.replaceChildren(empty);
    return;
  }

  const children = [];
  for (const groupName of groupNames) {
    const group = factsTable[groupName];
    const section = document.createElement('section');
    section.className = 'facts-group';

    const heading = document.createElement('h3');
    heading.className = 'facts-group__heading';
    heading.textContent = group.name;
    section.appendChild(heading);

    for (const field of group.fields) {
      const row = document.createElement('div');
      row.className = 'facts-row';

      const label = document.createElement('span');
      label.className = 'facts-row__label';
      label.textContent = field.label;
      row.appendChild(label);

      const value = document.createElement('span');
      value.className = 'facts-row__value';
      value.textContent = field.value;
      row.appendChild(value);

      section.appendChild(row);
    }
    children.push(section);
  }
  panel.replaceChildren(...children);
}

function renderSummaryTranscript(transcript) {
  const panel = summaryPanelEls.transcript;
  if (!panel) return;
  if (!transcript) {
    const empty = document.createElement('p');
    empty.className = 'summary-panel__empty';
    empty.textContent = 'No transcript was captured.';
    panel.replaceChildren(empty);
    return;
  }

  const children = [];
  // The transcript string from summary.js is "Speaker: text" per line,
  // with the prefixes "You: " / "Prospect: " (mandated by the
  // pendingTranscriptBySpeaker commit path in main.js). Parse it back
  // into typed lines so we can colour the prefix without re-baking it.
  const lines = transcript.split('\n');
  for (const raw of lines) {
    if (!raw) continue;
    let speaker = null;
    let text = raw;
    if (raw.startsWith('You: ')) {
      speaker = 'you';
      text = raw.slice('You: '.length);
    } else if (raw.startsWith('Prospect: ')) {
      speaker = 'other';
      text = raw.slice('Prospect: '.length);
    }
    const p = document.createElement('p');
    p.className = 'summary-transcript__line';
    if (speaker) p.dataset.speaker = speaker;
    p.textContent = text;
    children.push(p);
  }
  panel.replaceChildren(...children);
}

function renderSummaryDebrief(debrief) {
  const panel = summaryPanelEls.debrief;
  if (!panel) return;

  const wentWell = debrief.wentWell || '';
  const missed = debrief.missed || '';
  const improvements = (debrief.improvements || []).filter(Boolean);

  if (!wentWell && !missed && improvements.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'summary-panel__empty';
    empty.textContent = 'Debrief unavailable.';
    panel.replaceChildren(empty);
    return;
  }

  const children = [];

  if (wentWell) {
    const sec = document.createElement('section');
    sec.className = 'debrief__section';
    const h = document.createElement('h3');
    h.className = 'debrief__heading';
    h.textContent = 'What went well';
    const p = document.createElement('p');
    p.className = 'debrief__text';
    p.textContent = wentWell;
    sec.appendChild(h);
    sec.appendChild(p);
    children.push(sec);
  }

  if (missed) {
    const sec = document.createElement('section');
    sec.className = 'debrief__section';
    const h = document.createElement('h3');
    h.className = 'debrief__heading';
    h.textContent = 'What was missed';
    const p = document.createElement('p');
    p.className = 'debrief__text';
    p.textContent = missed;
    sec.appendChild(h);
    sec.appendChild(p);
    children.push(sec);
  }

  if (improvements.length > 0) {
    const sec = document.createElement('section');
    sec.className = 'debrief__section';
    const h = document.createElement('h3');
    h.className = 'debrief__heading';
    h.textContent = 'Top 3 improvements';
    const ul = document.createElement('ul');
    ul.className = 'debrief__list';
    for (const imp of improvements) {
      const li = document.createElement('li');
      li.textContent = imp;
      ul.appendChild(li);
    }
    sec.appendChild(h);
    sec.appendChild(ul);
    children.push(sec);
  }

  panel.replaceChildren(...children);
}

function flashSummaryToast(message) {
  if (!summaryToastEl) return;
  summaryToastEl.textContent = message;
  summaryToastEl.hidden = false;
  // Auto-clear after a few seconds so the footer doesn't keep yelling
  // "Copied!" forever.
  clearTimeout(flashSummaryToast._timer);
  flashSummaryToast._timer = setTimeout(() => {
    summaryToastEl.hidden = true;
    summaryToastEl.textContent = '';
  }, 2500);
}

/**
 * Copy a string to the OS clipboard. Tries Electron's native
 * clipboard module first (via the `clipboard:write` IPC) because
 * it bypasses the renderer's permission system entirely — the
 * browser API was previously blocked by main.js's permission
 * handler, causing the Copy buttons to silently fail with a
 * "Copy failed" toast.
 *
 * Falls back to `navigator.clipboard.writeText` if the IPC bridge
 * is missing (e.g. an old preload before this feature shipped) so
 * the code is forward-compatible. Returns `true` on success, `false`
 * on failure (which lights up the "Copy failed" toast).
 */
async function copyToClipboard(text) {
  if (typeof text !== 'string' || text.length === 0) return false;

  const native = window.gemini?.clipboard?.writeText;
  if (typeof native === 'function') {
    try {
      const result = await native(text);
      if (result?.ok) return true;
      console.warn('[summary] native clipboard write failed:', result?.error);
    } catch (err) {
      console.warn('[summary] native clipboard IPC threw:', err?.message || err);
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn('[summary] clipboard fallback failed:', err?.message || err);
    return false;
  }
}

for (const btn of summaryTabEls) {
  btn.addEventListener('click', () => selectSummaryTab(btn.dataset.tab));
}

if (summaryCopyJsonEl) {
  summaryCopyJsonEl.addEventListener('click', async () => {
    const payload = state.summary.payload;
    if (!payload?.asJSON) return;
    const ok = await copyToClipboard(payload.asJSON);
    flashSummaryToast(ok ? 'JSON copied to clipboard.' : 'Copy failed.');
  });
}

if (summaryCopyMdEl) {
  summaryCopyMdEl.addEventListener('click', async () => {
    const payload = state.summary.payload;
    if (!payload?.asMarkdown) return;
    const ok = await copyToClipboard(payload.asMarkdown);
    flashSummaryToast(ok ? 'Markdown copied to clipboard.' : 'Copy failed.');
  });
}

if (summarySaveEl) {
  summarySaveEl.addEventListener('click', async () => {
    const payload = state.summary.payload;
    if (!payload) return;
    // Default to Markdown — it's the friendlier export for sharing.
    const result = await window.gemini.saveSummary?.({
      format: 'markdown',
      content: payload.asMarkdown,
    });
    if (result?.ok) {
      flashSummaryToast('Saved.');
    } else if (result?.error === 'cancelled') {
      // No-op; user dismissed the dialog.
    } else if (result?.error) {
      flashSummaryToast(`Save failed: ${result.error}`);
    }
  });
}

if (summaryCloseEl) summaryCloseEl.addEventListener('click', closeSummaryModal);
if (summaryCloseXEl) summaryCloseXEl.addEventListener('click', closeSummaryModal);

// Click on the rail overlay's backdrop (i.e. anywhere outside the
// panel) closes the overlay. The panel itself doesn't propagate clicks
// because they hit the panel's children — but we still defensively
// check that the click landed on the overlay root, not the panel.
railOverlayEl.addEventListener('click', (e) => {
  if (e.target === railOverlayEl) {
    closePillarOverlay();
  }
});

document.addEventListener('keydown', (e) => {
  // Don't interfere with typing into any future inputs.
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

  // Don't interfere with modal dialogs — the native <dialog> element
  // handles Esc itself, and we don't want Enter to accidentally fire
  // Start while a modal is open.
  if (permissionModalEl?.open || summaryModalEl?.open || settingsModalEl?.open) return;

  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    recToggleEl.click();
    return;
  }
  if (e.key === 'Escape') {
    if (state.activePillarId !== null) {
      e.preventDefault();
      closePillarOverlay();
    }
    return;
  }

  // Coach history navigation. ← walks back through previous suggestions;
  // → walks forward, or asks the coach for a fresh one at the live edge.
  if (e.key === 'ArrowLeft') {
    if (state.coachIndex > 0) {
      e.preventDefault();
      state.coachIndex -= 1;
      renderCoachSuggestion();
    }
    return;
  }
  if (e.key === 'ArrowRight') {
    if (state.coachIndex < state.coachHistory.length - 1) {
      e.preventDefault();
      state.coachIndex += 1;
      renderCoachSuggestion();
    } else if (state.coachHistory.length > 0) {
      e.preventDefault();
      // At the live edge — route through the same advance logic as
      // the inline Skip pill so cover-queue cycling stays consistent
      // across the two skip paths.
      if (state.coverQueue) {
        advanceCoverQueue();
      } else {
        // Ask the coach for a fresh suggestion. The new suggestion
        // arrives asynchronously via onCoachSuggestion.
        window.gemini.skipCoachSuggestion?.();
      }
    }
    return;
  }
});

window.addEventListener('beforeunload', () => {
  if (state.status === 'listening' || state.status === 'starting') {
    stopCapture();
  }
});

/* ── Initial render ─────────────────────────────────────────────────── */

// Apply the persisted coach mode to the toggle UI on startup. We
// don't notify main yet — main has its own default ('signalled') and
// will pick up the persisted value when the rep hits Start (see
// startCapture → setCoachMode). Notifying earlier risks a race with
// session teardown when reloading during dev.
applyCoachMode(state.coachMode, { persist: false, notifyMain: false });

renderTimer();
renderSpeakers();
renderRail();
renderRailOverlay();
renderCaptured();
renderQuickFix();
renderTranscriptPane();
renderCoachSuggestion();
renderCoachThinking();
renderConnectionStatus();
// Badge starts in "unknown" — the mic-capture path will flip it to
// "on" / "off" the moment getUserMedia hands back a stream.
setAecBadgeState('unknown');

// Build-version pill (one-shot). Fired here, alongside the other
// initial-render calls, so the user sees the running build's SHA
// from the first frame. See applyVersionBadge() for the format +
// dirty-state semantics; main's computeAppVersion() doc-block for
// the dev-vs-packaged read decision.
applyInitialVersionBadge();

// Eagerly load persisted settings at boot so the user's custom
// speaker-label tag colours are in effect from the first frame (the
// :root CSS defaults cover the "no persisted value yet" case so
// there's no flash even on the slow path). `ensureSettingsLoaded`
// is idempotent — the same cache feeds the modal's lazy open path
// without a second IPC roundtrip.
ensureSettingsLoaded();
