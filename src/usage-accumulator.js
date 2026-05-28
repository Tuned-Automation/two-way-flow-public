/**
 * Usage accumulator — per-session token & minute counter.
 *
 * One instance is constructed per recording session and lives on
 * `coachContext.usageAccumulator`. Every billable event the app
 * generates (a Coach LLM tick, a Summary roll-up, a Facts scan, a
 * Quick-Fix roll, a Gemini Live `usageMetadata` ping, a Deepgram
 * transcription chunk) calls one of the `record*` methods. At
 * `gemini:stop` the main process calls `snapshot()` and feeds the
 * result through `src/pricing.js::computeCost()` to derive the
 * USD figures persisted in the SessionRecord.
 *
 * Invariants (from the plan):
 *   #1 — The accumulator is the ONLY place per-session usage is
 *        mutated. Consumers never touch coachContext.usage directly.
 *   #2 — A null/undefined `usage` from a provider is always tolerated.
 *        Don't crash a session because one SDK didn't return usage
 *        metadata; treat missing usage as zero.
 *
 * Component slot taxonomy
 *   - geminiLive     audio-token loop (always-on)
 *   - deepgram       streaming transcription (always-on, two channels)
 *   - coach          per-tick text LLM
 *   - summary        post-call debrief text LLM
 *   - factsScanner   stage-1 background facts extractor
 *   - quickFix       stage-2 background facts rollup
 *
 * Deepgram channel taxonomy
 *   - 'you'          mic capture (the rep)
 *   - 'other'        system audio capture (the prospect)
 *   The accumulator carries per-channel connected-seconds so a future
 *   per-channel billing roll-up doesn't need a schema change. v1 of
 *   this feature derives `audioMinutes` in main.js at gemini:stop
 *   from session duration × channel count instead of calling
 *   `recordTranscriptionSeconds` per chunk (~5% accuracy loss from
 *   reconnect gaps is acceptable — see plan Task 6 §3); the per-
 *   channel API stays here so a more accurate v2 path is a drop-in.
 *
 * Snapshot contract
 *   `snapshot()` returns a plain object copy (so the caller can
 *   safely JSON.stringify or mutate it) shaped to feed directly into
 *   `computeCost()` per component. The Deepgram slot's per-channel
 *   seconds are rolled up to a single `audioMinutes` total inside
 *   the snapshot — internal per-channel detail isn't persisted in v1.
 */

/**
 * Factory — returns a fresh accumulator. Call once per session,
 * typically from `resetCoachContext()` in `src/main.js`.
 *
 * Internal state is intentionally not exposed; only the methods on
 * the returned object can mutate it. This keeps the accumulator
 * compliant with invariant #1 (single mutation surface).
 */
export function createUsageAccumulator() {
  const state = {
    geminiLive: {
      model: null,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      textOutputTokens: 0,
    },
    deepgram: {
      model: null,
      audioSecondsByChannel: { you: 0, other: 0 },
    },
    coach:        { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
    summary:      { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
    factsScanner: { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
    quickFix:     { provider: null, model: null, inputTokens: 0, outputTokens: 0, calls: 0 },
  };

  return {
    /**
     * Record a text-LLM call result. `component` is one of
     * 'coach' | 'summary' | 'factsScanner' | 'quickFix'. `usage`
     * is the `{ provider, model, inputTokens, outputTokens }`
     * shape returned by `provider.generateContent()`; a null /
     * undefined `usage` is tolerated and silently dropped
     * (invariant #2 — common for streaming completions or SDK
     * versions that omit usage metadata).
     *
     * `provider` and `model` on the usage payload OVERWRITE the
     * slot's stored values rather than asserting consistency.
     * Rationale: a user can switch provider/model mid-session
     * (e.g. by editing settings and re-arming Coach) and the
     * accumulator should reflect the last-known values for the
     * session's pricing lookup. The persisted record will be
     * priced against whatever was active at session END — which
     * matches the user's mental model of "this is what I paid for
     * the final stretch of this call".
     */
    recordLlmCall(component, usage) {
      if (!usage) return;
      const slot = state[component];
      if (!slot) return;
      if (usage.provider) slot.provider = usage.provider;
      if (usage.model)    slot.model    = usage.model;
      slot.inputTokens  += Number(usage.inputTokens)  || 0;
      slot.outputTokens += Number(usage.outputTokens) || 0;
      slot.calls        += 1;
    },

    /**
     * Record a Gemini Live `usageMetadata` ping. The Live SDK emits
     * these periodically over the WebSocket, broken down by
     * modality (AUDIO / TEXT). The caller is responsible for
     * extracting the right field from the message and passing the
     * pre-parsed values — keeping SDK-shape knowledge in
     * `src/gemini-session.js` rather than here means a future SDK
     * upgrade doesn't have to touch this module.
     */
    recordLiveAudio({
      model,
      audioInputTokens = 0,
      audioOutputTokens = 0,
      textOutputTokens = 0,
    } = {}) {
      if (model) state.geminiLive.model = model;
      state.geminiLive.audioInputTokens  += Number(audioInputTokens)  || 0;
      state.geminiLive.audioOutputTokens += Number(audioOutputTokens) || 0;
      state.geminiLive.textOutputTokens  += Number(textOutputTokens)  || 0;
    },

    /**
     * Record connected-time for one Deepgram channel. `channel`
     * must be 'you' or 'other'; any other value is silently
     * dropped. `seconds` is the elapsed wall-clock seconds since
     * the last record (i.e. delta, NOT total — the accumulator
     * sums them).
     *
     * UNCALLED IN V1: the simpler alternative of computing
     * `audioMinutes = (durationMs / 1000 / 60) * 2` in
     * `gemini:stop` is the v1 path (see plan Task 6 §3). This
     * method stays here so a future per-channel-accuracy v2 can
     * adopt it without changing the accumulator surface or the
     * persisted schema.
     */
    recordTranscriptionSeconds(channel, seconds, model) {
      if (model) state.deepgram.model = model;
      if (!Object.prototype.hasOwnProperty.call(state.deepgram.audioSecondsByChannel, channel)) {
        return;
      }
      state.deepgram.audioSecondsByChannel[channel] += Number(seconds) || 0;
    },

    /**
     * Return a plain-object copy of the per-component usage,
     * shaped to feed directly into `computeCost()` per slot. The
     * Deepgram slot's per-channel seconds are flattened to a
     * single `audioMinutes` total — internal per-channel detail
     * isn't persisted in v1 (the SessionRecord schema mirrors
     * this collapsed shape).
     *
     * Object identity: every nested object is a fresh shallow
     * copy of the live state, so the caller can JSON.stringify
     * or mutate freely without corrupting the accumulator's
     * internal numbers.
     */
    snapshot() {
      const dgSecs =
        state.deepgram.audioSecondsByChannel.you +
        state.deepgram.audioSecondsByChannel.other;
      return {
        geminiLive: { ...state.geminiLive },
        deepgram: {
          model: state.deepgram.model,
          audioMinutes: dgSecs / 60,
        },
        coach:        { ...state.coach },
        summary:      { ...state.summary },
        factsScanner: { ...state.factsScanner },
        quickFix:     { ...state.quickFix },
      };
    },
  };
}
