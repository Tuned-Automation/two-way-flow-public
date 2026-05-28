import dotenv from 'dotenv';
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import started from 'electron-squirrel-startup';

/* ────────────────────────────────────────────────────────────────────
 * .env discovery — dev vs packaged
 *
 * In `npm start` dev mode the process cwd IS the project folder, so a
 * bare `dotenv.config()` finds `.env` there. In a packaged macOS .app
 * the cwd is `/` (Launchpad / Spotlight launches from root), so the
 * same call silently no-ops and the GEMINI_API_KEY / DEEPGRAM_API_KEY
 * env-var fallback in settings.js's getApiKey() never resolves —
 * which surfaces as "Missing Gemini API key" in the renderer toast.
 *
 * Fix: try multiple paths, in priority order:
 *   1. cwd (`process.cwd()/.env`)               — dev workflow
 *   2. resourcesPath (`Contents/Resources/.env`) — packaged build
 *      (the file is bundled via forge.config.js's `extraResource`;
 *      see the comment there for the bundling decision + the personal-
 *      use security implication)
 *   3. userData (`<userData>/.env`)              — user-supplied
 *      override that survives reinstalls and doesn't require rebuild;
 *      handy for adding ANTHROPIC_API_KEY / OPENAI_API_KEY without a
 *      Settings → Providers UI write
 *
 * `override: false` (after the cwd load) means a value already set by
 * dev mode wins over a stale packaged value. This matters because
 * `extraResource` bakes WHATEVER .env existed at build time into the
 * bundle, and we want a developer iterating on a fresh .env in cwd to
 * still see their latest values after `npm run make`.
 *
 * userData is queried inside a try/catch because `app.getPath` can be
 * unsafe to call before the Electron `app` is ready on some versions —
 * Electron 42 is fine pre-ready but the guard costs nothing.
 * ──────────────────────────────────────────────────────────────────── */
dotenv.config();
function loadPackagedEnv() {
  /** @type {string[]} */
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, '.env'));
  }
  try {
    candidates.push(path.join(app.getPath('userData'), '.env'));
  } catch {
    // app not ready yet — userData candidate gets retried after whenReady
  }
  for (const p of candidates) {
    dotenv.config({ path: p, override: false });
  }
}
loadPackagedEnv();

/* ────────────────────────────────────────────────────────────────────
 * Version-badge metadata — git-aware build identifier
 *
 * The renderer surfaces a tiny "v1.0.0 · 89f97a8" pill in the header
 * via the `app:version` IPC channel (see registerIpcHandlers below).
 * The pill exists because a user can easily end up running an old
 * packaged build alongside an `npm start` dev window and not notice
 * that their latest fixes aren't loaded — the SHA + dirty-flag give
 * an at-a-glance answer to "is this the build I just rebuilt?".
 *
 * Two read paths, chosen by `app.isPackaged`:
 *
 *   - DEV (`npm start`)         — runtime `git rev-parse` + `git
 *                                 status --porcelain`. This tracks
 *                                 working-tree state across commits
 *                                 without a Vite restart, so the
 *                                 badge stays fresh as the user
 *                                 iterates. The `.git` dir is
 *                                 guaranteed to be reachable
 *                                 (process started from the repo).
 *
 *   - PACKAGED (.app bundle)    — Vite-injected compile-time
 *                                 constants (__APP_GIT_SHA__,
 *                                 __APP_GIT_DIRTY__,
 *                                 __APP_BUILT_AT__) from
 *                                 vite.main.config.mjs. The
 *                                 packaged bundle has no `.git`
 *                                 directory and Spotlight launches
 *                                 cwd from `/`, so a runtime `git`
 *                                 call would always fail.
 *
 * Both paths fall back gracefully: a missing or unreadable git
 * binary downgrades the badge to "v1.0.0" with no SHA, rather than
 * crashing the app at startup. The dirty-flag distinguishes "your
 * saved file edits won't be in this running window unless you
 * restart npm start" from "this is exactly the committed HEAD" —
 * the renderer paints the pill amber in the dirty state so the
 * mismatch is impossible to miss.
 *
 * IPC channel:
 *   renderer → main: ipcRenderer.invoke('app:version')
 *   returns:         { pkgVersion, gitSha, gitDirty, builtAt }
 *
 * The value is computed once and cached for the process lifetime
 * because none of the inputs can change without a restart (Vite
 * defines bake at build start; the runtime git read captures the
 * working-tree state at process boot).
 * ──────────────────────────────────────────────────────────────────── */

// `__APP_GIT_SHA__`, `__APP_GIT_DIRTY__`, `__APP_BUILT_AT__` below
// are NOT declared as local bindings — esbuild's `define` (configured
// in vite.main.config.mjs) only substitutes UNBOUND identifier
// references, so any local `var __APP_GIT_SHA__` here would shadow
// the define and silently leave the constant as `undefined` at
// runtime. The references are intentionally undeclared globals; the
// `typeof X !== 'undefined'` guard makes them safe to read outside a
// Vite build (where the substitution doesn't run). See the long
// block-comment above for the full read-path decision.
/* global __APP_GIT_SHA__, __APP_GIT_DIRTY__, __APP_BUILT_AT__ */

/** @type {{ pkgVersion: string, gitSha: string, gitDirty: boolean, builtAt: number } | null} */
let APP_VERSION = null;

/**
 * Read package.json's "version" field. Uses readFileSync (rather than
 * a top-level `import pkg from '../package.json'`) so the Vite-
 * bundled main process doesn't have to ship the entire package.json
 * as inline JSON. In dev mode the file is read from the project
 * root; in packaged mode it's read from the asar root via
 * app.getAppPath().
 *
 * Falls back to '0.0.0' if the file is unreadable — should never
 * happen in practice, but a crash here would block startup before
 * the BrowserWindow ever opens.
 */
