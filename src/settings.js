import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/* ────────────────────────────────────────────────────────────────────
 * SETTINGS EXPANSION — PHASE ROADMAP
 *
 * Phase 1 (this file, schema v3) ships the foundation: six top-level
 * blocks aligned to the six tabs in the Settings modal, plus Reset /
 * Export / Import helpers (see bottom of file). Phases 2-6 each
 * populate exactly one of the empty / lightly-populated blocks:
 *
 *   Phase 2 — Audio tab  (settings.audio.*)
 *     T1 micDeviceId, T2 systemAudioSourceId, T3 aec, T4 noiseSuppression,
 *     T5 autoGainControl, T14 deepgramModel, V10 hideAecBadge.
 *
 *   Phase 3 — Appearance expansion  (settings.appearance.*)
 *     V2 accent, V6 windowSize, V7/V8 windowPosition, V9 alwaysOnTop,
 *     V13 railStyle, V14 capturedPaneVisible, V15 suggestionCardStyle,
 *     V16 pillarTintsEnabled, V20 summaryGlass.
 *     (V3 "opacity" is now landed as `appearance.transparency` —
 *      per-surface 0..1 alpha for outline / body / text on the four
 *      controllable overlay surfaces, plus three named preset slots
 *      under `appearance.transparencyPresets`. Supersedes the original
 *      single-knob V3 design.)
 *
 *   Phase 4 — Coach tuning  (settings.coach.*)
 *     T6 tickMs, T7 pauseThresholdMs, T9 kickstartDelayMs,
 *     T10 reformulateDelayMs, T11 transcriptWindowLines, T16 costCap,
 *     T18 temperature, T19 debugLogging, T21 networkProxy.
 *
 *   Phase 5 — Workflow & persistence  (settings.general.*)
 *     U4 autoTestKeyOnPaste, U5 transcriptSavePath, U6 summarySavePath,
 *     T17 liveCostMeter, T20 crashAutosave, U17 perCallRubric,
 *     U19 pillarsEnabled.
 *
 *   Phase 6 — Onboarding & help  (settings.help.*)
 *     U3 firstRunCompleted, U23 cheatSheetEnabled, U24 tourCompleted.
 *
 * Each phase only touches its own block + the renderer wiring for its
 * tab. Cross-phase fields stay out — keeps merges trivial and lets a
 * future per-phase rollback drop one block without disturbing siblings.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Persistent app settings.
 *
 * Storage choice
 * ─────────────────────────────────────────────────────────────────────
 * `electron-store` is NOT a dep (verified at scaffold time). To avoid
 * pulling in a new dependency unilaterally we hand-roll a tiny JSON
 * file store under `app.getPath('userData')`. The footprint is small
 * enough that swapping to electron-store later is a one-file change
 * if/when richer features (schema validation, migrations, watchers)
 * are needed.
 *
 * File path
 *   macOS:   ~/Library/Application Support/Two Way Flow/settings.json
 *   Win:     %APPDATA%/Two Way Flow/settings.json
 *   Linux:   ~/.config/Two Way Flow/settings.json
 *
 * Shape (schemaVersion = 3)
 *   {
 *     schemaVersion: 3,
 *     defaultProvider: 'gemini' | 'anthropic' | 'openai',
 *     providers: {
 *       anthropic: { apiKey: '', defaultModel: 'claude-3-5-sonnet-latest' },
 *       gemini:    { apiKey: '', defaultModel: 'gemini-2.5-flash' },
 *       openai:    { apiKey: '', defaultModel: 'gpt-5' },
 *     },
 *     models: {
 *       summary: 'gemini-2.5-flash',   // post-call debrief — Gemini-only for now
 *     },
 *     appearance: {
 *       tagColors: {
 *         you:   '#f0f0f0',   // YOU transcript-label colour
 *         other: '#c7d2fe',   // PROSPECT transcript-label colour
 *       },
 *       transparency: {
 *         // Per-surface 0..1 alpha for outline / body / text on the
 *         // four controllable overlay surfaces (.coach, .transcript-pane,
 *         // .captured, .suggestion). The renderer mirrors these into
 *         // --surface-<name>-{outline,body,text}-alpha on every
 *         // settings:changed broadcast; src/index.css composes the
 *         // final rgba via color-mix(...). Defaults below match the
 *         // pre-refactor literal alphas exactly so a fresh install or
 *         // a back-filled older settings file boots visually identical.
 *         coach:      { outline, body, text },
 *         transcript: { outline, body, text },
 *         captured:   { outline, body, text },
 *         suggestion: { outline, body, text },
 *       },
 *       transparencyPresets: {
 *         // Three reusable preset slots. Each slot has a renameable
 *         // `name` label and a `values` block that mirrors the shape of
 *         // `appearance.transparency`. Loading a preset writes only into
 *         // `appearance.transparency` — other appearance.* fields stay
 *         // intact. Slot defaults: 'Day' (legible on bright screens),
 *         // 'Night' (today's literal look), 'Demo' (punchy borders for
 *         // screenshots).
 *         slot1: { name, values: { coach, transcript, captured, suggestion } },
 *         slot2: { ... },
 *         slot3: { ... },
 *       },
 *       // Phase 3 — Appearance expansion will land here:
 *       //   accent, density, windowSize, windowPosition,
 *       //   alwaysOnTop, railStyle, capturedPaneVisible,
 *       //   suggestionCardStyle, pillarTintsEnabled, summaryGlass.
 *     },
 *     audio: {
 *       // Phase 2 — Audio tab will land here:
 *       //   micDeviceId, systemAudioSourceId, aec, noiseSuppression,
 *       //   autoGainControl, deepgramModel, hideAecBadge.
 *     },
 *     coach: {
 *       trackQuestionState: false,
 *       autoReformulate: false,
 *       // Phase 4 — Coach tuning will land here:
 *       //   tickMs, pauseThresholdMs, kickstartDelayMs,
 *       //   reformulateDelayMs, transcriptWindowLines,
 *       //   costCap, temperature, debugLogging, networkProxy.
 *     },
 *     general: {
 *       // Phase 5 — Workflow & persistence will land here:
 *       //   autoTestKeyOnPaste, transcriptSavePath, summarySavePath,
 *       //   liveCostMeter, crashAutosave, perCallRubric, pillarsEnabled.
 *     },
 *     help: {
 *       // Phase 6 — Onboarding & help will land here:
 *       //   firstRunCompleted, cheatSheetEnabled, tourCompleted.
 *     },
 *   }
 *
 *   v1 (apiKeys.<provider>, models.coach) and v2 (advanced.*) shapes
 *   are migrated forward on load. See migrateSettings() below for the
 *   exact mapping. v3 files that pre-date later top-level additions
 *   are back-filled by deepMerge inside migrateSettings()/loadSettings()'s
 *   defaults-fill path — no schema bump needed for additive changes
 *   within a major version.
 *
 * In-memory cache
 *   loadSettings() reads from disk on first call and caches the
 *   result. Subsequent calls return the cache. saveSettings() deep-
 *   merges into the cache, then writes back. This means any code path
 *   that calls getApiKey / getModelFor after the IPC handler has been
 *   registered will see fresh values without a disk hit.
 *
 * Extension points
 *   - Add new top-level keys (`audio`, `general`, …) by extending
 *     DEFAULT_SETTINGS — deepMerge preserves user overrides.
 *   - To add a new provider, add a key to providers + an entry to
 *     PROVIDER_ENV_VARS. getApiKey / getProviderStatus pick it up
 *     automatically.
 *   - To add a new configurable service that ISN'T provider-routed
 *     (i.e. always Gemini today), add a key to `models` and read via
 *     getModelFor(). Coach uses the per-provider defaultModel via the
 *     provider abstraction instead.
 *   - Phase 2-6 each populate exactly one of the new top-level blocks
 *     (audio / appearance / coach / general / help). Keep new keys
 *     scoped to their phase's block so a future per-phase rollback
 *     stays contained to a single sub-tree.
 */

