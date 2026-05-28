import { GeminiProvider } from './gemini.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

/**
 * Provider abstraction — the single seam between coach.js / summary.js
 * and the underlying SDKs (@google/genai, @anthropic-ai/sdk, openai).
 *
 * Universal interface every provider implements:
 *
 *   generateContent({ systemInstruction, tools, history, userMessage })
 *     → Promise<{
 *         toolCalls: Array<{ name, args }>,
 *         text:      string,
 *         usage:     { provider, model, inputTokens, outputTokens } | null,
 *       }>
 *
 *   testConnection()
 *     → Promise<{ ok: boolean, message?: string }>
 *
 * `tools` is supplied as Gemini-style FunctionDeclaration[] (the format
 * coach.js already authors them in). Each provider has its own
 * translation layer that maps the universal shape into the SDK-native
 * format, so the call sites stay provider-agnostic.
 *
 * `history` is optional and currently unused by the Coach — we kept the
 * arg in the contract because the universal shape is intentionally
 * close to a "single-turn chat with optional history" so a future
 * multi-turn coach is a natural fit.
 *
 * `usage` (added with the session-cost-tracking feature) is the per-
 * call token tally pulled out of the SDK's response metadata. The
 * field is `null`-tolerant — consumers that don't care can ignore
 * it; consumers that DO care (today: the four text-LLM call sites
 * forwarding into the usage accumulator in `src/usage-accumulator.js`)
 * destructure it and treat `null` as "no usage to record". Provider-
 * specific field shapes:
 *   - Anthropic: result.usage.{input_tokens, output_tokens}
 *   - Gemini:    result.usageMetadata.{promptTokenCount, candidatesTokenCount}
 *   - OpenAI:    result.usage.{prompt_tokens, completion_tokens}
 * NOTE: the Gemini Live native-audio loop in `src/gemini-session.js`
 * has its own modality-aware usage extractor (audio in / audio out /
 * text out) — that's a different code path because the Live SDK is
 * a streaming WebSocket, not a request/response. The generateContent
 * extractor here covers only the text models.
 *
 * Extension point: to add a new provider, drop a class with
 * `generateContent` + `testConnection` into this folder and add a case
 * to getProvider() below. The schema translator lives inside the
 * provider class — no other file changes.
 *
 * For wrapper-style additions (e.g. error-logging, retries, fallback)
 * that wrap `getProvider()` itself: preserve the `usage` field on
 * generateContent()'s return — the cost-tracking accumulator relies
 * on it surviving the wrapper chain. The simplest pattern is
 * `return { ...await inner.generateContent(args), wrapperMeta: ... }`.
 */

/**
 * Construct a ready-to-call provider instance.
 *
 * @param {'anthropic'|'gemini'|'openai'} name
 * @param {{ apiKey: string, model: string }} options
 * @returns {{ generateContent: Function, testConnection: Function, name: string, model: string }}
 */
export function getProvider(name, { apiKey, model } = {}) {
  switch (name) {
    case 'gemini':
      return new GeminiProvider({ apiKey, model });
    case 'anthropic':
      return new AnthropicProvider({ apiKey, model });
    case 'openai':
      return new OpenAIProvider({ apiKey, model });
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

export { GeminiProvider, AnthropicProvider, OpenAIProvider };
