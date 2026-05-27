import OpenAI from 'openai';

/**
 * OpenAI provider — wraps the `openai` SDK behind the universal
 * provider interface. Uses Chat Completions (`client.chat.completions.create`)
 * with function calling via the `tools` parameter.
 *
 * Why Chat Completions over the Responses API
 *   Chat Completions has the most stable, well-documented function-
 *   calling surface and supports the broadest range of models
 *   (gpt-5, gpt-4o, o1, …). The Responses API is newer and currently
 *   varies more between model families. The Coach's call shape — a
 *   single turn with structured tool output — is squarely in Chat
 *   Completions' sweet spot.
 *
 * Tool schema translation
 *   Gemini-style:  { name, description, parameters: { type:'OBJECT', properties, required } }
 *                   with `type` values as uppercase enum strings.
 *   OpenAI:        { type: 'function', function: { name, description,
 *                     parameters: { type:'object', properties, required } } }
 *                   with JSON-Schema lowercase types.
 *
 *   geminiToolsToOpenAI() does a deep walk over the parameters tree,
 *   lowercasing every `type` and wrapping each declaration in the
 *   { type:'function', function:{…} } envelope.
 *
 * System prompt
 *   OpenAI puts the system prompt at the head of the `messages` array
 *   as `{ role: 'system', content }`. The universal contract's
 *   `systemInstruction` maps to that prepended message.
 *
 * Tool calls in the response
 *   `choices[0].message.tool_calls` is an array of
 *   { id, type:'function', function: { name, arguments } } where
 *   `arguments` is a JSON STRING (not a parsed object). We JSON.parse
 *   it once, defending against malformed JSON by falling back to an
 *   empty object — the Coach already validates the field shapes.
 */
export class OpenAIProvider {
  constructor({ apiKey, model }) {
    if (!apiKey) throw new Error('OpenAIProvider: apiKey is required');
    if (!model) throw new Error('OpenAIProvider: model is required');
    this.name = 'openai';
    this.apiKey = apiKey;
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  async generateContent({ systemInstruction, tools, history, userMessage }) {
    const messages = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (!turn || typeof turn.text !== 'string') continue;
        const role = turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: turn.text });
      }
    }
    messages.push({ role: 'user', content: String(userMessage || '') });

    /** @type {Record<string, unknown>} */
    const request = {
      model: this.model,
      messages,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      request.tools = geminiToolsToOpenAI(tools);
      // 'auto' matches Gemini's AUTO mode — let the model decide whether
      // to invoke a tool. The Coach's correctness depends on the model
      // actually calling tools when they're offered.
      request.tool_choice = 'auto';
    }

    const result = await this.client.chat.completions.create(request);

    return {
      toolCalls: extractToolCalls(result),
      text: extractText(result),
    };
  }

  async testConnection() {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_completion_tokens: 4,
      });
      return { ok: true };
    } catch (err) {
      // Some newer reasoning models (o1, gpt-5 family) reject
      // `max_completion_tokens` and want `max_tokens` instead, or vice
      // versa. If the first try complains about the parameter name,
      // retry with the legacy `max_tokens` so the connectivity check
      // works across the whole catalogue.
      if (isMaxTokensParamError(err)) {
        try {
          await this.client.chat.completions.create({
            model: this.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 4,
          });
          return { ok: true };
        } catch (innerErr) {
          return { ok: false, message: friendlyError(innerErr) };
        }
      }
      return { ok: false, message: friendlyError(err) };
    }
  }
}

/**
 * Recursively translate a Gemini-style parameter schema into a
 * JSON-Schema-shaped object that OpenAI's tools[].function.parameters
 * expects. Same mechanic as the Anthropic translator: lowercase the
 * `type` values, recurse into properties / items, pass everything else
 * through verbatim.
 */
function translateSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toLowerCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = translateSchema(propSchema);
      }
      out.properties = props;
    } else if (key === 'items') {
      out.items = translateSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function geminiToolsToOpenAI(tools) {
  return tools
    .filter((t) => t && typeof t === 'object' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: translateSchema(
          t.parameters || { type: 'object', properties: {} },
        ),
      },
    }));
}

function extractToolCalls(result) {
  /** @type {Array<{ name: string, args: any }>} */
  const calls = [];
  const toolCalls = result?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls)) return calls;
  for (const tc of toolCalls) {
    if (tc?.type !== 'function') continue;
    const name = tc?.function?.name;
    if (!name) continue;
    const rawArgs = tc?.function?.arguments;
    let args = {};
    if (typeof rawArgs === 'string' && rawArgs.length > 0) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // Malformed JSON from the model — leave args empty and let the
        // Coach's per-call validation drop it. We don't throw here
        // because one bad tool call shouldn't blow up the whole batch.
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    }
    calls.push({ name, args });
  }
  return calls;
}

function extractText(result) {
  const content = result?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function isMaxTokensParamError(err) {
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('max_tokens') ||
    message.includes('max_completion_tokens') ||
    message.includes('unsupported parameter')
  );
}

function friendlyError(err) {
  return err?.message || String(err);
}