const SCHEMA_VERSION = 3;

/**
 * Authoritative shape. Exported as DEFAULT_SETTINGS per the spec — the
 * legacy `DEFAULTS` alias is also exported so any in-repo caller that
 * happened to import it (none today, but search-friendly) keeps
 * working.
 *
 * Six top-level blocks correspond 1:1 with the six tabs in the Settings
 * modal (Providers / Audio / Appearance / Coach / General / Help). The
 * `audio`, `general`, and `help` blocks are intentionally empty in
 * Phase 1 — they're populated by phases 2, 5, and 6 respectively. The
 * presence of the empty blocks keeps the migration path linear: any
 * future field added under one of them only needs a defaults-fill,
 * never a schema bump.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  defaultProvider: 'gemini',
  // Per-provider defaults track each vendor's current "balanced /
  // recommended" tier as of May 2026 — fast enough for the Coach's
  // tick cadence but smart enough to follow the rubric. The user can
  // override per-provider in Settings → Providers; legacy IDs they
  // had saved (claude-3-5-sonnet-latest, gpt-4o, …) are auto-upgraded
  // by upgradeDeprecatedModelIds() below on load.
  providers: {
    anthropic: {
      apiKey: '',
      defaultModel: 'claude-sonnet-4-6',
    },
    gemini: {
      apiKey: '',
      defaultModel: 'gemini-3.5-flash',
    },
    openai: {
      apiKey: '',
      defaultModel: 'gpt-5.5',
    },
  },
  models: {
    // Post-call debrief is Gemini-only today. 3.5 Flash is described
    // by Google as "near-Pro intelligence at Flash-tier cost" — ideal
    // for a one-shot structured-output task like the summary.
    summary: 'gemini-3.5-flash',
  },
  /**
   * Per-feature provider overrides (Strategy A / Work-stream C).
   *
   * `quickFix` is the Stage-2 background worker that rolls a sheet
   * of structured meeting facts up into a single annualised USD
   * opportunity. It uses its own provider+model rather than sharing
   * the coach's because the workloads are different:
   *
   *   - The coach runs every 1.5 s on a rolling window; latency is
   *     load-bearing, so a Flash-tier model is the right pick.
   *   - The quick-fix worker fires at most every ~2.5 s of fact
   *     activity, and the rep is allowed to wait a beat for a more
   *     accurate rollup. Pro-tier reasoning models earn their keep
   *     here because the model has to (a) annualise across mixed
   *     units, (b) detect double-counts across rephrased facts, and
   *     (c) confidence-score the result.
   *
   * Empty strings mean "fall back to the coach's routed provider /
   * model" — that's the safe default for the first install. The
   * accessor `getQuickFix()` resolves the cascade.
   *
   * No matching Settings UI in v1 — the rep can hand-edit
   * `settings.json` if they want to override. A future Coach-tab
   * field can add the picker without touching consumers because
   * everything reads through `getQuickFix()`.
   */
  quickFix: {
    /** @type {''|'gemini'|'anthropic'|'openai'} */
    provider: '',
    /** @type {string} */
    model: '',
  },
  /**
   * Stage-1 facts scanner (rearchitected pipeline, post-test-call
   * fixes batch 2 / Issue 3).
   *
   * Owns the periodic AI sweep that extracts monetary / time /
   * headcount / percentage / opportunity facts from the rolling
   * transcript. Each tick the scanner reads the lines committed since
   * its previous run, asks the configured provider for zero-or-more
   * `record_meeting_fact`-shaped JSON objects, and appends them to
   * `coachContext.factsSheet.entries`. Stage-2 (`src/quick-fix.js`)
   * then debounces and rolls the entries up into the headline total.
   *
   * Why this lives outside the Coach now:
   *   The Coach used to own `record_meeting_fact` as one of its
   *   per-tick tools. That coupled (a) the fast 1.5 s lifecycle-
   *   tracking loop with (b) the slower, more expensive "extract a
   *   complete list of facts from the chunk" task. Splitting the two
   *   lets the Coach stay narrowly focused on rubric scoring + ask
   *   suggestions, and lets the scanner take the longer cadence it
   *   actually needs.
   *
   * Cadence:
   *   `intervalMs` is the period between scans. 12 s is the default —
   *   short enough that a fact stated during the call is reflected in
   *   the headline within the same conversational beat, long enough
   *   that the per-tick model cost stays bounded. The spec called for
   *   ~10 s but flagged that as "probably too short"; 12-15 s is the
   *   pragmatic window.
   *
   *   `enabled: false` falls back to the old behaviour (no scanner
   *   tick, no fact emission). Provided for testability + a manual
   *   kill-switch if a future model regression makes the scanner
   *   chatty.
   *
   * Provider routing intentionally reuses the existing `quickFix`
   * cascade via `getQuickFix()` — both AI passes belong to the same
   * "background financial analyst" workflow so the user's provider
   * choice should apply uniformly.
   */
  factsScanner: {
    /** @type {number} */
    intervalMs: 12_000,
    /** @type {boolean} */
    enabled: true,
  },
  // Visual customisation. Right now this is just speaker-label tag
  // colours for the live transcript pane + summary modal; future
  // theming knobs (font scale, accent colour, …) should be added here
  // under sibling keys so the renderer can keep a single `appearance`
  // form section. Defaults must visually match the original hard-coded
  // CSS values (see src/index.css's :root --speaker-color-* fallbacks)
  // so an upgrade doesn't visibly shift the transcript on first boot.
  appearance: {
    tagColors: {
      you: '#f0f0f0',
      other: '#c7d2fe',
    },
    // Per-surface alpha for the four controllable overlay surfaces.
    // Values are raw 0..1 numerics; src/index.css composes the final
    // colour via color-mix(in srgb, <hue> calc(var(--surface-X-Y-alpha)
    // * 100%), transparent). Defaults below MUST equal the pre-refactor
    // literal alphas in src/index.css so a fresh install (or a deep-
    // merge back-fill of an older settings file) boots visually
    // identical to the version that shipped without this block.
    transparency: {
      coach:      { outline: 0,    body: 0.9,  text: 0.94 },
      transcript: { outline: 0.08, body: 0.03, text: 0.94 },
      captured:   { outline: 0.08, body: 0.03, text: 0.66 },
      suggestion: { outline: 0.08, body: 0.10, text: 0.94 },
    },
    // Three reusable preset slots. `name` is a short renameable label
    // (≤20 chars in the editor UI); `values` mirrors the shape of
    // `appearance.transparency`. Loading a preset writes ONLY into
    // `appearance.transparency` — never into other appearance.* fields.
    // Slot 2 ("Night") exactly equals the live default so the current
    // look is always one click away after the user starts experimenting.
    transparencyPresets: {
      slot1: {
        name: 'Day',
        values: {
          coach:      { outline: 0,    body: 0.65, text: 0.94 },
          transcript: { outline: 0.12, body: 0.08, text: 0.94 },
          captured:   { outline: 0.12, body: 0.08, text: 0.78 },
          suggestion: { outline: 0.12, body: 0.18, text: 0.94 },
        },
      },
      slot2: {
        name: 'Night',
        values: {
          coach:      { outline: 0,    body: 0.9,  text: 0.94 },
          transcript: { outline: 0.08, body: 0.03, text: 0.94 },
          captured:   { outline: 0.08, body: 0.03, text: 0.66 },
          suggestion: { outline: 0.08, body: 0.10, text: 0.94 },
        },
      },
      slot3: {
        name: 'Demo',
        values: {
          coach:      { outline: 0,    body: 0.4,  text: 1.0 },
          transcript: { outline: 0.2,  body: 0.05, text: 1.0 },
          captured:   { outline: 0.2,  body: 0.05, text: 0.9 },
          suggestion: { outline: 0.2,  body: 0.18, text: 1.0 },
        },
      },
    },
  },
  /**
   * Audio capture + STT controls (Phase 2). Defaults match today's
   * hardcoded behaviour exactly — a settings file that pre-dates
   * Phase 2 (lacking any `audio.*` overrides) boots indistinguishably
   * from the original pipeline.
   *
   * Apply policy:
   *   - `hideAecBadge` (V10) — immediate. Pure DOM visibility, applied
   *     on every settings load / settings:changed broadcast.
   *   - everything else — next call only. getUserMedia /
   *     getDisplayMedia / Deepgram WS bake their config at session-
   *     open time; the Audio tab surfaces a small "Changes apply on
   *     next Start" hint when state.status !== 'idle'.
   *
   * Field map:
   *   T1  micDeviceId          ''  = OS default mic (no deviceId
   *                                  constraint on getUserMedia)
   *   T2  systemAudioSourceId  ''  = first available screen
   *                                  (current behaviour — sources[0])
   *   T3  aec                  true  echoCancellation constraint
   *                                  on the mic chain. Note: a
   *                                  Chromium force-flag in main.js
   *                                  may override `false` on some
   *                                  platforms — see comment there.
   *   T4  noiseSuppression     true  noiseSuppression constraint
   *   T5  autoGainControl      true  autoGainControl constraint
   *   T14 deepgramModel        'nova-3'  Deepgram listen.v1 model
   *                                       (passed through to the
   *                                       WS query string at connect
   *                                       time — model change requires
   *                                       a fresh WS, which the
   *                                       reconnect plumbing already
   *                                       handles on next call).
   *   V10 hideAecBadge         false  hide #aecBadge in the header
   *                                  (does not stop the badge state
   *                                  machine from updating internally
   *                                  — un-hiding restores the
   *                                  current state without a refresh).
   */
  audio: {
    micDeviceId: '',
    systemAudioSourceId: '',
    aec: true,
    noiseSuppression: true,
    autoGainControl: true,
    deepgramModel: 'nova-3',
    hideAecBadge: false,
  },
  /**
   * Experimental coach-behaviour toggles. All default OFF so the
   * existing pipeline is unchanged unless the user explicitly opts in.
   *
   * Renamed from `advanced` in schema v3 to match the new "Coach" tab
   * label. The migration in migrateSettings() handles the rename so
   * older settings files continue to load.
   *
   *   trackQuestionState  — the coach uses a per-tick
   *     `mark_question_asked` tool to validate, against the
   *     transcript, which previously-pinned suggestions the
   *     seller actually asked. Asked entries surface with a
   *     green outline + faint green tint in the drawer's
   *     `logged_questions` synthetic pillar.
   *
   *   autoReformulate     — every 10s, if a pinned suggestion
   *     is still unasked, the coach generates a fresh wording
   *     of the same intent and replaces the pinned suggestion.
   *     Requires `trackQuestionState` (without "asked" detection
   *     there's no way to know when to stop reformulating).
   *
   * Phase 4 will add the timing knobs (tickMs, pauseThresholdMs,
   * kickstartDelayMs, …) under this same block. Missing `coach` field
   * on an older settings file is fine — the deep-merge default
   * fallback in loadSettings fills it in (after the v2→v3 migration
   * promotes the old `advanced` block, when present).
   */
  coach: {
    trackQuestionState: false,
    autoReformulate: false,
  },
  /**
   * General workflow + persistence. Empty in Phase 1; Phase 5 lands
   * auto-test-key-on-paste, transcript/summary autosave folders, the
   * live cost meter toggle, crash-recovery autosave, per-call rubric
   * selection, and pillar enable/disable.
   *
   * Also hosts the **Data** subsection (export / import / reset)
   * landed in Phase 1, but those are pure UI actions — they don't
   * read or write any field under `general` itself.
   */
  general: {},
  /**
   * Onboarding + help surfaces. Empty in Phase 1; Phase 6 lands
   * first-run-wizard completion flag, cheat-sheet toggle, and the
   * onboarding-tour completion flag (so the user can re-trigger it
   * from this tab).
   */
  help: {},
});

