import { GoogleGenAI } from '@google/genai';

/**
 * Gemini provider — wraps the @google/genai client behind the universal
 * provider interface. This is the original code path that lived inside
 * coach.js before the multi-provider rewrite; the call shape is
 * unchanged so existing tool-calling behaviour is preserved bit-for-bit.
 *
 * Tool schema translation
 *   The universal interface accepts Gemini-style FunctionDeclaration[]
 *   verbatim (because that's the format coach.js already authors them
 *   in). No translation needed — we just hand them straight to the
 *   SDK under `tools: [{ functionDeclarations }]`.
 *
 * Response parsing
 *   @google/genai v2 exposes `result.functionCalls` as a flat array
 *   getter on the response, and also surfaces them under
 *   `candidates[0].content.parts[i].functionCall`. We check the array
 *   getter first and fall back to walking parts so the parser stays
 *   resilient across minor SDK shape drift.
 *
 * Text extraction
 *   `result.text` is a getter on the response object in v2 — when the
 *   model returns prose rather than (or alongside) tool calls we
 *   surface it under `text` so the universal contract is honoured.
 *   The Coach today only consumes `toolCalls`, but Summary may rely
 *   on `text` in the future and other providers fill it in.
 */
export class GeminiProvider {
  /**
   * @param {{ apiKey: string, model: string }} opts
   */
  constructor({ apiKey, model }) {
    if (!apiKey) throw new Error('GeminiProvider: apiKey is required');
    if (!model) throw new Error('GeminiProvider: model is required');
    this.name = 'gemini';
    this.apiKey = apiKey;
    this.model = model;
    this.client = new GoogleGenAI({ apiKey });
  }

  /**
   * Universal generate call.
   *
   * @param {{
   *   systemInstruction?: string,
   *   tools?: Array<object>,
   *   history?: Array<{ role: 'user'|'model', text: string }>,
   *   userMessage: string,
   *   responseMimeType?: string,
   *   responseSchema?: object,
   * }} args
   *
   * `responseMimeType` + `responseSchema` are Gemini-specific structured-
   * output controls — used by src/summary.js for the post-call debrief.
   * Other providers ignore them. They're optional so the Coach's tool-
   * call path is unaffected.
   */
  async generateContent({ systemInstruction, tools, history, userMessage, responseMimeType, responseSchema }) {
    const contents = [];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (!turn || typeof turn.text !== 'string') continue;
        const role = turn.role === 'model' ? 'model' : 'user';
        contents.push({ role, parts: [{ text: turn.text }] });
      }
    }
    contents.push({ role: 'user', parts: [{ text: String(userMessage || '') }] });

    /** @type {Record<string, unknown>} */
    const config = {};
    if (systemInstruction) config.systemInstruction = systemInstruction;
    if (Array.isArray(tools) && tools.length > 0) {
      config.tools = [{ functionDeclarations: tools }];
      // Match the old coach behaviour: let the model decide whether to
      // emit tool calls. AUTO is the default but we set it explicitly
      // because the Coach's correctness depends on the model actually
      // calling tools when they're available.
      config.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    if (responseMimeType) config.responseMimeType = responseMimeType;
    if (responseSchema) config.responseSchema = responseSchema;

    const result = await this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });

    return {
      toolCalls: extractToolCalls(result),
      text: extractText(result),
    };
  }

  /**
   * Cheap connectivity test. Asks the model to reply with a single
   * token; success means the key + project + model combo is good.
   * We deliberately don't try to parse the response — any non-error
   * return value proves the round-trip works.
   */
  async testConnection() {
    try {
      const result = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        config: {
          // No tools. A bare "ping" with a 1-token cap is the cheapest
          // possible probe — most of the latency is the TLS handshake
          // not the inference.
          maxOutputTokens: 4,
        },
      });
      // Any well-formed response (with or without text content) means
      // auth + endpoint are healthy. We don't require non-empty text
      // because `maxOutputTokens: 4` can legitimately come back empty
      // on some safety-blocked responses.
      if (result) return { ok: true };
      return { ok: false, message: 'Empty response from Gemini.' };
    } catch (err) {
      return { ok: false, message: friendlyError(err) };
    }
  }
}

/**
 * Walk the response candidates' parts looking for functionCall entries,
 * normalised into the universal toolCalls shape. Stays defensive about
 * the response shape because the SDK occasionally returns either
 * functionCalls() helpers or raw parts depending on version.
 */
function extractToolCalls(result) {
  /** @type {Array<{ name: string, args: any }>} */
  const calls = [];

  if (Array.isArray(result?.functionCalls)) {
    for (const c of result.functionCalls) {
      if (c?.name) calls.push({ name: c.name, args: c.args || {} });
    }
  }

  if (calls.length === 0) {
    const parts = result?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part?.functionCall?.name) {
        calls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
      }
    }
  }

  return calls;
}

function extractText(result) {
  if (typeof result?.text === 'string' && result.text.length > 0) return result.text;
  const parts = result?.candidates?.[0]?.content?.parts || [];
  const buf = [];
  for (const p of parts) {
    if (typeof p?.text === 'string') buf.push(p.text);
  }
  return buf.join('');
}

function friendlyError(err) {
  const message = err?.message || String(err);
  // Strip the "[GoogleGenerativeAI Error]:" prefix from SDK errors so
  // the renderer's status pill stays readable on a single line.
  return message.replace(/^\[Google[^\]]*Error\]:\s*/i, '');
}
