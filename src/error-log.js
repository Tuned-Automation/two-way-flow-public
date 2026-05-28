/**
 * Error log — session-scoped ring buffer for AI provider failures.
 *
 * Pre-feature every provider error was `console.warn`-only: a stalled
 * auto-generation (most often facts-scanner / quick-fix) left the rep
 * with no on-screen explanation, and the SDK-level context that
 * `friendlyError(err)` discards (status, raw response body, durationMs)
 * was never captured. This module owns the in-memory ring buffer that
 * fixes both. Failures land here via two routes:
 *
 *   1. Wrapper-side capture from `src/providers/index.js` — every
 *      `generateContent` / `testConnection` exception flows through
 *      `errorLog.append({ level: 'error', source, provider, model,
 *      status, durationMs, message, rawResponse, ... })` before
 *      rethrowing.
 *
 *   2. Direct warn-path capture from the two non-throw warning paths
 *      the wrapper can't catch:
 *        - `src/facts-scanner.js` JSON-parse failure
 *        - `src/quick-fix.js` `recordFailure(...)`
 *
 * The Settings → Error Log tab subscribes to live updates via the
 * `logs:entry` IPC channel; main.js writes a per-call
 * `error-log-<ISO-timestamp>.jsonl` to `<userData>/error-logs/` on Stop.
 *
 * IMPORTANT — renderer safety
 * ───────────────────────────
 *   This file MUST stay renderer-safe (no `electron`, no `node:fs`,
 *   no `node:path`). The provider-wrapper at `src/providers/index.js`
 *   imports `append` from here, and although today none of the
 *   provider-wrapped consumers (coach.js / facts-scanner.js /
 *   quick-fix.js / summary.js) sit in the renderer's transitive
 *   import chain, the defensive split keeps the renderer-bundle
 *   evaluation safe if anyone ever adds one to it (cf. the
 *   rubric.js → rubric-store.js precedent at `1e03b45` that broke
 *   the renderer for the entire post-Wave-1 period).
 *
 *   Disk-side work lives in `src/error-log-flush.js`, which IS
 *   main-only (imports `electron` + `node:fs`). main.js wires the
 *   two together on Stop:
 *     errorLog.markCallStop();
 *     errorLogFlush.flushCallToFile(errorLog.getCallWindow(),
 *                                   errorLog.getEntries());
 *
 * Surface
 *   append(entry)        — push an entry onto the ring (fills in id +
 *                          `at` if missing, truncates `rawResponse` to
 *                          4 KB), broadcasts `logs:entry` via the
 *                          registered sender. Returns the stored entry.
 *   getAll(opts?)        — snapshot of the ring (newest-first).
 *   getEntries()         — raw ordered array (oldest-first). Used by
 *                          the flush module so the JSONL file lines
 *                          are chronological.
 *   clear()              — empty the ring.
 *   markCallStart()      — record callStartedAt = now, clear stoppedAt.
 *   markCallStop()       — record callStoppedAt = now. Returns the
 *                          window object so callers can chain into
 *                          the flush module.
 *   getCallWindow()      — { startedAt, stoppedAt } snapshot.
 *   registerSender(fn)   — main.js calls this once with its
 *                          `send(channel, payload)` helper so the
 *                          module can broadcast without depending on
 *                          BrowserWindow directly. Safe to call before
 *                          any window exists — the send helper itself
 *                          no-ops when mainWindowRef is null.
 *
 * Architecture invariants (preserved across every consumer):
 *   1. All AI-call error capture flows through this module. No
 *      consumer file writes its own log file or maintains its own
 *      buffer.
 *   2. The provider-factory wrapper is the primary capture point.
 *      Consumer files only call `append(...)` for the specific
 *      non-throw warning paths the wrapper can't catch.
 *   3. The `source` field is the contract for the renderer's filter UI
 *      (future work). Allowed values: 'coach' | 'facts-scanner' |
 *      'quick-fix' | 'summary' | 'provider-test' | 'unknown'.
 *   4. The ring is bounded at 500 entries. Oldest is dropped when full.
 *   5. `rawResponse` is truncated to 4 KB at append time. Both the
 *      in-memory entry and the file row stay capped.
 *   6. No transcript content is captured. The log is failure metadata
 *      only — provider, model, status, error string, raw response body.
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} id              Unique-enough opaque id ('log_<rand>').
 * @property {number} at              ms since epoch. Defaults to Date.now()
 *                                    when omitted.
 * @property {'error'|'warn'} level   'error' for thrown exceptions
 *                                    (provider wrapper). 'warn' for
 *                                    non-throw failure paths (parse
 *                                    fail, recordFailure).
 * @property {'coach'|'facts-scanner'|'quick-fix'|'summary'|'provider-test'|'unknown'} source
 * @property {string} provider        'gemini' | 'anthropic' | 'openai'.
 * @property {string|null} model
 * @property {number|null} durationMs Milliseconds from call start to
 *                                    throw. Null for warn-path entries.
 * @property {string} message         Human-readable failure summary.
 * @property {number|null} status     HTTP status when the SDK exposes
 *                                    one. Null otherwise.
 * @property {('parse_error'|'sum_mismatch'|'monotonic_violation'|'empty_response'|'validation'|'exception')|null} reason
 *                                    Categorical label for the failure.
 *                                    Wrapper-captured exceptions tag
 *                                    'exception'; warn-path callers
 *                                    pass their own reason string.
 * @property {string|null} rawResponse Truncated to 4 KB. Null when no
 *                                     response body was available.
 */

