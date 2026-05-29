/**
 * Rubric library — JSON-on-disk store under `userData/rubrics/`.
 *
 * Mirrors the hand-rolled pattern in `src/settings.js`: no new npm
 * deps, in-memory cache for the index, lazy file-path resolution, and
 * defensive try/catch around every disk read so a corrupted file can
 * never brick the app.
 *
 * Layout
 * ──────
 *   userData/rubrics/
 *     index.json              { schemaVersion, activeId, rubrics: string[] }
 *     <id>.json               full rubric object — see DEFAULT_RUBRIC shape
 *
 * Schema version
 * ──────────────
 *   `schemaVersion: 1` is the only supported version today. A file with
 *   an unsupported version FAILS to load (returns null + warns) rather
 *   than being silently absorbed — this is an architecture invariant of
 *   the editable-rubric feature (see plan §"Architecture invariants").
 *
 * Atomicity
 * ─────────
 *   Saves write to `<id>.json.tmp` and then `rename()` into place.
 *   POSIX rename is atomic, so a crash mid-save can never leave a
 *   half-written rubric file on disk.
 *
 * Synthetic pillars
 * ─────────────────
 *   The seed (`src/rubric-defaults.js`) deliberately excludes the two
 *   synthetic pillars (`live_signals`, `logged_questions`). They are
 *   re-injected at runtime by `src/rubric.js:applyRubric()` and must
 *   NEVER appear in a persisted rubric — the validator rejects them.
 *
 * Extension point
 * ───────────────
 *   When the schema needs to evolve (e.g. adding per-item scoring
 *   weights), bump `SCHEMA_VERSION` and add a `migrateRubric(loaded)`
 *   chain mirroring `migrateSettings()` in settings.js. Until then,
 *   additive fields with sensible defaults can ride the existing v1
 *   shape because the validator only errors on missing-or-malformed,
 *   not on extras.
 */

import { app } from 'electron';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUBRIC } from './rubric-defaults.js';
import { SOFTWARE_WALKTHROUGH_RUBRIC } from './rubric-software-walkthrough.js';

const SCHEMA_VERSION = 1;

/**
 * Built-in rubrics that ship with the app. The FIRST entry is the
 * primary seed: `ensureSeeded()` writes it on first launch and points
 * `index.activeId` at it. Every entry (including the first) is also run
 * through `ensureBuiltins()` so additional built-ins are installed
 * additively on every boot — see that function for the invariants.
 *
 * To add another built-in rubric: author a `<thing>-rubric.js` module
 * exporting a DEFAULT_RUBRIC-shaped object, import it here, and append
 * it to this array. Do NOT reorder — index[0] is the active default.
 */
const BUILTIN_RUBRICS = [DEFAULT_RUBRIC, SOFTWARE_WALKTHROUGH_RUBRIC];

/** Reserved ids — synthetic pillars must never appear in a persisted rubric. */
const RESERVED_PILLAR_IDS = new Set(['live_signals', 'logged_questions']);

/* ────────────────────────────────────────────────────────────────────
 * Paths (lazy — app.getPath may not be valid pre-ready in some
 * Electron versions; current 42 is fine but the lazy guard costs
 * nothing and keeps the module require-able from any context).
 * ──────────────────────────────────────────────────────────────────── */

export function getRubricsDir() {
  return path.join(app.getPath('userData'), 'rubrics');
}

export function getIndexPath() {
  return path.join(getRubricsDir(), 'index.json');
}

export function getRubricPath(id) {
  return path.join(getRubricsDir(), `${id}.json`);
}

/* ────────────────────────────────────────────────────────────────────
 * Index cache + low-level read/write
 * ──────────────────────────────────────────────────────────────────── */

/** In-memory cache of the parsed index.json. `null` until first load. */
let indexCache = null;

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn(`[rubric-store] failed to read ${filePath}:`, err?.message || err);
    return null;
  }
}

