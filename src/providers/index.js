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
 *     → Promise<{ toolCalls: Array<{ name, args }>, text: string }>
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
 * Extension point: to add a new provider, drop a class with
 * `generateContent` + `testConnection` into this folder and add a case
 * to getProvider() below. The schema translator lives inside the
 * provider class — no other file changes.
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
