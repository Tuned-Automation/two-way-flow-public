/**
 * Active rubric — live view of the rubric the user currently has selected.
 *
 * Pre-feature this file owned a hard-coded `const` catalogue. Post-feature
 * the catalogue lives in `userData/rubrics/<id>.json` (seeded from
 * `src/rubric-defaults.js`) and this module exposes the same named exports
 * as `let` LIVE BINDINGS that can be re-pointed at any rubric shape via
 * `applyRubric(rubricData)`.
 *
 * IMPORTANT — renderer safety
 * ───────────────────────────
 *   This file MUST stay renderer-safe (no `electron`, no `node:fs`,
 *   no `node:path`). `src/renderer.js` imports `{ PILLARS, ITEMS, … }`
 *   from here at module load. If you re-introduce a Node-only static
 *   import the renderer bundle will crash with "__dirname is not
 *   defined" before any code runs.
 *
 *   The disk-reading logic lives in `src/rubric-store.js`. Main process
 *   wires the two together via `applyRubric(rubricStore.loadActiveRubric())`
 *   (see src/main.js). Renderer initialises with `DEFAULT_RUBRIC` and
 *   can re-hydrate on `rubrics:changed` IPC by re-fetching the rubric
 *   through `window.rubrics.*` and calling `applyRubric(...)` itself.
 *
 * Why `let` matters
 * ─────────────────
 *   ES modules already give callers *live bindings*: when an exporter
 *   reassigns a `let` binding, every importer in the SAME JS realm
 *   sees the new value on the next read. That's the trick that lets
 *   the coach, the live-session, the facts scanner, the quick-fix
 *   worker, etc. keep importing `{ PILLARS, ITEMS, … }` exactly as
 *   before — no getter functions, no namespace objects — and silently
 *   pick up the new active rubric after `applyRubric(...)`.
 *
 *   Cross-realm propagation (main ↔ renderer) is a SEPARATE concern:
 *   each realm has its own copy of these bindings. After a rubric
 *   swap in main, the renderer must also call `applyRubric(...)` in
 *   its own realm to stay in sync.
 *
 *   Consumers that capture a binding into a module-level constant
 *   (e.g. `const x = ITEMS;` at module scope) would NOT pick up
 *   reloads. The only known previous offender was `src/coach.js`'s
 *   four tool-schema constants — Task 4 moves them into per-instance
 *   construction. All other consumers call through to live exports
 *   at call-time.
 *
 * Surface — every named export pre-feature is preserved:
 *   PILLARS, PILLARS_BY_ID, ITEMS, ITEMS_BY_ID, ITEMS_BY_PILLAR,
 *   CAPTURED_FIELDS, FIELDS_BY_ID, FIELD_GROUPS, FLAGS, FLAGS_BY_ID,
 *   REAL_PILLAR_IDS, ITEM_IDS, FIELD_IDS, FLAG_IDS,
 *   SUGGESTABLE_ITEM_IDS, SUGGESTION_ITEM_IDS,
 *   SUGGESTION_SENTINEL_ITEM_IDS (still const — it's static),
 *   RUBRIC_SYSTEM_INSTRUCTION, COACH_SYSTEM_INSTRUCTION,
 *   formatCoachState.
 *
 * Public hydration hook:
 *   applyRubric(rubricData)   — recomputes every exported binding from
 *                               a rubric shape. Caller decides where
 *                               the shape comes from (disk in main,
 *                               IPC in renderer).
 *
 * Imported by:
 *   - src/gemini-session.js    → tool schemas + RUBRIC_SYSTEM_INSTRUCTION
 *   - src/coach.js             → COACH_SYSTEM_INSTRUCTION + enums
 *   - src/renderer.js          → rail / checklist / captured pane
 *   - src/main.js              → applyRubric() after swap / save / boot
 *   - src/summary.js, src/facts-scanner.js, src/quick-fix.js,
 *     src/deepgram-session.js, src/providers/*  → call-time reads
 *
 * Extension point: when adding 1-10 category scoring later, add a
 * CATEGORIES catalogue + `record_category_score` tool. The pillar/item
 * structure here stays unchanged — category scores extend the rubric,
 * they don't replace it.
 */

import { DEFAULT_RUBRIC } from './rubric-defaults.js';