export const DEFAULTS = DEFAULT_SETTINGS;

/** Provider → env var name. Used by getApiKey() to fall back to the
 *  process env when the settings file leaves a slot blank. */
const PROVIDER_ENV_VARS = Object.freeze({
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
});

/** Provider → env var (publicly exported so the renderer can render
 *  "Using env variable" badges without hard-coding the mapping). The
 *  shape is intentionally identical to PROVIDER_ENV_VARS — we just
 *  expose it under a friendlier name. */
export function envVarForProvider(provider) {
  return PROVIDER_ENV_VARS[provider] || null;
}

/** Cached settings, lazy-loaded. `null` until the first loadSettings()
 *  call returns. Subsequent calls hit the cache; saveSettings() updates
 *  it in place. */
let cache = null;

/** Resolve the settings file path. Lazy because `app.getPath` may not
 *  be valid until after `app.whenReady()` in some older Electron
 *  versions — current 42 is fine pre-ready, but the lazy guard costs
 *  nothing and keeps us defensive. */
function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Recursive merge — `partial`'s leaf values override `base`'s.
 * Arrays are replaced wholesale (we don't have any in the current
 * schema, but the rule prevents future surprises). Anything that
 * isn't a plain object on `base` is replaced regardless of `partial`'s
 * shape — i.e. you can't accidentally turn `providers.gemini.apiKey`
 * (a string) into an object via a bad partial.
 */
