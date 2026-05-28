/**
 * Pricing — per-provider, per-model rate table + USD cost helper.
 *
 * Source of truth for what every text-LLM call, Gemini Live audio
 * frame, and Deepgram transcription minute costs the user. Read once
 * per session at `gemini:stop` to convert the accumulator snapshot
 * into a `costUsd.*` block on the persisted SessionRecord.
 *
 * ⚠ RATES BELOW ARE PLACEHOLDERS — VERIFY BEFORE SHIPPING
 * ──────────────────────────────────────────────────────────────────
 * Each provider publishes its rates on a vendor-controlled page. The
 * numbers in RATES below were the public rates AT PLAN-WRITE TIME
 * (2026-05-27) and must be reconciled against the live pages before
 * the first user-visible release. The reconciliation is per-provider:
 *
 *   Anthropic   https://www.anthropic.com/pricing
 *               (per-1M input / output tokens, distinct per model)
 *   Gemini      https://ai.google.dev/pricing
 *               (per-1M input / output text tokens; Gemini Live
 *               native-audio bills audio tokens at a separate rate)
 *   OpenAI      https://openai.com/api/pricing
 *               (per-1M prompt / completion tokens)
 *   Deepgram    https://deepgram.com/pricing
 *               (per-minute streaming; Nova tier varies by sub-model)
 *
 * Versioning: `PRICING_VERSION` is stamped onto every persisted
 * SessionRecord at the time it was costed. Bump it whenever the
 * RATES table changes so historical sessions remain auditable —
 * "this $0.42 estimate was computed against the 2026-05-27 table",
 * not "against whatever the table happens to be today". The UI can
 * later surface a "your old sessions were costed with version X"
 * note if/when that becomes useful.
 *
 * Tolerance contract (invariant #3 of the plan):
 *   computeCost() NEVER throws. Unknown models return
 *   `{ usd: 0, matched: false }` so a model rename mid-flight (or a
 *   user picking a model we haven't priced yet) can't lose a
 *   session record. The `matched: false` flag is surfaced in the
 *   UI as "estimate unavailable".
 *
 * Extension points:
 *   - Add a new model: append to RATES under `provider:model`.
 *     Use the field shape that matches the model's billing
 *     dimensions (text tokens vs audio tokens vs per-minute).
 *   - Add a whole new provider's billing dimension (e.g. image
 *     tokens, fine-tuning surcharges): add a new field name to the
 *     rate object and extend the if-chain in computeCost().
 *   - Bump PRICING_VERSION whenever any rate moves. Don't reuse a
 *     previous version string — historical session records cross-
 *     reference it.
 */

/**
 * Date-stamped version identifier persisted alongside each session
 * record. Bump on every RATES change.
 */
export const PRICING_VERSION = '2026-05-27';

/**
 * Rate table indexed by `${provider}:${model}`. Rates are USD per
 * 1,000,000 tokens (text + Gemini Live audio dimensions) and USD
 * per connected minute (Deepgram streaming). Field shape varies
 * by billing dimension:
 *
 *   { inputPerM, outputPerM }                              text LLMs
 *   { audioInPerM, audioOutPerM, textOutPerM }             Gemini Live
 *   { perMinute }                                          Deepgram
 *
 * Mixed shapes (e.g. an LLM that bills both text tokens and image
 * tokens) can compose fields freely — computeCost() only consumes
 * the fields it sees. Unknown fields are ignored.
 *
 * Coverage strategy: keep every model the user can pick from the
 * default settings (see `src/settings.js`'s DEFAULT_SETTINGS) AND
 * every model the upgrade map (`DEPRECATED_MODEL_UPGRADES`) auto-
 * promotes TO. Models a user picks manually that aren't in this
 * table land in the `matched: false` branch — they still log the
 * record, just without a cost estimate.
 */