/** Maximum entries kept in memory. Older entries drop off the front. */
const RING_CAPACITY = 500;

/** Truncation cap for `rawResponse` payloads — characters, not bytes. */
const RAW_RESPONSE_CAP = 4096;

/** Truncation sentinel appended when a `rawResponse` was clipped. */
const RAW_RESPONSE_SENTINEL = '\n…(truncated to 4 KB)';

/** Allowed `source` values — enforced softly by defaulting unknowns. */
const ALLOWED_SOURCES = new Set([
  'coach',
  'facts-scanner',
  'quick-fix',
  'summary',
  'provider-test',
  'unknown',
]);

/** In-memory ring buffer. Oldest at index 0. */
const ring = [];

/**
 * `send(channel, payload)` helper, registered by main.js after the
 * main window exists. Null until then — `append` falls back to a
 * no-op broadcast so the ring still records.
 *
 * @type {((channel: string, payload: any) => void) | null}
 */
let senderFn = null;

/** Per-call window markers. Both null when no call is in progress. */
let callStartedAt = null;
let callStoppedAt = null;

/**
 * Generates a short, unique-enough id without depending on `crypto`
 * (which is technically available in both Node and modern Chromium,
 * but staying dep-free keeps this file trivially renderer-safe).
 *
 * Format: `log_<base36-time>_<base36-rand>`. The leading time portion
 * keeps ids loosely sortable when sequenced through a logs viewer.
 */
function generateId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `log_${t}_${r}`;
}

/**
 * Push a new entry onto the ring buffer + broadcast it to the renderer.
 *
 * Fills in `id` and `at` when missing, normalises `source` to one of
 * the allowed values (falling back to 'unknown'), and truncates
 * `rawResponse` to 4 KB if longer. Drops the oldest entry when the
 * ring is full.
 *
 * Safe to call before `registerSender(...)` — the broadcast is a no-op
 * in that case but the ring still records, so `getAll()` will return
 * the entry on the next call.
 *
 * @param {Partial<LogEntry>} entry
 * @returns {LogEntry} The stored entry (post-normalisation).
 */
export function append(entry) {
  const safeEntry = normaliseEntry(entry);
  ring.push(safeEntry);
  if (ring.length > RING_CAPACITY) {
    ring.shift();
  }
  if (typeof senderFn === 'function') {
    try {
      senderFn('logs:entry', safeEntry);
    } catch {
      // Broadcasting is best-effort; never let a renderer-side issue
      // (window destroyed mid-broadcast, etc.) prevent the in-memory
      // capture from succeeding.
    }
  }
  return safeEntry;
}

/**
 * Coerce a partial entry into a complete `LogEntry`. Pulled out of
 * `append` so it can be unit-tested in isolation and so the field
 * defaults live in one place.
 *
 * @param {Partial<LogEntry>} input
 * @returns {LogEntry}
 */