function deepMerge(base, partial) {
  if (!partial || typeof partial !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(partial)) {
    const existing = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function cloneDefaults() {
  return deepMerge({}, DEFAULT_SETTINGS);
}

/**
 * Migrate a loaded settings object up to the current schema version.
 * Idempotent — anything that's already at SCHEMA_VERSION (or higher) is
 * returned unchanged after a defaults-fill.
 *
 * Migration steps are layered so each step only has to understand the
 * previous version's shape. The chain currently looks like:
 *
 *   v1 (apiKeys.*, models.coach) → v2 (providers.*.{apiKey, defaultModel})
 *   v2 (advanced.*)              → v3 (coach.*, + empty audio/general/help)
 *
 * v1 mapping
 *   - apiKeys.gemini    → providers.gemini.apiKey
 *   - apiKeys.anthropic → providers.anthropic.apiKey
 *   - apiKeys.openai    → providers.openai.apiKey
 *   - models.coach      → providers.gemini.defaultModel (best-effort —
 *                         a user who'd somehow set this to a non-Gemini
 *                         string in v1 keeps the value here; the coach
 *                         will only consult the per-provider default
 *                         that matches its routed provider so an
 *                         unreachable value is harmless).
 *   - models.summary    → models.summary (preserved as-is).
 *
 * v2 → v3 mapping
 *   - advanced.trackQuestionState → coach.trackQuestionState
 *   - advanced.autoReformulate    → coach.autoReformulate
 *   - audio / general / help      → seeded empty (Phases 2/5/6 populate)
 *
 * Returns the migrated object — caller is responsible for writing it
 * back to disk if the migration produced a change.
 */
export function migrateSettings(loaded) {
  if (!loaded || typeof loaded !== 'object') return cloneDefaults();

  const version = Number(loaded.schemaVersion);
  if (Number.isFinite(version) && version >= SCHEMA_VERSION) {
    // Already current; just defaults-fill missing keys. Any new
    // top-level block added to DEFAULT_SETTINGS after a user's last
    // save gets seeded here without a version bump — deepMerge keeps
    // existing leaves and only fills holes. This is the fast path on
    // every boot after the user's first run on a given schema.
    return deepMerge(cloneDefaults(), loaded);
  }

  // Sequential migrations. Each step assumes input is at the previous
  // version (or at least shaped close enough that defensive reads still
  // work). We start by promoting v1 → v2 in memory if needed, then
  // promote v2 → v3.
  let working = loaded;
  if (!Number.isFinite(version) || version < 2) {
    working = migrateV1ToV2(working);
  }
  // `working` is now v2-shaped (or close enough — extra fields are
  // tolerated by the v2→v3 step which only reads the keys it cares
  // about). Promote to v3.
  const migrated = migrateV2ToV3(working);
  migrated.schemaVersion = SCHEMA_VERSION;
  return migrated;
}

/**
 * v1 → v2: lift `apiKeys.<provider>` and `models.coach` into the v2
 * `providers.<provider>.{apiKey, defaultModel}` shape. Anything the v1
 * file didn't set falls back to defaults via deepMerge. Returns a v2-
 * shaped object — does NOT bump schemaVersion (the caller chains into
 * v2→v3 immediately, which will set the final version).
 */
function migrateV1ToV2(v1) {
  if (!v1 || typeof v1 !== 'object') return cloneDefaults();
  const migrated = cloneDefaults();

  const v1Keys = v1.apiKeys && typeof v1.apiKeys === 'object' ? v1.apiKeys : {};
  for (const provider of Object.keys(migrated.providers)) {
    const v1Key = v1Keys[provider];
    if (typeof v1Key === 'string' && v1Key.length > 0) {
      migrated.providers[provider].apiKey = v1Key;
    }
  }

  const v1Models = v1.models && typeof v1.models === 'object' ? v1.models : {};
  if (typeof v1Models.coach === 'string' && v1Models.coach.length > 0) {
    // v1 only ever ran the coach on Gemini, so pull the value into the
    // Gemini provider's defaultModel. The downstream coach reads the
    // ROUTED provider's defaultModel; if the user later switches the
    // default provider this value just becomes "the Gemini default
    // they last chose", which is the right semantic.
    migrated.providers.gemini.defaultModel = v1Models.coach;
  }
  if (typeof v1Models.summary === 'string' && v1Models.summary.length > 0) {
    migrated.models.summary = v1Models.summary;
  }

  // Preserve the v1 `appearance` block as-is if present. The v2 shape
  // was the first to include it; users on actual v1 wouldn't have
  // appearance.tagColors set, so deepMerge fills the defaults.
  if (v1.appearance && typeof v1.appearance === 'object') {
    migrated.appearance = deepMerge(migrated.appearance, v1.appearance);
  }

  return migrated;
}

/**
 * v2 → v3: rename `advanced.*` → `coach.*` (the toggles' shape is
 * identical, only the parent key changed) and seed empty `audio`,
 * `general`, `help` blocks for Phases 2 / 5 / 6 to populate. All other
 * fields pass through untouched via deepMerge so a v2 file with the
 * tagColors customised, providers configured, etc., keeps every leaf.
 */
function migrateV2ToV3(v2) {
  if (!v2 || typeof v2 !== 'object') return cloneDefaults();
  // Start from defaults so the empty audio/general/help blocks are
  // present, then layer the v2 fields on top.
  const migrated = deepMerge(cloneDefaults(), v2);

  // Promote v2's `advanced` block into v3's `coach` block. We read from
  // the original `v2.advanced` rather than the merged `migrated.advanced`
  // because the deepMerge above didn't have an `advanced` slot in the
  // defaults — so any field the user had set is still in `v2.advanced`.
  if (v2.advanced && typeof v2.advanced === 'object') {
    migrated.coach = deepMerge(migrated.coach, v2.advanced);
  }
  // Drop the legacy block from the migrated shape so it doesn't get
  // re-persisted alongside `coach`. This keeps disk reads compact and
  // prevents a future bug where someone reads `advanced.*` and gets a
  // stale snapshot.
  delete migrated.advanced;

  return migrated;
}

/**
 * Read the settings file from disk. Returns the parsed object on
 * success, or null if the file is missing / unreadable / malformed.
 * Malformed contents are logged but never throw — the caller falls
 * back to defaults so a corrupted settings file can't brick the app.
 */
function readFromDisk() {
  const filePath = settingsFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn('[settings] failed to read settings file:', err?.message || err);
    return null;
  }
}

/**
 * Write the cached settings to disk. Creates the userData directory
 * if it doesn't exist. Best-effort: write failures are logged but
 * don't throw — the in-memory cache stays correct so the current
 * session keeps the new values.
 */
function writeToDisk(settings) {
  const filePath = settingsFilePath();
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.warn('[settings] failed to write settings file:', err?.message || err);
  }
}