/**
 * Atomic JSON write. Writes to `<path>.tmp` then renames into place so
 * a crash mid-write can never leave a half-formed file. Best-effort —
 * errors are surfaced via the return value so callers can decide
 * whether to bubble or swallow.
 */
function writeJsonFile(filePath, value) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
    return { ok: true };
  } catch (err) {
    console.warn(`[rubric-store] failed to write ${filePath}:`, err?.message || err);
    return { ok: false, reason: err?.message || 'write_failed' };
  }
}

/**
 * Load and cache `index.json`. Returns the cached copy on subsequent
 * calls. A missing file returns null — caller should run ensureSeeded()
 * to create one.
 */
export function loadIndex() {
  if (indexCache) return indexCache;
  const parsed = readJsonFile(getIndexPath());
  if (!parsed) return null;
  if (Number(parsed.schemaVersion) !== SCHEMA_VERSION) {
    console.warn(
      `[rubric-store] index.json has unsupported schemaVersion ${parsed.schemaVersion}; ignoring`,
    );
    return null;
  }
  indexCache = parsed;
  return indexCache;
}

function saveIndex(index) {
  const next = { ...index, schemaVersion: SCHEMA_VERSION };
  const result = writeJsonFile(getIndexPath(), next);
  if (result.ok) indexCache = next;
  return result;
}

/* ────────────────────────────────────────────────────────────────────
 * Validation
 * ──────────────────────────────────────────────────────────────────── */

/** Slugify a display string into an id segment. Lowercase, alphanumeric
 *  and underscore only, collapsed dashes/spaces → `_`. */