function readPkgVersion() {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolve the full version metadata once, lazily, the first time the
 * IPC handler is invoked. Cached on the module-level `APP_VERSION` so
 * subsequent calls are free. See the block-comment above for the
 * dev-vs-packaged read-path decision.
 *
 * `stdio: ['ignore', 'pipe', 'ignore']` silences git's stderr (which
 * would otherwise spam the dev console with "fatal: not a git
 * repository" on a fresh checkout pulled from a tarball).
 */
function computeAppVersion() {
  if (APP_VERSION) return APP_VERSION;

  const pkgVersion = readPkgVersion();
  let gitSha = '';
  let gitDirty = false;
  let builtAt = Date.now();

  // Vite-injected fallbacks (always present in built artefacts).
  const injectedSha =
    typeof __APP_GIT_SHA__ !== 'undefined' && typeof __APP_GIT_SHA__ === 'string'
      ? __APP_GIT_SHA__
      : '';
  const injectedDirty =
    typeof __APP_GIT_DIRTY__ !== 'undefined' && typeof __APP_GIT_DIRTY__ === 'boolean'
      ? __APP_GIT_DIRTY__
      : false;
  const injectedBuiltAt =
    typeof __APP_BUILT_AT__ !== 'undefined' && typeof __APP_BUILT_AT__ === 'number'
      ? __APP_BUILT_AT__
      : 0;

  if (app.isPackaged) {
    // Packaged builds can't shell out to git — the bundle ships
    // without a `.git` directory. Use the values baked in at
    // vite.main.config.mjs build time.
    gitSha = injectedSha;
    gitDirty = injectedDirty;
    builtAt = injectedBuiltAt || builtAt;
  } else {
    // Dev mode: re-read git at runtime so a fresh commit between
    // Vite-build and the IPC call shows up in the badge without a
    // `npm start` restart. The cwd is app.getAppPath() (= project
    // root in dev) so `git` walks up from a sensible anchor even
    // if Electron was launched with a different cwd.
    const cwd = app.getAppPath();
    try {
      gitSha = execSync('git rev-parse --short HEAD', {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      gitSha = injectedSha;
    }
    try {
      gitDirty =
        execSync('git status --porcelain', {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim().length > 0;
    } catch {
      gitDirty = injectedDirty;
    }
    // In dev, "built at" effectively means "when this Electron
    // process started" — close enough to "how old is the running
    // window" that the renderer can render a humanised "5m ago"
    // string. The Vite-injected value (build start) and Date.now()
    // (module load) are within ms of each other on `npm start`.
    builtAt = injectedBuiltAt || builtAt;
  }

  APP_VERSION = { pkgVersion, gitSha, gitDirty, builtAt };
  return APP_VERSION;
}

import { GeminiSession } from './gemini-session.js';
import { DeepgramSession } from './deepgram-session.js';
import { Coach } from './coach.js';
import { generateSummary } from './summary.js';
import { createQuickFixRoller } from './quick-fix.js';
import { createFactsScanner } from './facts-scanner.js';
import {
  loadSettings,
  saveSettings,
  resetSettings,
  exportSettingsAsJSON,
  validateImportedSettings,
  applyImportedSettings,
  getApiKey,
  getModelFor,
  getDefaultProvider,
  getDefaultModelForProvider,
  getProviderStatus,
  getProviderEnvAvailability,
  getCoach,
  getAudio,
  getFactsScanner,
} from './settings.js';
import { getProvider } from './providers/index.js';
import * as rubricStore from './rubric-store.js';
import { reloadActiveRubric } from './rubric.js';
import { DEFAULT_RUBRIC } from './rubric-defaults.js';

if (started) {
  app.quit();
}

// Single-instance lock: a second `npm start` (or running build) should focus
// the existing overlay instead of opening another window on top of it.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

/* ── Chromium command-line switches ────────────────────────────────────
 *
 * MUST be set before app.whenReady() resolves. After that point the
 * command-line argv has already been parsed by the renderer process(es)
 * and these will be silently ignored.
 *
 * Why these matter:
 *   - WebRtcEchoCanceller3 is Chromium's modern (AEC3) echo canceller.
 *     It's the default in current Chromium but old/embedded versions
 *     may fall back to AEC2 or disable AEC entirely depending on
 *     platform heuristics. We force-enable AEC3 because our use case
 *     (speakerphone → mic loopback during a discovery call) is
 *     exactly what AEC3 is engineered for.
 *   - The WebRTC field-trial pin is belt-and-braces: even when the
 *     feature flag is on, the field-trial layer can override per
 *     experiment cohort. Pinning the trial to /Enabled/ makes the
 *     canceller deterministic regardless of cohort.
 *
 * No effect on the system-audio loopback (getDisplayMedia path) —
 * those tracks bypass AEC by design because they're already clean
 * isolated sources.
 *
 * Phase 2 interaction with settings.audio.aec:
 *   The renderer's startCapture() reads `settings.audio.aec` and
 *   passes `echoCancellation: { ideal: <value> }` to getUserMedia.
 *   These switches sit ABOVE that constraint — when AEC3 is force-
 *   enabled here, Chromium may still honour the renderer's
 *   `echoCancellation: false` on a per-track basis, but on some
 *   platforms the switches override and AEC stays on. The Audio
 *   tab's AEC toggle sub-text surfaces this caveat to the user.
 *   To make the user's "AEC off" setting authoritative, this block
 *   would need to read settings.audio.aec at app boot and skip the
 *   switches when false — achievable, but the read has to happen
 *   before app.whenReady() resolves, which means hoisting
 *   loadSettings() ahead of all the other imports. Out of Phase 2
 *   scope; tracked as a future improvement.
 */
app.commandLine.appendSwitch('enable-features', 'WebRtcEchoCanceller3');
app.commandLine.appendSwitch(
  'force-fieldtrials',
  'WebRTC-Audio-EchoCanceller3/Enabled/',
);

/* Floating-overlay window geometry.
 *
 * The original 720×440 default was too tight for the v1.1.0 header — the
 * accumulated row of pills (You / Other / AEC / Connection / Version) +
 * the right-side controls (gear, Signalled|Automated mode toggle, Start,
 * minimise, close) requires ~950px of header content width once the
 * grid-template-columns:1fr auto 1fr forces both 1fr tracks to match
 * the controls cluster. At 720px the Start button was clipped to "St"
 * and the captured pane on the right rendered with its edge cropped.
 *
 * WINDOW_MIN_* is a soft floor — `resizable: true` lets the user pull
 * the overlay smaller for narrow displays, but Chromium will refuse to
 * go below the min so the header layout never collapses entirely. The
 * outer .coach card carries the visible drop-shadow via box-shadow, so
 * the window dimensions include 20-28px of transparent gutter for the
 * shadow to render into (see .coach { margin } in src/index.css). */
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 520;
/* WINDOW_MIN_WIDTH must remain >= rail(60) + transcript_floor(360) +
 * captured_min(160) + 2 × col-splitter(4) + body horizontal padding (~0).
 * Inner pane clamps live in src/renderer.js — see mountSplitter() and
 * the .coach__body grid-template-columns rule in src/index.css. If you
 * drop this below ~600 the captured-pane container queries collapse
 * to the single-column branch and the row of ask buttons starts
 * hiding labels — see the reflow rules in
 * /Users/taylor/.cursor/plans/resizable_internal_panes_4bf4f174.plan.md
 * (sections D1/D2). The plan keeps 960 as the floor so the header
 * pill cluster (You / Other / AEC / Connection / Version) doesn't
 * collapse either. */
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 440;
const EDGE_MARGIN = 20;

/**
 * Single in-flight Gemini Live session + its sibling text-coach session
 * + the Deepgram dual-channel STT session. The overlay only ever
 * captures from one mic at a time, so we keep them all as module-level
 * singletons instead of per-window state.
 *
 * Extension point: when adding multi-call support, key these by
 * webContents.id and route IPC events back to the correct sender.
 */
let liveSession = null;
let coachSession = null;
let deepgramSession = null;
let mainWindowRef = null;
/**
 * Secondary BrowserWindow used by the Appearance tab's transparency
 * preview. Lazy-created the first time the user clicks "Open preview"
 * (appearance:open-preview IPC); destroyed on appearance:close-preview
 * or when the main window closes. See createPreviewWindow() below for
 * the WebPreferences contract — it re-uses the same preload bridge as
 * the main window so window.api.settings.onChanged is available in
 * the preview renderer for the live-update path.
 */
let previewWindowRef = null;
let sessionStartedAt = 0;

/**
 * Stage-2 quick-fix roller (post-test-call fixes batch 2 / Issue 3).
 *
 * Eagerly constructed at `gemini:start` time alongside the Stage-1
 * scanner (see the facts-scanner setup block). Earlier iterations
 * built the roller lazily on the first model-fired `record_meeting_fact`,
 * but that path no longer exists — the Stage-1 scanner owns fact
 * extraction now and the roller has to be alive from the moment the
 * scanner's first tick could land. Eager construction also lets the
 * roller's monotonic baseline (`lastAcceptedHeadline`) reset cleanly
 * with the session lifecycle.
 *
 * Cleared in teardownSession after `cancelPendingRollup()` so a
 * stale roller from a previous session can't fire against a fresh
 * coachContext.factsSheet.
 */
let quickFixRoller = null;

/**
 * Stage-1 facts scanner (post-test-call fixes batch 2 / Issue 3).
 *
 * Eagerly constructed in `gemini:start` once a session is open
 * (unlike the lazy `quickFixRoller`, which only materialised on the
 * first model-fired meeting fact). The scanner runs on its own
 * periodic interval and needs to be alive from the start of the
 * call so it can stay caught up to the rolling transcript.
 *
 * Lifecycle:
 *   - constructed + `start()` in `gemini:start` after the live
 *     sessions open. Skipped silently when `settings.factsScanner
 *     .enabled` is false (a manual kill-switch for testing).
 *   - `stop()` + cleared in `teardownSession()` so a fresh
 *     `gemini:start` rebuilds with the latest settings.
 */
let factsScanner = null;

/**
 * Read-cursor into `coachContext.transcriptLines` for the facts
 * scanner. Each scanner tick consumes everything from the cursor
 * onward and then advances the cursor to the new tail.
 *
 * Stored as a length count (not an index into a snapshot) so that
 * any in-place mutation of `transcriptLines` (e.g. the
 * cross-channel dedup splicing out a YOU line in favour of a
 * PROSPECT one) doesn't cause us to skip or re-feed lines —
 * `findAndRemoveMatchingLine` modifies the array but leaves all
 * unaffected entries in place, and a length-based cursor naturally
 * recovers.
 *
 * Reset to 0 by `resetCoachContext` on every fresh session.
 */
let factsScannerCursor = 0;

/**
 * Module-level reference to the menu-bar / system-tray icon. Held here
 * (rather than scoped inside whenReady()) for two reasons:
 *
 *   1. Tray on macOS/Linux is garbage-collected if it falls out of
 *      scope, which silently removes the icon a few seconds after
 *      launch. Keeping a strong reference at module top is the
 *      idiomatic workaround.
 *   2. `before-quit` needs to explicitly `destroy()` it on Windows
 *      so the icon isn't left in the notification area until the
 *      next hover.
 *
 * Constructed once in `createTray()` during `app.whenReady()`. Never
 * re-created — the same Tray persists for the app's lifetime even if
 * the BrowserWindow is closed and re-opened.
 */
let tray = null;

let deepgramReconnectAttempts = 0;
const MAX_DEEPGRAM_RECONNECTS = 3;

/* ── Gemini Live reconnect plumbing (E3) ────────────────────────────
 *
 * Mirrors the Deepgram reconnect pattern above. Gemini Live's job in
 * this app is flag detection (record_flag → live_signals pillar) plus
 * fallback transcription when Deepgram is unavailable. Flag detection
 * is the only capability Deepgram doesn't cover, so when the Live
 * WebSocket drops we attempt a small number of reconnects before
 * giving up — without reconnect, the rest of the call has no live
 * flag detection (which is the UX symptom of the 36-minute drop in
 * the test call).
 *
 * The Live drop is NOT fatal to the call: E2's decoupling in the
 * renderer keeps the call going on Deepgram alone. The reconnect is
 * a "try to recover flag detection" attempt, not a "keep the call
 * alive" attempt.
 *
 * Cap of 3 attempts × 2 s backoff is intentionally identical to the
 * Deepgram reconnect — same UX expectation ("a few seconds of
 * degraded signals, then either back or definitively down"). No
 * history replay on reconnect; the live model rebuilds state from
 * the next few seconds of audio.
 */
let geminiReconnectAttempts = 0;
const MAX_GEMINI_RECONNECTS = 3;

/* ── Connection-status state (E4 / E5) ──────────────────────────────
 *
 * Mirror of the upstream transport health, broadcast to the renderer
 * via the connection:status IPC. Each lifecycle handler
 * (open / close / reconnect-start / reconnect-success / give-up)
 * mutates the matching slot and calls broadcastConnectionStatus,
 * which fires the IPC with the full snapshot. The renderer rolls the
 * two slots up into one worst-of pill.
 *
 * State values
 *   deepgram   — 'connected' | 'reconnecting' | 'down'
 *   geminiLive — 'connected' | 'reconnecting' | 'down' | 'closed'
 *                The 'closed' value is Gemini-Live-specific
 *                soft-degrade: Deepgram is still canonical so the
 *                call continues, but flag detection is unavailable
 *                until reconnect succeeds.
 *
 * Reset to 'down' on every fresh session start (so a previous
 * session's status doesn't leak into the new call's pill).
 */
const connectionState = {
  /** @type {'connected'|'reconnecting'|'down'} */
  deepgram: 'down',
  /** @type {'connected'|'reconnecting'|'down'|'closed'} */
  geminiLive: 'down',
};

/**
 * Rolling state the coach reads each tick. Lives in main (not the
 * renderer) so the coach has zero-IPC access to it. The renderer mirrors
 * the same scoring state via `scoring:item-state` / `scoring:field`
 * events, but main is the source of truth for the coach's context.
 *
 * Reset on every `gemini:start` so a fresh call doesn't inherit stale
 * coverage.
 */
const coachContext = {
  /** @type {string[]} Committed turns prefixed with "You: " or "Prospect: ", oldest first. */
  transcriptLines: [],

  /**
   * Current in-flight partials, keyed by speaker. With Deepgram active
   * (Phase 4) both channels can have a partial in flight simultaneously
   * — one for the salesperson mic, one for the system-audio loopback —
   * so we can't share a single buffer.
   *
   * Each partial is REPLACED (not appended) on every interim message
   * because Deepgram's interim_results give us the full current segment
   * text each time. On `finished=true` the partial is committed to
   * `transcriptLines` with the correct speaker prefix and the buffer
   * is reset.
   *
   * When Deepgram isn't running (no API key), the legacy Gemini
   * inputTranscription path normalises into this same buffer under the
   * `you` key — see handleGeminiTranscript() for the accumulation path.
   *
   * @type {{ you: string, other: string }}
   */
  pendingTranscriptBySpeaker: { you: '', other: '' },

  /**
   * Per-speaker timestamp of the MOST RECENT interim that landed
   * non-empty text in the slot (post-test-call fixes batch 2 / Issue
   * 1 — stale-pending watchdog).
   *
   * The bug being prevented:
   *   Deepgram's `finished` event maps to `speech_final=true`, not
   *   `is_final=true` (see src/deepgram-session.js). If Deepgram
   *   never fires `speech_final` for a segment (network blip, AEC
   *   misfire, conservative VAD), the pending text stays in the slot
   *   until the NEXT segment's first interim arrives — at which
   *   point `pendingTranscriptBySpeaker[speaker] = text` SILENTLY
   *   OVERWRITES it. The text the rep saw greyed in the transcript
   *   pane never makes it to transcriptLines (or to the saved
   *   transcript / downstream coach + scanner).
   *
   * Two defences run in parallel:
   *   1. Rotation guard in handleDeepgramTranscript: when a new
   *      interim is NOT a prefix-extension of the existing pending,
   *      force-commit the old text BEFORE replacing.
   *   2. Periodic watchdog (`maybeForceCommitStalePending`): if a
   *      pending has been sitting unchanged for > STALE_PENDING_MS
   *      with no new interim, force-commit it.
   *
   * Semantics: this is "time since the most recent interim", NOT
   * "time since the segment started". A slowly-but-actively-growing
   * segment with frequent Deepgram interim refreshes never hits the
   * threshold because every extending interim re-stamps the timer.
   * The watchdog fires only when Deepgram genuinely goes silent on a
   * pending slot — which is exactly the bug case.
   *
   * 0 means "no segment in flight" — set when the slot is cleared
   * by a successful commit (normal `finished=true` path OR forced).
   * Stamped to Date.now() on every interim that lands non-empty
   * text (fresh segment OR extension OR rotation — the only thing
   * that DOESN'T re-stamp is an empty `finished=true` no-op).
   *
   * @type {{ you: number, other: number }}
   */
  pendingTranscriptStartedAt: { you: 0, other: 0 },

  /**
   * 4-state item lifecycle. Map<itemId, { state, evidence, confidence, at }>.
   *   state — 'in_progress' | 'covered' | 'logged'
   *   evidence — short quote from the transcript
   *   confidence — 0..100, set by the coach
   *   at — Date.now() when this state was last set; the auto-log
   *     timer in maybeAutoLogStaleItems() uses this to demote
   *     in_progress items to logged after AUTO_LOG_MS of silence.
   */
  itemStates: new Map(),

  /** @type {Record<string, { value: string, at: number }>} */
  capturedFields: {},

  /**
   * Structured monetary facts (post-test-call fixes batch 2 / Issue 3).
   *
   * Populated by the Stage-1 scanner (src/facts-scanner.js), which
   * runs on a ~12 s periodic sweep over the transcript. Each entry
   * is a discrete quantitative fact (current spend, pain cost, time
   * cost, etc.) with the raw amount, unit, period, an anchor quote
   * for renderer drill-through, and a `correction` flag the scanner
   * sets to `true` when the speaker explicitly revised an earlier
   * figure.
   *
   * `entries` feeds the Stage-2 quick-fix worker (src/quick-fix.js).
   * The worker dedupes the entries (ignoring superseded ones), sums
   * them into a headline, and enforces a CODE-SIDE monotonic
   * constraint: the headline MUST NOT decrease unless either at
   * least one entry has `correction === true` OR the response
   * carries a non-empty `correctionReason`.
   *
   * `previousHeadlineUsdAnnual` is the last ACCEPTED headline value,
   * stamped on each successful Stage-2 rollup. The Stage-2 prompt
   * receives this as input so the model knows the floor it's working
   * against; the enforcer uses it for the actual gate.
   *
   * Entry shape:
   *   {
   *     id: string,            // `fact_${seq}_${Date.now()}` (stable per call)
   *     kind: string,          // 'current_spend' | 'pain_cost' | …
   *     amount: number,
   *     unit: 'usd' | 'hours' | 'people' | 'percent',
   *     period: 'one_time' | 'weekly' | 'monthly' | 'quarterly' | 'annual',
   *     basis: string,
   *     quote: string,         // ≤120 chars anchor quote
   *     recordedAt: number,
   *     supersedes: string | null,
   *     correction: boolean,   // Stage-1 sets true on explicit revisions
   *   }
   *
   * `quickFix` shape: null until the first successful rollup, then
   *   {
   *     headlineUsdAnnual: number,
   *     breakdown: Array<{ label, amountUsdAnnual, source, notes }>,
   *     assumptions: string[],
   *     confidence: 'low' | 'medium' | 'high',
   *     currency: 'USD',
   *     correctionReason: string | null, // when Stage-2 justifies a drop
   *     updatedAt: number,
   *     stale: boolean,        // true while Stage-2 is retrying after validation/monotonic failure
   *     error: boolean,        // true after ERROR_THRESHOLD consecutive failures
   *   }
   *
   * Reset on every fresh session (resetCoachContext below).
   */
  factsSheet: {
    entries: [],
    quickFix: null,
    previousHeadlineUsdAnnual: null,
  },

  /**
   * Per-suggestion history (Advanced → Track question state).
   *
   * Map<suggestionId, {
   *   id: string,            // `${itemId}__${Date.now()}` (stable; survives reformulation)
   *   itemId: string,        // rubric item id (or 'freeform.*')
   *   questionText: string,  // the spoken question the coach pinned
   *   kind: string,          // 'next' | 'deeper' | 'pivot' | 'pause' | 'recap' | 'targeted' | 'reformulate'
   *   pinnedAt: number,
   *   asked: boolean,        // flipped by the coach via mark_question_asked
   *   askedAt: number | null,
   *   evidence: string | null,
   *   replaced: boolean,     // true when a newer suggestion took the pin
   * }>
   *
   * Populated unconditionally — the toggle gates whether the coach
   * receives the PENDING SUGGESTIONS block, not whether main tracks
   * history. Cheap to keep around (a few dozen entries per call) and
   * keeps the renderer's drawer rendering consistent regardless of
   * when the toggle flips.
   *
   * Reset on every session (resetCoachContext) so a new call starts
   * with a clean slate.
   */
  suggestionHistory: new Map(),
};

const COACH_TRANSCRIPT_WINDOW_LINES = 40; // cap context size
const COACH_RECENT_TURNS = 3;

/* Auto-log heuristic: any item that's been sitting in `in_progress`
 * for longer than this without a confirming `covered` update gets
 * demoted to `logged` automatically. The hand-tuned value is a guess
 * — re-tune once we have real call data. */
const AUTO_LOG_MS = 30_000;
const AUTO_LOG_CHECK_INTERVAL_MS = 5_000;

let autoLogTimer = null;

/* ── Stale-pending watchdog (post-test-call fixes batch 2 / Issue 1) ──
 *
 * Background — the bug being fixed: Deepgram's `interim_results=true`
 * stream produces non-incremental segment text on every interim, and
 * we surface `finished=true` ONLY when Deepgram fires `speech_final`.
 * If Deepgram never fires `speech_final` for a particular utterance
 * (silent VAD hand-off, network blip, AEC misfire) the pending text
 * stays in the slot until the NEXT segment's first interim arrives —
 * which then SILENTLY OVERWRITES it via
 * `pendingTranscriptBySpeaker[speaker] = text`. The text the rep saw
 * greyed in the transcript pane never makes it to transcriptLines,
 * the saved transcript, the coach, or the scanner.
 *
 * STALE_PENDING_MS is the per-segment ceiling: if the watchdog ticks
 * and finds a pending that's been sitting unchanged for longer than
 * this, it force-commits the segment via the same path
 * `speech_final` would have taken.
 *
 * 4500 ms is the empirical pick — short enough that lost text lands
 * in the same beat of the call (the rep doesn't have to wait long to
 * see committed lines appear), long enough that a deliberately slow
 * speaker mid-sentence isn't aggressively force-flushed mid-thought.
 * Tighter would risk fragmenting genuinely-long utterances; looser
 * would let the rotation guard in handleDeepgramTranscript do most of
 * the work (which it already does for the common case of a new
 * segment beginning immediately after the dropped one).
 *
 * STALE_PENDING_CHECK_INTERVAL_MS is the watchdog cadence. 1 s gives
 * sub-second granularity on stale detection without burning cycles —
 * the check itself just walks two slots and reads two timestamps,
 * so overhead is negligible.
 */
const STALE_PENDING_MS = 4_500;
const STALE_PENDING_CHECK_INTERVAL_MS = 1_000;
let stalePendingTimer = null;

/* ── Coach mode + pause detection (v2.5 redesign) ──────────────────────
 *
 * Coach mode is a per-session setting forwarded from the renderer (with
 * a localStorage default of 'signalled'). It controls whether the
 * pause-detection nudge is active:
 *
 *   'signalled' (default) — the coach NEVER auto-suggests. Suggestions
 *                           only come from the rep's explicit asks
 *                           (Suggest / Deeper / Pivot) or a skip.
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
 *
 * The mode is held here in main rather than on the Coach instance
 * because main owns the canonical transcript stream timing — the
 * pause detector keys off `lastTranscriptAt`, which is updated
 * in-line by handleDeepgramTranscript / handleGeminiTranscript.
 */
let coachMode = 'signalled';

/** Timestamp of the most recent transcript activity from either
 *  speaker — committed line OR interim partial. The pause detector
 *  compares Date.now() against this to decide whether enough silence
 *  has elapsed to warrant a nudge. Reset to Date.now() at session
 *  start so the first 6s of warm-up isn't treated as a pause. */
let lastTranscriptAt = 0;

/** One-shot guard: set to true once a pause-triggered suggestion has
 *  fired for the current silence; cleared by `markTranscriptActivity`
 *  on the next transcript activity so subsequent pauses can still
 *  fire. Without this we'd nudge once a second during a long quiet
 *  stretch. */
let pendingPauseFired = false;

let pauseCheckTimer = null;

/** Silence threshold for the Automated-mode pause detector. */
const PAUSE_THRESHOLD_MS = 6_000;
const PAUSE_CHECK_INTERVAL_MS = 1_000;

/**
 * One-shot timer that fires the coach's opening "kickstart" question
 * shortly after a fresh session starts. The goal is to remove the
 * "what do I ask first?" cognitive load — within ~10s of the user
 * clicking Start, the coach surfaces a strong opening prompt
 * (typically an agenda-confirm / "what brings us together today"
 * since `opening_agenda.*` items are the highest-priority uncovered
 * pillar at call start) unless it has already done so on its own.
 *
 * Lifecycle:
 *   - Armed in `gemini:start` once liveSession.open() succeeds.
 *   - Cancelled in `teardownSession()` so a fast Start → Stop →
 *     Start cycle never leaves a zombie timer that would fire
 *     against a torn-down or replaced coachSession.
 */
let kickstartTimer = null;
const KICKSTART_DELAY_MS = 10_000;

/**
 * One-shot latch: has the kickstart timer ALREADY fired (i.e.
 * actually requested an opening suggestion) for the current session?
 * Set inside armKickstart's timer callback at the moment the
 * coach.requestSuggestion call goes out; reset to false in
 * resetCoachContext() so a fresh session re-arms cleanly.
 *
 * Combined with `kickstartTimer` (the in-flight timer reference) this
 * forms a small state machine that lets coach:set-mode call
 * armKickstart() safely after a session is already underway: if the
 * kickstart has already fired this session, the re-arm is a no-op so
 * the rep doesn't get a duplicate opening question.
 */
let kickstartFired = false;

/**
 * Arm the one-shot coach kickstart. Two call sites:
 *
 *   1. `gemini:start`, once liveSession.open() succeeds — covers the
 *      "user starts a session already in automated mode" path.
 *   2. `coach:set-mode`, when the rep flips signalled → automated
 *      mid-session — covers the gap that surfaced on the 2026-05-26
 *      test call where the rep started in signalled, flipped to
 *      automated, and nothing happened until they manually asked the
 *      first question. The original code armed kickstart ONCE at
 *      session start so the post-flip session sat silent.
 *
 * Behaviour:
 *   - No-op if `kickstartFired` (already done this session).
 *   - No-op if `coachMode !== 'automated'` at arm time (with silent-
 *     failure logging — this IS the expected case when the rep is
 *     still in signalled mode at session start, but logging it lets
 *     us audit unexpected arms after a flip).
 *   - Otherwise clears any previously-armed timer and arms a fresh
 *     KICKSTART_DELAY_MS-second one. The timer callback re-checks the
 *     session, mode, and pin state before firing so a teardown / flip
 *     during the wait window cleanly cancels the fire.
 *
 * Side-effect contract: only writes `kickstartTimer` (timer
 * reference) and `kickstartFired` (latch). Reads `coachMode`,
 * `coachSession`, and a method on coachSession.
 */
function armKickstart() {
  if (kickstartFired) {
    return;
  }
  if (coachMode !== 'automated') {
    console.warn(
      '[coach-silent-failure] armKickstart: skipped — coachMode is',
      coachMode,
    );
    return;
  }
  if (kickstartTimer) clearTimeout(kickstartTimer);
  kickstartTimer = setTimeout(() => {
    kickstartTimer = null;
    if (!coachSession) {
      console.warn('[coach-silent-failure] kickstart fired but coachSession is null');
      return;
    }
    if (coachMode !== 'automated') {
      console.warn(
        '[coach-silent-failure] kickstart timer fired but coachMode is now',
        coachMode,
      );
      return;
    }
    if (coachSession.hasPinnedSuggestion?.()) {
      console.log('[kickstart] skipped — pinned suggestion already present');
      return;
    }
    kickstartFired = true;
    console.log('[kickstart] firing opening question');
    coachSession.requestSuggestion({ kind: 'next' });
  }, KICKSTART_DELAY_MS);
}

/**
 * Per-guard "have we already logged the silent-failure warning since
 * the last mode flip?" latches. Each value flips to true on the
 * first console.warn for that guard, then stays true until the next
 * coach:set-mode transition resets all three back to false. Throttles
 * the 5s pause-nudge tick (which would otherwise spam the console in
 * signalled mode) while still surfacing one audit line per
 * transition. The auto-reformulate guards see fewer fires (once per
 * pinned suggestion) but follow the same pattern for consistency.
 */
const silentFailureLogged = {
  pauseNudge: false,
  reformulateArm: false,
  reformulateFire: false,
};

/**
 * Advanced → Auto-reformulate: re-fire 10s after a pinned suggestion
 * that the seller hasn't asked. Lives at module scope so the IPC
 * handlers (skip / boost / ask) can cancel it from outside the
 * onSuggestion callback.
 *
 * Lifecycle:
 *   - Armed in onSuggestion when both `trackQuestionState` and
 *     `autoReformulate` are on. Replaces any previous timer (so
 *     each fresh pin resets the 10s clock).
 *   - Cleared explicitly when the seller manually skips / boosts /
 *     asks via the IPC handlers — the seller's intent overrides the
 *     auto-reformulate window.
 *   - Cleared in teardownSession() + resetCoachContext() so a
 *     timer from a previous call can't fire against a torn-down
 *     coach session.
 *
 * Spec: 10s. Calibrated so the rep has time to actually ask the
 * pinned suggestion at a natural pause, but not so long that an
 * abandoned question lingers across a whole topic shift.
 */
let reformulateTimer = null;
const REFORMULATE_DELAY_MS = 10_000;

/**
 * Id of the currently-pinned suggestion entry in `coachContext.suggestionHistory`,
 * or null when no suggestion is pinned. Set in the `onSuggestion` callback
 * whenever a new suggestion takes the pin slot. The previously-pinned
 * entry (if any) gets its `replaced: true` flag flipped at the same
 * time so the renderer can distinguish "this was the active suggestion
 * but a newer one replaced it" from "this is the active suggestion".
 *
 * Cleared on session teardown via `resetCoachContext()`.
 */
let currentPinnedSuggestionId = null;

function resetCoachContext() {
  coachContext.transcriptLines = [];
  coachContext.pendingTranscriptBySpeaker = { you: '', other: '' };
  coachContext.pendingTranscriptStartedAt = { you: 0, other: 0 };
  coachContext.itemStates = new Map();
  coachContext.capturedFields = {};
  coachContext.suggestionHistory = new Map();
  // Wipe the facts sheet so the new call starts with an empty
  // rollup. The Stage-2 worker's debounce timer is cancelled by
  // teardownSession (which fires before resetCoachContext on a
  // fresh start) so a late roll-up can't land against the new
  // session's empty entries. previousHeadlineUsdAnnual back to null
  // so the next session's first rollup isn't constrained by the
  // previous call's ceiling.
  coachContext.factsSheet = { entries: [], quickFix: null, previousHeadlineUsdAnnual: null };
  // Reset the scanner cursor so a fresh session starts from line 0
  // of its own transcript rather than skipping the opening turns.
  factsScannerCursor = 0;
  currentPinnedSuggestionId = null;
  // Reset the kickstart latch so the next session's armKickstart()
  // call can fire (whether from gemini:start or from a mid-session
  // signalled → automated flip via coach:set-mode).
  kickstartFired = false;
  // Treat the session start as "fresh transcript activity" so the
  // pause detector doesn't immediately trip on an empty buffer.
  lastTranscriptAt = Date.now();
  pendingPauseFired = false;
  // Drop any cross-channel dedupe entries from a previous session —
  // the 3 s window normally protects us across restart latency, but a
  // very fast re-Start could otherwise let a stale "you" commit drop
  // a legitimate opening line on the new call.
  recentCommitBySpeaker.you = null;
  recentCommitBySpeaker.other = null;
  deepgramReconnectAttempts = 0;
  geminiReconnectAttempts = 0;
  // Reset connection-status state so a previous session's "down"
  // doesn't leak into the new session's header pill. The broadcast
  // fires the empty state to the renderer, which renders 'down/down'
  // until the new sessions report 'connected'.
  setConnectionStatus('deepgram', 'down');
  setConnectionStatus('geminiLive', 'down');
  // Cancel any in-flight auto-reformulate window from the previous
  // session so it can't fire against a torn-down or replaced
  // coachSession.
  if (reformulateTimer) {
    clearTimeout(reformulateTimer);
    reformulateTimer = null;
  }
}

/**
 * Attempt to reopen a new DeepgramSession after an unexpected close.
 * Capped at MAX_DEEPGRAM_RECONNECTS attempts per call; resets to 0
 * on success or on a fresh gemini:start (via resetCoachContext).
 *
 * The user experience is intentionally seamless: no error banner is
 * shown unless we exhaust all retries. A brief transcription gap is
 * acceptable — coach context is unaffected because no new lines can
 * arrive during the gap, not because we lost existing context.
 *
 * Call-active check: both liveSession AND coachSession being null
 * means teardownSession() has already run (user pressed Stop, or an
 * earlier fatal error cleaned up). In that case we skip silently.
 */
async function reconnectDeepgram() {
  if (deepgramReconnectAttempts >= MAX_DEEPGRAM_RECONNECTS) {
    console.error('[deepgram] max reconnects reached — giving up');
    send('gemini:error', { message: 'Transcription connection lost after multiple retries.' });
    setConnectionStatus('deepgram', 'down');
    return;
  }
  deepgramReconnectAttempts++;
  console.log(`[deepgram] reconnecting (attempt ${deepgramReconnectAttempts})…`);
  setConnectionStatus('deepgram', 'reconnecting');
  await new Promise((r) => setTimeout(r, 2000));
  if (!liveSession && !coachSession) {
    console.log('[deepgram] call already ended — skipping reconnect');
    return;
  }
  // Commit any in-flight partial that landed JUST before Deepgram
  // dropped, so the new session's first interim_results message can't
  // overwrite it. The Deepgram client buffers `text` on every interim
  // and replaces (not appends) on the next one, so without this flush
  // we'd silently lose whatever the rep / prospect was mid-sentence
  // saying at the exact moment the WebSocket closed.
  flushPendingTranscripts();
  try {
    const key = process.env.DEEPGRAM_API_KEY;
    // Re-read settings on reconnect so a model change made while the
    // call was in flight takes effect on the next WS open. Settings
    // changes don't hot-swap an existing connection but a reconnect
    // is the cheapest natural boundary to refresh on.
    const newSession = new DeepgramSession({
      apiKey: key,
      model: getAudio().deepgramModel,
      onTranscript: handleDeepgramTranscript,
      onError: (message) => {
        console.warn('[deepgram] error after reconnect:', message);
      },
      onClose: () => {
        console.warn('[deepgram] connection closed after reconnect');
        reconnectDeepgram();
      },
    });
    await newSession.open();
    deepgramSession = newSession;
    deepgramReconnectAttempts = 0;
    console.log('[deepgram] reconnected successfully');
    setConnectionStatus('deepgram', 'connected');
  } catch (err) {
    console.error('[deepgram] reconnect failed:', err?.message || err);
    reconnectDeepgram();
  }
}

/**
 * Open (or re-open) the Gemini Live session. Factored out of the
 * gemini:start handler so the reconnect path (reconnectGeminiLive
 * below) can re-use the same construction + handler wiring.
 *
 * The session's role in this app is narrow: it's the sole producer of
 * the red/green coaching flags (record_flag → live_signals pillar)
 * and the fallback transcription path when Deepgram is unavailable.
 * Closures captured here always check `liveSession === created` before
 * mutating the singleton, so a stale handler from an earlier session
 * can't clobber a newer one.
 *
 * `onClose` fires `reconnectGeminiLive()` on every close — the
 * reconnect helper's attempt-cap is the gate that decides whether to
 * keep trying or give up.
 */
async function openGeminiLiveSession({ apiKey }) {
  const created = new GeminiSession({
    apiKey,
    onTranscript: handleGeminiTranscript,
    onTurnComplete: handleTurnComplete,
    onFlag: (payload) => {
      console.log('[scoring] flag:', payload.id, '—', payload.evidence);
      send('scoring:flag', payload);
    },
    onError: (message) => {
      console.error('[gemini] session error:', message);
      send('gemini:error', { message });
      // The session is already in 'closed' state; clear our reference.
      // We deliberately don't trigger reconnect from onError — the
      // session's _fail path always calls onClose() too (via the
      // session.close() in _fail), and that's where the reconnect
      // decision lives. Doing it in both would double-fire.
      if (liveSession === created) liveSession = null;
    },
    onClose: (reason) => {
      console.log('[gemini] session closed:', reason);
      send('gemini:closed', { reason });
      if (liveSession === created) liveSession = null;
      // Trigger reconnect attempt. The renderer's E2 handler treats
      // this as a soft degrade while Deepgram is canonical, so the
      // call doesn't end — but live flag detection stops until the
      // reconnect lands. Capped at MAX_GEMINI_RECONNECTS attempts.
      reconnectGeminiLive({ apiKey });
    },
  });
  await created.open();
  liveSession = created;
  setConnectionStatus('geminiLive', 'connected');
  return created;
}

/**
 * Attempt to re-open a fresh Gemini Live session after an unexpected
 * close. Mirrors `reconnectDeepgram` — 3 attempts, 2 s backoff, no
 * history replay (the live model rebuilds state from the next few
 * seconds of audio, which is faster and more reliable than trying to
 * carry session context across a WebSocket break).
 *
 * Gating:
 *   - Stop once the call is over (`!liveSession && !coachSession` means
 *     teardownSession() has already run; the previous session's
 *     close handler may still be firing this late).
 *   - Stop after MAX_GEMINI_RECONNECTS attempts; the renderer's pill
 *     surfaces 'down' so the rep knows live flag detection is
 *     unavailable for the rest of the call. The transcript path is
 *     unaffected because Deepgram is canonical.
 *
 * Why we reconnect at all (per the E1 verification): flag detection
 * is the only Gemini-Live-only capability. Transcripts are fallback
 * only. So reconnect is purely a "try to bring back live flag
 * detection" attempt — not a "keep the call alive" attempt (E2
 * handles call survival in the renderer).
 */
async function reconnectGeminiLive({ apiKey }) {
  if (geminiReconnectAttempts >= MAX_GEMINI_RECONNECTS) {
    console.error('[gemini] max reconnects reached — giving up on flag detection for this call');
    setConnectionStatus('geminiLive', 'down');
    return;
  }
  geminiReconnectAttempts++;
  console.log(`[gemini] reconnecting (attempt ${geminiReconnectAttempts})…`);
  setConnectionStatus('geminiLive', 'reconnecting');
  await new Promise((r) => setTimeout(r, 2000));
  // If the call ended during the backoff, drop the reconnect. We
  // check both sessions because teardownSession nulls them in order
  // and a race could leave either one non-null briefly.
  if (!liveSession && !coachSession) {
    console.log('[gemini] call already ended — skipping reconnect');
    return;
  }
  // A previous reconnect attempt may have already opened a new
  // session; if liveSession is non-null we're done.
  if (liveSession) {
    console.log('[gemini] session already re-opened — skipping reconnect');
    geminiReconnectAttempts = 0;
    setConnectionStatus('geminiLive', 'connected');
    return;
  }
  try {
    await openGeminiLiveSession({ apiKey });
    geminiReconnectAttempts = 0;
    console.log('[gemini] reconnected successfully');
  } catch (err) {
    console.error('[gemini] reconnect failed:', err?.message || err);
    // openGeminiLiveSession's onClose handler will fire reconnect
    // again — but it only fires if the session actually opened then
    // closed. If openGeminiLiveSession threw before opening, we need
    // to retry here to keep the cycle going.
    reconnectGeminiLive({ apiKey });
  }
}

/**
 * Called from the transcript handlers whenever new text arrives (either
 * an interim partial or a committed line, from either speaker). Two
 * jobs: bump `lastTranscriptAt` so the pause detector sees freshness,
 * and clear the one-shot `pendingPauseFired` guard so the next silence
 * can fire its own nudge.
 */
function markTranscriptActivity() {
  lastTranscriptAt = Date.now();
  pendingPauseFired = false;
}

/**
 * Periodic check (Automated mode only). Fires a `kind: 'pause'`
 * suggestion request when:
 *   - coach mode is 'automated' AND
 *   - a coach session is running AND
 *   - no suggestion is currently pinned AND
 *   - ≥ PAUSE_THRESHOLD_MS has elapsed since the last transcript
 *     activity AND
 *   - we haven't already fired a pause-nudge for this silence
 *
 * The "pinned suggestion" check is delegated to the Coach instance
 * (`hasPinnedSuggestion`) so the rep doesn't get a new suggestion
 * dropped on top of one they haven't acted on yet.
 */
function maybeFirePauseNudge() {
  if (coachMode !== 'automated') {
    if (!silentFailureLogged.pauseNudge) {
      console.warn(
        '[coach-silent-failure] maybeFirePauseNudge: skipped — coachMode is',
        coachMode,
      );
      silentFailureLogged.pauseNudge = true;
    }
    return;
  }
  if (!coachSession) return;
  if (pendingPauseFired) return;
  if (coachSession.hasPinnedSuggestion?.()) return;
  if (lastTranscriptAt === 0) return;
  const elapsed = Date.now() - lastTranscriptAt;
  if (elapsed < PAUSE_THRESHOLD_MS) return;
  pendingPauseFired = true;
  console.log('[coach] pause nudge fired (silence =', elapsed, 'ms)');
  coachSession.requestSuggestion({ kind: 'pause' });
}

function speakerPrefix(speaker) {
  return speaker === 'you' ? 'You: ' : 'Prospect: ';
}

/**
 * Walk `transcriptLines` backwards looking for the most recent committed
 * line spoken by `speaker`. Returns the array index or -1 if none found
 * within the lookback window.
 *
 * Why a bounded lookback: this is used by the prefix-extension dedupe
 * below. Deepgram (with the speech_final gating fix in deepgram-session)
 * should only commit once per utterance — but if VAD fires two
 * `speech_final`s back-to-back on a continuation, we'd see two adjacent
 * lines for the same speaker where the second's text starts with the
 * first's text. The dedupe target is therefore always very recent; we
 * only need to skip over a small number of other-speaker interjections
 * ("uh-huh", "right") that may have landed in between. A wider scan
 * would risk merging into a stale earlier utterance.
 */
function findLastLineBySpeaker(lines, speaker, maxLookback = 4) {
  const prefix = speakerPrefix(speaker);
  const start = lines.length - 1;
  const end = Math.max(0, start - maxLookback + 1);
  for (let i = start; i >= end; i--) {
    if (typeof lines[i] === 'string' && lines[i].startsWith(prefix)) return i;
  }
  return -1;
}

/**
 * Walk `transcriptLines` backwards and splice out the most recent line
 * for `speaker` whose text is near-identical to `committed`. Used by
 * the cross-channel dedupe when a PROSPECT commit matches a YOU line
 * that already landed — the bias is to keep PROSPECT, so the
 * pre-existing YOU line is yanked.
 *
 * Bounded lookback for the same reason as findLastLineBySpeaker: the
 * duplicate is always very recent, and a wider scan risks eating an
 * unrelated earlier turn.
 *
 * Returns true iff a line was removed.
 */
function findAndRemoveMatchingLine(lines, speaker, committed, maxLookback = 4) {
  const prefix = speakerPrefix(speaker);
  const start = lines.length - 1;
  const end = Math.max(0, start - maxLookback + 1);
  for (let i = start; i >= end; i--) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    if (!line.startsWith(prefix)) continue;
    const text = line.slice(prefix.length);
    if (isNearIdentical(text, committed)) {
      lines.splice(i, 1);
      return true;
    }
  }
  return false;
}

/* ── Cross-channel duplicate suppression ───────────────────────────────
 *
 * The IPC routing (sendMicAudio → channel 1, sendSystemAudio → channel
 * 2) is clean, so the two Deepgram channels carry physically separate
 * audio streams. Despite that, the user is seeing every utterance
 * transcribed on BOTH channels — once labelled YOU and once labelled
 * PROSPECT — with character-identical text. The likely physical paths:
 *
 *   - Mic picking up the prospect's voice from the user's speakers
 *     even with AEC3 (open-air room, low headroom).
 *   - User's own voice being routed back through the system-audio
 *     loopback (Zoom Original Sound, sidetone/monitor, BlackHole or
 *     Loopback virtual device, etc.).
 *
 * We don't try to fix this at the audio layer — instead we suppress
 * the visible symptom by tracking the most recent committed line per
 * speaker and removing same-window commits on the OTHER channel when
 * the text is near-identical.
 *
 * ── Attribution bias: always keep PROSPECT, drop YOU ────────────────
 *
 * Cross-channel duplicates almost always come from one source: the AI
 * / prospect voice playing through the user's speakers and bleeding
 * into their mic. The loopback (PROSPECT channel) captures it cleanly
 * from the OS audio mixer; the mic (YOU channel) captures the same
 * content as acoustic echo. The "first to finalize" heuristic is
 * unreliable because finalisation timing depends on Deepgram's VAD
 * per stream, not the actual order the audio arrived. Defaulting to
 * "keep PROSPECT" is correct in the common case (speakerphone bleed)
 * and only wrong in the rare case where the user's own voice is
 * routed back through system audio (Zoom monitor mode, sidetone,
 * virtual loopback devices) — that's a setup quirk we surface
 * separately, not the default.
 *
 * Tuning:
 *   - WINDOW_MS = 5 s: mic and loopback can finalize on different
 *     VAD timings; 3 s was too tight when one channel was noticeably
 *     later than the other.
 *   - MIN_CHARS = 3: short fragments ("Look.", "But", "Honestly,")
 *     are the most common form the bleed takes when the AI voice is
 *     broken up by the speech-final VAD. The length-aware logic in
 *     `isNearIdentical` keeps unrelated short strings ("yes" vs
 *     "yeah") from colliding by requiring exact normalised match on
 *     anything ≤ 12 chars.
 */
const CROSS_CHANNEL_WINDOW_MS = 5000;
const CROSS_CHANNEL_DEDUPE_MIN_CHARS = 3;

/**
 * Recent transcript commits, keyed by speaker, used to suppress
 * cross-channel duplicates. When the prospect (or rep) speaks and that
 * audio bleeds onto the other channel via speaker echo or sidetone,
 * Deepgram transcribes it on both channels with near-identical text.
 *
 * Both directions are checked, but the resolution rule is biased: see
 * the "Attribution bias" block above. We do NOT rely on "first to
 * arrive wins" — Deepgram's per-stream VAD makes that ordering
 * unreliable when one channel's audio is delayed by acoustic bleed.
 *
 * Entry: { text: string, ts: number }. We only need the most recent
 * commit per speaker — older entries fall out of the window naturally.
 *
 * @type {{ you: { text: string, ts: number } | null, other: { text: string, ts: number } | null }}
 */
const recentCommitBySpeaker = { you: null, other: null };

/** Lowercase + strip non-alphanumerics + collapse whitespace. The
 *  goal is to make "So you're basically looking to..." and "so you're
 *  basically looking to" hash to the same canonical form so ASR
 *  capitalisation / punctuation drift between channels doesn't defeat
 *  the dedupe. */
function normaliseForMatch(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Length-aware near-identity check for cross-channel dedup.
 *
 *   - Exact match on the normalised strings always wins — that's the
 *     common case for the bleed pattern this is targeting ("Look." vs
 *     "Look.", "Hello there" vs "Hello there").
 *   - For short normalised strings (≤ shortLen chars), exact match is
 *     the ONLY way to dedupe. Substring containment and token Jaccard
 *     are meaningless on 1–2 token strings and would catch unrelated
 *     content like "yes" vs "yeah" or "but" vs "buttons".
 *   - For longer strings, fall through to the original substring +
 *     Jaccard checks, which absorb one channel catching a slightly
 *     longer tail / head or a single ASR substitution.
 *
 * Deliberately NOT full Levenshtein — these run on every commit and
 * Jaccard is O(n) once tokenised. The conservative thresholds (and
 * the MIN_CHARS gate at the call site) are the safety net against
 * false-positive drops.
 */
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
 * Diagnostic logging gate for the transcript pipeline. Off by default
 * because it fires on every Deepgram commit; flip to `true` when
 * debugging the cross-channel dedupe or the prefix-extension dedupe
 * to see a one-line summary per commit (speaker, kind, KEEP/DROP, and
 * a 50-char preview of the text).
 */
const DEBUG_TRANSCRIPT = false;

function buildCoachContextSnapshot() {
  const lines = coachContext.transcriptLines.slice(-COACH_TRANSCRIPT_WINDOW_LINES);

  // Append any in-flight partials so the coach can react to a turn the
  // moment it starts rather than waiting for the final commit. Each
  // pending segment is prefixed by speaker so the model can tell who
  // is mid-sentence.
  for (const speaker of /** @type {const} */ (['you', 'other'])) {
    const pending = coachContext.pendingTranscriptBySpeaker[speaker];
    if (pending) lines.push(speakerPrefix(speaker) + pending);
  }

  // Materialise the Map as a plain object for the coach prompt builder.
  /** @type {Record<string, { state: string, evidence?: string, confidence?: number, at?: number }>} */
  const itemStates = {};
  for (const [id, s] of coachContext.itemStates) itemStates[id] = s;

  return {
    transcriptWindow: lines.join('\n'),
    itemStates,
    capturedFields: coachContext.capturedFields,
    recentSellerTurns: coachContext.transcriptLines.slice(-COACH_RECENT_TURNS),
    // Recap-specific window: "everything since the rep last asked a
    // tracked question". Computed at snapshot time so the Coach can
    // pull it for kind:'recap' ticks without having to know how the
    // suggestion history is stored. See getRecapWindow() doc-block
    // for fallback semantics when no question has been asked yet.
    recapWindow: getRecapWindow(),
  };
}

/**
 * Build the transcript slice the coach should use for a Recap-kind
 * suggestion.
 *
 * Test-call finding 5: the previous Recap behaviour used the standard
 * trailing 40-line window, which on long calls drifted further and
 * further from the "since the last question landed" boundary the rep
 * actually wanted to recap from. The fix is to remember where the
 * transcript was at each asked event (stamped onto the history entry
 * by applyMarkAsked → `transcriptIndexAtAsk`) and slice from there.
 *
 * Fallback semantics:
 *   - If no asked entry has been stamped yet (e.g. early call, or the
 *     rep is in signalled mode and hasn't asked anything tracked), we
 *     fall back to the same trailing window the standard tick uses
 *     (`COACH_TRANSCRIPT_WINDOW_LINES`) so a recap requested in the
 *     first beat of the call still has something useful to summarise.
 *   - If the stamp exists but is ≥ transcriptLines.length (race: the
 *     stamp landed but the transcript hasn't grown since), the slice
 *     would be empty; we degrade to the trailing window for the same
 *     reason.
 *
 * Return shape: `{ lines: string[], sinceAskedAt: number | null }`.
 * `sinceAskedAt` is the askedAt timestamp of the entry we sliced from
 * (null when we fell back). The coach prompt can format this as a
 * human-readable duration if we ever surface "Recap covers the last
 * 2:14" to the rep.
 *
 * Walked newest-first across `suggestionHistory.values()` and bails on
 * the first `asked === true` we find. Map insertion order is preserved
 * across reformulates / replacements so the latest-asked entry is
 * structurally the latest in the iteration order.
 */
function getRecapWindow() {
  let latestAsked = null;
  for (const entry of coachContext.suggestionHistory.values()) {
    if (entry?.asked && typeof entry.transcriptIndexAtAsk === 'number') {
      // Each newer asked entry wins because Map iteration is insertion-
      // order — and registerSuggestion always inserts at the end, so
      // the last asked entry we see in the walk IS the most recent.
      latestAsked = entry;
    }
  }
  const total = coachContext.transcriptLines.length;
  if (latestAsked && latestAsked.transcriptIndexAtAsk < total) {
    return {
      lines: coachContext.transcriptLines.slice(latestAsked.transcriptIndexAtAsk),
      sinceAskedAt: latestAsked.askedAt,
    };
  }
  // Fallback to the standard trailing window so a recap requested
  // before any question has been asked still has context.
  return {
    lines: coachContext.transcriptLines.slice(-COACH_TRANSCRIPT_WINDOW_LINES),
    sinceAskedAt: null,
  };
}

/**
 * Run periodically (every AUTO_LOG_CHECK_INTERVAL_MS) while a session
 * is active. Demotes any item in `in_progress` whose last `at` is
 * older than AUTO_LOG_MS to `logged` and forwards the transition to
 * the renderer. Coach context's itemStates is the source of truth, so
 * we update it in place and emit the same `scoring:item-state` event
 * the model emits to keep the renderer in sync.
 */
function maybeAutoLogStaleItems() {
  if (!coachSession) return;
  const cutoff = Date.now() - AUTO_LOG_MS;
  for (const [itemId, entry] of coachContext.itemStates) {
    if (entry?.state !== 'in_progress') continue;
    if ((entry.at ?? 0) > cutoff) continue;
    const updated = {
      state: 'logged',
      evidence: entry.evidence || '',
      confidence: entry.confidence ?? 0,
      at: Date.now(),
      // Tag the source so the renderer / future debugging knows this
      // wasn't a model-driven transition.
      source: 'auto_log_timeout',
    };
    coachContext.itemStates.set(itemId, updated);
    console.log('[coach] auto-logged stale item:', itemId);
    send('scoring:item-state', {
      itemId,
      state: updated.state,
      evidence: updated.evidence,
      confidence: updated.confidence,
      source: updated.source,
    });
  }
}

/* ── Suggestion history (Advanced → Track question state) ────────────
 *
 * The Coach reports each new pinned suggestion via `onSuggestion`.
 * We keep a per-call history of every pin so:
 *   (a) the model can validate against it via `mark_question_asked`,
 *   (b) the renderer can surface asked / replaced annotations under
 *       the `logged_questions` synthetic pillar,
 *   (c) the 10s auto-reformulate timer has something to read.
 *
 * Entries are added by `registerSuggestion`, flipped to `asked: true`
 * by `applyMarkAsked` (model-driven), and flipped to `replaced: true`
 * by `registerSuggestion` itself whenever a new pin lands on top of
 * an existing one.
 *
 * Renderer sync: every mutation runs through `broadcastSuggestionHistory`,
 * which sends the full serialised list on `scoring:suggestion-history`.
 * Cheap — the history rarely exceeds a few dozen entries per call. */

/** Generate a stable id for a new suggestion entry. We use crypto.randomUUID
 *  when available (Electron always has it in main) for guaranteed
 *  uniqueness across reformulations that fire within the same millisecond,
 *  falling back to a `${itemId}__${ms}__${counter}` shape so two distinct
 *  test environments can both keep working. */
let _suggestionIdCounter = 0;
function generateSuggestionId(itemId) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  _suggestionIdCounter += 1;
  return `${itemId || 'sug'}__${Date.now()}__${_suggestionIdCounter}`;
}

/** Serialise the history Map into a plain array (oldest first) for
 *  IPC transport — Map is not structured-clone friendly across the
 *  contextIsolation boundary. */
function serialiseSuggestionHistory() {
  return Array.from(coachContext.suggestionHistory.values()).map((entry) => ({
    id: entry.id,
    itemId: entry.itemId,
    questionText: entry.questionText,
    kind: entry.kind,
    pinnedAt: entry.pinnedAt,
    asked: entry.asked,
    askedAt: entry.askedAt,
    evidence: entry.evidence,
    replaced: entry.replaced,
  }));
}

/** Push the current history to the renderer. Called after every
 *  mutation. The renderer treats the payload as the full snapshot —
 *  it just replaces state.suggestionHistory wholesale. */
function broadcastSuggestionHistory() {
  send('scoring:suggestion-history', serialiseSuggestionHistory());
}

/**
 * Register a freshly-pinned suggestion in history. Called from the
 * `onSuggestion` callback before the IPC fan-out to the renderer.
 * Any previously-pinned (still-unresolved) entry has `replaced: true`
 * flipped — the old wording is still visible in the drawer but is
 * no longer the active suggestion.
 *
 * Returns the new entry id so the caller can stash it as the
 * current pin.
 */
function registerSuggestion({ itemId, questionText, kind }) {
  // Flip the previously-pinned entry to `replaced` so the renderer
  // knows the old wording is no longer active. `currentPinnedSuggestionId`
  // gets overwritten below.
  if (currentPinnedSuggestionId) {
    const prev = coachContext.suggestionHistory.get(currentPinnedSuggestionId);
    if (prev && !prev.asked) {
      prev.replaced = true;
    }
  }
  const id = generateSuggestionId(itemId);
  const entry = {
    id,
    itemId: typeof itemId === 'string' ? itemId : '',
    questionText: typeof questionText === 'string' ? questionText : '',
    kind: typeof kind === 'string' ? kind : 'next',
    pinnedAt: Date.now(),
    asked: false,
    askedAt: null,
    evidence: null,
    replaced: false,
  };
  coachContext.suggestionHistory.set(id, entry);
  currentPinnedSuggestionId = id;
  return id;
}

/**
 * Flip a history entry to `asked: true` based on a model-driven
 * `mark_question_asked` call. Tolerant of unknown ids — a model that
 * hallucinates an id (or references one from a previous session
 * after a fast restart) is a no-op rather than an error.
 *
 * Also cancels the auto-reformulate timer if the asked entry is the
 * currently-pinned one — there's no point rephrasing a question the
 * seller has already asked.
 */
function applyMarkAsked({ suggestionId, evidence }) {
  const entry = coachContext.suggestionHistory.get(suggestionId);
  if (!entry) {
    console.warn('[coach] mark_question_asked for unknown id:', suggestionId);
    return false;
  }
  if (entry.asked) return false;
  entry.asked = true;
  entry.askedAt = Date.now();
  entry.evidence = typeof evidence === 'string' ? evidence : '';
  // Stamp the transcript index at the moment the question was
  // observed-as-asked. getRecapWindow() reads this to slice the
  // transcript so the next Recap covers ONLY the conversation that
  // happened SINCE the rep last asked a tracked question — which is
  // the "where did the prospect land?" window the rep actually
  // wants to recap. Without this stamp the recap would always re-read
  // the same trailing 40 lines, which is the v2 behaviour we're
  // tightening here (Test-call note 5).
  //
  // Using `length` (not `length - 1`) so the slice is "everything
  // from this point forward, exclusive of the question turn itself".
  // The seller's question gets included naturally as the first line
  // of the recap window the next time it fires.
  entry.transcriptIndexAtAsk = coachContext.transcriptLines.length;
  if (currentPinnedSuggestionId === suggestionId && reformulateTimer) {
    clearTimeout(reformulateTimer);
    reformulateTimer = null;
  }
  console.log('[coach] question asked:', suggestionId, '—', entry.evidence);
  return true;
}

/**
 * Manual mark-as-asked helper. Wraps the same `applyMarkAsked`
 * side-effects the AI-driven path uses (flip entry.asked + cancel the
 * reformulate timer + stamp the recap window) and additionally
 * transitions the entry's rubric item to `'logged'` so the next coach
 * tick's `formatCoachState` candidate list naturally drops it.
 *
 * The extra item-state transition is intentionally manual-path only:
 * when the AI fires `mark_question_asked` it typically pairs the call
 * with its own `update_item_state` for coverage off the prospect's
 * answer, so the AI path doesn't need this nudge. The rep clicking
 * the tick has no such guarantee — without this we'd flip the
 * suggestion green but the model could still resurface the same item
 * one tick later.
 *
 * Returns the same `{ changed, alreadyAsked }` discriminator both
 * call sites (the IPC handler + a hypothetical future caller) can use
 * to decide whether to broadcast. Idempotent — a second call for an
 * already-asked entry resolves with `{ changed: false, alreadyAsked:
 * true }` and skips the item-state side-effect.
 *
 * `source` is forwarded onto the `scoring:item-state` IPC so the
 * renderer can distinguish manual marks from model-driven ones for
 * future debugging / audit.
 *
 * Freeform sentinels (`freeform.deeper`, `freeform.recap`) carry no
 * rubric item, so the transition step is skipped for those — there's
 * no item to log. The asked-flip still runs.
 */
function markSuggestionAskedManual({ suggestionId, source }) {
  const entry = coachContext.suggestionHistory.get(suggestionId);
  if (!entry) return { changed: false, alreadyAsked: false, unknown: true };
  if (entry.asked) return { changed: false, alreadyAsked: true };

  const evidence = entry.questionText
    ? `Manually marked asked by rep: "${entry.questionText}"`
    : 'Manually marked asked by rep';
  const changed = applyMarkAsked({ suggestionId, evidence });
  if (!changed) return { changed: false, alreadyAsked: true };

  // Stamp the coach's in-memory skip set so the model drops the item
  // from its candidate pool on the next tick. The itemStates update
  // below is additive — it makes the rubric row green in the rail
  // drawer — but `formatCoachState` only EXCLUDES candidates that
  // are in `coveredSet` or `skippedSet`, NOT items in the `logged`
  // bucket. Without this skip-set stamp, an over-eager model could
  // still pick the same item one tick later despite the asked flip.
  // No-op for freeform sentinels (handled inside markItemAsAsked).
  if (coachSession && entry.itemId) {
    coachSession.markItemAsAsked(entry.itemId);
  }

  if (entry.itemId && !entry.itemId.startsWith('freeform.')) {
    const prev = coachContext.itemStates.get(entry.itemId);
    const isTerminal = prev?.state === 'covered' || prev?.state === 'logged';
    if (!isTerminal) {
      const updated = {
        state: 'logged',
        evidence: entry.questionText || evidence,
        confidence: prev?.confidence ?? 0.8,
        at: Date.now(),
        source: source || 'manual_mark_asked',
      };
      coachContext.itemStates.set(entry.itemId, updated);
      console.log(
        '[coach] manual mark-asked → logged:',
        entry.itemId,
        '—',
        entry.questionText,
      );
      send('scoring:item-state', {
        itemId: entry.itemId,
        state: updated.state,
        evidence: updated.evidence,
        confidence: updated.confidence,
        source: updated.source,
      });
    }
  }

  return { changed: true, alreadyAsked: false };
}

/**
 * Arm the 10s auto-reformulate timer for the currently-pinned
 * suggestion. Called from `onSuggestion` after a new pin lands.
 * Reads the live Advanced settings each time so flipping the toggle
 * mid-call takes effect immediately without restarting the session
 * (the next pin sees the new value).
 *
 * Both toggles must be true — `autoReformulate` alone is useless
 * without `trackQuestionState` because the timer's "still pinned and
 * not yet asked?" check needs the asked-detection signal.
 */
function armReformulateTimer(suggestionId) {
  if (reformulateTimer) {
    clearTimeout(reformulateTimer);
    reformulateTimer = null;
  }
  const coach = getCoach();
  if (!coach?.trackQuestionState || !coach?.autoReformulate) return;
  // Gated on coachMode === 'automated' so signalled mode never auto-
  // refires a reformulation the rep didn't ask for. The drawer-level
  // toggles (trackQuestionState / autoReformulate) STILL matter — they
  // control whether tracking happens at all — but signalled mode adds a
  // hard upper bound on automatic coach activity. Test-call note 5
  // surfaced the leak: signalled mode was still firing reformulates
  // every 10s of an unasked pin.
  if (coachMode !== 'automated') {
    if (!silentFailureLogged.reformulateArm) {
      console.warn(
        '[coach-silent-failure] armReformulateTimer: skipped — coachMode is',
        coachMode,
      );
      silentFailureLogged.reformulateArm = true;
    }
    return;
  }
  reformulateTimer = setTimeout(() => {
    reformulateTimer = null;
    if (!coachSession) return;
    // Re-validate: the pin may have rotated, the entry may have
    // been asked, or the seller may have skipped between arm and
    // fire. Bail in any of those cases.
    if (suggestionId !== currentPinnedSuggestionId) return;
    const entry = coachContext.suggestionHistory.get(suggestionId);
    if (!entry || entry.asked || entry.replaced) return;
    // Final live toggle check — the user may have flipped it off
    // during the 10s window. Re-check coachMode too in case it
    // flipped from automated → signalled during the window.
    const live = getCoach();
    if (!live?.trackQuestionState || !live?.autoReformulate) return;
    if (coachMode !== 'automated') {
      if (!silentFailureLogged.reformulateFire) {
        console.warn(
          '[coach-silent-failure] reformulate timer fired but coachMode is now',
          coachMode,
        );
        silentFailureLogged.reformulateFire = true;
      }
      return;
    }
    console.log('[coach] auto-reformulating pinned suggestion:', entry.itemId);
    coachSession.requestSuggestion({ kind: 'reformulate', itemId: entry.itemId });
  }, REFORMULATE_DELAY_MS);
}

/** Drop the auto-reformulate timer without firing. Called from the
 *  seller-driven IPC handlers (skip / boost / ask) because the
 *  seller's intent overrides the auto-reformulate window. The next
 *  suggestion that lands will arm a fresh 10s clock. */
function cancelReformulateTimer() {
  if (reformulateTimer) {
    clearTimeout(reformulateTimer);
    reformulateTimer = null;
  }
}

const createWindow = () => {
  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - WINDOW_WIDTH - EDGE_MARGIN;
  const y = workArea.y + EDGE_MARGIN;

  const mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    /* Resizable so the user can pull the overlay narrower on small
     * displays. The Chromium-enforced min above keeps the header
     * controls from being clipped at whatever the floor ends up being. */
    resizable: true,
    /* hasShadow: false is REQUIRED on macOS for this overlay.
     *
     * With frame:false + transparent:true, current macOS still draws
     * a native NSWindow shadow around the alpha mask of the rendered
     * content. That OS shadow stacks on top of .coach's CSS
     * box-shadow and rasterises as a sharp ~1px ring tracing the
     * rounded perimeter of the card — exactly the "ugly outline"
     * users see (and have reported twice now). The macOS shadow
     * renderer samples the alpha edge of whatever the renderer
     * paints; even the soft outer pixels of our CSS box-shadow are
     * enough to anchor a native ring around them.
     *
     * The CSS box-shadow in src/index.css alone is sufficient for
     * elevation — see the comment on `.coach` for the two-layer
     * recipe. Disabling the native shadow here removes the
     * conflicting second layer and the outline goes away.
     *
     * Background: this is the canonical Electron-on-macOS workaround
     * (electron/electron#8847, #21173). hasShadow:false is the
     * recommended pattern for any transparent + frameless window
     * that draws its own shadow in CSS. */
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // Open DevTools in a detached window so it doesn't shove the overlay around.
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
    // The preview window is conceptually a sidecar of the main
    // overlay — without an overlay to compare against it has no
    // reason to exist, and a stale preview hanging around after
    // the main quits looks like an app bug. Tear it down here so
    // a future re-open of the main window starts with a clean
    // slate. We dispose explicitly rather than relying on
    // BrowserWindow.getAllWindows() so we don't accidentally
    // catch any other top-level window a later plan might add.
    if (previewWindowRef && !previewWindowRef.isDestroyed()) {
      previewWindowRef.destroy();
    }
    previewWindowRef = null;
  });

  mainWindowRef = mainWindow;
  return mainWindow;
};

/**
 * Build the preview BrowserWindow used by the transparency editor.
 *
 * Cloned from createWindow() with three intentional differences:
 *
 *   1. `alwaysOnTop: false` — we want the user to be able to focus
 *      the main settings tab while the preview sits beside it.
 *      Forcing it to float would mean clicks on the Appearance tab
 *      get masked by the preview if it overlaps.
 *
 *   2. Smaller default dimensions (480 × 360, min 360 × 280) —
 *      the preview is a styling sandbox, not a working surface,
 *      so it shouldn't compete with the main overlay for screen
 *      real estate.
 *
 *   3. Positioned to the LEFT of the main window if the main is
 *      alive, else top-left of the workArea. Keeps the two
 *      windows side-by-side without overlapping on first open;
 *      the user can drag the preview wherever they like
 *      afterwards (frame:false + transparent:true + the existing
 *      app-region drag handle in preview.html).
 *
 * `hasShadow: false` is preserved from the main window for the same
 * macOS reason — see the long comment in createWindow() above. With
 * frame:false + transparent:true the OS would otherwise rasterise a
 * 1px ring around the preview's alpha mask, and we want the preview
 * to look pixel-identical to the main overlay so the user's edits
 * read accurately.
 */
function createPreviewWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const PREVIEW_WIDTH = 480;
  const PREVIEW_HEIGHT = 360;
  const PREVIEW_MIN_WIDTH = 360;
  const PREVIEW_MIN_HEIGHT = 280;

  let x = workArea.x + EDGE_MARGIN;
  let y = workArea.y + EDGE_MARGIN;
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    const mainBounds = mainWindowRef.getBounds();
    // Place the preview to the LEFT of the main, vertically centred
    // on the main. Clamp so the preview stays inside the work area
    // if the main is already snug against the right edge with no
    // room on its left.
    const proposedX = mainBounds.x - PREVIEW_WIDTH - 16;
    x = Math.max(workArea.x + EDGE_MARGIN, proposedX);
    y = Math.max(
      workArea.y + EDGE_MARGIN,
      mainBounds.y + Math.floor((mainBounds.height - PREVIEW_HEIGHT) / 2),
    );
  }

  const previewWindow = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    minWidth: PREVIEW_MIN_WIDTH,
    minHeight: PREVIEW_MIN_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    /* The preview is NOT alwaysOnTop — see top-of-function comment. */
    alwaysOnTop: false,
    resizable: true,
    /* See createWindow() above for the full hasShadow:false rationale.
     * Briefly: macOS's native NSWindow shadow stacks on top of the CSS
     * box-shadow and rasterises as a sharp 1px ring around the alpha
     * mask. Disabling the OS shadow lets the CSS box-shadow alone do
     * the elevation, and the preview looks pixel-identical to the
     * main overlay. */
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    title: 'Two Way Flow — Transparency Preview',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (typeof PREVIEW_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' && PREVIEW_WINDOW_VITE_DEV_SERVER_URL) {
    previewWindow.loadURL(PREVIEW_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    previewWindow.loadFile(
      path.join(__dirname, `../renderer/${PREVIEW_WINDOW_VITE_NAME}/preview.html`),
    );
  }

  previewWindow.on('closed', () => {
    if (previewWindowRef === previewWindow) previewWindowRef = null;
  });

  previewWindowRef = previewWindow;
  return previewWindow;
}

/**
 * Bring the overlay window forward from any state. Used by:
 *   - The Tray's `click` handler (menu-bar / system-tray icon).
 *   - The Tray's "Open Two Way Flow" context-menu item.
 *   - `app.on('activate')` (macOS dock-icon click).
 *   - The `second-instance` handler (already inlined separately).
 *
 * Handles three start states:
 *   - Window destroyed (e.g. user closed it but app stayed alive via
 *     a future "minimise to tray" workflow) — re-create.
 *   - Window minimised — `restore()` first so `.show()` lifts it back
 *     to its previous bounds rather than leaving it in the dock /
 *     taskbar.
 *   - Window hidden (via the Cmd/Ctrl+Shift+H global shortcut) —
 *     `show()` un-hides it.
 *
 * `focus()` is called last so keyboard input lands in the renderer
 * straight away.
 */
function showAndFocusMainWindow() {
  let w = mainWindowRef;
  if (!w || w.isDestroyed()) {
    w = createWindow();
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/**
 * Build the tray icon. Lookup order:
 *
 *   1. `assets/tray-icon.png` at the app root — the recommended path
 *      for shipping a real branded icon. macOS convention is a 22×22
 *      black-on-transparent PNG marked as a template image (so it
 *      auto-tints to match light/dark menu bar); Windows / Linux
 *      prefer a 16×16 coloured PNG.
 *   2. On macOS only — fall back to the system's built-in
 *      `NSImageNameTouchBarAudioInputTemplate` (mic glyph). Fits a
 *      voice-AI overlay and is guaranteed to be visible even without
 *      a shipped asset.
 *   3. Final fallback — `nativeImage.createEmpty()`. The Tray still
 *      constructs (so the rest of the app boots) but the icon is
 *      invisible. We `console.warn` so the user sees the hint to
 *      drop a real PNG into assets/.
 *
 * TODO(designer): drop a branded `assets/tray-icon.png` here. The
 * file is picked up automatically on next launch — no code change
 * required.
 */
function buildTrayIcon() {
  const userIconPath = path.join(app.getAppPath(), 'assets', 'tray-icon.png');
  const fileImg = nativeImage.createFromPath(userIconPath);
  if (fileImg && !fileImg.isEmpty()) {
    if (process.platform === 'darwin') fileImg.setTemplateImage(true);
    return fileImg;
  }

  if (process.platform === 'darwin') {
    try {
      const named = nativeImage.createFromNamedImage(
        'NSImageNameTouchBarAudioInputTemplate',
      );
      if (named && !named.isEmpty()) return named;
    } catch (err) {
      // createFromNamedImage isn't strictly typed by Electron — guard
      // a future rename / removal so it can't crash the tray boot.
      console.warn('[tray] createFromNamedImage failed:', err?.message || err);
    }
  }

  console.warn(
    '[tray] no icon at assets/tray-icon.png — registering with an empty image. ' +
    'Drop a 22×22 (macOS) or 16×16 (Win/Linux) PNG there to make the tray visible.',
  );
  return nativeImage.createEmpty();
}

/**
 * Register the menu-bar / system-tray entry. Idempotent — a second
 * call after the tray already exists is a no-op so a future hot-
 * reload of whenReady() can't stack duplicate icons.
 *
 * Click semantics differ slightly by platform but we treat them
 * uniformly: any single-click on the tray icon brings the overlay
 * forward. macOS users typically expect right-click for the context
 * menu (handled by `setContextMenu`); Windows / Linux users get the
 * same menu via right-click and the icon is also clickable for the
 * quick open.
 */
function createTray() {
  if (tray) return tray;
  const icon = buildTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (err) {
    // Some Linux desktops (no system tray protocol) throw here. Log
    // and bail so the rest of the app boots — the in-app header
    // buttons and global shortcut still cover window control.
    console.warn('[tray] failed to construct Tray:', err?.message || err);
    tray = null;
    return null;
  }
  tray.setToolTip('Two Way Flow');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Two Way Flow',
      click: () => showAndFocusMainWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit Two Way Flow',
      click: () => app.quit(),
    },
  ]));
  tray.on('click', () => showAndFocusMainWindow());
  return tray;
}

