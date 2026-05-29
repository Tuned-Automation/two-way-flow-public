import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge for the renderer.
 *
 * Audio capture stays in the renderer (Web Audio + AudioWorklet), but the
 * Gemini Live + Deepgram WebSockets live in the main process so the API
 * keys never touch the renderer. This bridge is the only surface between
 * them.
 *
 * Channels:
 *   renderer → main:
 *     gemini:start             — open a Live + Deepgram session
 *     gemini:audio:channel1    — Int16 PCM 16kHz mono chunk (ArrayBuffer)
 *                                from the salesperson mic. Fans out to
 *                                Gemini Live (flag detection) AND
 *                                Deepgram channel 1 ('you' transcript).
 *     gemini:audio:channel2    — Int16 PCM 16kHz mono chunk (ArrayBuffer)
 *                                from the system audio loopback. Routed
 *                                to Deepgram channel 2 only ('other'
 *                                transcript). Gemini Live doesn't see
 *                                this stream by design — its flag rules
 *                                are scoped to the salesperson.
 *     gemini:stop              — close all sessions
 *     coach:skip               — seller dismissed the active suggestion;
 *                                triggers a fresh 'next'-kind ask.
 *     coach:boost              — { itemId } — boost a Logged-pillar item
 *     coach:ask-suggest        — { kind: 'next'|'deeper'|'pivot' } —
 *                                one of the three transcript-footer
 *                                buttons was pressed. Adds a one-shot
 *                                suggestion opportunity on the next
 *                                coach tick.
 *     coach:ask-recap          — rep pressed the Recap button. Same
 *                                shape as coach:ask-suggest but the
 *                                'recap' kind has its own channel so
 *                                the kind validator on ask-suggest
 *                                stays tight to the three primary
 *                                buttons. Triggers a freeform recap
 *                                suggestion (item_id =
 *                                'freeform.recap').
 *     coach:ask-item           — { itemId } — rep clicked the per-item
 *                                `+ Ask` button on an uncovered rubric
 *                                row in the pillar drawer (or the
 *                                "Cover remaining" queue advanced).
 *                                Triggers a 'targeted'-kind
 *                                suggestion for that exact rubric id.
 *     coach:set-mode           — { mode: 'automated'|'signalled' } —
 *                                changes the coach's interaction mode.
 *                                Persisted on the renderer side
 *                                (localStorage); main holds a live
 *                                copy because the pause detector keys
 *                                off it.
 *     coach:mark-suggestion-asked
 *                              — { suggestionId } — rep clicked the
 *                                tick button on a pinned suggestion.
 *                                Mirrors the side-effects of the AI's
 *                                `mark_question_asked` tool (flips
 *                                the history entry's `asked` flag +
 *                                broadcasts), and additionally
 *                                transitions the corresponding rubric
 *                                item to 'logged' so the model
 *                                naturally avoids re-suggesting it
 *                                on the next tick. Idempotent — a
 *                                second click on an already-asked
 *                                entry resolves with
 *                                { ok: true, alreadyAsked: true }
 *                                and is a no-op server-side.
 *     summary:save             — { format, content } — open Save dialog
 *                                and write the summary to disk.
 *                                (Refactored in Phase 1 to route
 *                                through the shared dialog:save helper
 *                                in main.js, so the IPC contract is
 *                                unchanged.)
 *     settings:load            — read persisted app settings (six
 *                                top-level blocks: providers, audio,
 *                                appearance, coach, general, help).
 *                                See src/settings.js for shape +
 *                                fallback semantics.
 *     settings:save            — deep-merge a partial into stored
 *                                settings. Returns the FULL current
 *                                settings object so the renderer form
 *                                can re-hydrate from the response.
 *     settings:reset           — { preserveKeys?: boolean } — wipe all
 *                                settings back to defaults. Default
 *                                preserveKeys=true keeps API keys
 *                                across the reset. Returns the full
 *                                reset shape; main broadcasts
 *                                `settings:changed` on success.
 *     settings:export          — { includeKeys?: boolean } — returns
 *                                { json, includesKeys, filename }
 *                                ready to feed into dialog:save.
 *     settings:validate-import — JSON string in. Returns
 *                                { ok, normalised? | error? }.
 *                                Used by the import preview modal.
 *     settings:apply-import    — JSON string in. Commits a wholesale
 *                                replacement. Returns
 *                                { ok, settings? | error? }; main
 *                                broadcasts `settings:changed` on
 *                                success.
 *     appearance:open-preview  — open / focus the transparency
 *                                preview window (second
 *                                BrowserWindow used by the
 *                                Appearance tab's slider editor).
 *                                Lazy-created on first invoke;
 *                                idempotent if already open.
 *                                Returns { ok: true }.
 *     appearance:close-preview — destroy the transparency preview
 *                                window if alive. Idempotent.
 *                                Returns { ok: true }.
 *     dialog:open              — { title?, defaultPath?, filters?,
 *                                  properties?, readAs? } — show a
 *                                native Open dialog. If `readAs:
 *                                'utf8'`, also reads the chosen file
 *                                and returns its contents.
 *     dialog:save              — { title?, defaultName?, defaultPath?,
 *                                  filters?, content? } — show a
 *                                native Save dialog. If `content` is
 *                                a string, also writes it to the
 *                                chosen path.
 *     clipboard:write          — { text } — write a string to the OS
 *                                clipboard via Electron's native
 *                                clipboard module. Bypasses the
 *                                browser permission system so the
 *                                call-summary Copy buttons work even
 *                                when navigator.clipboard would
 *                                otherwise be gated.
 *     system:open-screen-recording-settings
 *                              — open the macOS Screen Recording
 *                                privacy pane (no-op elsewhere). Used
 *                                by the permission explainer modal.
 *     system:screen-recording-status
 *                              — query current Screen Recording perm
 *                                state ('granted' | 'denied' |
 *                                'not-determined' | 'restricted' |
 *                                'unknown' on non-darwin).
 *     system:list-audio-sources
 *                              — enumerate desktop audio sources for
 *                                the Audio tab's system-audio picker.
 *                                Returns { sources: [{ id, name }],
 *                                permission, error? }. macOS without
 *                                Screen Recording perm returns an
 *                                empty list + the perm state so the
 *                                renderer can surface the explainer
 *                                modal.
 *     window:minimize          — minimise the overlay BrowserWindow
 *                                to the OS taskbar / dock. The
 *                                frameless header's "—" button calls
 *                                this; the user can restore via the
 *                                Tray icon, the macOS dock, or the
 *                                Cmd/Ctrl+Shift+H global shortcut.
 *     window:close             — close the overlay window. main's
 *                                `window-all-closed` handler fires
 *                                `app.quit()` afterwards on every
 *                                platform (overlay-tool semantics),
 *                                so the in-header × button ends up
 *                                fully exiting the app. The Settings
 *                                and Summary modal × buttons are
 *                                separate dialog-close handlers and
 *                                are unaffected.
 *     window:quit              — short-circuit straight to
 *                                `app.quit()`. Exposed for symmetry
 *                                with the Tray's Quit menu so the
 *                                renderer doesn't have to distinguish
 *                                close-then-quit from quit-now.
 *     app:version              — one-shot read of the build-version
 *                                metadata used by the header
 *                                `#versionBadge` pill. Returns
 *                                { pkgVersion, gitSha, gitDirty,
 *                                builtAt }. Cached in main for the
 *                                process lifetime — none of the
 *                                inputs change without a restart.
 *                                Renderer calls once at boot. See
 *                                computeAppVersion() in src/main.js
 *                                for the dev-vs-packaged read
 *                                decision.
 *
 *   main → renderer:
 *     gemini:opened            — session established
 *     gemini:transcript        — { speaker, text, finished } incremental
 *                                transcript chunk. `speaker` is 'you'
 *                                (salesperson mic / Deepgram ch1) or
 *                                'other' (prospect via loopback /
 *                                Deepgram ch2). When Deepgram is down,
 *                                main.js falls back to Gemini's
 *                                inputTranscription tagged as 'you'.
 *                                `text` is the FULL current segment
 *                                text for that speaker (replace-on-
 *                                interim semantics — see main.js
 *                                handleDeepgramTranscript).
 *     gemini:turn-complete     — server marked the current turn complete
 *     gemini:error             — { message } connection/api error
 *     gemini:closed            — session closed (reason)
 *     scoring:flag             — { id, evidence } live coaching flag
 *     scoring:item-state       — { itemId, state, evidence, confidence,
 *                                  source } a rubric checklist item
 *                                  moved between the 4 lifecycle states.
 *     scoring:field            — { fieldId, value, evidence } captured
 *                                  key/value pair extracted by the coach.
 *     scoring:quick-fix        — { quickFix, entries } — Strategy A
 *                                  Stage-2 rollup. `quickFix` is the
 *                                  rolled-up { headlineUsdAnnual,
 *                                  breakdown, assumptions, confidence,
 *                                  currency, updatedAt, stale, error }
 *                                  shape (or null if the sheet is
 *                                  empty); `entries` is the snapshot
 *                                  of active factsSheet entries the
 *                                  rollup was computed from so the
 *                                  renderer's drill-through can map a
 *                                  breakdown row's `source` id back to
 *                                  the original anchor quote. See
 *                                  src/quick-fix.js for the rollup
 *                                  pipeline + validator + fallback
 *                                  semantics.
 *     coach:suggestion         — { itemId, question, rationale,
 *                                  anchorQuote, kind } the coach's
 *                                  most recent "ask this next". The
 *                                  anchorQuote (≤120 chars) is a
 *                                  required field for the v2.5
 *                                  context-first prompt; the renderer
 *                                  surfaces it as "responding to: …"
 *                                  under the suggestion card. `kind`
 *                                  reflects which ask triggered this
 *                                  suggestion (next | deeper | pivot |
 *                                  pause) so the UI can adjust labels
 *                                  / styling per kind.
 *     coach:tick-start         — coach roundtrip started (drives the
 *                                  pulsing "thinking" dot).
 *     coach:tick-end           — coach roundtrip ended.
 *     scoring:suggestion-history
 *                              — Array<{ id, itemId, questionText,
 *                                  kind, pinnedAt, asked, askedAt,
 *                                  evidence, replaced }> — full
 *                                  snapshot of suggestion history
 *                                  (Coach → Track question state).
 *                                  Broadcast on every mutation so the
 *                                  drawer can render the asked /
 *                                  replaced annotations.
 *     settings:changed         — { …full settings, _envAvailability }
 *                                  — main broadcasts whenever
 *                                  settings:save / :reset / :import
 *                                  is invoked so the renderer can
 *                                  re-pull settings.coach.* (and any
 *                                  other live-read field) without a
 *                                  second roundtrip.
 *     summary:ready            — { scorecard, factsTable, transcript,
 *                                  debrief, durationMs, asJSON,
 *                                  asMarkdown } — Phase 5 post-call
 *                                  summary payload. Fired by main.js
 *                                  after `gemini:stop` once the Gemini
 *                                  Flash debrief call returns. Always
 *                                  fires (even on failure — payload
 *                                  degrades gracefully).
 *     connection:status        — { deepgram, geminiLive } — current
 *                                  health snapshot of each upstream
 *                                  transport. Each value is one of:
 *                                    'connected'   — open and streaming
 *                                    'reconnecting' — closed, retrying
 *                                    'down'        — closed, giving up
 *                                    'closed'      — gemini-specific:
 *                                                    soft-degraded
 *                                                    (Deepgram still
 *                                                    canonical, so the
 *                                                    call continues
 *                                                    without
 *                                                    flag detection)
 *                                  Broadcast on every lifecycle
 *                                  transition (Deepgram open / close /
 *                                  reconnect-attempt / give-up; Gemini
 *                                  Live open / close / reconnect /
 *                                  give-up) so the header pill can
 *                                  surface the worst-of state without
 *                                  polling. See connectionState +
 *                                  broadcastConnectionStatus in
 *                                  src/main.js for the source of truth.
 *
 * `scoring:*` carries the structured-rubric pipeline; `coach:*` carries
 * the next-question advisory output. They share a producer (the text
 * coach in src/coach.js) but are split so the renderer can subscribe to
 * each surface independently.
 *
 * The `rubrics:*` channels (list / load / save / create / duplicate /
 * delete / set-active / export / import / validate / get-default-prompts
 * renderer→main, plus `rubrics:changed` main→renderer) belong to the
 * editable-rubric feature and are exposed via a SEPARATE top-level
 * `window.rubrics.*` namespace rather than nested under `gemini.*`.
 * See the doc block on that contextBridge.exposeInMainWorld call below
 * for the full per-channel contract.
 */

const RENDERER_EVENTS = [
  'gemini:opened',
  'gemini:transcript',
  'gemini:turn-complete',
  'gemini:error',
  'gemini:closed',
  'scoring:flag',
  'scoring:item-state',
  'scoring:field',
  'scoring:quick-fix',
  'scoring:suggestion-history',
  'coach:suggestion',
  'coach:tick-start',
  'coach:tick-end',
  'summary:ready',
  'settings:changed',
  'connection:status',
  // Editable-rubric feature: broadcast on rubrics:set-active and on
  // rubrics:save when the saved rubric is active AND the session is
  // idle. The renderer re-runs `rubrics.list()` to refresh the
  // switcher pill + library bar, then re-renders the rail/captured
  // pane against the new active rubric.
  'rubrics:changed',
  // Error-log feature: pushed every time errorLog.append(...) fires
  // (provider-wrapper throws, facts-scanner parse failure, quick-fix
  // recordFailure). Payload is a single LogEntry shape — see
  // src/error-log.js's typedef. The renderer's Error Log tab
  // subscribes via `window.gemini.onLogsEntry(cb)` and prepends a
  // .log-row to #errorLogList in real time.
  'logs:entry',
  // Updater download progress ({ receivedBytes, totalBytes, percent }).
  // The renderer's Updates UI subscribes via window.gemini.updates.onProgress.
  'updates:progress',
];

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('gemini', {
  start: () => ipcRenderer.invoke('gemini:start'),
  stop: () => ipcRenderer.invoke('gemini:stop'),
  skipCoachSuggestion: () => ipcRenderer.invoke('coach:skip'),
  // Alias matching the v2.5 spec; both names point at the same channel
  // so older renderer code paths keep working alongside the new Skip
  // pill on the suggestion card.
  skipCoach: () => ipcRenderer.invoke('coach:skip'),
  boostCoachItem: (itemId) => ipcRenderer.invoke('coach:boost', { itemId }),
  // v2.5 redesign: one of the three transcript-footer buttons was
  // pressed. `kind` is one of 'next' | 'deeper' | 'pivot' (the
  // internal 'pause' kind is fired by main's pause detector, not
  // the renderer).
  askSuggestion: (kind) => ipcRenderer.invoke('coach:ask-suggest', { kind }),
  // Recap button — separate IPC channel because recap is always
  // freeform (item_id = 'freeform.recap') and the renderer doesn't
  // need to pass a kind discriminator. Triggers a one-shot
  // suggestion opportunity with kind:'recap' on the next coach tick.
  askRecap: () => ipcRenderer.invoke('coach:ask-recap'),
  // Per-item targeted ask. Fired by the `+ Ask` button on each
  // uncovered rubric row in the pillar rail drawer, and by the
  // "Cover remaining" queue as it cycles through items. Triggers a
  // 'targeted'-kind suggestion request — the coach generates a
  // question for THAT exact rubric item rather than picking from the
  // backlog.
  askItem: (itemId) => ipcRenderer.invoke('coach:ask-item', { itemId }),
  // v2.5 redesign: persist + propagate the coach interaction mode.
  // `mode` is 'automated' | 'signalled'. Called on session start AND
  // every time the user flips the header toggle so the pause detector
  // can light up / dim live.
  setCoachMode: (mode) => ipcRenderer.invoke('coach:set-mode', { mode }),
  // Manual mark-as-asked. Fired by the tick button on the pinned
  // suggestion card. Mirrors the AI's `mark_question_asked` side-
  // effects (flips entry.asked) and additionally transitions the
  // rubric item to 'logged' so the next coach tick's candidate list
  // drops it. Idempotent — repeated clicks on an already-asked entry
  // resolve without re-running the side-effects.
  markSuggestionAsked: (suggestionId) =>
    ipcRenderer.invoke('coach:mark-suggestion-asked', { suggestionId }),
  // ArrayBuffer / Uint8Array survives structured clone across the bridge.
  sendMicAudio: (pcmChunk) => ipcRenderer.send('gemini:audio:channel1', pcmChunk),
  sendSystemAudio: (pcmChunk) => ipcRenderer.send('gemini:audio:channel2', pcmChunk),

  // Phase 5: post-call summary save (via native Save dialog in main).
  saveSummary: ({ format, content }) => ipcRenderer.invoke('summary:save', { format, content }),

  /**
   * Persistent app settings (six top-level blocks: providers, audio,
   * appearance, coach, general, help — one per tab in the Settings
   * modal).
   *
   * All mutating methods (save / reset / applyImport) return the FULL
   * current settings object — the renderer can re-hydrate its form
   * without a second `load()` roundtrip. Main also broadcasts
   * `settings:changed` on every mutation so any other subscriber
   * (drawer-rendering code, etc.) picks up the new shape without
   * an extra IPC.
   *
   * Storage lives at app.getPath('userData') + '/settings.json' (see
   * src/settings.js). Saves take effect on the NEXT session start —
   * the live Coach / Gemini Live sessions snapshot their model + key
   * at start time and don't re-read them mid-call.
   */
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (partial) => ipcRenderer.invoke('settings:save', partial),
    /**
     * Cheap connectivity probe — pings the provider with a minimal
     * request and returns { ok, message? }. The renderer surfaces the
     * result inline next to the Test button on each provider card.
     */
    testProvider: (provider) => ipcRenderer.invoke('settings:test-provider', provider),
    /**
     * Snapshot of which providers have a key configured vs falling
     * back to env. Used by the Providers tab to refresh status badges
     * after a save without re-loading the whole settings object.
     */
    providerStatus: () => ipcRenderer.invoke('settings:provider-status'),

    /* ── Data subsection (General tab, Phase 1) ─────────────────── */

    /**
     * Reset every setting to its built-in defaults. Pass
     * `{ preserveKeys: false }` to also wipe configured API keys
     * (default true keeps them — the high-value default since keys
     * are the only setting users meaningfully lose work over).
     *
     * Returns the full reset settings shape (same shape as `load`).
     * Main also broadcasts `settings:changed` so subscribers refresh.
     */
    reset: (options) => ipcRenderer.invoke('settings:reset', options || {}),

    /**
     * Serialise the current settings for export. Returns
     *   { json: string, includesKeys: boolean, filename: string }
     *
     * Pass `{ includeKeys: true }` to include configured API keys in
     * the export. Default omits them so the exported file is safer
     * to share. The renderer chains this with `dialog.save` to write
     * the JSON to a user-chosen path.
     */
    export: (options) => ipcRenderer.invoke('settings:export', options || {}),

    /**
     * Validate a JSON string as importable settings WITHOUT applying
     * it. Returns
     *   { ok: true, normalised }  — parsed + migrated, ready to apply
     *   { ok: false, error }      — human-readable failure reason
     *
     * The renderer uses this to populate the import preview modal
     * before the user confirms the wholesale replacement.
     */
    validateImport: (json) => ipcRenderer.invoke('settings:validate-import', json),

    /**
     * Commit a previously-validated import (full wholesale replace).
     * Returns
     *   { ok: true, settings }  — the new full settings shape
     *   { ok: false, error }    — validation failed (unchanged on disk)
     *
     * Main broadcasts `settings:changed` on success.
     */
    applyImport: (json) => ipcRenderer.invoke('settings:apply-import', json),
  },

  /**
   * Error-log feature — `window.gemini.logs.*` bridge.
   *
   * The renderer's Settings → Error Log tab uses this sub-namespace to
   * read the in-memory ring buffer snapshot, clear it, and open the
   * on-disk per-call `.jsonl` folder. Live tail is handled by
   * `onLogsEntry` (below, next to onSettingsChanged) which subscribes
   * to the 'logs:entry' broadcast added to RENDERER_EVENTS.
   *
   * NESTED under `window.gemini.*` (not a peer top-level like
   * `window.rubrics` / `window.sessions`) per the kickoff
   * coordination decision — keeps the gemini bridge surface
   * consolidated for new observability features that don't need
   * their own bridge.
   *
   * Channels (renderer → main, all invoke):
   *   logs:load          → opts? { limit?: number, offset?: number }
   *                        → LogEntry[] (newest-first)
   *   logs:clear         → () → undefined
   *   logs:reveal-folder → () → undefined. Opens <userData>/error-logs/
   *                        in Finder / Explorer. Creates the folder
   *                        if it doesn't exist (fresh-install case).
   */
  logs: {
    load: (opts) => ipcRenderer.invoke('logs:load', opts || {}),
    clear: () => ipcRenderer.invoke('logs:clear'),
    revealFolder: () => ipcRenderer.invoke('logs:reveal-folder'),
  },

  /**
   * Appearance-tab sidecar plumbing — currently just the transparency
   * preview window. Read-only bridge: open / close lifecycle only.
   * The preview window itself reads the current transparency settings
   * via the existing `settings.load` + `onSettingsChanged` plumbing
   * exposed on this same bridge (the preview's preload IS this file).
   *
   * No `transparency.*` methods here on purpose — slider edits flow
   * through the existing `settings.save` path so they round-trip
   * through `settings:changed` and reach every subscriber (main
   * renderer + preview renderer + any future window).
   */
  appearance: {
    openPreview: () => ipcRenderer.invoke('appearance:open-preview'),
    closePreview: () => ipcRenderer.invoke('appearance:close-preview'),
  },

  /**
   * Generic Open / Save dialogs. Used by:
   *   - settings.export / .applyImport flows for the export-to-JSON
   *     and import-from-JSON file pickers.
   *   - `pickPathFromDialog` in renderer.js for any future field
   *     that stores a file or folder path (Phase 5's autosave folders,
   *     etc.).
   *   - Indirectly by `saveSummary` (which is its own IPC channel,
   *     but routes through the same main-side helper).
   *
   * Both methods accept an optional content/read-step:
   *   - dialog.save({ content: '...' })   → writes the content to the
   *                                          chosen path before
   *                                          returning. Omit `content`
   *                                          for a path-only pick.
   *   - dialog.open({ readAs: 'utf8' })   → reads the chosen file and
   *                                          returns its contents.
   *                                          Omit `readAs` for a
   *                                          path-only pick.
   */
  dialog: {
    open: (options) => ipcRenderer.invoke('dialog:open', options || {}),
    save: (options) => ipcRenderer.invoke('dialog:save', options || {}),
  },

  /**
   * Native clipboard bridge. Used by the call-summary modal's Copy
   * JSON / Copy Markdown buttons. Routes through Electron's
   * `clipboard.writeText()` in main so the write doesn't go through
   * the renderer's `navigator.clipboard` permission gate (which
   * Electron's permission handler can otherwise deny silently).
   *
   * Returns `{ ok: true }` on success or `{ ok: false, error }` on
   * failure. The renderer's `copyToClipboard` helper consumes the
   * boolean and flashes the footer toast accordingly.
   */
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write', { text }),
  },

  /**
   * System-facing helpers grouped under `system.*`. Phase 2 adds the
   * audio-source enumeration for the Audio tab's system-audio picker.
   * The two existing screen-recording helpers are kept at the top
   * level for back-compat with Phase 4 call sites.
   */
  system: {
    /**
     * Enumerate desktop audio sources for the system-audio picker.
     * Returns `{ sources: Array<{ id, name }>, permission, error? }`.
     * On macOS without granted Screen Recording perm, `sources` is
     * empty and `permission` reflects the OS state ('not-determined'
     * | 'denied' | 'restricted') so the renderer can surface the
     * existing explainer modal without an extra IPC.
     *
     * Implementation: desktopCapturer.getSources({ types: ['screen',
     * 'window'] }) in main.js. Thumbnails are stripped because the
     * dropdown doesn't render previews.
     */
    listAudioSources: () => ipcRenderer.invoke('system:list-audio-sources'),
  },

  // Phase 4: macOS Screen Recording permission helpers.
  openScreenRecordingSettings: () => ipcRenderer.invoke('system:open-screen-recording-settings'),
  getScreenRecordingStatus: () => ipcRenderer.invoke('system:screen-recording-status'),

  /**
   * Window-chrome controls for the frameless overlay. The visible
   * "—" and "×" buttons in the in-HTML header drive these — there
   * is no native chrome to fall back on (`frame: false`).
   *
   * Semantics worth surfacing here (long-form lives in main.js's
   * IPC doc-block):
   *   - close() fully quits the app on all platforms. main's
   *     window-all-closed handler overrides the macOS default of
   *     keeping the app alive in the dock, so the header's × is
   *     equivalent to Quit. The Tray icon + macOS dock-click
   *     handler (`app.on('activate')`) are the way back in.
   *   - minimize() is a true OS minimise: visible in the taskbar /
   *     dock, restorable via the tray icon, dock click, or the
   *     Cmd/Ctrl+Shift+H global shortcut.
   *   - quit() is provided for completeness — the tray's Quit
   *     context-menu item bypasses this and calls app.quit() from
   *     main directly, but if a future in-renderer code path wants
   *     to exit without going through a window close, this is the
   *     channel.
   */
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    quit: () => ipcRenderer.invoke('window:quit'),
    // Grow the overlay while the Settings modal is open (true) and
    // restore its previous bounds on close (false). The Settings modal
    // lives inside the overlay window, so this is how it gets room
    // bigger than the overlay's default size. Backed by
    // 'window:settings-open' in src/main.js.
    setSettingsOpen: (open) => ipcRenderer.invoke('window:settings-open', !!open),
  },

  /**
   * Build-version metadata for the header `#versionBadge`. Resolves
   * to { pkgVersion: '1.0.0', gitSha: '89f97a8', gitDirty: false,
   * builtAt: 1716700000000 }. In dev mode the SHA + dirty flag are
   * read at runtime via `git`; in a packaged build they're baked in
   * at Vite-compile time (see vite.main.config.mjs + the
   * computeAppVersion block-comment in src/main.js).
   *
   * Renderer calls this once at boot — the values can't change
   * mid-session, so there's no companion subscriber on the
   * main → renderer channel.
   */
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  /**
   * In-app updater bridge (backed by src/updater.js via main IPC).
   *   check()              -> { ok, currentVersion, latestVersion,
   *                             updateAvailable, mustUpdate, notes, asset }
   *   download(asset)      -> { ok, filePath, verified } | { ok:false, reason }
   *                           (reason 'integrity_mismatch' = SHA-256 failed)
   *   reveal(filePath)     -> show the verified download in Finder
   *   onProgress(cb)       <- 'updates:progress' { receivedBytes, totalBytes, percent }
   */
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    download: (asset) => ipcRenderer.invoke('updates:download', asset),
    reveal: (filePath) => ipcRenderer.invoke('updates:reveal', filePath),
    onProgress: subscribe('updates:progress'),
  },

  onOpened: subscribe('gemini:opened'),
  onTranscript: subscribe('gemini:transcript'),
  onTurnComplete: subscribe('gemini:turn-complete'),
  onError: subscribe('gemini:error'),
  onClosed: subscribe('gemini:closed'),
  onScoringFlag: subscribe('scoring:flag'),
  onScoringItemState: subscribe('scoring:item-state'),
  onScoringField: subscribe('scoring:field'),
  /**
   * Stage-2 quick-fix rollup (Strategy A / Work-stream C). Fired
   * every time the Stage-2 worker produces a new rollup (success or
   * fallback-with-stale-flag). The renderer mirrors `entries` into
   * local state to support the drill-through from breakdown row →
   * anchor quote in the transcript pane.
   */
  onScoringQuickFix: subscribe('scoring:quick-fix'),
  // Coach → Track question state: full per-call history snapshot,
  // refreshed on every mutation. The renderer mirrors it into
  // state.suggestionHistory and re-renders the logged-questions drawer.
  onScoringSuggestionHistory: subscribe('scoring:suggestion-history'),
  onCoachSuggestion: subscribe('coach:suggestion'),
  onCoachTickStart: subscribe('coach:tick-start'),
  onCoachTickEnd: subscribe('coach:tick-end'),
  onSummaryReady: subscribe('summary:ready'),
  // Main broadcasts the full settings shape (including
  // _envAvailability) whenever settings:save / :reset / :import fires.
  // Renderer subscribers re-read settings.coach.* (and other live-read
  // fields) and re-render anything that depends on them (e.g. the
  // green-outline drawer styling).
  onSettingsChanged: subscribe('settings:changed'),

  /**
   * Error-log live tail. Fires every time main appends a LogEntry to
   * the ring buffer (provider wrapper throws, facts-scanner parse
   * fail, quick-fix recordFailure). The Error Log tab prepends a
   * new .log-row to #errorLogList; the subscription stays active
   * across Settings open/close so the renderer never misses an
   * entry. `unsubscribe = onLogsEntry(callback)` to detach.
   */
  onLogsEntry: subscribe('logs:entry'),

  /**
   * Connection-health broadcast. Fires on every lifecycle transition
   * for either upstream transport (Deepgram / Gemini Live). The
   * renderer's header pill subscribes and rolls the per-transport
   * statuses up into a single worst-of indicator — green when both
   * are connected, amber on any reconnect-in-progress, red when both
   * are down.
   *
   * Payload shape:
   *   { deepgram: 'connected'|'reconnecting'|'down',
   *     geminiLive: 'connected'|'reconnecting'|'down'|'closed' }
   *
   * The 'closed' state is Gemini-Live-specific and means
   * "soft-degraded": Deepgram is still canonical, so the call
   * continues without live flag detection. The renderer treats it
   * the same as 'down' for the worst-of rollup but the title
   * tooltip can differentiate.
   */
  onConnectionStatus: subscribe('connection:status'),

  // Escape hatch for renderer-side teardown / hot reload.
  _events: RENDERER_EVENTS,
});