function slugify(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a rubric object. Returns `{ ok, errors, warnings }`.
 *
 * Errors block the save (`saveRubric` refuses); warnings are surfaced
 * to the UI but don't block. Used by both `saveRubric` and
 * `importRubric`, and exposed as the `rubrics:validate` IPC channel.
 */
export function validateRubric(rubric) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) {
    errors.push('Rubric must be a JSON object.');
    return { ok: false, errors, warnings };
  }

  if (Number(rubric.schemaVersion) !== SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion (expected ${SCHEMA_VERSION}, got ${rubric.schemaVersion ?? '(missing)'}).`);
  }
  if (!isNonEmptyString(rubric.id)) errors.push('Rubric id is required.');
  if (!isNonEmptyString(rubric.name)) errors.push('Rubric name is required.');

  const pillars = Array.isArray(rubric.pillars) ? rubric.pillars : null;
  if (!pillars || pillars.length === 0) {
    errors.push('Rubric must have at least one pillar.');
  }

  const items = Array.isArray(rubric.items) ? rubric.items : [];
  const capturedFields = Array.isArray(rubric.capturedFields) ? rubric.capturedFields : [];
  const flags = Array.isArray(rubric.flags) ? rubric.flags : [];

  /* ── Pillars ──────────────────────────────────────────────── */
  /** @type {Set<string>} */
  const pillarIds = new Set();
  /** @type {Map<string, number>} */
  const glyphCounts = new Map();
  if (pillars) {
    pillars.forEach((p, idx) => {
      const prefix = `pillar[${idx}]`;
      if (!p || typeof p !== 'object') {
        errors.push(`${prefix}: not an object.`);
        return;
      }
      if (!isNonEmptyString(p.id)) errors.push(`${prefix}: id is required.`);
      if (RESERVED_PILLAR_IDS.has(p.id)) {
        errors.push(`${prefix}: '${p.id}' is reserved for synthetic pillars and cannot be persisted.`);
      }
      if (pillarIds.has(p.id)) errors.push(`${prefix}: duplicate pillar id '${p.id}'.`);
      else if (isNonEmptyString(p.id)) pillarIds.add(p.id);
      if (!isNonEmptyString(p.name)) errors.push(`${prefix}: name is required.`);
      if (!isNonEmptyString(p.short)) errors.push(`${prefix}: short label is required.`);
      else if (p.short.length > 25) warnings.push(`${prefix}: short label '${p.short}' is over 25 characters; truncates in compact rail.`);
      if (!isNonEmptyString(p.glyph)) errors.push(`${prefix}: glyph is required.`);
      else {
        const cnt = (glyphCounts.get(p.glyph) || 0) + 1;
        glyphCounts.set(p.glyph, cnt);
      }
    });
  }
  for (const [glyph, count] of glyphCounts) {
    if (count > 1) warnings.push(`${count} pillars share the glyph '${glyph}' — consider disambiguating.`);
  }

  /* ── Items ────────────────────────────────────────────────── */
  /** @type {Set<string>} */
  const itemIds = new Set();
  /** @type {Set<string>} */
  const pillarsWithItems = new Set();
  items.forEach((it, idx) => {
    const prefix = `item[${idx}]`;
    if (!it || typeof it !== 'object') {
      errors.push(`${prefix}: not an object.`);
      return;
    }
    if (!isNonEmptyString(it.id)) errors.push(`${prefix}: id is required.`);
    else {
      const parts = it.id.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        errors.push(`${prefix}: id '${it.id}' must match '<pillarId>.<localId>'.`);
      } else if (pillarIds.size && !pillarIds.has(parts[0])) {
        errors.push(`${prefix}: id '${it.id}' references unknown pillar '${parts[0]}'.`);
      } else {
        // Cross-check pillarId field matches the id prefix (if both present).
        if (isNonEmptyString(it.pillarId) && it.pillarId !== parts[0]) {
          errors.push(`${prefix}: pillarId '${it.pillarId}' disagrees with id prefix '${parts[0]}'.`);
        }
        pillarsWithItems.add(parts[0]);
      }
      if (itemIds.has(it.id)) errors.push(`${prefix}: duplicate item id '${it.id}'.`);
      else itemIds.add(it.id);
    }
    if (!isNonEmptyString(it.label)) errors.push(`${prefix}: label is required.`);
    if (!isNonEmptyString(it.hint)) errors.push(`${prefix}: hint is required.`);
  });
  if (pillars) {
    for (const p of pillars) {
      if (p && isNonEmptyString(p.id) && !pillarsWithItems.has(p.id)) {
        warnings.push(`Pillar '${p.id}' has zero items — it will appear empty in the rail.`);
      }
    }
  }

  /* ── Captured fields ──────────────────────────────────────── */
  /** @type {Set<string>} */
  const fieldIds = new Set();
  capturedFields.forEach((f, idx) => {
    const prefix = `capturedField[${idx}]`;
    if (!f || typeof f !== 'object') {
      errors.push(`${prefix}: not an object.`);
      return;
    }
    if (!isNonEmptyString(f.id)) errors.push(`${prefix}: id is required.`);
    else {
      const parts = f.id.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        errors.push(`${prefix}: id '${f.id}' must match '<group>.<localId>'.`);
      } else if (isNonEmptyString(f.group) && slugify(f.group) !== parts[0]) {
        errors.push(
          `${prefix}: id prefix '${parts[0]}' does not match slugified group '${slugify(f.group)}' (from '${f.group}').`,
        );
      }
      if (fieldIds.has(f.id)) errors.push(`${prefix}: duplicate field id '${f.id}'.`);
      else fieldIds.add(f.id);
    }
    if (!isNonEmptyString(f.group)) errors.push(`${prefix}: group is required.`);
    if (!isNonEmptyString(f.label)) errors.push(`${prefix}: label is required.`);
    if (!isNonEmptyString(f.hint)) errors.push(`${prefix}: hint is required.`);
  });

  /* ── Flags ────────────────────────────────────────────────── */
  /** @type {Set<string>} */
  const flagIds = new Set();
  flags.forEach((fl, idx) => {
    const prefix = `flag[${idx}]`;
    if (!fl || typeof fl !== 'object') {
      errors.push(`${prefix}: not an object.`);
      return;
    }
    if (!isNonEmptyString(fl.id)) errors.push(`${prefix}: id is required.`);
    else if (flagIds.has(fl.id)) errors.push(`${prefix}: duplicate flag id '${fl.id}'.`);
    else flagIds.add(fl.id);
    if (fl.severity !== 'red' && fl.severity !== 'green') {
      errors.push(`${prefix}: severity must be 'red' or 'green'.`);
    }
    if (fl.when !== 'mid' && fl.when !== 'late') {
      errors.push(`${prefix}: when must be 'mid' or 'late'.`);
    }
    if (!isNonEmptyString(fl.category)) errors.push(`${prefix}: category is required.`);
    if (!isNonEmptyString(fl.short)) errors.push(`${prefix}: short title is required.`);
    if (!isNonEmptyString(fl.desc)) errors.push(`${prefix}: description is required.`);
  });

  /* ── Prompts (lenient — empties OK; we only check shape) ──── */
  if (!rubric.prompts || typeof rubric.prompts !== 'object') {
    errors.push('Rubric prompts block is required.');
  } else {
    if (typeof rubric.prompts.voiceAndTone !== 'string') {
      errors.push('prompts.voiceAndTone must be a string (use "" if unused).');
    }
    if (!isNonEmptyString(rubric.prompts.coachSystemInstruction)) {
      errors.push('prompts.coachSystemInstruction is required.');
    }
    if (!isNonEmptyString(rubric.prompts.liveSystemInstruction)) {
      errors.push('prompts.liveSystemInstruction is required.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ────────────────────────────────────────────────────────────────────
 * ensureSeeded
 * ──────────────────────────────────────────────────────────────────── */

/**
 * First-launch seeding. If the rubrics dir doesn't exist OR index.json
 * is missing, create them with the DEFAULT_RUBRIC + an index pointing
 * to it. Idempotent — subsequent calls do nothing.
 *
 * Called once at app boot in main.js BEFORE the first Coach is
 * constructed (so the active rubric is available when src/rubric.js's
 * module-init pass runs).
 */
export function ensureSeeded() {
  const dir = getRubricsDir();
  const indexPath = getIndexPath();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // If the index exists and points at a rubric that exists, the primary
  // seed is intact — but additional built-ins may still be missing
  // (e.g. on an install that predates a newly-shipped built-in), so run
  // the additive pass before returning.
  const existingIndex = readJsonFile(indexPath);
  if (
    existingIndex &&
    Number(existingIndex.schemaVersion) === SCHEMA_VERSION &&
    isNonEmptyString(existingIndex.activeId) &&
    existsSync(getRubricPath(existingIndex.activeId))
  ) {
    ensureBuiltins();
    return { ok: true, seeded: false };
  }

  // Either the index is missing/corrupt, or it points at a deleted
  // rubric. Either way, drop in the default rubric + a fresh index.
  // Existing rubric files (if any) are preserved — we only rewrite
  // the seed file and the index.
  const now = new Date().toISOString();
  const seed = {
    ...DEFAULT_RUBRIC,
    createdAt: DEFAULT_RUBRIC.createdAt || now,
    updatedAt: now,
  };
  const writeRubric = writeJsonFile(getRubricPath(seed.id), seed);
  if (!writeRubric.ok) return { ok: false, reason: writeRubric.reason };

  // Build the rubrics list by scanning the directory so re-seeding
  // never orphans a custom rubric the user already has on disk.
  const onDisk = listRubricFilesOnDisk();
  const rubricsList = onDisk.includes(seed.id) ? onDisk : [...onDisk, seed.id];
  const writeIdx = saveIndex({
    schemaVersion: SCHEMA_VERSION,
    activeId: existingIndex && rubricsList.includes(existingIndex.activeId) ? existingIndex.activeId : seed.id,
    rubrics: rubricsList,
  });
  if (!writeIdx.ok) return { ok: false, reason: writeIdx.reason };

  // Install any additional built-ins alongside the freshly-written
  // primary seed. activeId stays on the primary seed.
  ensureBuiltins();
  return { ok: true, seeded: true };
}

/**
 * Additively install the built-in rubrics in `BUILTIN_RUBRICS`.
 *
 * Idempotent and safe to call on every boot. For each built-in:
 *   - writes its `<id>.json` ONLY if the file is absent (so user edits
 *     to a built-in survive — same source-of-truth rule as the primary
 *     seed), and
 *   - appends its id to `index.rubrics` if not already listed.
 *
 * Invariants this function MUST preserve:
 *   - It NEVER changes `index.activeId` — the active rubric is the
 *     user's (or the primary-seed default), not ours to move.
 *   - It NEVER overwrites an existing rubric file, including the
 *     `tuned_automation` primary seed.
 *
 * Best-effort: a failed write for one built-in is logged and skipped so
 * a single bad file can never block boot.
 */
function ensureBuiltins() {
  const index = loadIndex();
  // The primary-seed path guarantees an index exists before this runs.
  // If it somehow doesn't, bail rather than invent one without activeId.
  if (!index) return;

  const rubrics = Array.isArray(index.rubrics) ? [...index.rubrics] : [];
  let changed = false;

  for (const builtin of BUILTIN_RUBRICS) {
    if (!builtin || !isNonEmptyString(builtin.id)) continue;
    const filePath = getRubricPath(builtin.id);
    if (!existsSync(filePath)) {
      const now = new Date().toISOString();
      const seed = {
        ...builtin,
        createdAt: builtin.createdAt || now,
        updatedAt: now,
      };
      const write = writeJsonFile(filePath, seed);
      if (!write.ok) continue;
    }
    if (!rubrics.includes(builtin.id)) {
      rubrics.push(builtin.id);
      changed = true;
    }
  }

  if (changed) {
    saveIndex({ ...index, rubrics });
  }
}

/** Scan the rubrics directory and return rubric ids derived from
 *  `<id>.json` filenames. Skips `index.json`. */
function listRubricFilesOnDisk() {
  const dir = getRubricsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json' && !f.endsWith('.tmp'))
      .map((f) => f.slice(0, -'.json'.length));
  } catch (err) {
    console.warn('[rubric-store] failed to list rubrics dir:', err?.message || err);
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Public read API
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Return a lightweight summary of every rubric on disk for the library
 * dropdown. Each entry: `{ id, name, description, isActive, updatedAt }`.
 * Skips files that fail schema validation but logs them so the user can
 * surface "1 rubric failed to load" in the Rubrics tab later if needed.
 */
/**
 * Upgrade a loaded rubric to the current SCHEMA_VERSION — the rubric
 * counterpart to migrateSettings() in settings.js, so a future schema
 * bump can never strand a user's rubrics. Returns the (possibly
 * upgraded) rubric, or null if it can't be safely migrated.
 *
 * There are NO migration steps yet (v1 is the floor): today this passes
 * a v1 rubric through unchanged and rejects junk / newer-than-known
 * versions (a downgrade is never safe). WHEN YOU BUMP SCHEMA_VERSION,
 * add sequential `if (v < N) working = upToN(working)` steps here — and
 * persist the upgraded shape from loadRubric — and every existing user
 * rubric is carried forward instead of being dropped on load.
 */
function migrateRubric(loaded) {
  if (!loaded || typeof loaded !== 'object') return null;
  const v = Number(loaded.schemaVersion);
  if (v === SCHEMA_VERSION) return loaded;
  if (!Number.isFinite(v) || v > SCHEMA_VERSION) {
    // Junk, or written by a NEWER app than this one — don't guess.
    return null;
  }
  // v < SCHEMA_VERSION — apply upgrade steps here as the schema evolves.
  const working = loaded;
  // (no migration steps yet)
  working.schemaVersion = SCHEMA_VERSION;
  return working;
}

export function listRubrics() {
  const index = loadIndex();
  const activeId = index?.activeId || null;
  const ids = index?.rubrics?.length ? index.rubrics : listRubricFilesOnDisk();

  /** @type {Array<{ id: string, name: string, description: string, isActive: boolean, updatedAt: string|null }>} */
  const out = [];
  for (const id of ids) {
    const parsed = readJsonFile(getRubricPath(id));
    if (!parsed) continue;
    const migrated = migrateRubric(parsed);
    if (!migrated) {
      console.warn(`[rubric-store] skipping ${id}: schemaVersion ${parsed.schemaVersion} unsupported`);
      continue;
    }
    out.push({
      id: migrated.id || id,
      name: migrated.name || id,
      description: migrated.description || '',
      isActive: (migrated.id || id) === activeId,
      updatedAt: migrated.updatedAt || null,
    });
  }
  return out;
}

/**
 * Load the full rubric object for `id`. Returns null on missing /
 * malformed / schema-mismatched files. The active-rubric loader
 * (`loadActiveRubric`) calls this and falls back to seeding if it
 * returns null.
 */
export function loadRubric(id) {
  if (!isNonEmptyString(id)) return null;
  const parsed = readJsonFile(getRubricPath(id));
  if (!parsed) return null;
  const migrated = migrateRubric(parsed);
  if (!migrated) {
    console.warn(`[rubric-store] refusing to load ${id}: schemaVersion ${parsed.schemaVersion} unsupported`);
    return null;
  }
  return migrated;
}

/**
 * Return the active rubric. If the active id points at a missing /
 * unsupported file, re-runs `ensureSeeded()` to recover, then loads
 * the (now-active) default. Guarantees a usable rubric or — in the
 * worst case where even seeding failed — returns the in-memory
 * DEFAULT_RUBRIC so callers never get null.
 */
export function loadActiveRubric() {
  const index = loadIndex();
  if (index?.activeId) {
    const loaded = loadRubric(index.activeId);
    if (loaded) return loaded;
  }
  // Index missing or active rubric unreadable — re-seed and retry.
  ensureSeeded();
  const reloaded = loadRubric(loadIndex()?.activeId || DEFAULT_RUBRIC.id);
  if (reloaded) return reloaded;
  // Last-resort fallback: hand back the in-memory seed so the app can
  // still boot. The on-disk store is broken; the user will see this in
  // logs and via the Rubrics tab's "failed to load" surface.
  console.warn('[rubric-store] falling back to in-memory DEFAULT_RUBRIC — disk store unrecoverable');
  return DEFAULT_RUBRIC;
}

/**
 * Metadata-only view of the active rubric. Cheaper than
 * loadActiveRubric() when callers just need `{ id, name }` for the
 * switcher pill or a window title. Falls back to DEFAULT_RUBRIC.id /
 * .name if the disk store is unreadable.
 */
export function getActiveRubricMeta() {
  const index = loadIndex();
  const activeId = index?.activeId || DEFAULT_RUBRIC.id;
  const list = listRubrics();
  const found = list.find((r) => r.id === activeId);
  if (found) return { id: found.id, name: found.name };
  return { id: DEFAULT_RUBRIC.id, name: DEFAULT_RUBRIC.name };
}

/* ────────────────────────────────────────────────────────────────────
 * Public write API
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Persist `rubric` under `id`. Runs the validator first; if any errors
 * are reported the save is refused and the result echoes them back so
 * the renderer can surface them in the error banner.
 *
 * On success, stamps `updatedAt`, writes JSON atomically, refreshes
 * the index if `id` is new, and returns `{ ok: true, warnings }`.
 *
 * If `id !== rubric.id` the disk filename follows `id` (so a rename
 * round-trip works) but rubric.id is rewritten to match. The renderer
 * passes them equal in normal flow; the rename path is reserved for
 * the future "rename via id-edit" UX.
 */
export function saveRubric(id, rubric) {
  if (!isNonEmptyString(id)) return { ok: false, errors: ['id is required.'], warnings: [] };
  if (!rubric || typeof rubric !== 'object') {
    return { ok: false, errors: ['rubric must be an object.'], warnings: [] };
  }

  const normalised = {
    ...rubric,
    id,
    schemaVersion: SCHEMA_VERSION,
    createdAt: rubric.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const validation = validateRubric(normalised);
  if (!validation.ok) return { ok: false, errors: validation.errors, warnings: validation.warnings };

  const write = writeJsonFile(getRubricPath(id), normalised);
  if (!write.ok) return { ok: false, errors: [write.reason || 'write_failed'], warnings: validation.warnings };

  // Refresh the index so a brand-new rubric becomes discoverable.
  const index = loadIndex() || {
    schemaVersion: SCHEMA_VERSION,
    activeId: id,
    rubrics: [],
  };
  if (!index.rubrics.includes(id)) {
    saveIndex({ ...index, rubrics: [...index.rubrics, id] });
  }

  return { ok: true, errors: [], warnings: validation.warnings };
}

/**
 * Create a new rubric. If `copyFrom` is provided, deep-clones that
 * rubric's data; otherwise starts from an empty template (an empty
 * rubric won't pass validation — Identity edits in the Rubrics tab
 * are expected before the first save).
 *
 * Returns `{ ok: true, id }` on success. The new id is derived by
 * slugifying `name` and adding a uniqueness suffix when needed.
 */
export function createRubric({ name, copyFrom } = {}) {
  if (!isNonEmptyString(name)) return { ok: false, reason: 'name_required' };
  const baseId = slugify(name) || 'rubric';
  const existing = new Set((loadIndex()?.rubrics) || []);
  let id = baseId;
  let suffix = 1;
  while (existing.has(id)) {
    suffix += 1;
    id = `${baseId}_${suffix}`;
  }

  /** @type {any} */
  let source;
  if (isNonEmptyString(copyFrom)) {
    const src = loadRubric(copyFrom);
    if (!src) return { ok: false, reason: 'copy_source_not_found' };
    // structuredClone is fine here — the rubric is pure JSON data.
    source = structuredClone(src);
  } else {
    source = {
      pillars: [],
      items: [],
      capturedFields: [],
      flags: [],
      prompts: {
        voiceAndTone: '',
        coachSystemInstruction: DEFAULT_RUBRIC.prompts.coachSystemInstruction,
        liveSystemInstruction: DEFAULT_RUBRIC.prompts.liveSystemInstruction,
      },
    };
  }

  const now = new Date().toISOString();
  const rubric = {
    ...source,
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    description: source.description || '',
    createdAt: now,
    updatedAt: now,
  };

  // Skip validation when seeding an empty rubric — the Identity section
  // editor needs a slot to write into before the user can fill in
  // pillars. The first explicit Save in the tab runs validation.
  if (!isNonEmptyString(copyFrom)) {
    const result = writeJsonFile(getRubricPath(id), rubric);
    if (!result.ok) return { ok: false, reason: result.reason };
    const index = loadIndex() || { schemaVersion: SCHEMA_VERSION, activeId: id, rubrics: [] };
    if (!index.rubrics.includes(id)) {
      saveIndex({ ...index, rubrics: [...index.rubrics, id] });
    }
    return { ok: true, id };
  }

  const save = saveRubric(id, rubric);
  if (!save.ok) return { ok: false, reason: save.errors?.[0] || 'save_failed' };
  return { ok: true, id };
}

/** Duplicate the rubric at `id` under a new name. */
export function duplicateRubric(id, { newName } = {}) {
  if (!isNonEmptyString(newName)) return { ok: false, reason: 'name_required' };
  return createRubric({ name: newName, copyFrom: id });
}

/**
 * Delete rubric `id`. Refuses if `id` is the active rubric — the
 * caller must call `setActiveRubric` on a different rubric first.
 */
export function deleteRubric(id) {
  const index = loadIndex();
  if (!index) return { ok: false, reason: 'no_index' };
  if (id === index.activeId) return { ok: false, reason: 'is_active' };
  if (!index.rubrics.includes(id)) return { ok: false, reason: 'not_found' };

  const filePath = getRubricPath(id);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch (err) {
      console.warn(`[rubric-store] failed to unlink ${filePath}:`, err?.message || err);
      return { ok: false, reason: 'unlink_failed' };
    }
  }

  saveIndex({ ...index, rubrics: index.rubrics.filter((rid) => rid !== id) });
  return { ok: true };
}

/**
 * Update the active rubric id. Verifies the target file exists.
 * Pure index update — the lifecycle gating (refuse while a call is in
 * progress, teardown the Coach, broadcast `rubrics:changed`) is the
 * main-process orchestration's job (see Task 5 in the plan).
 */
export function setActiveRubric(id) {
  if (!isNonEmptyString(id)) return { ok: false, reason: 'id_required' };
  if (!existsSync(getRubricPath(id))) return { ok: false, reason: 'not_found' };
  const index = loadIndex() || { schemaVersion: SCHEMA_VERSION, activeId: id, rubrics: [] };
  const nextRubrics = index.rubrics.includes(id) ? index.rubrics : [...index.rubrics, id];
  const write = saveIndex({ ...index, activeId: id, rubrics: nextRubrics });
  if (!write.ok) return { ok: false, reason: write.reason };
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────────────
 * Export / import
 * ──────────────────────────────────────────────────────────────────── */

/** Serialise the rubric at `id` for save-to-file. */
export function exportRubric(id) {
  const rubric = loadRubric(id);
  if (!rubric) return { ok: false, reason: 'not_found' };
  return { ok: true, json: JSON.stringify(rubric, null, 2) };
}

/**
 * Validate + persist an imported rubric. If the imported id clashes
 * with an existing rubric, a uniqueness suffix is added to the id so
 * the round-trip never overwrites.
 */
export function importRubric(jsonOrObject) {
  let candidate;
  if (typeof jsonOrObject === 'string') {
    try {
      candidate = JSON.parse(jsonOrObject);
    } catch (err) {
      return { ok: false, errors: [`Invalid JSON: ${err?.message || err}`] };
    }
  } else {
    candidate = jsonOrObject;
  }
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['Imported value is not an object.'] };
  }

  // Normalise schemaVersion before validation so users importing a
  // hand-edited file without the field get a clear "missing" error
  // rather than a NaN comparison.
  if (candidate.schemaVersion === undefined) {
    return { ok: false, errors: ['Imported rubric is missing schemaVersion.'] };
  }
  if (Number(candidate.schemaVersion) !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`Unsupported schemaVersion (expected ${SCHEMA_VERSION}, got ${candidate.schemaVersion}).`],
    };
  }

  const validation = validateRubric(candidate);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  // Generate a non-colliding id.
  const existing = new Set((loadIndex()?.rubrics) || []);
  let id = candidate.id;
  if (existing.has(id)) {
    let suffix = 1;
    while (existing.has(`${candidate.id}_${suffix}`)) suffix += 1;
    id = `${candidate.id}_${suffix}`;
  }

  const save = saveRubric(id, { ...candidate, id });
  if (!save.ok) return { ok: false, errors: save.errors };
  return { ok: true, id, warnings: save.warnings };
}

/* ────────────────────────────────────────────────────────────────────
 * Internals exposed for tests / harnesses
 * ──────────────────────────────────────────────────────────────────── */

/** Reset the in-memory index cache. Test-only — used by harness scripts
 *  that switch the userData dir between runs. Not wired to any IPC. */
export function _resetCacheForTests() {
  indexCache = null;
}