function send(channel, payload) {
  const w = mainWindowRef;
  if (!w || w.isDestroyed()) return;
  w.webContents.send(channel, payload);
}

/**
 * Broadcast a `settings:changed` payload to every live renderer that
 * cares about appearance state — currently the main window and (if
 * open) the transparency preview window. We keep this separate from
 * the generic `send()` above on purpose: most main → renderer
 * channels (gemini:*, transcript:*, coach:*, connection:*) are only
 * meaningful to the main window's renderer, so blindly fan-outing
 * them through getAllWindows() would dump noise into the preview's
 * console and risk wiring confusion later. Settings broadcasts are
 * the ONE channel both renderers genuinely need.
 *
 * Safe to call before either window is alive — each branch no-ops
 * when its ref is null or destroyed.
 *
 * Sibling broadcaster: `broadcastRubricsChanged` (below) uses the
 * `getAllWindows()` pattern instead — that's intentional, see the
 * comment block there.
 */
function broadcastSettings(payload) {
  const m = mainWindowRef;
  if (m && !m.isDestroyed()) m.webContents.send('settings:changed', payload);
  const p = previewWindowRef;
  if (p && !p.isDestroyed()) p.webContents.send('settings:changed', payload);
}

/**
 * Broadcast `rubrics:changed` to every live BrowserWindow.
 *
 * The Rubrics tab + rubric-switcher pill subscribe via the
 * `window.rubrics.onChanged` preload bridge. A broadcast fires whenever:
 *   - `rubrics:set-active` succeeds (the rail / captured pane re-render
 *     against the new active rubric)
 *   - `rubrics:save` mutates the currently-active rubric AND the
 *     session is idle (a save while a call is running stays on disk
 *     but doesn't notify, because the live Coach owns its tool schemas
 *     for the duration of the call)
 *
 * Single-window today, but iterating `getAllWindows()` is the
 * forward-compatible choice — a future tray window or detached panel
 * picks up the events for free. Diverges intentionally from
 * `broadcastSettings` (above), which targets specific window refs
 * because it has a narrow two-window contract.
 *
 * @param {{ activeId: string, reason: 'set-active' | 'save' }} payload
 */
function broadcastRubricsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('rubrics:changed', payload);
    }
  }
}

/**
 * Mutate `connectionState[transport]` and broadcast the full snapshot
 * to the renderer. Centralised so every lifecycle handler updates one
 * way — the renderer rolls the two slots up into a single pill, and
 * we want the broadcast to fire on every transition (including
 * 'connected' → 'connected' no-ops, which keep the tooltip's "last
 * checked" timestamp accurate if we add that later).
 *
 * Safe to call before the renderer is ready — `send()` is a no-op
 * when the BrowserWindow is gone.
 */
function setConnectionStatus(transport, status) {
  if (transport !== 'deepgram' && transport !== 'geminiLive') return;
  connectionState[transport] = status;
  send('connection:status', {
    deepgram: connectionState.deepgram,
    geminiLive: connectionState.geminiLive,
  });
}

async function teardownSession() {
  // Flush in-flight partial transcripts BEFORE we tear anything down.
  // Without this, the grey interim text the user was watching at the
  // moment of Stop never lands in coachContext.transcriptLines — the
  // renderer flushes its own mirror in stopCapture() but the summary
  // path reads main's snapshot, not the renderer's. See
  // flushPendingTranscripts() for the full reasoning + edge cases.
  flushPendingTranscripts();

  if (autoLogTimer) {
    clearInterval(autoLogTimer);
    autoLogTimer = null;
  }
  if (pauseCheckTimer) {
    clearInterval(pauseCheckTimer);
    pauseCheckTimer = null;
  }
  if (kickstartTimer) {
    clearTimeout(kickstartTimer);
    kickstartTimer = null;
  }
  if (reformulateTimer) {
    clearTimeout(reformulateTimer);
    reformulateTimer = null;
  }
  // Cancel any in-flight Stage-2 debounce so a late roll-up can't fire
  // against the about-to-be-reset factsSheet. The roller is rebuilt
  // on the next session's gemini:start (no longer lazy — see the
  // facts-scanner setup block) so keeping it null here ensures we
  // don't carry the last session's monotonic baseline forward into
  // a fresh call.
  if (quickFixRoller) {
    try { quickFixRoller.cancelPendingRollup(); } catch { /* ignore */ }
    quickFixRoller = null;
  }
  // Stop the Stage-1 facts scanner (post-test-call fixes batch 2).
  // No in-flight call can leak into the next session because the
  // scanner's setInterval is gone before the next gemini:start
  // re-creates a fresh instance. An in-flight provider roundtrip
  // that lands after stop() is a no-op because the scanner's
  // `stopped` guard short-circuits before any appendEntry call.
  if (factsScanner) {
    try { factsScanner.stop(); } catch { /* ignore */ }
    factsScanner = null;
  }
  // Stop the stale-pending watchdog (post-test-call fixes batch 2 /
  // Issue 1). Cleared before flushPendingTranscripts is called above
  // so a late watchdog tick can't race with the flush — actually,
  // flushPendingTranscripts runs FIRST in this function, which is
  // intentional: the flush captures everything the watchdog would
  // have caught one tick later, and then we kill the watchdog so it
  // doesn't fire against an emptied pending slot.
  if (stalePendingTimer) {
    clearInterval(stalePendingTimer);
    stalePendingTimer = null;
  }

  const c = coachSession;
  coachSession = null;
  if (c) {
    try { c.stop(); } catch { /* ignore */ }
  }

  const s = liveSession;
  liveSession = null;
  if (s) {
    try {
      await s.close();
    } catch {
      /* ignore */
    }
  }

  const d = deepgramSession;
  deepgramSession = null;
  if (d) {
    try {
      await d.close();
    } catch {
      /* ignore */
    }
  }

  // Reset connection-status snapshot so the renderer's pill goes back
  // to a neutral "both down" state — both transports are closed by
  // construction here. The broadcast also keeps any subscriber in
  // lockstep with the source-of-truth so a stale 'connected' value
  // can't linger into the next session start.
  setConnectionStatus('deepgram', 'down');
  setConnectionStatus('geminiLive', 'down');
}