/**
 * Map of deprecated / retired model IDs → the vendor-recommended
 * replacement as of May 2026. Applied by upgradeDeprecatedModelIds()
 * on every settings load so a user with a stale saved value gets
 * silently bumped to a working model instead of seeing API errors
 * (e.g. claude-3-5-sonnet-latest → 404 after the 3.5 → 4 retirement,
 * gpt-4o → still works today but will retire 2026-10-23, …).
 *
 * Rules for what belongs here:
 *   - the old ID is RETIRED or scheduled to retire soon, AND
 *   - the new ID is a drop-in API replacement (same request/response
 *     shape, same tool-calling support, no behavioural surprise that
 *     would silently break the Coach).
 *
 * IDs that are merely "older but still active" (e.g. claude-sonnet-4-5)
 * stay out of this map — the user explicitly picked them and may have
 * good reasons (cost tier, eval results). We only fix what's broken.
 *
 * Extension: add a new line per retirement. Removing entries is fine
 * once the original ID has been gone for a release cycle — until then
 * keep the upgrade so a user opening an old settings export doesn't
 * land on a 404.
 */
const DEPRECATED_MODEL_UPGRADES = Object.freeze({
  // Anthropic — Claude 3.5 family is fully retired; Claude 4.0 retires
  // 2026-06-15 (snapshot AND alias). Bump to 4.6/4.7 generation, which
  // is the official recommended replacement per Anthropic's deprecation
  // table.
  'claude-3-5-sonnet-latest': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-6',
  'claude-3-5-haiku-latest': 'claude-haiku-4-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-opus-20240229': 'claude-opus-4-7',
  'claude-3-sonnet-20240229': 'claude-sonnet-4-6',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'claude-opus-4-20250514': 'claude-opus-4-7',
  'claude-opus-4-0': 'claude-opus-4-7',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-sonnet-4-0': 'claude-sonnet-4-6',

  // OpenAI — GPT-4 / 4o family retires 2026-10-23, replaced by GPT-5.5
  // tier per OpenAI's deprecation table. GPT-5.x still works today, no
  // upgrade needed.
  'gpt-4o': 'gpt-5.5',
  'gpt-4o-mini': 'gpt-5.4-mini',
  'gpt-4-turbo': 'gpt-5.5',
  'gpt-4': 'gpt-5.5',
  'gpt-4.1': 'gpt-5.5',
  'gpt-4.1-mini': 'gpt-5.4-mini',
  'gpt-4.1-nano': 'gpt-5.4-nano',
  'gpt-3.5-turbo': 'gpt-5.4-mini',
  'o1': 'gpt-5.5',
  'o1-pro': 'gpt-5.5-pro',
  'o3-mini': 'gpt-5.5',
  'o4-mini': 'gpt-5.4-mini',

  // Gemini — 2.0 family retires 2026-06-01; bump to 2.5 Flash (the
  // closest cost/perf match) rather than 3.5 Flash, so existing users
  // don't get a pricing surprise without opting in via the dropdown.
  'gemini-2.0-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash-001': 'gemini-2.5-flash',
  'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite-001': 'gemini-2.5-flash-lite',
  'gemini-1.5-pro': 'gemini-2.5-pro',
  'gemini-1.5-flash': 'gemini-2.5-flash',
  'gemini-1.5-flash-8b': 'gemini-2.5-flash-lite',
  'gemini-pro': 'gemini-2.5-pro',
});