/**
 * Editable-rubric feature — `window.rubrics.*` bridge.
 *
 * Separate top-level namespace (not nested under `gemini.*`) because
 * the rubric library is a peer concept to the call-side runtime: a
 * user can manage rubrics without a call in progress. Keeping them
 * at sibling scope makes the consumer surface read clearly in the
 * renderer:
 *
 *     await window.rubrics.list()
 *     await window.rubrics.setActive('tuned_automation')
 *
 * Channel ↔ method mapping (every method round-trips one IPC):
 *
 *   list()                          → rubrics:list
 *       Returns { ok, rubrics: [{ id, name, description, isActive,
 *       updatedAt }], active: { id, name } } — feeds the library bar
 *       dropdown and the switcher pill title.
 *
 *   load(id)                        → rubrics:load
 *       Returns { ok, rubric } | { ok: false, reason: 'not_found' }.
 *       Full rubric object for the editor panel.
 *
 *   save(id, rubric)                → rubrics:save
 *       Returns { ok, errors[], warnings[], applied } where
 *       `applied: true` means the saved rubric was the active one
 *       AND the session was idle, so main reloaded the live bindings
 *       and broadcast `rubrics:changed`. `applied: false` means the
 *       save persisted to disk but the live state was left alone
 *       (a call is in progress or this isn't the active rubric).
 *
 *   create({ name, copyFrom? })     → rubrics:create
 *       Returns { ok, id } | { ok: false, reason }.
 *
 *   duplicate(id, { newName })      → rubrics:duplicate
 *       Returns { ok, id } | { ok: false, reason }.
 *
 *   remove(id)                      → rubrics:delete
 *       Returns { ok } | { ok: false, reason: 'is_active' | 'not_found' }.
 *       NB: the method is named `remove` rather than `delete` only
 *       because `delete` is a reserved word and the codebase prefers
 *       not to lean on JS's grace-period support for reserved names
 *       in property positions. The IPC channel itself is `rubrics:delete`.
 *
 *   setActive(id)                   → rubrics:set-active
 *       Returns { ok } | { ok: false, reason: 'call_in_progress'
 *       | 'not_found' | ... }. The renderer surfaces 'call_in_progress'
 *       as "End the current call before switching rubrics."
 *
 *   export(id)                      → rubrics:export
 *       Returns { ok, json } — pretty-printed JSON ready to feed
 *       into window.gemini.dialog.save for a Save-as-file flow.
 *
 *   import(json)                    → rubrics:import
 *       Validates, generates a non-colliding id if needed, persists.
 *       Returns { ok, id, warnings } | { ok: false, errors[] }.
 *
 *   validate(rubric)                → rubrics:validate
 *       Synchronous validation pass. Returns { ok, errors[],
 *       warnings[] }. Used by the editor's live "show pending
 *       errors" surface so the user can spot a malformed shape
 *       BEFORE clicking Save.
 *
 *   getDefaultPrompts()             → rubrics:get-default-prompts
 *       Returns { ok, coachSystemInstruction, liveSystemInstruction,
 *       voiceAndTone } — the DEFAULT_RUBRIC's prompt templates.
 *       Used by the editor's "Reset to default" buttons under the
 *       Coach Prompt section.
 *
 *   activeSync()                    → rubrics:active-sync  (SYNCHRONOUS)
 *       Blocking round-trip that returns the full active rubric shape
 *       (or null). The ONLY synchronous channel in this bridge. Used
 *       exactly once, at the top of the renderer module body, to hydrate
 *       rubric.js's live bindings before any rubric-derived state is
 *       built — so the first frame paints the active rubric instead of
 *       flashing DEFAULT_RUBRIC. Not for general use.
 *
 *   onChanged(callback)             ← rubrics:changed
 *       Subscribe to active-rubric / saved-active-rubric broadcasts.
 *       Callback receives { activeId, reason: 'set-active' | 'save' }.
 *       Returns an unsubscribe function. Renderers should subscribe
 *       once at boot and re-render rail / captured / switcher pill /
 *       library bar in response to every event.
 *
 * Architecture invariant honoured here: NO direct fs access from the
 * renderer. Every rubric mutation routes through main so the
 * call-active gate (`rubrics:set-active` refusing while a session is
 * running) is enforceable centrally — a renderer that bypassed the
 * bridge would defeat that invariant.
 */