/**
 * Handle a transcript message from the Deepgram session. This is the
 * canonical transcript path in v2 — Deepgram's dual-channel STT gives
 * us per-speaker attribution (channel 1 → 'you', channel 2 → 'other')
 * which the legacy Gemini inputTranscription can't provide.
 *
 * Buffering semantics:
 *   - Deepgram's `interim_results=true` mode sends the FULL current
 *     segment text on every interim message, not incremental deltas.
 *     We REPLACE `pendingTranscriptBySpeaker[speaker]` with the new
 *     text rather than appending.
 *   - On `finished=true` we commit the buffer to `transcriptLines`
 *     with the speaker prefix (the contract `src/summary.js` requires)
 *     and clear the pending slot for that speaker.
 *   - Each speaker has its own pending slot so simultaneous mid-turn
 *     speech on both channels doesn't get mixed.
 *
 * The renderer also receives the same `{ speaker, text, finished }`
 * payload via the `gemini:transcript` channel so the transcript pane
 * stays in sync.
 */
function handleDeepgramTranscript({ speaker, text, finished }) {
  if (speaker !== 'you' && speaker !== 'other') return;
  if (typeof text !== 'string') return;

  // ── Segment-rotation guard (post-test-call fixes batch 2 / Issue 1)
  //
  // The bug: if Deepgram never fires `speech_final` for a segment but
  // immediately starts a new segment, the next interim arrives with
  // entirely different text and `pendingTranscriptBySpeaker[speaker]
  // = text` SILENTLY OVERWRITES the previous text. The rep saw the
  // greyed-out text live but it never made it to the committed
  // transcript.
  //
  // Detection: if a non-empty pending exists and the new interim is
  // NOT a prefix-extension (i.e. doesn't start with the existing
  // pending), treat the new interim as a NEW segment and force-
  // commit the old one before replacing the slot.
  //
  // We deliberately ignore the rotation guard when `finished` is true
  // — the normal `finished=true` path below already handles the
  // commit, and a rotation immediately followed by a finished event
  // can't happen in Deepgram's stream (finished applies to the slot
  // we're about to replace anyway).
  if (!finished) {
    const currentPending = coachContext.pendingTranscriptBySpeaker[speaker];
    if (currentPending && currentPending.trim().length > 0 && !text.startsWith(currentPending)) {
      if (DEBUG_TRANSCRIPT) {
        console.log(
          '[transcript] rotation guard: force-commit', speaker,
          JSON.stringify(currentPending.slice(0, 50)),
          'before new segment',
          JSON.stringify(text.slice(0, 50)),
        );
      }
      forceCommitPendingSegment(speaker);
    }
  }

  coachContext.pendingTranscriptBySpeaker[speaker] = text;
  // Stamp the timer on EVERY interim that lands non-empty text in
  // the slot. The watchdog measures "time since the most recent
  // interim" — not "time since the segment started" — so a slowly-
  // but-actively-growing segment (long sentence with frequent
  // Deepgram interim refreshes) never hits the threshold. The
  // watchdog only fires when Deepgram has genuinely gone silent on
  // a pending slot. Per the post-test-call spec: "Reset the watch-
  // dog on every interim that genuinely extends or replaces the
  // pending." See `maybeForceCommitStalePending` for the cadence.
  if (text.length > 0) {
    coachContext.pendingTranscriptStartedAt[speaker] = Date.now();
  }

  send('gemini:transcript', { speaker, text, finished: Boolean(finished) });

  if (finished) {
    const committed = coachContext.pendingTranscriptBySpeaker[speaker].trim();
    coachContext.pendingTranscriptBySpeaker[speaker] = '';
    coachContext.pendingTranscriptStartedAt[speaker] = 0;
    if (committed) {
      commitTranscriptLineForSpeaker(speaker, committed);
    }
  }

  // Any text (interim or committed, either speaker) counts as activity
  // for the pause detector — we only want to nudge when both channels
  // have genuinely gone quiet.
  if (text || finished) markTranscriptActivity();
}

/**
 * Commit a finalised (or force-finalised) segment for one speaker.
 *
 * Extracted from the original `handleDeepgramTranscript` body so that
 * three call sites can share one implementation:
 *
 *   1. The normal `finished=true` Deepgram path.
 *   2. The rotation guard at the top of `handleDeepgramTranscript`,
 *      when a new interim arrives that's not a prefix-extension of
 *      the existing pending (post-test-call fixes batch 2 / Issue 1).
 *   3. The periodic stale-pending watchdog
 *      (`maybeForceCommitStalePending`) — the safety net for when
 *      Deepgram never fires `speech_final` AND no rotation arrives.
 *
 * Performs the same cross-channel PROSPECT-biased dedup, prefix-
 * extension folding, and recent-commit bookkeeping as the original
 * inline block. Does NOT touch the pending slot — the caller is
 * responsible for clearing `pendingTranscriptBySpeaker[speaker]` and
 * `pendingTranscriptStartedAt[speaker]` before calling so the watch-
 * dog can't see stale state if we throw mid-commit.
 *
 * @param {'you'|'other'} speaker
 * @param {string} committed  Already trim()ed segment text.
 */
function commitTranscriptLineForSpeaker(speaker, committed) {
  if (!committed) return;

  // ── Cross-channel dedupe (PROSPECT-biased) ─────────────────────
  // Bleed almost always flows AI/prospect → mic, so when both
  // channels carry the same content within CROSS_CHANNEL_WINDOW_MS
  // we keep PROSPECT and drop YOU. See "Attribution bias" doc-block
  // at module top.
  const other = speaker === 'you' ? 'other' : 'you';
  const otherEntry = recentCommitBySpeaker[other];
  const now = Date.now();
  const isDuplicateOfOtherChannel =
    Boolean(otherEntry) &&
    now - otherEntry.ts < CROSS_CHANNEL_WINDOW_MS &&
    committed.length >= CROSS_CHANNEL_DEDUPE_MIN_CHARS &&
    isNearIdentical(committed, otherEntry.text);

  if (speaker === 'you' && isDuplicateOfOtherChannel) {
    if (DEBUG_TRANSCRIPT) {
      console.log(
        '[transcript] you commit → DROP (matched recent PROSPECT)',
        JSON.stringify(committed.slice(0, 50)),
      );
    }
    return;
  }

  if (speaker === 'other' && isDuplicateOfOtherChannel) {
    const removed = findAndRemoveMatchingLine(
      coachContext.transcriptLines,
      'you',
      committed,
    );
    if (removed) recentCommitBySpeaker.you = null;
    if (DEBUG_TRANSCRIPT) {
      console.log(
        '[transcript] other commit → KEEP, removed prior YOU line:',
        removed,
        JSON.stringify(committed.slice(0, 50)),
      );
    }
    // Fall through to the normal PROSPECT commit flow.
  } else if (DEBUG_TRANSCRIPT) {
    console.log(
      '[transcript]', speaker, 'commit → KEEP',
      JSON.stringify(committed.slice(0, 50)),
    );
  }

  recentCommitBySpeaker[speaker] = { text: committed, ts: now };

  // Prefix-extension dedupe (belt-and-braces). The primary fix lives
  // in deepgram-session.js (only commit on `speech_final`), but if
  // VAD ever emits two `speech_final`s back-to-back on a continuing
  // utterance the second commit would otherwise produce a duplicate
  // line whose text contains the first as a prefix. Detect that
  // case and REPLACE the prior line instead of pushing.
  const lines = coachContext.transcriptLines;
  const lastIdx = findLastLineBySpeaker(lines, speaker);
  const newLine = speakerPrefix(speaker) + committed;
  if (lastIdx >= 0 && newLine.startsWith(lines[lastIdx])) {
    lines[lastIdx] = newLine;
  } else {
    lines.push(newLine);
  }
}

/**
 * Force-commit the current pending segment for `speaker`, regardless
 * of whether Deepgram has fired `speech_final` for it yet. Used by
 * the rotation guard (when a new segment's interim arrives without
 * the previous having committed) and by the watchdog (when nothing
 * else has arrived to displace a stale pending).
 *
 * Mirrors the `finished=true` path inside `handleDeepgramTranscript`
 * step by step:
 *   - clear the pending slot + start-time stamp FIRST so the watchdog
 *     can't see stale state if we re-enter (e.g. the renderer commit
 *     synchronously triggers a re-entry on an interim that was
 *     buffered while we were processing).
 *   - synthesise the `gemini:transcript` IPC with `finished: true` so
 *     the renderer's mirror commits its own copy of the text and
 *     clears its `pendingBySpeaker[speaker]` slot. Order matters:
 *     this happens BEFORE the next interim's `finished=false`
 *     broadcast in the rotation case, so the renderer commits the
 *     OLD text before receiving the NEW one as a fresh pending.
 *   - run the same cross-channel + prefix-extension commit pipeline
 *     so the line lands in `transcriptLines` exactly as if Deepgram
 *     had fired `speech_final`.
 *
 * Bookkeeping for `markTranscriptActivity` is intentionally NOT
 * called here — the caller of `forceCommitPendingSegment` (either
 * the rotation guard's enclosing `handleDeepgramTranscript` or the
 * watchdog) is the right place to decide whether this counts as
 * activity for the pause detector.
 *
 * @param {'you'|'other'} speaker
 */
function forceCommitPendingSegment(speaker) {
  const committed = coachContext.pendingTranscriptBySpeaker[speaker].trim();
  coachContext.pendingTranscriptBySpeaker[speaker] = '';
  coachContext.pendingTranscriptStartedAt[speaker] = 0;
  if (!committed) return;

  // Tell the renderer to commit too. Synthesising finished=true is
  // semantically identical to a real Deepgram speech_final from the
  // renderer's perspective — it runs its own mirror of the
  // commit-and-clear pipeline. See the renderer's
  // window.gemini.onTranscript subscriber for the matching code path.
  send('gemini:transcript', { speaker, text: committed, finished: true });

  commitTranscriptLineForSpeaker(speaker, committed);
}

/**
 * Periodic watchdog (post-test-call fixes batch 2 / Issue 1). Runs
 * every STALE_PENDING_CHECK_INTERVAL_MS once a session is active and
 * force-commits any pending segment that's been sitting unchanged
 * for longer than STALE_PENDING_MS.
 *
 * This is the safety net for the worst case where Deepgram (a) never
 * fires `speech_final` for a segment AND (b) no new segment arrives
 * to trigger the rotation guard. Without it that segment would just
 * sit greyed in the renderer forever and never reach the saved
 * transcript / coach / scanner.
 *
 * Idempotent: a slot already cleared (because either a real
 * speech_final OR the rotation guard already committed it) shows up
 * with startedAt=0, which fails the threshold check and is skipped.
 *
 * Double-commit safety: `forceCommitPendingSegment` clears the slot
 * BEFORE running the commit pipeline, so a watchdog tick that races
 * with a real speech_final arriving at the same moment can't both
 * land the same text — whichever runs first leaves the slot empty
 * for the other to skip.
 */
function maybeForceCommitStalePending() {
  const now = Date.now();
  for (const speaker of /** @type {const} */ (['you', 'other'])) {
    const startedAt = coachContext.pendingTranscriptStartedAt[speaker];
    if (!startedAt) continue;
    const pending = coachContext.pendingTranscriptBySpeaker[speaker];
    if (!pending || pending.trim().length === 0) continue;
    if (now - startedAt < STALE_PENDING_MS) continue;
    console.log(
      '[transcript] watchdog: force-commit stale pending',
      speaker,
      `(age ${now - startedAt}ms)`,
      JSON.stringify(pending.slice(0, 60)),
    );
    forceCommitPendingSegment(speaker);
    // Treat the watchdog-fired commit as transcript activity so the
    // pause detector doesn't simultaneously nudge — same speaker that
    // just dropped a line probably wasn't actually silent.
    markTranscriptActivity();
  }
}