/* ────────────────────────────────────────────────────────────────────
 * Synthetic pillars — runtime-only injection
 * ────────────────────────────────────────────────────────────────────
 * These two pillars never live in the persisted rubric (the store's
 * validator actively rejects them). They are re-injected at the top of
 * PILLARS by `applyRubric` so the rail / renderer can keep their
 * existing "first row is signals, second is logged" assumption.
 *
 *   live_signals    — owns flag display, populated by `record_flag`
 *                     calls from the live audio session.
 *   logged_questions — aggregates items currently in the `logged` state
 *                     across all pillars. Body is derived by the renderer
 *                     at render-time from state.itemStates.
 */
const SYNTHETIC_PILLARS = Object.freeze([
  Object.freeze({
    id: 'live_signals',
    name: 'Live signals',
    short: 'Signals',
    glyph: '!',
    tint: '#f59e0b',
    synthetic: true,
  }),
  Object.freeze({
    id: 'logged_questions',
    name: 'Logged questions',
    short: 'Logged',
    glyph: '↺',
    tint: '#f59e0b',
    synthetic: true,
  }),
]);

/* ────────────────────────────────────────────────────────────────────
 * Live-binding exports
 * ────────────────────────────────────────────────────────────────────
 * Declared with `let` so `applyRubric` can reassign them on rubric
 * swap. ES modules propagate `let` reassignment to every importer's
 * binding — that's the whole reason this design works without a
 * getter API.
 */

/**
 * @typedef {Object} PillarDef
 * @property {string} id
 * @property {string} name
 * @property {string} short
 * @property {string} glyph
 * @property {string} tint
 * @property {boolean} [synthetic]
 */

/**
 * @typedef {Object} ItemDef
 * @property {string} id
 * @property {string} pillarId
 * @property {string} label
 * @property {string} hint
 * @property {boolean} [suggestable]
 */

/**
 * @typedef {Object} FieldDef
 * @property {string} id
 * @property {string} group
 * @property {string} label
 * @property {string} hint
 */

/**
 * @typedef {Object} FlagDef
 * @property {string} id
 * @property {'red'|'green'} severity
 * @property {string} category
 * @property {string} short
 * @property {string} desc
 * @property {'mid'|'late'} when
 */

/** @type {PillarDef[]} */
export let PILLARS;
/** @type {Record<string, PillarDef>} */
export let PILLARS_BY_ID;
/** @type {ItemDef[]} */
export let ITEMS;
/** @type {Record<string, ItemDef>} */
export let ITEMS_BY_ID;
/** @type {Record<string, ItemDef[]>} */
export let ITEMS_BY_PILLAR;
/** @type {FieldDef[]} */
export let CAPTURED_FIELDS;
/** @type {Record<string, FieldDef>} */
export let FIELDS_BY_ID;
/** @type {string[]} */
export let FIELD_GROUPS;
/** @type {FlagDef[]} */
export let FLAGS;
/** @type {Record<string, FlagDef>} */
export let FLAGS_BY_ID;
/** @type {string[]} */
export let REAL_PILLAR_IDS;
/** @type {string[]} */
export let ITEM_IDS;
/** @type {string[]} */
export let FIELD_IDS;
/** @type {string[]} */
export let FLAG_IDS;
/** @type {string[]} */
export let SUGGESTABLE_ITEM_IDS;
/** @type {string[]} */
export let SUGGESTION_ITEM_IDS;
/** @type {string} */
export let RUBRIC_SYSTEM_INSTRUCTION;
/** @type {string} */
export let COACH_SYSTEM_INSTRUCTION;

/* Static — never depends on the active rubric. */
export const SUGGESTION_SENTINEL_ITEM_IDS = ['freeform.deeper', 'freeform.recap'];

/* ────────────────────────────────────────────────────────────────────
 * Catalogue-block formatters (take data as arguments so `applyRubric`
 * can compose the new instructions BEFORE assigning the bindings —
 * avoids any read-before-write hazard on reload).
 * ──────────────────────────────────────────────────────────────────── */

function formatItemBlock(pillars, itemsByPillar) {
  /** @type {string[]} */
  const out = [];
  for (const p of pillars) {
    if (p.synthetic) continue;
    const items = itemsByPillar[p.id] || [];
    if (items.length === 0) continue;
    out.push(`  Pillar "${p.name}" (${p.id}):`);
    for (const it of items) {
      out.push(`    - ${it.id}: ${it.hint}`);
    }
  }
  return out.join('\n');
}

function formatFieldBlock(fields) {
  /** @type {string[]} */
  const out = [];
  let lastGroup = '';
  for (const f of fields) {
    if (f.group !== lastGroup) {
      out.push(`  ${f.group}:`);
      lastGroup = f.group;
    }
    out.push(`    - ${f.id}: ${f.hint}`);
  }
  return out.join('\n');
}