contextBridge.exposeInMainWorld('rubrics', {
  list: () => ipcRenderer.invoke('rubrics:list'),
  load: (id) => ipcRenderer.invoke('rubrics:load', { id }),
  save: (id, rubric) => ipcRenderer.invoke('rubrics:save', { id, rubric }),
  create: (opts) => ipcRenderer.invoke('rubrics:create', opts || {}),
  duplicate: (id, opts) => ipcRenderer.invoke('rubrics:duplicate', { id, ...(opts || {}) }),
  remove: (id) => ipcRenderer.invoke('rubrics:delete', { id }),
  setActive: (id) => ipcRenderer.invoke('rubrics:set-active', { id }),
  export: (id) => ipcRenderer.invoke('rubrics:export', { id }),
  import: (json) => ipcRenderer.invoke('rubrics:import', { json }),
  validate: (rubric) => ipcRenderer.invoke('rubrics:validate', { rubric }),
  getDefaultPrompts: () => ipcRenderer.invoke('rubrics:get-default-prompts'),
  // SYNCHRONOUS — returns the full active rubric shape (or null) in a
  // single blocking round-trip. Exists solely so the renderer can
  // hydrate its rubric.js live bindings at the very top of its module
  // body, before any rubric-derived state is computed, and paint the
  // active rubric on the first frame instead of flashing DEFAULT_RUBRIC.
  // Do NOT use this for anything else — every other read/mutation must
  // stay on the async invoke channels above. Backed by `rubrics:active-sync`
  // (ipcMain.on) in src/main.js.
  activeSync: () => ipcRenderer.sendSync('rubrics:active-sync'),
  onChanged: subscribe('rubrics:changed'),
});