/**
 * Legacy Gemini inputTranscription handler. Two roles:
 *
 *   1. When Deepgram is active (the common case), this is a NO-OP.
 *      Deepgram owns the canonical transcript stream and is the only
 *      source that gets appended to `coachContext.transcriptLines`
 *      and forwarded to the renderer. Gemini's transcripts would
 *      otherwise duplicate the salesperson's voice in both the pane
 *      and the coach context (since Gemini Live only sees the mic
 *      channel — channel 1).
 *
 *   2. When Deepgram is NOT running (e.g. DEEPGRAM_API_KEY missing),
 *      this is the fallback. We accumulate Gemini's incremental
 *      deltas into the 'you' pending buffer, forward the running
 *      segment to the renderer as `speaker: 'you'`, and commit on
 *      finished. The renderer treats this exactly the same as the
 *      Deepgram path because we normalise the payload shape.
 *
 * Gemini Live is still configured with `inputAudioTranscription: {}`
 * because the live model may use it internally for its own context —
 * we just don't surface the result downstream when Deepgram is the
 * canonical source.
 */
function handleGeminiTranscript(payload) {
  if (deepgramSession) return;

  const text = typeof payload?.text === 'string' ? payload.text : '';
  const finished = Boolean(payload?.finished);
  if (!text && !finished) return;

  if (text) coachContext.pendingTranscriptBySpeaker.you += text;
  const segment = coachContext.pendingTranscriptBySpeaker.you;

  send('gemini:transcript', { speaker: 'you', text: segment, finished });

  if (finished) {
    const committed = segment.trim();
    coachContext.pendingTranscriptBySpeaker.you = '';
    if (committed) coachContext.transcriptLines.push(speakerPrefix('you') + committed);
  }

  // Mirror the Deepgram path's pause-detector bookkeeping so the
  // detector still works when Deepgram isn't running.
  markTranscriptActivity();
}

function handleTurnComplete() {
  send('gemini:turn-complete', null);
  // Belt-and-braces: flush any in-flight partials for BOTH speakers via
  // the shared helper. With Deepgram active this is normally a no-op
  // because Deepgram commits on its own `finished` events; the helper's
  // prefix-extension check absorbs the rare case where Gemini's
  // turnComplete fires between a Deepgram interim and its commit and
  // we'd otherwise drop the in-flight YOU partial.
  flushPendingTranscripts();
}

/**
 * Commit any in-flight partial transcripts into `coachContext.transcriptLines`.
 *
 * Used as a "commit the best version of what we heard" moment at two
 * boundaries where the pending buffer would otherwise be wiped:
 *
 *   1. `teardownSession()` — the user pressed Stop (or an error closed
 *      the call). Without this flush, the grey interim text the user
 *      was watching never lands in `coachContext.transcriptLines` and
 *      so is missing from the post-call summary path. The renderer
 *      already flushes its own mirror in `stopCapture()`, but main is
 *      the source of truth for the summary, so a renderer-only flush
 *      isn't enough.
 *
 *   2. `reconnectDeepgram()` — Deepgram dropped and we're about to
 *      open a fresh session. Without this flush, the next session's
 *      first interim REPLACES the old (now-orphaned) pending text and
 *      the partial we were sitting on at drop-time vanishes silently.
 *
 *   3. `handleTurnComplete()` — Gemini Live's turn-complete fires on
 *      its own VAD rhythm, which doesn't necessarily line up with
 *      Deepgram's commit cadence. Flushing here makes the legacy and
 *      Deepgram paths share one commit code path.
 *
 * Per-speaker handling mirrors the prefix-extension logic in
 * `handleDeepgramTranscript` so we don't push a duplicate line when
 * the pending text is itself the start of a line we just committed.
 *
 * We deliberately SKIP the cross-channel PROSPECT-bias dedup here.
 * That dedup exists to handle live acoustic bleed where both channels
 * carry the same content within a few hundred milliseconds — at
 * end-of-call or pre-reconnect we'd rather keep a duplicate-ish line
 * than silently drop transcript text. This is a "commit what we have"
 * moment, not a "decide which channel was canonical" moment.
 */
function flushPendingTranscripts() {
  for (const speaker of /** @type {const} */ (['you', 'other'])) {
    const pending = coachContext.pendingTranscriptBySpeaker[speaker].trim();
    // Also wipe the started-at stamp regardless — even if pending
    // was empty (a clean state), we want to leave the slot in a
    // consistent "no segment in flight" shape so the watchdog
    // doesn't misfire on stale timestamps from a previous session.
    coachContext.pendingTranscriptBySpeaker[speaker] = '';
    coachContext.pendingTranscriptStartedAt[speaker] = 0;
    if (!pending) continue;
    const lines = coachContext.transcriptLines;
    const lastIdx = findLastLineBySpeaker(lines, speaker);
    const newLine = speakerPrefix(speaker) + pending;
    if (lastIdx >= 0 && newLine.startsWith(lines[lastIdx])) {
      lines[lastIdx] = newLine;
    } else {
      lines.push(newLine);
    }
  }
}

