import { GeminiProvider } from './gemini.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import * as errorLog from '../error-log.js';

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
 * Error-logging wrapper
 * ─────────────────────
 * As of the error-log feature, `getProvider(...)` returns a proxy that
 * instruments `generateContent` + `testConnection` for failure
 * capture. The proxy:
 *   - records `start = Date.now()` before each call,
 *   - on throw, appends a `level: 'error'` entry to the in-memory
 *     ring buffer in `src/error-log.js` (which broadcasts `logs:entry`
 *     to the renderer for the live tail UI), then rethrows so
 *     existing catch blocks behave unchanged,
 *   - on a `{ ok: false }` return from `testConnection`, appends an
 *     entry too (the provider implementations catch their own SDK
 *     errors inside testConnection and translate to a return value
 *     rather than throwing, so the throw branch wouldn't fire alone),
 *   - on success, returns the inner result verbatim — the spread
 *     pattern is unnecessary because no metadata is added by the
 *     wrapper. The `.usage` field on the cost-tracking shape is
 *     preserved by definition (we return `inner.generateContent`'s
 *     result reference unchanged).
 *
 * Callers pass `{ source }` to tag the entry with which subsystem
 * triggered the call. Allowed values mirror the contract in
 * `src/error-log.js`:
 *   'coach' | 'facts-scanner' | 'quick-fix' | 'summary' |
 *   'provider-test' | 'unknown' (default)
 *
 * Adding a new wrapper layer ON TOP of this one:
 *   preserve the `usage` field on generateContent()'s return — the
 *   cost-tracking accumulator (src/usage-accumulator.js) relies on
 *   it surviving the wrapper chain. The simplest pattern is
 *   `return { ...await inner.generateContent(args), wrapperMeta: ... }`.
 *   Or just return the result reference if you don't add metadata.
 */

/**
 * Construct a ready-to-call, error-log-instrumented provider instance.
 *
 * @param {'anthropic'|'gemini'|'openai'} name
 * @param {{ apiKey: string, model: string, source?: 'coach'|'facts-scanner'|'quick-fix'|'summary'|'provider-test'|'unknown' }} options
 * @returns {{ generateContent: Function, testConnection: Function, name: string, model: string }}
 */
export function getProvider(name, { apiKey, model, source } = {}) {
  /** @type {{ generateContent: Function, testConnection: Function, name: string, model: string }} */
  let inner;
  switch (name) {
    case 'gemini':
      inner = new GeminiProvider({ apiKey, model });
      break;
    case 'anthropic':
      inner = new AnthropicProvider({ apiKey, model });
      break;
    case 'openai':
      inner = new OpenAIProvider({ apiKey, model });
      break;
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
  return instrumentWithErrorLog(inner, source);
}

/**
 * Wrap a provider instance with the error-log capture layer. Pulled
 * out of `getProvider` so a future test that wants to construct a
 * provider WITHOUT instrumentation can do so via the class exports
 * below.
 *
 * The wrapper exposes `name` and `model` for downstream consumers
 * that read them (e.g. usage-accumulator's per-call attribution
 * uses `result.usage.model`, not the wrapper's `model`, but exposing
 * the field keeps the proxy a clean stand-in).
 *
 * @param {{ generateContent: Function, testConnection: Function, name: string, model: string }} inner
 * @param {string | undefined} source
 */
function instrumentWithErrorLog(inner, source) {
  return {
    name: inner.name,
    model: inner.model,

    async generateContent(args) {
      const start = Date.now();
      try {
        // Pass-through. We DO NOT destructure to { toolCalls, text }
        // and re-emit, because that would silently drop the cost-
        // tracking .usage field on the return shape. Returning the
        // result reference unchanged preserves whatever the provider
        // surfaces today and survives future shape additions.
        return await inner.generateContent(args);
      } catch (err) {
        errorLog.append({
          level: 'error',
          source,
          provider: inner.name,
          model: inner.model,
          durationMs: Date.now() - start,
          message: err?.message || String(err),
          status: typeof err?.status === 'number' ? err.status : null,
          reason: 'exception',
          rawResponse: extractRawBody(err),
        });
        throw err;
      }
    },

    async testConnection() {
      const start = Date.now();
      try {
        const result = await inner.testConnection();
        // Every provider's testConnection catches its own SDK errors
        // and returns `{ ok: false, message }` instead of throwing
        // (so the Settings → Providers Test button can render an
        // inline error without unhandled-rejection noise). To make
        // provider-test failures land in the live error log, we
        // inspect the return value here and append on failure.
        if (result && result.ok === false) {
          errorLog.append({
            level: 'error',
            source,
            provider: inner.name,
            model: inner.model,
            durationMs: Date.now() - start,
            message: result.message || 'Test connection failed.',
            status: null,
            reason: 'exception',
            rawResponse: null,
          });
        }
        return result;
      } catch (err) {
        // Defensive: testConnection's inner implementation catches
        // its own SDK errors, but a synchronous TypeError (e.g.
        // construct-time failure on the SDK client) would escape
        // here. Log + rethrow so the calling settings:test-provider
        // handler can translate to the inline error UI.
        errorLog.append({
          level: 'error',
          source,
          provider: inner.name,
          model: inner.model,
          durationMs: Date.now() - start,
          message: err?.message || String(err),
          status: typeof err?.status === 'number' ? err.status : null,
          reason: 'exception',
          rawResponse: extractRawBody(err),
        });
        throw err;
      }
    },
  };
}

/**
 * Best-effort raw-response body extractor. The three SDKs in play
 * (`@google/genai`, `@anthropic-ai/sdk`, `openai`) expose the
 * server-returned body on different fields when they throw — none
 * of them is canonical, so we try a few in priority order.
 *
 * Returns:
 *   - the body as a string, truncated to 4 KB (the error-log ring
 *     also truncates at append time as a safety net, but doing it
 *     at the boundary keeps the entry compact in transit between
 *     here and the IPC broadcast),
 *   - or `null` when no body candidate is present (which is the
 *     common case for network-level failures and constructor
 *     errors that never reached a request body).
 *
 * The 4 KB constant is duplicated from `src/error-log.js` on
 * purpose — keeping this helper free of cross-module imports lets
 * it stay collocated with the wrapper and avoids a circular
 * dependency back into the error-log module's internals.
 *
 * @param {any} err
 * @returns {string | null}
 */
function extractRawBody(err) {
  if (!err || typeof err !== 'object') return null;
  // Candidates ordered by SDK convention:
  //   - response.body / response.data: HTTP-layer body (newer fetch-based SDKs)
  //   - error.body:                    SDK's already-parsed error envelope
  //   - body / responseBody:           lower-level / legacy
  //   - error:                         parsed body sub-tree (Anthropic / OpenAI)
  const candidates = [
    err.response?.body,
    err.response?.data,
    err.error?.body,
    err.body,
    err.responseBody,
    err.error,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string') {
      return c.length > 4096 ? c.slice(0, 4096) : c;
    }
    if (typeof c === 'object') {
      try {
        const s = JSON.stringify(c);
        return s.length > 4096 ? s.slice(0, 4096) : s;
      } catch {
        // circular ref / BigInt / etc. — skip and try the next candidate.
      }
    }
  }
  return null;
}

export { GeminiProvider, AnthropicProvider, OpenAIProvider };