export const RATES = Object.freeze({
  // ── Anthropic ────────────────────────────────────────────────────
  // claude-sonnet-4-6 is the current settings.js default; the 4.x
  // family pricing tier slots one notch above the previous 3.5
  // Sonnet generation per Anthropic's published pricing.
  'anthropic:claude-sonnet-4-6':    { inputPerM: 3.00,  outputPerM: 15.00 },
  'anthropic:claude-haiku-4-5':     { inputPerM: 0.80,  outputPerM: 4.00 },
  'anthropic:claude-opus-4-7':      { inputPerM: 15.00, outputPerM: 75.00 },

  // ── Gemini (text models — Coach / Summary / FactsScanner / QuickFix) ─
  // gemini-3.5-flash is the current settings.js default for the
  // text routing AND the summary service.
  'gemini:gemini-3.5-flash':        { inputPerM: 0.30,  outputPerM: 2.50 },
  'gemini:gemini-2.5-flash':        { inputPerM: 0.075, outputPerM: 0.30 },
  'gemini:gemini-2.5-flash-lite':   { inputPerM: 0.04,  outputPerM: 0.15 },
  'gemini:gemini-2.5-pro':          { inputPerM: 1.25,  outputPerM: 5.00 },

  // ── Gemini Live (native-audio preview — the always-on audio loop) ───
  // Three rate dimensions: audio in / audio out / text out. The text-
  // out dimension is used when the model is grounded with text rather
  // than emitting audio.
  'gemini:gemini-2.5-flash-native-audio-preview-12-2025':
    { audioInPerM: 3.00, audioOutPerM: 12.00, textOutPerM: 0.60 },

  // ── OpenAI ──────────────────────────────────────────────────────
  // gpt-5.5 is the current settings.js default; 5.4-mini and
  // 5.4-nano follow the upgrade map for the retired GPT-4 family.
  'openai:gpt-5.5':                 { inputPerM: 1.25,  outputPerM: 10.00 },
  'openai:gpt-5.5-pro':             { inputPerM: 5.00,  outputPerM: 25.00 },
  'openai:gpt-5.4-mini':            { inputPerM: 0.25,  outputPerM: 2.00 },
  'openai:gpt-5.4-nano':            { inputPerM: 0.05,  outputPerM: 0.40 },

  // ── Deepgram (streaming transcription) ───────────────────────────
  // nova-3 is the current settings.js default; nova-2 kept for any
  // legacy session record costed before that change.
  'deepgram:nova-3':                { perMinute: 0.0077 },
  'deepgram:nova-2':                { perMinute: 0.0058 },
  'deepgram:nova-2-meeting':        { perMinute: 0.0058 },
  'deepgram:enhanced':              { perMinute: 0.0145 },
});

/**
 * Compute USD cost for a single usage event. Returns
 * `{ usd, matched }` where:
 *   - `usd` is the computed USD amount (0 for unknown models or
 *     when every dimension is zero — same return shape so callers
 *     don't have to special-case missing rates).
 *   - `matched` is `true` when the model was found in RATES,
 *     `false` otherwise. The UI surfaces "estimate unavailable"
 *     for `false` so the user isn't misled into thinking a
 *     mystery model is free.
 *
 * Accepts a generous usage shape — callers from the accumulator
 * pass per-component slots that may carry text-only fields
 * (`inputTokens`, `outputTokens`), Gemini Live audio fields
 * (`audioInputTokens`, `audioOutputTokens`, `textOutputTokens`),
 * or Deepgram minutes (`audioMinutes`). Unused dimensions default
 * to 0 so a slot that's only ever text-typed doesn't have to
 * pretend to carry audio fields.
 */
export function computeCost({
  provider,
  model,
  inputTokens = 0,
  outputTokens = 0,
  audioInputTokens = 0,
  audioOutputTokens = 0,
  textOutputTokens = 0,
  audioMinutes = 0,
} = {}) {
  if (!provider || !model) return { usd: 0, matched: false };
  const rate = RATES[`${provider}:${model}`];
  if (!rate) return { usd: 0, matched: false };

  let usd = 0;
  if (rate.inputPerM)    usd += (inputTokens       / 1_000_000) * rate.inputPerM;
  if (rate.outputPerM)   usd += (outputTokens      / 1_000_000) * rate.outputPerM;
  if (rate.audioInPerM)  usd += (audioInputTokens  / 1_000_000) * rate.audioInPerM;
  if (rate.audioOutPerM) usd += (audioOutputTokens / 1_000_000) * rate.audioOutPerM;
  if (rate.textOutPerM)  usd += (textOutputTokens  / 1_000_000) * rate.textOutPerM;
  if (rate.perMinute)    usd += audioMinutes * rate.perMinute;
  return { usd, matched: true };
}