function registerIpcHandlers() {
  /**
   * Settings IPC. Both handlers return the FULL current settings
   * object so the renderer can re-hydrate its form without a second
   * roundtrip. See src/settings.js for the storage / fallback rules.
   *
   * Changes take effect on the NEXT session — the live Coach / Gemini
   * Live sessions read their model + key at start time and don't
   * re-read them mid-call. That's intentional: swapping the model on
   * an in-flight session would invalidate the rolling transcript
   * context. The user just needs to Stop + Start to apply.
   */
  /**
   * Load the full settings object. The response also includes an
   * `_envAvailability` snapshot keyed by provider so the renderer's
   * status badges can render the "Using env variable" pill without a
   * second IPC roundtrip. The underscore prefix flags it as a
   * read-only piggyback — saveSettings() ignores it.
   */
  ipcMain.handle('settings:load', () => {
    const settings = loadSettings();
    return { ...settings, _envAvailability: getProviderEnvAvailability() };
  });
  ipcMain.handle('settings:save', (_event, partial) => {
    // Strip the renderer's piggyback fields (anything starting with `_`)
    // so they can't accidentally end up persisted. This is belt-and-
    // brace: the renderer doesn't send them today, but a future
    // wholesale re-save of the loaded object would otherwise pollute
    // the file.
    const cleaned = partial && typeof partial === 'object'
      ? Object.fromEntries(Object.entries(partial).filter(([k]) => !k.startsWith('_')))
      : partial;
    const next = saveSettings(cleaned);
    const payload = { ...next, _envAvailability: getProviderEnvAvailability() };
    // Broadcast a `settings:changed` event so renderer subscribers
    // outside the save initiator (e.g. the drawer-rendering code
    // reading settings.coach.trackQuestionState) can re-pull the
    // fresh values without an explicit roundtrip.
    //
    // Main itself doesn't subscribe — its plumbing reads settings
    // live via getCoach() / loadSettings() each tick, so an
    // in-process listener would be redundant. Single-direction
    // broadcast keeps the contract simple. broadcastSettings() also
    // fans the payload out to the transparency preview window when
    // it's open so slider edits reach both renderers in lock-step.
    broadcastSettings(payload);
    return payload;
  });

  /**
   * Run a cheap connectivity probe against a provider. Returns
   * { ok, message? } so the renderer can render an inline pass/fail
   * status next to the Test button. Uses whichever key + model the
   * user has configured for that provider (Settings → env fallback).
   *
   * Bound to the testConnection() method on the provider class —
   * each provider implements its own minimal ping. Safe to call
   * concurrently per provider; the renderer debounces clicks on its
   * side via a per-card "in flight" flag.
   */
  ipcMain.handle('settings:test-provider', async (_event, provider) => {
    try {
      if (typeof provider !== 'string' || !provider) {
        return { ok: false, message: 'Invalid provider id.' };
      }
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        return { ok: false, message: 'No API key configured.' };
      }
      const inst = getProvider(provider, {
        apiKey,
        model: getDefaultModelForProvider(provider),
      });
      const result = await inst.testConnection();
      return result;
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  });

  /**
   * Returns the current provider-status snapshot for the renderer's
   * Settings → Providers tab. Returned shape:
   *   {
   *     defaultProvider: 'gemini'|'anthropic'|'openai',
   *     providers: { [id]: { status: 'connected'|'env'|'unconfigured' } },
   *   }
   * The renderer also has the full settings via settings:load, so
   * this is only used after a save where the badge needs to refresh
   * without re-hydrating the form.
   */
  ipcMain.handle('settings:provider-status', () => {
    const out = {};
    for (const id of ['gemini', 'anthropic', 'openai']) {
      out[id] = { status: getProviderStatus(id) };
    }
    return {
      defaultProvider: getDefaultProvider(),
      providers: out,
    };
  });

  /* ── Settings → General → Data subsection (Phase 1) ───────────────
   *
   * Reset / Export / Import handlers. All three operate on the same
   * settings cache as :load / :save, broadcast `settings:changed`
   * after a successful mutation (so the renderer's existing listener
   * picks up the new values), and route file I/O through the generic
   * dialog handlers above so the dialog chrome is consistent. */

  /**
   * Reset every setting back to defaults. The renderer surfaces a
   * confirmation modal before invoking this — we don't double-confirm
   * here, so any caller (including future automation) gets exactly
   * one wipe with one IPC call.
   *
   * The `preserveKeys` flag (default true) keeps the configured
   * provider API keys across the reset; that's the high-value default
   * because keys are the only setting users meaningfully lose work
   * over.
   */
  ipcMain.handle('settings:reset', (_event, options) => {
    const preserveKeys = options?.preserveKeys !== false;
    const fresh = resetSettings({ preserveKeys });
    const payload = { ...fresh, _envAvailability: getProviderEnvAvailability() };
    // Same broadcast contract as settings:save — subscribers can't tell
    // the difference, which is intentional. A reset IS a wholesale
    // save; the only special-casing is on the renderer's own button-
    // click code path that calls applySettingsToForm() after this
    // resolves. broadcastSettings() also re-skins the transparency
    // preview window if it's open so a reset wipes its surfaces too.
    broadcastSettings(payload);
    return payload;
  });

  /**
   * Serialise the current settings for export. Returns the JSON
   * string + a recommended filename + a flag echoing whether the
   * payload includes API keys (so the renderer can label the saved
   * file accurately).
   *
   * No file write yet — the renderer chains this with a `dialog:save`
   * call so the user gets the standard "where do you want to save?"
   * Save dialog rather than an Electron-internal path.
   */
  ipcMain.handle('settings:export', (_event, options) => {
    const includeKeys = options?.includeKeys === true;
    return exportSettingsAsJSON({ includeKeys });
  });

  /**
   * Validate a JSON string as importable settings WITHOUT applying
   * it. The renderer calls this from the Import preview modal — it
   * shows the diff, gets user confirmation, and then calls
   * `settings:apply-import` to commit.
   *
   * Returns:
   *   { ok: true, normalised }  — parsed + migrated, ready to apply
   *   { ok: false, error }      — human-readable failure reason
   */
  ipcMain.handle('settings:validate-import', (_event, json) => {
    if (typeof json !== 'string') {
      return { ok: false, error: 'Import payload must be a JSON string.' };
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${err?.message || 'parse failed'}` };
    }
    return validateImportedSettings(parsed);
  });

  /**
   * Commit a previously-validated import. The renderer is expected
   * to have run `settings:validate-import` first and shown the diff
   * preview — passing an unvalidated object still works (the helper
   * re-validates internally) but the standard flow is validate-then-
   * apply.
   *
   * On success, broadcasts `settings:changed` so any subscribers
   * outside the renderer's initiating tab pick up the new shape.
   */
  ipcMain.handle('settings:apply-import', (_event, json) => {
    if (typeof json !== 'string') {
      return { ok: false, error: 'Import payload must be a JSON string.' };
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${err?.message || 'parse failed'}` };
    }
    const result = applyImportedSettings(parsed);
    if (!result.ok) return result;
    const payload = { ...result.settings, _envAvailability: getProviderEnvAvailability() };
    broadcastSettings(payload);
    return { ok: true, settings: payload };
  });

  /* ── Settings → Appearance → Transparency preview window ──────────
   *
   * Two lifecycle handlers for the second BrowserWindow used by the
   * transparency editor. The preview is a styling sandbox only — it
   * loads preview.html, subscribes to the settings:changed broadcast
   * via the same preload bridge as the main window, and applies the
   * --surface-*-alpha CSS variables on every payload. It NEVER
   * mutates settings (invariant 5 in the plan); all edits flow from
   * the main window's Appearance tab.
   *
   * Idempotent: open-preview on an already-open window just lifts
   * and focuses it; close-preview on an already-closed window
   * returns { ok: true } harmlessly. */
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

  ipcMain.handle('gemini:start', async () => {
    // Resolve the Gemini key via the Settings module — Settings → Setup
    // takes precedence over the process env (the env value is the
    // fallback). See src/settings.js getApiKey() for the lookup rule.
    const apiKey = getApiKey('gemini');
    if (!apiKey) {
      // Treat missing key the same as a connection error from the renderer's
      // perspective so it lands in the "Connection lost" UI path. The
      // message mentions both surfaces so the user knows where to set
      // the key.
      send('gemini:error', { message: 'Missing Gemini API key — set one in Settings → Providers or via GEMINI_API_KEY in .env.' });
      return { ok: false, error: 'missing_api_key' };
    }

    // If a previous session is still hanging around (e.g. user double-clicked),
    // tear it down before opening a new one.
    await teardownSession();
    resetCoachContext();
    sessionStartedAt = Date.now();

    // ── Deepgram first ──────────────────────────────────────────────
    // Open the dual-channel STT session BEFORE Gemini Live so that by
    // the time the renderer starts streaming PCM, both consumers are
    // ready. Failure to open Deepgram is non-fatal: we log and carry
    // on; Gemini's inputTranscription fallback fills in for the 'you'
    // channel and the renderer just won't see a separate 'other'
    // stream until the user provisions a key.
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramKey) {
      // Read the model fresh at session start so the latest Audio-tab
      // selection takes effect on this call. Phase 2 plumbs this onto
      // settings.audio.deepgramModel via the renderer's autosave; main
      // never holds a cached copy because the read is cheap (sync
      // file read) and the source-of-truth lives in settings.json.
      const dg = new DeepgramSession({
        apiKey: deepgramKey,
        model: getAudio().deepgramModel,
        onTranscript: handleDeepgramTranscript,
        onError: (message) => {
          console.warn('[deepgram] error:', message);
          if (deepgramSession === dg) deepgramSession = null;
        },
        onClose: (reason) => {
          console.log('[deepgram] connection closed:', reason);
          if (deepgramSession === dg) deepgramSession = null;
          reconnectDeepgram();
        },
      });
      try {
        await dg.open();
        deepgramSession = dg;
        console.log('[deepgram] session opened');
        setConnectionStatus('deepgram', 'connected');
      } catch (err) {
        console.warn('[deepgram] failed to open session:', err?.message || err);
        deepgramSession = null;
        setConnectionStatus('deepgram', 'down');
      }
    } else {
      console.warn('[deepgram] DEEPGRAM_API_KEY missing in .env — speaker attribution disabled, falling back to Gemini inputTranscription for the mic channel only.');
      // No Deepgram configured — surface as 'down' so the pill reflects
      // the mic-only degraded state. The renderer can show "Mic only"
      // in the tooltip if we want to differentiate "not configured"
      // from "dropped" later; for now both read as 'down'.
      setConnectionStatus('deepgram', 'down');
    }

    try {
      await openGeminiLiveSession({ apiKey });
      console.log('[gemini] session opened');
      send('gemini:opened', null);
    } catch (err) {
      const message = err?.message || 'Failed to open Gemini session';
      console.error('[gemini] failed to open session:', err);
      send('gemini:error', { message });
      setConnectionStatus('geminiLive', 'down');
      return { ok: false, error: message };
    }

    // Spin up the text coach alongside the live session. The coach reads
    // coachContext on its own schedule and emits the structured scoring
    // events the renderer expects.
    //
    // Provider routing (v2 settings schema)
    //   The coach's provider is whichever the user has selected as
    //   `defaultProvider` in Settings → Providers. The matching
    //   per-provider API key + defaultModel are pulled via the helpers
    //   below — getApiKey() falls back to the matching env var if the
    //   Settings slot is empty, so .env-only users still work.
    //
    //   A missing key for the routed provider is non-fatal here: the
    //   Coach throws on construction if the key is empty, but the
    //   try/catch above the Coach instantiation surfaces that to the
    //   renderer via the existing `gemini:error` path.
    const coachProviderName = getDefaultProvider();
    const coachApiKey = getApiKey(coachProviderName);
    if (!coachApiKey) {
      // Tell the user which provider needs a key — we don't tear down
      // the live session because the audio/transcription pipeline can
      // run without the coach. The renderer surfaces this as a
      // non-fatal warning.
      send('gemini:error', {
        message: `Missing API key for ${coachProviderName} — open Settings to configure.`,
      });
      return { ok: true };
    }
    const coachProvider = getProvider(coachProviderName, {
      apiKey: coachApiKey,
      model: getDefaultModelForProvider(coachProviderName),
    });
    coachSession = new Coach({
      provider: coachProvider,
      getContext: buildCoachContextSnapshot,
      onItemStateChange: (payload) => {
        // Idempotent guard: if the state we just received is identical
        // to what's already stored (same state from the same source on
        // the same evidence) skip the update. This avoids re-rendering
        // the renderer for every redundant tick.
        const prev = coachContext.itemStates.get(payload.itemId);
        if (prev?.state === payload.state && prev?.evidence === payload.evidence) {
          return;
        }
        // Once an item is `covered` it's terminal; ignore subsequent
        // transitions to a "lower" state. The model is told this in
        // the system prompt but we belt-and-brace it here.
        if (prev?.state === 'covered' && payload.state !== 'covered') {
          return;
        }
        coachContext.itemStates.set(payload.itemId, {
          state: payload.state,
          evidence: payload.evidence,
          confidence: payload.confidence,
          at: Date.now(),
          source: 'model',
        });
        console.log(
          '[coach] item:',
          payload.itemId,
          '→',
          payload.state,
          `(conf ${payload.confidence})`,
          '—',
          payload.evidence,
        );
        send('scoring:item-state', {
          itemId: payload.itemId,
          state: payload.state,
          evidence: payload.evidence,
          confidence: payload.confidence,
          source: 'model',
        });
      },
      onFieldCaptured: (payload) => {
        coachContext.capturedFields[payload.fieldId] = {
          value: payload.value,
          at: Date.now(),
        };
        console.log(
          '[coach] field:',
          payload.fieldId,
          '=',
          payload.value,
          '—',
          payload.evidence,
        );
        send('scoring:field', payload);
      },
      // onMeetingFact is intentionally omitted — record_meeting_fact
      // moved out of the Coach to the Stage-1 facts scanner (see
      // `factsScanner` setup further below). The Coach's constructor
      // accepts a no-op default for this slot so older builds keep
      // running. The scanner's `appendEntry` callback owns the same
      // job (push onto coachContext.factsSheet.entries + schedule
      // the Stage-2 rollup) but lives on the scanner's cadence
      // instead of the Coach's 1.5s tick.
      onSuggestion: (payload) => {
        console.log(
          '[coach] suggest:',
          payload.itemId,
          '→',
          payload.question,
          '[kind:',
          payload.kind || 'next',
          ', anchor:',
          payload.anchorQuote ? `"${payload.anchorQuote.slice(0, 48)}…"` : '(none)',
          ']',
        );
        // Register the suggestion in history BEFORE the renderer IPC
        // so the broadcast that follows already carries the new
        // entry. The id is purely internal — the renderer keys off
        // it for asked/replaced rendering, the model keys off it
        // via the PENDING SUGGESTIONS block.
        registerSuggestion({
          itemId: payload.itemId,
          questionText: payload.question,
          kind: payload.kind,
        });
        // Arm the auto-reformulate timer for this pin. The function
        // itself bails when the Advanced toggles are off.
        armReformulateTimer(currentPinnedSuggestionId);
        broadcastSuggestionHistory();
        // Pass through the anchorQuote + kind so the renderer can
        // surface "responding to: …" under the suggestion card and
        // optionally style the card differently per ask kind.
        //
        // suggestionId is the freshly-registered history id (set on
        // `currentPinnedSuggestionId` by registerSuggestion above).
        // The renderer mirrors it onto the coachHistory entry and
        // uses it to cross-reference `state.suggestionHistory` for
        // the asked-flip styling on the pinned card. One source of
        // truth — no fuzzy text matching.
        send('coach:suggestion', { ...payload, suggestionId: currentPinnedSuggestionId });
      },
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
      getSuggestionContext: () => {
        // The Coach asks for this on every tick — return an empty
        // list when the toggle is off so the mark_question_asked
        // tool stays out of the declarations and the PENDING
        // SUGGESTIONS block doesn't appear in the prompt.
        const coach = getCoach();
        if (!coach?.trackQuestionState) return [];
        const out = [];
        for (const entry of coachContext.suggestionHistory.values()) {
          if (entry.asked) continue;
          if (entry.replaced) continue;
          out.push({
            id: entry.id,
            itemId: entry.itemId,
            questionText: entry.questionText,
          });
        }
        return out;
      },
      onError: (message) => {
        // Coach errors are non-fatal — log only, don't surface to UI.
        console.warn('[coach] error:', message);
      },
      // Lifecycle hooks — fired once per actual API roundtrip so the
      // renderer can show a "thinking" indicator.
      onTickStart: () => send('coach:tick-start', null),
      onTickEnd: () => send('coach:tick-end', null),
    });
    coachSession.start();

    // ── Stage-1 facts scanner (post-test-call fixes batch 2 / Issue 3)
    //
    // Construct the scanner eagerly (NOT lazy on first fact like the
    // legacy onMeetingFact path) so its first tick fires after one
    // `intervalMs` window of conversation. The scanner pulls
    // configuration (`intervalMs`, `enabled`) live from settings on
    // start; settings changes mid-call don't hot-swap — the next
    // gemini:start picks them up. Disabled scanners produce no IPC
    // and no Stage-2 work; the renderer's #quickFix card stays hidden
    // until a fact lands.
    //
    // The scanner's `appendEntry` callback re-uses the same shape +
    // bookkeeping the legacy Coach onMeetingFact callback did:
    //   - stable id per call (used by the renderer's drill-through)
    //   - push onto coachContext.factsSheet.entries IN PLACE so the
    //     getter we hand to the roller / scanner stays valid
    //     across resetCoachContext (which mutates `entries` rather
    //     than replacing the array)
    //   - schedule the Stage-2 quick-fix roller (debounced 2.5s) so a
    //     burst of facts from a single scanner tick coalesces into
    //     one Stage-2 roundtrip
    //
    // The roller is also constructed eagerly here (rather than the
    // old lazy-on-first-fact path) so its monotonic baseline
    // (`lastAcceptedHeadline`) starts null at the right moment in
    // the session lifecycle.
    const factsScannerConfig = getFactsScanner();
    if (factsScannerConfig.enabled) {
      if (!quickFixRoller) {
        quickFixRoller = createQuickFixRoller({
          getEntries: () => coachContext.factsSheet.entries,
          onRollup: (rollup, activeEntries) => {
            coachContext.factsSheet.quickFix = rollup;
            // Stamp the accepted headline back onto the factsSheet so
            // a future debugging tool / future read-only viewer can
            // see the monotonic baseline alongside the live quickFix.
            // The roller owns the AUTHORITATIVE copy of this value
            // (lastAcceptedHeadline) — this mirror is just for
            // observability.
            if (rollup && !rollup.stale && Number.isFinite(rollup.headlineUsdAnnual)) {
              coachContext.factsSheet.previousHeadlineUsdAnnual = rollup.headlineUsdAnnual;
            }
            send('scoring:quick-fix', { quickFix: rollup, entries: activeEntries });
          },
          onError: (message) => {
            console.warn('[quick-fix] worker error:', message);
          },
        });
      }
      factsScanner = createFactsScanner({
        intervalMs: factsScannerConfig.intervalMs,
        getEntries: () => coachContext.factsSheet.entries,
        getNewTranscriptLines: () => {
          // Hand back lines committed since the previous scan and
          // advance the cursor. Using `.length` as a marker means an
          // in-place splice (e.g. cross-channel dedup removing a YOU
          // line in favour of a PROSPECT one) doesn't cause us to
          // re-feed earlier lines on the next tick — the cursor still
          // points at "the count we'd already consumed", which is the
          // same count post-splice for the entries before the splice
          // point. The trade-off is that a splice can leave the
          // scanner re-feeding the LAST consumed line on the next
          // tick (because the splice shifted indices), but the
          // scanner's `correction:false` semantics + Stage-1 dedup
          // make that benign.
          const total = coachContext.transcriptLines.length;
          if (factsScannerCursor >= total) return [];
          const slice = coachContext.transcriptLines.slice(factsScannerCursor);
          factsScannerCursor = total;
          return slice;
        },
        appendEntry: (validated) => {
          const idx = coachContext.factsSheet.entries.length;
          const id = `fact_${idx}_${Date.now()}`;
          const entry = {
            id,
            kind: validated.kind,
            amount: validated.amount,
            unit: validated.unit,
            period: validated.period,
            basis: validated.basis,
            quote: validated.anchorQuote,
            recordedAt: Date.now(),
            supersedes: validated.supersedesId || null,
            correction: validated.correction === true,
          };
          coachContext.factsSheet.entries.push(entry);
          console.log(
            '[facts]', entry.id, '·',
            entry.amount, entry.unit, entry.period,
            entry.correction ? '(CORRECTION)' : '',
            '—', entry.basis,
          );
          if (quickFixRoller) quickFixRoller.schedule();
        },
        onError: (message) => {
          console.warn('[facts-scanner] error:', message);
        },
      });
      factsScanner.start();
    } else {
      console.log('[facts-scanner] disabled via settings.factsScanner.enabled');
    }

    // Start the stale-pending transcript watchdog (post-test-call
    // fixes batch 2 / Issue 1). The watchdog is the safety net for
    // segments Deepgram never speech_final's AND that no new
    // rotation displaces — without it, that text never reaches the
    // saved transcript / coach / scanner. The rotation guard in
    // handleDeepgramTranscript handles the common case; this is the
    // catch-all for the long-tail "Deepgram just went silent".
    if (stalePendingTimer) clearInterval(stalePendingTimer);
    stalePendingTimer = setInterval(
      maybeForceCommitStalePending,
      STALE_PENDING_CHECK_INTERVAL_MS,
    );

    // Start the periodic auto-log sweep. Each tick (every ~5s) demotes
    // stale `in_progress` items to `logged` per maybeAutoLogStaleItems.
    if (autoLogTimer) clearInterval(autoLogTimer);
    autoLogTimer = setInterval(maybeAutoLogStaleItems, AUTO_LOG_CHECK_INTERVAL_MS);

    // Start the pause detector. It's a no-op while coachMode is
    // 'signalled'; flipping the renderer toggle to 'automated' (via
    // coach:set-mode) lights it up live without restarting the
    // session.
    if (pauseCheckTimer) clearInterval(pauseCheckTimer);
    pauseCheckTimer = setInterval(maybeFirePauseNudge, PAUSE_CHECK_INTERVAL_MS);

    // Kickstart: 10s after a clean session start, if the coach hasn't
    // already pinned a suggestion (e.g. because the rep asked
    // manually inside the first 10s), surface a `next`-kind opening
    // question. The rubric's `opening_agenda.*` items are the
    // highest-priority uncovered candidates at this point so the
    // model naturally lands on an agenda / "what brings us together
    // today" prompt. Cancelled by teardownSession() on Stop.
    //
    // armKickstart() (defined above) gates on coachMode === 'automated'
    // and on kickstartFired so a session started in signalled mode no-
    // ops here; a later coach:set-mode flip to 'automated' will call
    // armKickstart() again and pick it up cleanly.
    armKickstart();

    return { ok: true };
  });

  ipcMain.handle('gemini:stop', async () => {
    // Snapshot the duration before teardown clears sessionStartedAt.
    const durationMs = sessionStartedAt > 0 ? Date.now() - sessionStartedAt : 0;
    sessionStartedAt = 0;

    await teardownSession();

    // Kick off the post-call summary asynchronously. The Gemini Flash
    // debrief call inside generateSummary() can take several seconds,
    // and we don't want to block the renderer's Stop button on it.
    // The renderer subscribes to `summary:ready` and shows the modal
    // whenever the payload arrives.
    //
    // Snapshot the context fields by value/reference at call time so a
    // late-arriving session reset (unlikely but possible if the user
    // immediately re-starts) doesn't blow the data away.
    const snapshot = {
      transcriptLines: [...coachContext.transcriptLines],
      itemStates: new Map(coachContext.itemStates),
      capturedFields: { ...coachContext.capturedFields },
      durationMs,
    };

    // Summary stays on Gemini for now (its structured-output debrief
    // call uses Gemini's responseSchema feature). If the Gemini key
    // is missing we still kick off generateSummary with `provider:
    // null` — it returns a transcript-only summary so the user
    // doesn't lose the call data just because the debrief can't run.
    const summaryApiKey = getApiKey('gemini');
    const summaryProvider = summaryApiKey
      ? getProvider('gemini', {
          apiKey: summaryApiKey,
          model: getModelFor('summary'),
        })
      : null;

    generateSummary({
      provider: summaryProvider,
      coachContext: snapshot,
    })
      .then((summary) => {
        send('summary:ready', summary);
      })
      .catch((err) => {
        console.warn('[summary] generation threw:', err?.message || err);
        send('summary:ready', {
          scorecard: {},
          factsTable: {},
          transcript: snapshot.transcriptLines.join('\n'),
          debrief: { wentWell: '', missed: '', improvements: ['', '', ''] },
          durationMs,
          asJSON: '{}',
          asMarkdown: '# Discovery Call Summary\n\n_Summary generation failed._',
        });
      });

    return { ok: true };
  });

  /* ── Generic dialog plumbing (dialog:open / dialog:save) ──────────
   *
   * Phase 1 of the Settings expansion factors out the dialog work so
   * `summary:save` and the new `settings:export` / `settings:import`
   * IPCs share one code path. Future per-setting file pickers (e.g.
   * Phase 5's transcript-autosave-folder picker) consume these via
   * the autosave helpers in renderer.js — no new IPC channel required.
   *
   * Both helpers accept a base set of dialog options + an optional
   * I/O step (`content` for save, `readAs` for open). If the I/O step
   * is omitted the handlers return just the chosen path, letting the
   * renderer do the read/write itself or store the path in settings. */
  async function showSaveDialogAndMaybeWrite({
    content,
    title,
    defaultName,
    defaultPath,
    filters,
  } = {}) {
    const win = mainWindowRef;
    const result = await dialog.showSaveDialog(
      win && !win.isDestroyed() ? win : null,
      {
        title: title || 'Save',
        defaultPath: defaultPath || defaultName || '',
        filters: filters || [{ name: 'All Files', extensions: ['*'] }],
      },
    );
    if (result.canceled || !result.filePath) {
      return { canceled: true, filePath: null };
    }
    if (typeof content === 'string') {
      try {
        await writeFile(result.filePath, content, 'utf8');
        return { canceled: false, filePath: result.filePath, wrote: true };
      } catch (err) {
        console.error('[dialog:save] write failed:', err?.message || err);
        return {
          canceled: false,
          filePath: result.filePath,
          wrote: false,
          error: err?.message || 'write_failed',
        };
      }
    }
    return { canceled: false, filePath: result.filePath };
  }

  async function showOpenDialogAndMaybeRead({
    title,
    defaultPath,
    filters,
    properties,
    readAs,
  } = {}) {
    const win = mainWindowRef;
    const result = await dialog.showOpenDialog(
      win && !win.isDestroyed() ? win : null,
      {
        title: title || 'Open',
        defaultPath: defaultPath || '',
        filters: filters || [{ name: 'All Files', extensions: ['*'] }],
        properties: properties || ['openFile'],
      },
    );
    const filePath = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
    if (result.canceled || !filePath) {
      return { canceled: true, filePath: null };
    }
    if (readAs === 'utf8') {
      try {
        const fileContent = await readFile(filePath, 'utf8');
        return { canceled: false, filePath, content: fileContent };
      } catch (err) {
        console.error('[dialog:open] read failed:', err?.message || err);
        return {
          canceled: false,
          filePath,
          content: null,
          error: err?.message || 'read_failed',
        };
      }
    }
    return { canceled: false, filePath };
  }

  ipcMain.handle('dialog:save', (_event, args) =>
    showSaveDialogAndMaybeWrite(args || {}),
  );
  ipcMain.handle('dialog:open', (_event, args) =>
    showOpenDialogAndMaybeRead(args || {}),
  );

  /**
   * Bulletproof clipboard write — uses Electron's native `clipboard`
   * module instead of the renderer's `navigator.clipboard.writeText`.
   *
   * Why both:
   *   - The browser API is the obvious first choice but it's gated by
   *     the `clipboard-sanitized-write` permission and Electron's
   *     setPermissionRequestHandler default-denies anything we don't
   *     explicitly allow. We DO allow it (see app.whenReady's
   *     permission handler) but a future tighten-up could regress
   *     that quietly.
   *   - This IPC bypasses the browser permission system entirely.
   *     The call-summary modal's Copy buttons use this path so they
   *     keep working even if the renderer's permission grant flakes.
   *
   * Returns { ok: true } on success or { ok: false, error } on a
   * thrown native write. The renderer surfaces the result via the
   * footer toast ("Copied" vs "Copy failed").
   */
  ipcMain.handle('clipboard:write', (_event, payload) => {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text) return { ok: false, error: 'empty_text' };
    try {
      clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      console.warn('[clipboard:write] failed:', err?.message || err);
      return { ok: false, error: err?.message || 'write_failed' };
    }
  });

  /**
   * Save a summary payload to disk via the native Save dialog.
   * `format` is informational — we use it to pick the default
   * extension and write the content verbatim. The renderer is
   * responsible for choosing which serialisation it wants saved.
   *
   * Routed through the generic showSaveDialogAndMaybeWrite helper so
   * the dialog + write code path is shared with settings:export and
   * any future "save to disk" IPC.
   */
  ipcMain.handle('summary:save', async (_event, payload) => {
    const format = payload?.format === 'markdown' ? 'markdown' : 'json';
    const content = typeof payload?.content === 'string' ? payload.content : '';
    if (!content) return { ok: false, error: 'empty_content' };

    const defaultExt = format === 'markdown' ? 'md' : 'json';
    const defaultName = `discovery-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.${defaultExt}`;
    const filters = format === 'markdown'
      ? [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }]
      : [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }];

    const result = await showSaveDialogAndMaybeWrite({
      title: 'Save call summary',
      content,
      defaultName,
      defaultPath: defaultName,
      filters,
    });

    if (result.canceled) return { ok: false, error: 'cancelled' };
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, filePath: result.filePath };
  });

  /**
   * Open the macOS Screen Recording privacy pane so the user can grant
   * the permission required for `getDisplayMedia` system audio
   * loopback. No-op on non-darwin platforms — Linux + Windows don't
   * gate `getDisplayMedia` behind a separate Screen Recording perm.
   */
  ipcMain.handle('system:open-screen-recording-settings', async () => {
    if (process.platform !== 'darwin') return { ok: false, error: 'not_darwin' };
    try {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
      return { ok: true };
    } catch (err) {
      console.warn('[system] failed to open screen-recording settings:', err);
      return { ok: false, error: err?.message || 'open_failed' };
    }
  });

  /**
   * Returns the current macOS Screen Recording permission status so
   * the renderer can decide whether to show the explainer modal up
   * front. Possible values: 'not-determined' | 'granted' | 'denied' |
   * 'restricted' | 'unknown' (the last is returned on non-darwin
   * platforms so the renderer can short-circuit the prompt flow).
   */
  ipcMain.handle('system:screen-recording-status', () => {
    if (process.platform !== 'darwin') return 'unknown';
    try {
      return systemPreferences.getMediaAccessStatus('screen');
    } catch (err) {
      console.warn('[system] failed to read screen status:', err);
      return 'unknown';
    }
  });

  /**
   * Enumerate desktop audio sources (screens + windows) so the
   * renderer's Audio tab can offer a system-audio picker. Returns
   * [{ id, name }] — we strip the thumbnail dataUrl because
   * desktopCapturer encodes a full PNG per source and the dropdown
   * doesn't render previews. `fetchWindowIcons: false` further
   * trims payload size.
   *
   * Sources are filtered to whatever desktopCapturer returns for the
   * 'screen' + 'window' types; the renderer surfaces the persisted
   * `audio.systemAudioSourceId` as the selected entry if it's still
   * present, otherwise the dropdown falls back to "Default (first
   * available screen)" — matching today's hardcoded `sources[0]`
   * behaviour.
   *
   * On macOS we early-return an empty list when Screen Recording
   * permission isn't granted — the source list would be empty
   * anyway and the existing explainer modal handles the prompt.
   */
  ipcMain.handle('system:list-audio-sources', async () => {
    if (process.platform === 'darwin') {
      try {
        const status = systemPreferences.getMediaAccessStatus('screen');
        if (status !== 'granted') return { sources: [], permission: status };
      } catch (err) {
        console.warn('[system] permission probe failed:', err?.message || err);
      }
    }
    try {
      const raw = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        fetchWindowIcons: false,
      });
      const sources = (raw || []).map((s) => ({
        id: s.id,
        name: s.name || s.id,
      }));
      return { sources, permission: 'granted' };
    } catch (err) {
      console.warn('[system] list-audio-sources failed:', err?.message || err);
      return { sources: [], permission: 'unknown', error: err?.message || 'list_failed' };
    }
  });

  /* ── Window chrome controls (frameless overlay) ────────────────────
   *
   * The overlay is `frame: false` so the visible —/× buttons in the
   * in-HTML header have NO native chrome to fall back on — every
   * action goes through one of these IPC channels.
   *
   * Semantics:
   *   window:minimize — proper minimize to the OS taskbar / dock so
   *                     the user can recall the overlay via the
   *                     standard restore gesture (dock-click on
   *                     macOS, taskbar on Win/Linux) OR the Tray
   *                     icon registered above.
   *   window:close    — close the window. main's `window-all-closed`
   *                     handler then triggers `app.quit()` for ALL
   *                     platforms (overlay-tool semantics — not the
   *                     default macOS "keep app alive in dock"
   *                     behaviour). The header's × button uses this.
   *   window:quit     — short-circuit straight to `app.quit()`. Used
   *                     by future code paths that want to exit
   *                     without going through a window close (e.g.
   *                     a "Quit" item in a future in-app menu). The
   *                     Tray's Quit context-menu item calls
   *                     `app.quit()` directly from main, not via
   *                     IPC, but we expose this channel symmetrically
   *                     so the renderer doesn't have to differentiate
   *                     close-then-quit from quit-immediately.
   */
  ipcMain.handle('window:minimize', () => {
    const w = mainWindowRef;
    if (w && !w.isDestroyed()) w.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:close', () => {
    const w = mainWindowRef;
    if (w && !w.isDestroyed()) w.close();
    return { ok: true };
  });

  ipcMain.handle('window:quit', () => {
    app.quit();
    return { ok: true };
  });

  /**
   * Build-version metadata for the header `#versionBadge` pill. See
   * the long block-comment above computeAppVersion() near the top of
   * this file for the dev-vs-packaged read-path decision and the
   * dirty-flag semantics.
   *
   * Renderer wiring: window.gemini.getAppVersion() → renders once at
   * boot (the values can't change mid-session — Vite defines bake at
   * build start and the runtime git read captures the working-tree
   * state at process boot). Cached after first read.
   */
  ipcMain.handle('app:version', () => computeAppVersion());

  // Renderer asks the coach for a fresh suggestion (seller pressed Skip
  // on the active suggestion card, or pressed → at the live edge of
  // suggestion history). Cheap call — the coach handles its own
  // in-flight guard, so this is safe to fire repeatedly.
  ipcMain.handle('coach:skip', () => {
    // The seller's intent overrides the auto-reformulate window.
    // Cancel without firing; the next suggestion that lands will
    // arm a fresh 10s clock in `onSuggestion`.
    cancelReformulateTimer();
    coachSession?.skip();
    return { ok: true };
  });

  // Renderer asks the coach to prioritise a specific item in its next
  // suggestion. Fired when the seller clicks an item in the Logged
  // pillar — the coach stamps the id into a one-shot boost queue and
  // re-suggests on the next tick.
  ipcMain.handle('coach:boost', (_event, payload) => {
    const itemId = typeof payload?.itemId === 'string' ? payload.itemId : null;
    if (!itemId) return { ok: false, error: 'missing_item_id' };
    cancelReformulateTimer();
    coachSession?.boost(itemId);
    return { ok: true };
  });

  /**
   * Set the coach's interaction mode. Persisted on the renderer side
   * (localStorage); main holds a live copy because the pause detector
   * keys off it. Forwarded by the renderer (a) on session start and
   * (b) every time the user flips the header toggle. Safe to call
   * before a session exists — the value is held for the next start.
   */
  ipcMain.handle('coach:set-mode', (_event, payload) => {
    const mode = payload?.mode;
    if (mode !== 'automated' && mode !== 'signalled') {
      return { ok: false, error: 'invalid_mode' };
    }
    const previousMode = coachMode;
    coachMode = mode;
    console.log('[coach] mode set:', mode);
    // Flipping back to signalled mid-session should clear any
    // half-armed pause guard so the next mode flip lights up cleanly.
    if (mode === 'signalled') pendingPauseFired = false;
    // Reset the silent-failure log latches so each mode transition
    // gets one fresh audit line per guard. Without this the per-
    // guard booleans would stick "true" forever after the first
    // skip, swallowing later transitions that we DO want to see.
    silentFailureLogged.pauseNudge = false;
    silentFailureLogged.reformulateArm = false;
    silentFailureLogged.reformulateFire = false;
    // signalled → automated mid-session: arm the kickstart so the
    // coach actually engages within ~10s of the flip. Without this
    // the test-call session sat silent until the rep manually asked
    // their first question — the kickstart was armed ONCE at session
    // start (when coachMode was still 'signalled') and never re-armed
    // after the flip. armKickstart() is a no-op when kickstartFired
    // is already true, so flipping back-and-forth doesn't double-fire.
    if (
      previousMode === 'signalled'
      && mode === 'automated'
      && coachSession
      && !kickstartFired
    ) {
      console.log('[coach] mid-session flip to automated — arming kickstart');
      armKickstart();
    }
    return { ok: true };
  });

  /**
   * Manual mark-as-asked tick on the pinned suggestion card. Mirrors
   * the AI's `mark_question_asked` side-effects (flip entry.asked +
   * stamp the recap window + cancel the reformulate timer) and
   * additionally transitions the rubric item to `'logged'` so the
   * model's next-tick candidate list drops it. The shared
   * `markSuggestionAskedManual` helper owns the logic so the IPC
   * surface stays a thin validation layer.
   *
   * Idempotent — repeated clicks resolve with `{ ok: true,
   * alreadyAsked: true }` without re-running the side-effects (which
   * would otherwise spam scoring:item-state and the suggestion-history
   * broadcast).
   */
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

  /**
   * One of the three "ask" buttons in the transcript pane footer fired.
   * Maps to Coach.requestSuggestion. The kind enum is enforced on the
   * coach side as well, but we validate here so the IPC channel's
   * contract is explicit.
   */
  ipcMain.handle('coach:ask-suggest', (_event, payload) => {
    if (!coachSession) return { ok: false, error: 'no_session' };
    const kind = payload?.kind;
    if (kind !== 'next' && kind !== 'deeper' && kind !== 'pivot') {
      return { ok: false, error: 'invalid_kind' };
    }
    cancelReformulateTimer();
    coachSession.requestSuggestion({ kind });
    return { ok: true };
  });

  /**
   * Recap button fired. Recap is its own channel (rather than a
   * fourth kind on coach:ask-suggest) because the renderer doesn't
   * pass any payload — recap is always freeform (item_id =
   * 'freeform.recap') and the coach picks the prospect themes off
   * the recent transcript itself. Surface a one-shot suggestion
   * opportunity with kind:'recap' on the next coach tick.
   */
  ipcMain.handle('coach:ask-recap', () => {
    if (!coachSession) return { ok: false, error: 'no_session' };
    cancelReformulateTimer();
    coachSession.requestSuggestion({ kind: 'recap' });
    return { ok: true };
  });

  /**
   * Per-item targeted ask. The renderer fires this with the rubric
   * item id when the seller clicks the `+ Ask` button on an uncovered
   * row in the pillar drawer, or when the "Cover remaining" queue
   * advances to the next item. The coach generates a question for
   * THAT specific item id (mode: targeted), bypassing the normal
   * "pick the most valuable backlog item" logic.
   *
   * The itemId is validated minimally here (non-empty string); the
   * coach's tool enum + the prompt's TARGETED_ITEM rules carry the
   * load-bearing constraint.
   */
  ipcMain.handle('coach:ask-item', (_event, payload) => {
    if (!coachSession) return { ok: false, error: 'no_session' };
    const itemId = typeof payload?.itemId === 'string' ? payload.itemId : null;
    if (!itemId) return { ok: false, error: 'missing_item_id' };
    cancelReformulateTimer();
    coachSession.requestSuggestion({ kind: 'targeted', itemId });
    return { ok: true };
  });

  /* ────────────────────────────────────────────────────────────────
   * Rubric library — 10 invoke channels + 1 event channel.
   *
   * The renderer talks to the rubric library exclusively through these
   * channels via the `window.rubrics.*` preload bridge (src/preload.js).
   * Direct fs access from the renderer is intentionally NOT supported.
   *
   * Lifecycle gating
   * ────────────────
   * `rubrics:set-active` checks the call-active flag — both
   * `liveSession` and `coachSession` must be null. The "either is
   * non-null" predicate is the same one teardownSession checks (see
   * line 1103-ish), so the gate stays in sync with the rest of main's
   * idle/running distinction.
   *
   * Idle path of `rubrics:set-active`:
   *   1. store.setActiveRubric(id)           — persist the swap
   *   2. reloadActiveRubric()                — re-pull catalogues into
   *                                            src/rubric.js's live
   *                                            bindings
   *   3. coachSession?.stop() + null         — defensive (should be
   *                                            null already when idle)
   *   4. broadcastRubricsChanged             — renderers re-render
   *
   * Save path:
   *   - Always persists.
   *   - If the saved rubric is the active one AND the session is idle,
   *     reload + broadcast so the rail, captured pane, and switcher
   *     pill pick up the edit immediately.
   *   - If the session is running, the edit stays on disk but doesn't
   *     take effect until the next session start (the live Coach owns
   *     its tool schemas for the duration of the call — see Task 4's
   *     per-instance _buildTools).
   * ──────────────────────────────────────────────────────────────── */
  ipcMain.handle('rubrics:list', () => {
    try {
      return {
        ok: true,
        rubrics: rubricStore.listRubrics(),
        active: rubricStore.getActiveRubricMeta(),
      };
    } catch (err) {
      console.warn('[rubrics:list]', err?.message || err);
      return { ok: false, reason: err?.message || 'list_failed' };
    }
  });

  ipcMain.handle('rubrics:load', (_event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id) return { ok: false, reason: 'id_required' };
    const rubric = rubricStore.loadRubric(id);
    if (!rubric) return { ok: false, reason: 'not_found' };
    return { ok: true, rubric };
  });

  ipcMain.handle('rubrics:save', (_event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id) return { ok: false, errors: ['id_required'], warnings: [] };
    const result = rubricStore.saveRubric(id, payload.rubric);
    if (!result.ok) return result;

    // Idle-active save → reload + broadcast.
    const meta = rubricStore.getActiveRubricMeta();
    const isActive = meta.id === id;
    const idle = !liveSession && !coachSession;
    let applied = false;
    if (isActive && idle) {
      try {
        reloadActiveRubric();
        broadcastRubricsChanged({ activeId: id, reason: 'save' });
        applied = true;
      } catch (err) {
        // Save succeeded on disk; the reload failure is logged but
        // doesn't roll back. Worst case the renderer's next list call
        // shows the edit and the user re-saves to retry the reload.
        console.warn('[rubrics:save] reload after save failed:', err?.message || err);
      }
    }
    return { ok: true, errors: [], warnings: result.warnings || [], applied };
  });

  ipcMain.handle('rubrics:create', (_event, payload = {}) => {
    return rubricStore.createRubric({
      name: typeof payload.name === 'string' ? payload.name : '',
      copyFrom: typeof payload.copyFrom === 'string' ? payload.copyFrom : undefined,
    });
  });

  ipcMain.handle('rubrics:duplicate', (_event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    return rubricStore.duplicateRubric(id, {
      newName: typeof payload.newName === 'string' ? payload.newName : '',
    });
  });

  ipcMain.handle('rubrics:delete', (_event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    return rubricStore.deleteRubric(id);
  });

  ipcMain.handle('rubrics:set-active', (_event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id) return { ok: false, reason: 'id_required' };

    // Refuse mid-call swaps. Architecture invariant #2: the active
    // rubric is loaded once at session start; mid-call hot-swap is
    // forbidden. The renderer surfaces this as "End the current call
    // before switching rubrics."
    if (liveSession || coachSession) return { ok: false, reason: 'call_in_progress' };

    const result = rubricStore.setActiveRubric(id);
    if (!result.ok) return result;

    try {
      reloadActiveRubric();
    } catch (err) {
      console.warn('[rubrics:set-active] reloadActiveRubric failed:', err?.message || err);
      return { ok: false, reason: 'reload_failed' };
    }

    // Defensive Coach teardown. When the session is idle (the only
    // path through this branch) coachSession is already null, but
    // mirror the claim-and-stop pattern from teardownSession so a
    // future code path that leaves a stale Coach reference around
    // doesn't leak its old tool schemas into the next call.
    const c = coachSession;
    coachSession = null;
    if (c) {
      try { c.stop(); } catch { /* ignore */ }
    }

    broadcastRubricsChanged({ activeId: id, reason: 'set-active' });
    return { ok: true };
  });

  ipcMain.handle('rubrics:export', (_event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    return rubricStore.exportRubric(id);
  });

  ipcMain.handle('rubrics:import', (_event, payload = {}) => {
    const json = typeof payload.json === 'string' ? payload.json : payload;
    return rubricStore.importRubric(json);
  });

  ipcMain.handle('rubrics:validate', (_event, payload = {}) => {
    return rubricStore.validateRubric(payload.rubric);
  });

  /**
   * Return the built-in default Coach prompt + live-session prompt
   * templates. Used by the Rubrics tab's "Reset to default" buttons
   * under the Coach prompt section — lets the user revert a prompt
   * edit without having to re-create the whole rubric.
   *
   * Not in the v1 plan's "11 channels" list — added when Task 9
   * surfaced a real UX need for it. Returns templates only (no
   * catalogue blocks); the runtime composer re-emits the catalogue
   * sections at concat time.
   */
  ipcMain.handle('rubrics:get-default-prompts', () => {
    return {
      ok: true,
      coachSystemInstruction: DEFAULT_RUBRIC.prompts.coachSystemInstruction,
      liveSystemInstruction: DEFAULT_RUBRIC.prompts.liveSystemInstruction,
      voiceAndTone: DEFAULT_RUBRIC.prompts.voiceAndTone,
    };
  });

  // Audio chunks are high-frequency and fire-and-forget — use `send` not `invoke`.
  //
  // Channel 1 = salesperson mic. Fan out to BOTH consumers:
  //   - Gemini Live (for fast flag detection on the salesperson side)
  //   - Deepgram channel 1 (for the 'you' transcript)
  ipcMain.on('gemini:audio:channel1', (_event, chunk) => {
    if (liveSession) liveSession.sendAudio(chunk);
    if (deepgramSession) deepgramSession.sendAudio({ channel: 1, chunk });
  });

  // Channel 2 = system audio loopback (prospect's voice as heard
  // through the system speakers / Zoom output). Only Deepgram needs
  // this — Gemini Live's flag detection is scoped to the salesperson's
  // own behaviour and feeding it the prospect's voice would confuse
  // the flag rules (e.g. "bundled question" must apply to the seller).
  ipcMain.on('gemini:audio:channel2', (_event, chunk) => {
    if (deepgramSession) deepgramSession.sendAudio({ channel: 2, chunk });
  });
}