function formatFlagBlock(flags) {
  return flags
    .map((f) => `  - ${f.id} [${f.severity}, ${f.when}]: ${f.desc}`)
    .join('\n');
}

/* ────────────────────────────────────────────────────────────────────
 * applyRubric — public hydration hook that recomputes every exported
 * binding from a rubric shape.
 *
 * Called once at module init with `DEFAULT_RUBRIC`, and again by callers
 * that have a more current rubric to hand (main process: after disk load
 * or set-active swap; renderer: on `rubrics:changed` IPC). Composes
 * derived shapes locally and THEN assigns them to the exports, so a
 * concurrent reader can never observe a half-applied state.
 *
 * Safe to call any number of times. Pass the same in-memory `DEFAULT_RUBRIC`
 * to reset bindings. Pass anything matching the persisted rubric shape
 * (see `src/rubric-defaults.js` doc-block) to install a new active rubric.
 * ──────────────────────────────────────────────────────────────────── */

export function applyRubric(rubric) {
  const persistedPillars = Array.isArray(rubric?.pillars) ? rubric.pillars : [];
  const persistedItems = Array.isArray(rubric?.items) ? rubric.items : [];
  const persistedFields = Array.isArray(rubric?.capturedFields) ? rubric.capturedFields : [];
  const persistedFlags = Array.isArray(rubric?.flags) ? rubric.flags : [];

  const allPillars = [...SYNTHETIC_PILLARS, ...persistedPillars];
  const pillarsById = Object.fromEntries(allPillars.map((p) => [p.id, p]));
  const itemsById = Object.fromEntries(persistedItems.map((it) => [it.id, it]));

  /** @type {Record<string, ItemDef[]>} */
  const itemsByPillar = {};
  for (const p of allPillars) itemsByPillar[p.id] = [];
  for (const it of persistedItems) {
    (itemsByPillar[it.pillarId] ||= []).push(it);
  }

  const fieldsById = Object.fromEntries(persistedFields.map((f) => [f.id, f]));
  const fieldGroups = (() => {
    const seen = new Set();
    const order = [];
    for (const f of persistedFields) {
      if (!seen.has(f.group)) {
        seen.add(f.group);
        order.push(f.group);
      }
    }
    return order;
  })();

  const flagsById = Object.fromEntries(persistedFlags.map((f) => [f.id, f]));

  const realPillarIds = allPillars.filter((p) => !p.synthetic).map((p) => p.id);
  const itemIds = persistedItems.map((it) => it.id);
  const fieldIds = persistedFields.map((f) => f.id);
  const flagIds = persistedFlags.map((f) => f.id);
  const suggestableItemIds = persistedItems.filter((it) => it.suggestable !== false).map((it) => it.id);
  const suggestionItemIds = [...suggestableItemIds, ...SUGGESTION_SENTINEL_ITEM_IDS];

  /* Compose system instructions from the rubric's prompt templates +
   * the freshly-built catalogue blocks. The templates intentionally
   * stop before the catalogue intro lines — we re-emit the labels here
   * so prompt edits in the Rubrics tab can never drop or duplicate them. */
  const livePrompt =
    (rubric?.prompts?.liveSystemInstruction || '') +
    '\n\nCoaching flags:\n' +
    formatFlagBlock(persistedFlags);

  let coachPrompt =
    (rubric?.prompts?.coachSystemInstruction || '') +
    '\n\nChecklist items:\n' +
    formatItemBlock(allPillars, itemsByPillar) +
    '\n\nCaptured fields (callable repeatedly to refine the value):\n' +
    formatFieldBlock(persistedFields);

  const voiceAndTone = typeof rubric?.prompts?.voiceAndTone === 'string'
    ? rubric.prompts.voiceAndTone.trim()
    : '';
  if (voiceAndTone) {
    coachPrompt += `\n\nVOICE & TONE OVERRIDE:\n${voiceAndTone}`;
  }

  /* Atomic-ish assignment block. Each `export let` reassignment is a
   * single statement and ESM bindings update on read, so a reader
   * that wedges itself between two lines below will see a brief
   * mixed state. In practice that doesn't matter — `applyRubric` is
   * only called when the live session is idle (the set-active IPC
   * handler in main.js gates that), so there is no concurrent consumer. */
  PILLARS = allPillars;
  PILLARS_BY_ID = pillarsById;
  ITEMS = persistedItems;
  ITEMS_BY_ID = itemsById;
  ITEMS_BY_PILLAR = itemsByPillar;
  CAPTURED_FIELDS = persistedFields;
  FIELDS_BY_ID = fieldsById;
  FIELD_GROUPS = fieldGroups;
  FLAGS = persistedFlags;
  FLAGS_BY_ID = flagsById;
  REAL_PILLAR_IDS = realPillarIds;
  ITEM_IDS = itemIds;
  FIELD_IDS = fieldIds;
  FLAG_IDS = flagIds;
  SUGGESTABLE_ITEM_IDS = suggestableItemIds;
  SUGGESTION_ITEM_IDS = suggestionItemIds;
  RUBRIC_SYSTEM_INSTRUCTION = livePrompt;
  COACH_SYSTEM_INSTRUCTION = coachPrompt;
}

