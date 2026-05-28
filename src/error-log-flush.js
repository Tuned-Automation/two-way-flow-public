/**
 * Error log — per-call file flush. Main-process only.
 *
 * This module owns the disk-write side of the error-log subsystem.
 * It is intentionally split from `src/error-log.js` (the renderer-safe
 * ring buffer + IPC broadcaster) because it imports `electron` and
 * `node:fs`, neither of which Vite can safely run inside the renderer
 * bundle. The split mirrors the established `src/rubric.js`
 * (renderer-safe live bindings) ↔ `src/rubric-store.js` (main-only
 * disk I/O) precedent — see the renderer-safety doc-block at the top
 * of `src/rubric.js` for the rationale.
 *
 * Wired by main.js on `gemini:stop`:
 *
 *   import * as errorLog from './error-log.js';
 *   import * as errorLogFlush from './error-log-flush.js';
 *   ...
 *   const window = errorLog.markCallStop();
 *   const filePath = errorLogFlush.flushCallToFile(window, errorLog.getEntries());
 *
 * Also wired for the `logs:reveal-folder` IPC handler:
 *
 *   ipcMain.handle('logs:reveal-folder', async () => {
 *     await errorLogFlush.revealFolder();
 *   });
 *
 * Surface
 *   getFolderPath()                  — absolute path to <userData>/error-logs/.
 *                                      Lazily resolves via `app.getPath`.
 *   flushCallToFile(window, entries) — write the window-filtered entries
 *                                      to error-log-<ISO>.jsonl. Returns
 *                                      the absolute file path on success,
 *                                      null when no entries fall in the
 *                                      window (or the window is null).
 *   revealFolder()                   — open the folder in Finder / Explorer
 *                                      via `shell.openPath`. Creates the
 *                                      folder first when missing so the
 *                                      Reveal button works on a fresh install.
 *
 * Architecture invariants (mirrored from `src/error-log.js`):
 *   - Per-call only: provider-test entries (which happen outside the
 *     Start/Stop window) appear in the live UI but are never written.
 *   - Empty-window guard: no file is written when zero entries fall
 *     inside `[startedAt, stoppedAt]`.
 *   - 4 KB truncation is enforced at append time in `src/error-log.js`,
 *     so each JSONL row stays compact without re-truncating here.
 */

import { app, shell } from 'electron';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Subfolder name under `userData`. Kept local so a future move
 * (e.g. nesting under `logs/error/`) is a one-line edit.
 */
const FOLDER_NAME = 'error-logs';

/**
 * Absolute path to the error-log folder.
 *
 * `app.getPath('userData')` is safe to call from this module because
 * Electron's `app` is only `null` before `whenReady` — and all
 * callers of `getFolderPath` (the `logs:reveal-folder` IPC handler
 * and `flushCallToFile`) run after the app is ready.
 *
 * @returns {string}
 */
export function getFolderPath() {
  return path.join(app.getPath('userData'), FOLDER_NAME);
}

/**
 * Ensure the error-log folder exists. Returns the resolved path.
 *
 * `recursive: true` makes this safe to call when the folder already
 * exists (no exception) AND when the parent userData dir is itself
 * a fresh install. Called from both `flushCallToFile` and
 * `revealFolder` so the "Open saved logs folder" affordance works
 * even on a brand-new install where no error has ever fired.
 *
 * @returns {string}
 */
function ensureFolder() {
  const folder = getFolderPath();
  if (!existsSync(folder)) {
    mkdirSync(folder, { recursive: true });
  }
  return folder;
}

/**
 * Build the per-call filename. Includes the ISO timestamp of the
 * call's start with `:` replaced by `-` for cross-platform safety
 * (Windows rejects `:` in filenames; macOS displays it as `/`).
 *
 *   startedAt 1748396400000 → 'error-log-2026-05-28T04-20-00.000Z.jsonl'
 *
 * @param {number} startedAt
 * @returns {string}
 */
function buildFilename(startedAt) {
  const iso = new Date(startedAt).toISOString().replace(/:/g, '-');
  return `error-log-${iso}.jsonl`;
}

/**
 * Filter entries to the call window. Entries with `at` strictly
 * outside `[startedAt, stoppedAt]` are excluded.
 *
 * Both bounds are inclusive so an entry that fires at the exact same
 * millisecond as Start (rare but possible on a fast machine where
 * the coach tick races the markCallStart call) still lands in the
 * file.
 *
 * @param {{ startedAt: number | null, stoppedAt: number | null }} window
 * @param {Array<{ at: number }>} entries
 * @returns {Array<any>}
 */
function filterToWindow(window, entries) {
  const { startedAt, stoppedAt } = window || {};
  if (typeof startedAt !== 'number' || typeof stoppedAt !== 'number') {
    return [];
  }
  return entries.filter((e) => {
    if (typeof e?.at !== 'number') return false;
    return e.at >= startedAt && e.at <= stoppedAt;
  });
}

/**
 * Write the call's failures to disk as a JSONL file.
 *
 * Returns the absolute file path on success, or `null` when nothing
 * was written. Two reasons to return `null`:
 *
 *   1. The window is incomplete (Start or Stop missing) — never
 *      flush a half-bounded window because the entries' membership
 *      is undefined.
 *
 *   2. After window-filtering, zero entries remain — silent calls
 *      (the happy path) don't deserve an empty `.jsonl` cluttering
 *      the folder.
 *
 * Synchronous on purpose: the Stop pipeline already runs to a
 * teardown chain that doesn't await async work, and a synchronous
 * write keeps the file contract simple. The file size is bounded
 * by the ring (500 entries × ~5 KB each ≈ 2.5 MB worst case), and
 * a worst-case session has many seconds of teardown around it
 * anyway — the write is not a perceptible blocker.
 *
 * Failures are caught and logged via `console.warn`. The function
 * never throws — a failed flush would be a poor reason to derail
 * the rest of the Stop pipeline (summary generation, session
 * persistence, etc.).
 *
 * @param {{ startedAt: number | null, stoppedAt: number | null }} window
 * @param {Array<any>} entries
 * @returns {string | null}
 */
export function flushCallToFile(window, entries) {
  const inWindow = filterToWindow(window, entries);
  if (inWindow.length === 0) return null;
  try {
    const folder = ensureFolder();
    const filename = buildFilename(window.startedAt);
    const filePath = path.join(folder, filename);
    const body = inWindow.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(filePath, body, 'utf8');
    return filePath;
  } catch (err) {
    console.warn('[error-log] failed to flush call to file:', err?.message || err);
    return null;
  }
}

/**
 * Open the error-log folder in the OS file browser. Ensures the
 * folder exists first so the Reveal button works on a fresh install
 * (no errors have fired → folder was never created by flush).
 *
 * Returns the open-result string from `shell.openPath` (empty string
 * on success, error message on failure). The IPC handler in main.js
 * doesn't propagate this — the renderer's button doesn't surface a
 * failure state today — but keeping the return aligns with the
 * Electron docs and lets a future caller log it if needed.
 *
 * @returns {Promise<string>}
 */
export async function revealFolder() {
  const folder = ensureFolder();
  return shell.openPath(folder);
}
