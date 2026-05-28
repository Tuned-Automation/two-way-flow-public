import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Session history — JSON-on-disk log of every recorded call session.
 *
 * Storage choice
 * ─────────────────────────────────────────────────────────────────────
 * Same hand-rolled JSON-file pattern as `src/settings.js`: a singleton
 * in-memory cache, synchronous reads/writes via node:fs, mkdir-recursive
 * on the parent directory before each write. No new npm dependency.
 *
 * Why one file (not one-per-session): a 30-minute session record is
 * ~1.5 KB, so 1,000 sessions ≈ 1.5 MB — well inside the size where a
 * full-file rewrite on every append is cheaper than directory scanning,
 * better-sqlite3, etc. If/when the file grows past ~10 MB the swap to
 * SQLite (or chunked monthly files) is a one-file change because the
 * renderer never imports this module directly (invariant #6 of the
 * plan — all access is via the `sessions:*` IPC channels in main.js).
 *
 * File path
 *   macOS:   ~/Library/Application Support/Two Way Flow/sessions.json
 *   Win:     %APPDATA%/Two Way Flow/sessions.json
 *   Linux:   ~/.config/Two Way Flow/sessions.json
 *
 * Shape (schemaVersion = 1)
 *   {
 *     schemaVersion: 1,
 *     sessions: SessionRecord[],
 *   }
 *
 * SessionRecord shape — see the canonical definition in
 * `docs/superpowers/plans/2026-05-27-session-cost-tracking.md` ("New
 * persisted schema" section). Roughly:
 *   {
 *     id:             string  (ISO timestamp of startedAt)
 *     startedAt:      number  (ms epoch)
 *     endedAt:        number  (ms epoch)
 *     durationMs:     number
 *     usage: {
 *       geminiLive:   { model, audioInputTokens, audioOutputTokens, textOutputTokens },
 *       deepgram:     { model, audioMinutes },
 *       coach:        { provider, model, inputTokens, outputTokens, calls },
 *       summary:      { provider, model, inputTokens, outputTokens, calls },
 *       factsScanner: { provider, model, inputTokens, outputTokens, calls },
 *       quickFix:     { provider, model, inputTokens, outputTokens, calls },
 *     },
 *     costUsd: { geminiLive, deepgram, coach, summary, factsScanner, quickFix, total },
 *     pricingVersion: string  (the PRICING_VERSION used at write time),
 *   }
 *
 * Tolerance contract
 * ──────────────────
 * - A missing file is treated as an empty store (returns no sessions).
 * - A malformed file is logged once and treated as an empty store —
 *   we never throw on read because a corrupted history file must not
 *   prevent the app from launching (parallels settings.js).
 * - A failed write is logged but doesn't throw — the in-memory cache
 *   stays correct so the rest of the current session is unaffected.
 *   The next successful write overwrites the file.
 *
 * Mutation surface
 * ────────────────
 * Append-only at the public API. The ONLY mutating IPC is
 * `sessions:clear` (full wipe). Per-session edit / delete is
 * intentionally out of scope for v1 — reach for it as a follow-up
 * once a use case appears.
 *
 * Extension points
 * ────────────────
 * - Bump SCHEMA_VERSION + add a migrateSessionHistory() chain when
 *   the SessionRecord shape needs to evolve. Mirror the layered
 *   migration pattern in settings.js.
 * - For per-prospect / per-day aggregations the persisted shape
 *   already carries everything needed — add a `summariseBy()`
 *   helper here rather than in the renderer so the persistence
 *   layer stays the single source of truth.
 */

export const SCHEMA_VERSION = 1;

/** Cached store, lazy-loaded on first access. `null` until the first
 *  loadInternal() call returns. Subsequent calls hit the cache; writes
 *  update it in place before persisting. */
let cache = null;

/** Whether we've already warned about a malformed on-disk file this
 *  session. Used to keep the log clean — one warning is enough; the
 *  next successful append rewrites the file with valid JSON anyway. */
let warnedOnMalformed = false;

/** Resolve the sessions file path. Lazy because `app.getPath` is only
 *  meaningful inside the main process — calling at module-load time
 *  would crash if this module were ever imported from the renderer
 *  (it isn't today; see invariant #6 in the plan). */
export function sessionsFilePath() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

/**
 * Read the sessions file from disk. Returns `{ schemaVersion, sessions }`
 * on success, or a fresh empty store on missing / unreadable / malformed
 * files. Malformed contents log a one-shot warning (see `warnedOnMalformed`)
 * but never throw.
 */
function readFromDisk() {
  const filePath = sessionsFilePath();
  if (!existsSync(filePath)) return emptyStore();
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
      if (!warnedOnMalformed) {
        console.warn('[history] sessions.json is malformed; starting from an empty store.');
        warnedOnMalformed = true;
      }
      return emptyStore();
    }
    return {
      schemaVersion: Number.isFinite(parsed.schemaVersion) ? parsed.schemaVersion : SCHEMA_VERSION,
      sessions: parsed.sessions,
    };
  } catch (err) {
    if (!warnedOnMalformed) {
      console.warn('[history] failed to read sessions file:', err?.message || err);
      warnedOnMalformed = true;
    }
    return emptyStore();
  }
}

/**
 * Persist the store to disk. Creates the userData directory if it
 * doesn't yet exist. Best-effort: write failures are logged but
 * don't throw — the cache stays correct so the current session
 * keeps working.
 */
function writeToDisk(store) {
  const filePath = sessionsFilePath();
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[history] failed to write sessions file:', err?.message || err);
  }
}

/** Fresh empty store at the current schema version. */
function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, sessions: [] };
}

/** Lazy-load the cache. Reads from disk on first call; subsequent
 *  calls return the same object reference. */
function loadInternal() {
  if (cache) return cache;
  cache = readFromDisk();
  return cache;
}

/**
 * Append a session record to the on-disk store. The record is
 * stored in append order; `listSessions()` reverses for the
 * newest-first contract.
 *
 * Async signature is a future-proofing hint — today the underlying
 * write is synchronous (matches settings.js) but a caller that
 * awaits will work unchanged if we ever switch to fs.promises or
 * batched writes.
 */
export async function appendSession(record) {
  const store = loadInternal();
  store.sessions.push(record);
  writeToDisk(store);
}

/**
 * Return all stored sessions, newest first. Returns a fresh array —
 * mutation by the caller can't corrupt the cache.
 */
export async function listSessions() {
  const store = loadInternal();
  return store.sessions.slice().reverse();
}

/**
 * Wipe the on-disk store. Returns `{ removed }` so the renderer can
 * confirm the count in the post-clear toast.
 */
export async function clearAllSessions() {
  const store = loadInternal();
  const removed = store.sessions.length;
  store.sessions = [];
  writeToDisk(store);
  return { removed };
}