app.whenReady().then(async () => {
  /**
   * Seed the on-disk rubric library on first launch.
   *
   * Defence-in-depth: src/rubric.js already calls loadActiveRubric() at
   * module init time, and the store falls back to ensureSeeded() if
   * the directory is missing. But because the explicit seed is cheap
   * (idempotent, single-file existsSync check) and the failure mode of
   * silently shipping an empty rubric library would be hard to debug,
   * we run it again here BEFORE registerIpcHandlers wires up the
   * `rubrics:list` channel. By the time the renderer can call that
   * channel the seed has run.
   */
  try {
    rubricStore.ensureSeeded();
  } catch (err) {
    console.warn('[main] rubricStore.ensureSeeded threw:', err?.message || err);
  }

  // Auto-grant media (mic/camera) permission requests from the renderer.
  // The OS-level prompt still gates real access on macOS/Windows.
  //
  // Clipboard write is also allowed so the call-summary modal's
  // Copy JSON / Copy Markdown buttons can use `navigator.clipboard.
  // writeText()` directly. Without this, Electron's default-deny
  // path rejected the request and the buttons silently failed with
  // a "Copy failed." toast. The renderer also has an IPC fallback
  // via window.gemini.clipboard.writeText() that uses Electron's
  // native clipboard module — that path doesn't go through this
  // handler, so the buttons would still work even if a future
  // tighten-up flips clipboard off here.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (
      permission === 'media' ||
      permission === 'audioCapture' ||
      permission === 'microphone' ||
      permission === 'display-capture' ||
      permission === 'clipboard-sanitized-write' ||
      permission === 'clipboard-read'
    ) {
      return callback(true);
    }
    callback(false);
  });

  /**
   * Phase 4: handle the renderer's `getDisplayMedia()` request that
   * captures the system audio loopback. Without this handler Electron
   * would either pop up its built-in picker (no audio capable) or
   * outright reject the request.
   *
   * On macOS 13+ `audio: 'loopback'` routes the system output through
   * ScreenCaptureKit — that's what gives us the prospect's voice as
   * heard through Zoom / Meet / etc. The browser API requires a video
   * track in the response even though we only want the audio; we hand
   * over the first available screen source and the renderer
   * immediately stops + discards the video track.
   *
   * If `desktopCapturer.getSources` returns nothing (e.g. user denied
   * Screen Recording at the OS level) we respond with an empty object
   * and the renderer surfaces the explainer modal.
   */
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (process.platform === 'darwin') {
      try {
        const status = systemPreferences.getMediaAccessStatus('screen');
        console.log('[display-media] screen-recording status:', status);
        if (status !== 'granted') {
          console.warn(
            '[display-media] permission not granted at OS level (' + status + '). ' +
            'Add the Electron binary to System Settings → Privacy → Screen & System Audio Recording. ' +
            'Path: node_modules/electron/dist/Electron.app',
          );
          callback({});
          return;
        }
      } catch (err) {
        console.warn('[display-media] getMediaAccessStatus failed:', err?.message || err);
      }
    }
    try {
      // Phase 2: respect the user's persisted system-audio source ID
      // from the Audio tab. We pull both screens AND windows because
      // the picker offers both; the fallback when no preference is
      // set (or the persisted id has gone stale, e.g. the chosen
      // window was closed) is sources[0] — same as the original
      // hardcoded behaviour, so an empty `audio.systemAudioSourceId`
      // is a no-regression default.
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (!sources || sources.length === 0) {
        console.warn('[display-media] desktopCapturer returned 0 sources');
        callback({});
        return;
      }

      const persistedId = getAudio().systemAudioSourceId || '';
      let chosen = null;
      let pickReason = 'fallback';
      if (persistedId) {
        chosen = sources.find((s) => s.id === persistedId) || null;
        if (chosen) {
          pickReason = 'settings';
        } else {
          console.warn(
            '[display-media] persisted systemAudioSourceId not found in current sources ' +
            '— falling back to sources[0]. The Audio tab dropdown should re-populate ' +
            'on next open and surface "Default (first available screen)" as the ' +
            'effective selection.',
          );
        }
      }
      if (!chosen) chosen = sources[0];

      console.log(
        `[display-media] handing source to renderer (${pickReason}):`,
        chosen.name,
      );
      callback({ video: chosen, audio: 'loopback' });
    } catch (err) {
      console.warn('[display-media] handler failed:', err?.message || err);
      callback({});
    }
  });

  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      // Non-fatal: the renderer will surface "Mic blocked" if denied.
    }
  }

  registerIpcHandlers();

  // Standard macOS menu so Cmd+W / Cmd+Q work on the frameless window.
  // (Without an app menu, accelerators don't get a hosting menu item and the
  // window can't be closed except via Activity Monitor — exactly what we
  // just hit.)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close', accelerator: 'Cmd+W' },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // Belt-and-braces global shortcut for hiding the overlay even when it
  // doesn't have keyboard focus (frameless windows often don't).
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const w = mainWindowRef;
    if (!w || w.isDestroyed()) return;
    if (w.isVisible()) w.hide();
    else w.show();
  });

  createWindow();
  createTray();

  app.on('second-instance', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore();
      mainWindowRef.show();
      mainWindowRef.focus();
    }
  });

  // macOS dock-icon click. The default Electron handler only recreates
  // a window when none exist — but for this single-window overlay we
  // also want to lift a hidden / minimised window back to the front,
  // since both states are reachable via the in-app Minimise button
  // and the Cmd+Shift+H global shortcut. `showAndFocusMainWindow`
  // covers all three start states (destroyed → recreate, minimised →
  // restore, hidden → show) so the dock icon behaves the same way the
  // tray icon does.
  app.on('activate', () => {
    showAndFocusMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // For an overlay/tool app we want closing the window to actually exit the
  // process — on macOS the default behaviour is to keep the app alive in the
  // dock, which would leave the single-instance lock held and confuse the
  // next launch.
  teardownSession();
  app.quit();
});

app.on('before-quit', () => {
  teardownSession();
  // Explicit tray teardown. On Windows the notification-area icon
  // can linger until the user hovers over it if we don't destroy
  // it ourselves; macOS / Linux clean up automatically but the
  // explicit call is harmless and keeps the lifecycle symmetric
  // with createTray() above.
  if (tray) {
    try { tray.destroy(); } catch { /* ignore */ }
    tray = null;
  }
});