/**
 * Mutate `settings` in place, walking every place a model ID can be
 * persisted and rewriting it via DEPRECATED_MODEL_UPGRADES. Returns
 * `true` if anything changed (so the caller can decide whether to
 * persist the upgraded shape back to disk).
 *
 * Walked locations:
 *   - providers.<id>.defaultModel  (Coach routing per provider)
 *   - models.summary               (post-call debrief)
 *
 * Unknown IDs (not in the upgrade map) pass through untouched — they
 * might be a brand-new model the user wants to test, or a legitimate
 * legacy value that's still active. We don't second-guess the user;
 * the only thing we fix is values that we KNOW are broken.
 */
function upgradeDeprecatedModelIds(settings) {
  let changed = false;
  if (settings?.providers && typeof settings.providers === 'object') {
    for (const config of Object.values(settings.providers)) {
      if (!config || typeof config !== 'object') continue;
      const current = config.defaultModel;
      if (typeof current === 'string' && DEPRECATED_MODEL_UPGRADES[current]) {
        config.defaultModel = DEPRECATED_MODEL_UPGRADES[current];
        changed = true;
      }
    }
  }
  if (settings?.models && typeof settings.models === 'object') {
    for (const [service, value] of Object.entries(settings.models)) {
      if (typeof value === 'string' && DEPRECATED_MODEL_UPGRADES[value]) {
        settings.models[service] = DEPRECATED_MODEL_UPGRADES[value];
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Load settings. First call reads from disk (or seeds defaults if no
 * file exists yet); subsequent calls return the cached copy. Always
 * returns a fully-populated v3 object — missing keys are back-filled
 * from DEFAULT_SETTINGS, and v1 / v2 files are migrated forward on
 * the first read.
 *
 * If the on-disk file was migrated (i.e. its schemaVersion differed
 * from ours) OR a deprecated model ID was auto-upgraded we write the
 * resulting shape back so subsequent runs hit the fast path. Best-
 * effort — a write failure leaves the cache hot for the current
 * session.
 */
export function loadSettings() {
  if (cache) return cache;
  const fromDisk = readFromDisk();
  let merged;
  let didMigrate = false;
  if (fromDisk) {
    const beforeVersion = Number(fromDisk.schemaVersion);
    merged = migrateSettings(fromDisk);
    if (!Number.isFinite(beforeVersion) || beforeVersion !== SCHEMA_VERSION) {
      didMigrate = true;
    }
  } else {
    merged = cloneDefaults();
  }
  merged.schemaVersion = SCHEMA_VERSION;
  // Quietly rewrite any retired / soon-to-retire model IDs to their
  // current replacement. This is intentionally separate from the
  // schema migration chain because it's an additive cleanup, not a
  // shape change — and the upgrade map is the right place to grow
  // as vendors retire more models without needing a v4 bump.
  const modelsChanged = upgradeDeprecatedModelIds(merged);
  cache = merged;
  if (didMigrate || modelsChanged) {
    writeToDisk(cache);
  }
  return cache;
}

/**
 * Deep-merge `partial` into the cached settings, write back to disk,
 * return the full updated object. The renderer always receives the
 * full settings shape so the form can re-hydrate from the response
 * without a second IPC roundtrip.
 *
 * Empty strings ARE valid values (they mean "clear this slot"). The
 * env-var fallback in getApiKey takes effect automatically when a
 * slot is empty.
 */
export function saveSettings(partial) {
  const current = loadSettings();
  const next = deepMerge(current, partial || {});
  next.schemaVersion = SCHEMA_VERSION;
  cache = next;
  writeToDisk(next);
  return next;
}

/**
 * Look up the configured API key for a provider, falling back to the
 * matching process.env value when the settings slot is blank.
 *
 * Returns an empty string if neither side has a value — callers that
 * need to surface "missing key" errors should check for falsy and
 * react (see the gemini:start handler in main.js).
 */
export function getApiKey(provider) {
  const settings = loadSettings();
  const fromSettings = settings.providers?.[provider]?.apiKey;
  if (typeof fromSettings === 'string' && fromSettings.trim().length > 0) {
    return fromSettings.trim();
  }
  const envName = PROVIDER_ENV_VARS[provider];
  if (envName && typeof process.env[envName] === 'string' && process.env[envName].length > 0) {
    return process.env[envName];
  }
  return '';
}

/**
 * Status of a provider's credentials:
 *   - 'connected'    — explicit API key configured in Settings
 *   - 'env'          — no Settings key, but the matching env var is set
 *   - 'unconfigured' — neither side has a value
 *
 * Used by the renderer to colour the status badges on each provider
 * card without having to mirror the env-var mapping in the renderer.
 */
export function getProviderStatus(provider) {
  const settings = loadSettings();
  const fromSettings = settings.providers?.[provider]?.apiKey;
  if (typeof fromSettings === 'string' && fromSettings.trim().length > 0) {
    return 'connected';
  }
  const envName = PROVIDER_ENV_VARS[provider];
  if (envName && typeof process.env[envName] === 'string' && process.env[envName].length > 0) {
    return 'env';
  }
  return 'unconfigured';
}

/** Returns the currently-selected default provider id. */
export function getDefaultProvider() {
  const settings = loadSettings();
  const id = settings.defaultProvider;
  // Validate against the known providers — a malformed settings file
  // shouldn't be able to route the coach to a non-existent provider.
  if (id && Object.prototype.hasOwnProperty.call(settings.providers || {}, id)) {
    return id;
  }
  return DEFAULT_SETTINGS.defaultProvider;
}

/** Returns the default model for `provider`. Falls back to the
 *  hard-coded default if the settings slot is empty / missing. */
export function getDefaultModelForProvider(provider) {
  const settings = loadSettings();
  const fromSettings = settings.providers?.[provider]?.defaultModel;
  if (typeof fromSettings === 'string' && fromSettings.length > 0) {
    return fromSettings;
  }
  const fallback = DEFAULT_SETTINGS.providers[provider]?.defaultModel;
  return typeof fallback === 'string' ? fallback : '';
}

/**
 * Look up the configured model for a non-provider-routed service
 * (currently just `summary`). Falls back to the DEFAULT_SETTINGS
 * value when the slot is missing or empty. Service names that aren't
 * in the schema return ''.
 *
 * The coach used to live here under service='coach' but in v2 it's
 * provider-routed via getDefaultModelForProvider() instead.
 */
export function getModelFor(service) {
  const settings = loadSettings();
  const fromSettings = settings.models?.[service];
  if (typeof fromSettings === 'string' && fromSettings.length > 0) {
    return fromSettings;
  }
  const fromDefaults = DEFAULT_SETTINGS.models[service];
  return typeof fromDefaults === 'string' ? fromDefaults : '';
}

/**
 * Return the full `appearance` block (tag colours and any future
 * theming knobs). Always returns the defaults-merged shape so the
 * renderer can read `tagColors.you` / `tagColors.other` without
 * defensive optional-chaining.
 */
export function getAppearance() {
  const settings = loadSettings();
  return settings.appearance;
}

/**
 * Return the full `coach` block (experimental behaviour toggles +
 * — in Phase 4 — coach timing knobs). Always returns the defaults-
 * merged shape so callers can read `.trackQuestionState` /
 * `.autoReformulate` without defensive optional-chaining. Read live
 * by main.js's coach plumbing on every tick so that flipping a toggle
 * mid-call takes effect immediately without restarting the session.
 *
 * Renamed from `getAdvanced` in schema v3. There's no back-compat
 * alias because the rename is internal (only main.js consumed the
 * old name and was updated alongside this).
 */
export function getCoach() {
  const settings = loadSettings();
  return settings.coach;
}

/**
 * Resolve the Stage-2 quick-fix worker's provider + model. Cascades
 * settings.quickFix.* over the coach's per-provider routing:
 *
 *   1. If `quickFix.provider` is set AND we have a key for it,
 *      use that provider — with `quickFix.model` if set, otherwise
 *      that provider's default model.
 *   2. Otherwise fall back to the coach's routed provider (the
 *      `defaultProvider` from Settings → Providers) and that
 *      provider's default model.
 *
 * Returns `{ provider, model }` where `provider` is the canonical
 * provider id ('gemini'|'anthropic'|'openai') and `model` is the
 * model name string. Either may be falsy if no providers are
 * configured — caller should check before constructing.
 */
export function getQuickFix() {
  const settings = loadSettings();
  const qf = settings.quickFix || {};
  const candidate = typeof qf.provider === 'string' && qf.provider.length > 0
    ? qf.provider
    : '';
  if (candidate && Object.prototype.hasOwnProperty.call(settings.providers || {}, candidate)) {
    // Only honour the override if we have a key for the candidate —
    // otherwise we'd construct a provider that will immediately fail.
    const overrideKey = getApiKey(candidate);
    if (overrideKey) {
      const model = typeof qf.model === 'string' && qf.model.length > 0
        ? qf.model
        : getDefaultModelForProvider(candidate);
      return { provider: candidate, model };
    }
  }
  // Fall back to the coach's routed provider.
  const fallback = getDefaultProvider();
  return {
    provider: fallback,
    model: getDefaultModelForProvider(fallback),
  };
}

/**
 * Return the full `audio` block (mic / system-audio device IDs,
 * AEC/NS/AGC constraint toggles, Deepgram model, and the visual
 * hide-AEC-badge flag). Always returns the defaults-merged shape
 * so callers can read `.deepgramModel`, `.micDeviceId`, etc.
 * without defensive optional-chaining.
 *
 * Read live by main.js at three points:
 *   - on every `new DeepgramSession({...})` to bake the model into
 *     the WS query string at connect time.
 *   - inside setDisplayMediaRequestHandler to honour the user's
 *     persisted system-audio source choice.
 *   - (renderer) inside startCapture() to bake mic device ID +
 *     AEC/NS/AGC constraints into getUserMedia.
 *
 * "Live read at session start" is intentional — settings changes
 * mid-call don't hot-swap the capture pipeline (a fresh getUserMedia
 * / WS connect is required) so the read happens once per session
 * boundary.
 */
export function getAudio() {
  const settings = loadSettings();
  return settings.audio;
}

/**
 * Resolve the Stage-1 facts-scanner configuration. Returns the merged
 * `factsScanner` block (defaults filled) so callers can read
 * `.intervalMs` and `.enabled` without defensive optional chaining.
 *
 * Read live by main.js at session start to arm the scanner's
 * setInterval, and during teardown to clear it. Settings changes
 * mid-call don't hot-swap the cadence — the next call picks up the
 * new value, matching the existing "audio settings apply on next
 * Start" pattern.
 *
 * The scanner shares provider routing with the Stage-2 worker (see
 * `getQuickFix()` above) — both AI passes belong to the same
 * background financial-analyst workflow, so the user's `quickFix`
 * provider choice applies to both.
 */
export function getFactsScanner() {
  const settings = loadSettings();
  return settings.factsScanner;
}

/**
 * Return a snapshot of which providers have an env-var fallback set.
 * The renderer uses this to render the "Using env variable" status
 * badge when the Settings slot is empty — without it the renderer
 * would have to invoke a separate IPC roundtrip per provider.
 *
 * Shape: { gemini: boolean, anthropic: boolean, openai: boolean }.
 */
export function getProviderEnvAvailability() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const [provider, envName] of Object.entries(PROVIDER_ENV_VARS)) {
    out[provider] = typeof process.env[envName] === 'string' && process.env[envName].length > 0;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────
 * Data subsection helpers (General tab → Data)
 *
 * Reset / Export / Import live as helpers here so the IPC handlers in
 * main.js stay thin and so any future automation (e.g. an "apply team
 * defaults" CLI step) can reuse the same code paths. All three operate
 * on the in-memory cache and call writeToDisk via saveSettings — no
 * direct disk writes outside the cache.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Reset all settings to their built-in defaults. By default the user's
 * provider API keys are preserved across the reset because they're the
 * only field a user meaningfully loses work over (everything else is
 * re-clickable in seconds). The renderer's confirmation modal forces an
 * explicit choice — there's no implicit code path that wipes keys.
 *
 * Options:
 *   - preserveKeys (default true) — keep providers.<id>.apiKey values
 *     across the reset. Other provider fields (defaultModel, …) are
 *     reset.
 *
 * Returns the full reset settings shape so the caller can echo it
 * back to the renderer for re-hydration without a second IPC.
 */
export function resetSettings({ preserveKeys = true } = {}) {
  const before = loadSettings();
  const fresh = cloneDefaults();

  if (preserveKeys && before?.providers && typeof before.providers === 'object') {
    for (const [provider, config] of Object.entries(before.providers)) {
      if (!fresh.providers[provider]) continue;
      const key = config?.apiKey;
      if (typeof key === 'string' && key.length > 0) {
        fresh.providers[provider].apiKey = key;
      }
    }
  }

  // Stomp the cache and write the new shape. Bypassing saveSettings'
  // deepMerge here is intentional — reset means "replace wholesale".
  cache = fresh;
  writeToDisk(fresh);
  return fresh;
}

/**
 * Serialise the current settings for export. By default API keys are
 * stripped to defang accidental sharing (forum posts, screenshots,
 * etc.). The renderer surfaces an explicit "Include API keys" toggle
 * so the user can opt in for legitimate cross-device sync.
 *
 * Returns:
 *   {
 *     json:          string — pretty-printed JSON ready to write
 *     includesKeys:  boolean — echoed back so the renderer can label
 *                              the saved file accurately
 *     filename:      string — recommended default filename for the
 *                              Save dialog (timestamped + .json)
 *   }
 *
 * The exported shape keeps `schemaVersion` so an Import on a future
 * schema can detect mismatches and run the migration chain. The Reset
 * step exists for the rare case where a future schema can't migrate
 * back; until then, every export is forward-compatible.
 */
export function exportSettingsAsJSON({ includeKeys = false } = {}) {
  const settings = loadSettings();
  // Deep-clone so the redaction below doesn't mutate the cache.
  const snapshot = deepMerge({}, settings);

  if (!includeKeys && snapshot.providers && typeof snapshot.providers === 'object') {
    for (const provider of Object.keys(snapshot.providers)) {
      if (snapshot.providers[provider] && typeof snapshot.providers[provider] === 'object') {
        snapshot.providers[provider].apiKey = '';
      }
    }
  }

  // Strip any underscore-prefixed piggyback fields that the renderer
  // may have stamped on (e.g. `_envAvailability`). They're runtime
  // hints, not persistable state, and exporting them would create
  // confusing diffs on import.
  for (const key of Object.keys(snapshot)) {
    if (key.startsWith('_')) delete snapshot[key];
  }

  const json = JSON.stringify(snapshot, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `two-way-flow-settings-${stamp}.json`;
  return { json, includesKeys: includeKeys, filename };
}

/**
 * Validate a JSON-parsed candidate object as an importable settings
 * file. Returns:
 *   { ok: true,  normalised }  — parsed + migrated to the current
 *                                schema, ready to commit via
 *                                applyImportedSettings()
 *   { ok: false, error }       — human-readable error string suitable
 *                                for surfacing in the import preview
 *
 * The validator is intentionally permissive: anything migrateSettings()
 * can promote forward is acceptable. The strict checks here only catch
 * input that obviously isn't a settings file — wrong top-level type,
 * missing `providers` shape, etc. — so a slightly-old export still
 * works without forcing the user to hand-edit.
 *
 * The normalised object is NOT applied to the cache. The caller (the
 * renderer's preview modal) shows a diff, gets user confirmation, and
 * THEN calls applyImportedSettings.
 */
export function validateImportedSettings(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, error: 'File contents are not a JSON object.' };
  }

  // The `providers` block is the load-bearing structural check. Every
  // schema version we've ever shipped (v1 had `apiKeys`, v2+ has
  // `providers`) accompanies it, so requiring one of the two avoids
  // accepting unrelated JSON files (e.g. a `package.json`).
  const looksLikeProviders =
    candidate.providers && typeof candidate.providers === 'object' && !Array.isArray(candidate.providers);
  const looksLikeApiKeys =
    candidate.apiKeys && typeof candidate.apiKeys === 'object' && !Array.isArray(candidate.apiKeys);
  if (!looksLikeProviders && !looksLikeApiKeys) {
    return {
      ok: false,
      error: 'File does not look like a Two Way Flow settings export (no providers block found).',
    };
  }

  // Run the migration chain — anything it accepts is importable.
  // migrateSettings is defensive against missing/extra fields, so a
  // partial export still merges cleanly with defaults.
  try {
    const normalised = migrateSettings(candidate);
    return { ok: true, normalised };
  } catch (err) {
    return { ok: false, error: err?.message || 'Migration failed.' };
  }
}

/**
 * Commit a previously-validated import object. The caller is expected
 * to have run validateImportedSettings() first; passing a non-validated
 * object will still work (validateImportedSettings is called again
 * internally as a belt-and-braces) but the renderer's preview flow
 * always validates before showing the diff so this is the fast path.
 *
 * Wholesale replacement, not a partial merge — import means "use this
 * file's values for every field". Fields not present in the imported
 * shape fall back to defaults (via the migrateSettings → cloneDefaults
 * deepMerge inside the validator).
 */
export function applyImportedSettings(parsed) {
  const result = validateImportedSettings(parsed);
  if (!result.ok) return result;
  const next = result.normalised;
  cache = next;
  writeToDisk(next);
  return { ok: true, settings: next };
}