function normaliseEntry(input) {
  const source = ALLOWED_SOURCES.has(input?.source) ? input.source : 'unknown';
  const level = input?.level === 'warn' ? 'warn' : 'error';
  const raw = typeof input?.rawResponse === 'string'
    ? truncateRaw(input.rawResponse)
    : null;
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : generateId(),
    at: typeof input?.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
    level,
    source,
    provider: typeof input?.provider === 'string' ? input.provider : 'unknown',
    model: typeof input?.model === 'string' ? input.model : null,
    durationMs: typeof input?.durationMs === 'number' && Number.isFinite(input.durationMs)
      ? input.durationMs
      : null,
    message: typeof input?.message === 'string' && input.message
      ? input.message
      : '(no message)',
    status: typeof input?.status === 'number' && Number.isFinite(input.status)
      ? input.status
      : null,
    reason: typeof input?.reason === 'string' && input.reason ? input.reason : null,
    rawResponse: raw,
  };
}

/**
 * Truncate a raw response body to RAW_RESPONSE_CAP characters and
 * append the sentinel when the body was clipped. Returns the input
 * unchanged when already within the cap.
 *
 * @param {string} body
 * @returns {string}
 */
function truncateRaw(body) {
  if (body.length <= RAW_RESPONSE_CAP) return body;
  return body.slice(0, RAW_RESPONSE_CAP) + RAW_RESPONSE_SENTINEL;
}

/**
 * Snapshot of the ring buffer, newest-first.
 *
 * Used by the Settings → Error Log tab on first open and by any
 * future filter UI. The `limit` / `offset` knobs are forward-compat
 * pagination hooks; today the renderer fetches everything.
 *
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {LogEntry[]}
 */
export function getAll(opts = {}) {
  const offset = Number.isInteger(opts?.offset) && opts.offset >= 0 ? opts.offset : 0;
  const limit = Number.isInteger(opts?.limit) && opts.limit > 0 ? opts.limit : RING_CAPACITY;
  const newestFirst = [...ring].reverse();
  return newestFirst.slice(offset, offset + limit);
}

/**
 * Raw ordered array (oldest-first). Returns a shallow copy so callers
 * can't mutate the live ring.
 *
 * Used by the flush module (`src/error-log-flush.js`) so the JSONL
 * file rows are chronological — viewing the file with `cat` reads
 * top-to-bottom in call order, matching how a tail / less workflow
 * expects log files to behave.
 *
 * @returns {LogEntry[]}
 */
export function getEntries() {
  return [...ring];
}

/**
 * Empty the in-memory ring. On-disk `.jsonl` artifacts are untouched
 * — they live across sessions until the user clears them via the
 * "Open saved logs folder" affordance.
 */
export function clear() {
  ring.length = 0;
}

/**
 * Record the wall-clock timestamp of the current call's start. Called
 * by main.js's `gemini:start` handler immediately after the call's
 * core state is initialised. Clears any stale `callStoppedAt` so a
 * mid-session resume doesn't write a stale window to the next flush.
 *
 * @returns {number} The recorded start timestamp.
 */
export function markCallStart() {
  callStartedAt = Date.now();
  callStoppedAt = null;
  return callStartedAt;
}

/**
 * Record the wall-clock timestamp of the current call's stop. Called
 * by main.js's `gemini:stop` handler AFTER summary scheduling so the
 * post-call summary's potential exception still falls inside the
 * flush window.
 *
 * Returns the window snapshot so callers can chain straight into
 * `errorLogFlush.flushCallToFile(window, entries)` without a second
 * `getCallWindow()` call.
 *
 * @returns {{ startedAt: number | null, stoppedAt: number }}
 */
export function markCallStop() {
  callStoppedAt = Date.now();
  return { startedAt: callStartedAt, stoppedAt: callStoppedAt };
}

/**
 * Snapshot of the current call window. Either field can be null
 * (e.g. before the first Start, or between Stop and the next Start).
 *
 * @returns {{ startedAt: number | null, stoppedAt: number | null }}
 */
export function getCallWindow() {
  return { startedAt: callStartedAt, stoppedAt: callStoppedAt };
}

/**
 * Register the main-side `send(channel, payload)` helper that
 * broadcasts to the renderer. Called once from `createWindow()` in
 * main.js after `mainWindowRef = mainWindow;`. Subsequent calls
 * replace the previous sender — handy for tests, otherwise unused.
 *
 * Passing a non-function (e.g. `null` to deregister during teardown)
 * is supported and reverts to the silent no-op behaviour.
 *
 * @param {((channel: string, payload: any) => void) | null} fn
 */
export function registerSender(fn) {
  senderFn = typeof fn === 'function' ? fn : null;
}