/* ────────────────────────────────────────────────────────────────────
 * Module init — populate every export so first imports get real values.
 * ────────────────────────────────────────────────────────────────────
 * Initialises from the in-memory DEFAULT_RUBRIC so this file stays
 * renderer-safe (no Node-only imports — see header doc-block).
 *
 * Main process calls `applyRubric(rubricStore.loadActiveRubric())` after
 * `app.whenReady()` to swap in the on-disk active rubric. Renderer can
 * re-hydrate the same way using IPC (`window.rubrics.list()` →
 * `window.rubrics.load(id)` → `applyRubric(...)`).
 */
applyRubric(DEFAULT_RUBRIC);

/* ────────────────────────────────────────────────────────────────────
 * formatCoachState — per-turn state block prepended to the transcript
 * before sending to the text coach.
 * ────────────────────────────────────────────────────────────────────
 * Unchanged from pre-feature except that the `ITEMS` reference now
 * resolves to the active rubric's items via the `let` binding above.
 *
 * `recentlySkippedIds` lists items the seller just dismissed via the
 * → skip control. They're temporarily off-rotation so the model doesn't
 * suggest the same thing right back; main.js prunes them after the TTL
 * elapses and they become eligible again.
 *
 * `boostedItemIds` lists items the seller explicitly asked the coach to
 * resurface (typically by clicking a logged item in the Logged pillar).
 * These should be prioritised for the next suggestion.
 *
 * @param {{
 *   itemStates?: Record<string, { state: string }>,
 *   capturedFields: Record<string, { value: string }>,
 *   recentSellerTurns?: string[],
 *   recentlySkippedIds?: string[],
 *   boostedItemIds?: string[],
 * }} state
 */
export function formatCoachState(state) {
  const itemStates = state.itemStates || {};

  const inProgress = [];
  const covered = [];
  const logged = [];
  for (const [id, s] of Object.entries(itemStates)) {
    if (s?.state === 'in_progress') inProgress.push(id);
    else if (s?.state === 'covered') covered.push(id);
    else if (s?.state === 'logged') logged.push(id);
  }

  const captured = Object.entries(state.capturedFields || {})
    .map(([id, v]) => `${id}="${v.value}"`)
    .join(', ') || '(none yet)';

  const skipped = state.recentlySkippedIds || [];
  const boosted = state.boostedItemIds || [];
  const skippedSet = new Set(skipped);
  const coveredSet = new Set(covered);
  const candidates = ITEMS
    .filter((it) => !coveredSet.has(it.id) && !skippedSet.has(it.id))
    .map((it) => it.id)
    .join(', ') || '(everything covered — skip suggest_next_question)';

  const recent = state.recentSellerTurns?.length
    ? state.recentSellerTurns.slice(-3).map((t, i) => `  ${i + 1}. "${t}"`).join('\n')
    : '  (no recent seller turns)';

  const lines = [
    'RUBRIC STATE',
    `Items in_progress: ${inProgress.join(', ') || '(none)'}`,
    `Items covered:     ${covered.join(', ')     || '(none)'}`,
    `Items logged:      ${logged.join(', ')      || '(none)'}`,
    `Captured fields:   ${captured}`,
    `Candidates for next suggestion: ${candidates}`,
  ];

  if (boosted.length) {
    lines.push(
      `BOOSTED ITEMS (if suggest_next_question is available this turn, PRIORITISE these): ${boosted.join(', ')}`,
    );
  }

  if (skipped.length) {
    lines.push(`RECENTLY SKIPPED (do not re-suggest unless boosted): ${skipped.join(', ')}`);
  }

  lines.push('', 'Recent seller turns (avoid suggesting near-duplicates):', recent);

  return lines.join('\n');
}