/* ────────────────────────────────────────────────────────────────────
 * Session cost tracking bridge (session-cost-tracking feature, Wave 2)
 *
 * Exposes the three `sessions:*` IPC channels under `window.sessions.*`.
 * Used by the Settings → Usage tab in src/renderer.js to render the
 * chronological list of session cost records and to wire the Export
 * and Clear buttons.
 *
 * Namespace placement
 *   Peer top-level namespace, NOT nested under `window.gemini.*`.
 *   Follows the precedent set by Wave 1's `window.rubrics` namespace
 *   (see the doc-block on that contextBridge call directly above).
 *   `window.gemini` continues to own the live-session lifecycle +
 *   coach IPC; `window.rubrics` owns the rubric library; `window.sessions`
 *   owns the read-only cost-record store. Splitting by domain keeps
 *   each namespace small enough to scan in one screen and avoids one
 *   giant `gemini.*` god-object.
 *
 *   The coordinator can consolidate under `gemini.sessions` later if
 *   the peer-namespace count becomes unwieldy — that's a one-line
 *   move on the renderer side because the IPC channels are unchanged.
 *
 * Methods
 *   list()    → SessionRecord[] (newest first)
 *               Source of truth for the Usage tab's <ol>.
 *   clear()   → { removed: number }
 *               Wipes the on-disk store. The renderer's "Clear history"
 *               button confirms via native confirm() before calling
 *               this — there's no undo.
 *   export()  → { json, csv, sessionsCount, filePath }
 *               Returns BOTH JSON (full per-component breakdown) and
 *               CSV (one row per session, headline cost figures) so
 *               the renderer's Export flow can route either format
 *               into the native Save dialog (v2; v1 copies JSON to
 *               clipboard — see plan Task 10 §4 for the migration
 *               path).
 *
 * Architecture invariant honoured here: the renderer NEVER imports
 * src/session-history.js or src/pricing.js directly (per plan
 * invariant #6). All access is through these three thin invokes so
 * a future swap to better-sqlite3 / remote sync stays renderer-
 * transparent.
 * ──────────────────────────────────────────────────────────────────── */
contextBridge.exposeInMainWorld('sessions', {
  list: () => ipcRenderer.invoke('sessions:list'),
  clear: () => ipcRenderer.invoke('sessions:clear'),
  export: () => ipcRenderer.invoke('sessions:export'),
});
