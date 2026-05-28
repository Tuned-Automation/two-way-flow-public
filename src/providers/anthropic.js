import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic provider — wraps @anthropic-ai/sdk behind the universal
 * provider interface. Uses the Messages API (`client.messages.create`)
 * with tool definitions translated from Gemini-style
 * FunctionDeclaration[] into Anthropic's `tools` shape.
 *
 * Tool schema translation
 *   Gemini-style:  { name, description, parameters: { type:'OBJECT', properties, required } }
 *                   with `type` values as the Type enum strings ('OBJECT','STRING','NUMBER','ARRAY','BOOLEAN').
 *   Anthropic:     { name, description, input_schema: { type:'object', properties, required } }
 *                   with `type` values as JSON Schema lowercase strings.
 *
 *   geminiToolsToAnthropic() does a deep walk over the parameters tree,
 *   lowercasing every `type` and renaming `parameters` → `input_schema`.
 *   String `enum` fields pass through unchanged because both formats
 *   spell them the same.
 *
 * System prompt
 *   Anthropic puts the system prompt in a top-level `system` field
 *   (not inside the messages array). The universal contract's
 *   `systemInstruction` maps 1:1.
 *
 * Tool calls in the response
 *   The response's `content` array contains a mix of text blocks
 *   (`type: 'text'`) and tool-use blocks (`type: 'tool_use'`). We
 *   filter for tool_use to populate toolCalls and join the text
 *   blocks into a single text string. `stop_reason: 'tool_use'` is
 *   the signal Anthropic gives that tool calls were emitted — we
 *   don't gate on it because the content walk is sufficient.
 */
export class AnthropicProvider {
  constructor({ apiKey, model }) {
    if (!apiKey) throw new Error('AnthropicProvider: apiKey is required');
    if (!model) throw new Error('AnthropicProvider: model is required');
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.model = model;
    this.client = new Anthropic({ apiKey });
  }

  async generateContent({ systemInstruction, tools, history, userMessage }) {
    const messages = [];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (!turn || typeof turn.text !== 'string') continue;
        // Anthropic uses 'assistant' (not 'model') for the LLM's role.
        const role = turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: turn.text });
      }
    }
    messages.push({ role: 'user', content: String(userMessage || '') });

    /** @type {Record<string, unknown>} */
    const request = {
      model: this.model,
      // Anthropic requires max_tokens. 2048 is generous for the coach's
      // tool-call payloads (which are short structured JSON) and leaves
      // headroom for a hypothetical longer text response.
      max_tokens: 2048,
      messages,
    };
    if (systemInstruction) request.system = systemInstruction;
    if (Array.isArray(tools) && tools.length > 0) {
      request.tools = geminiToolsToAnthropic(tools);
      // Default tool_choice ('auto') matches Gemini's AUTO mode — let
      // the model decide whether to call a tool.
    }

    const result = await this.client.messages.create(request);

    return {
      toolCalls: extractToolCalls(result),
      text: extractText(result),
      usage: extractUsage(result, this.model),
    };
  }

  async testConnection() {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: friendlyError(err) };
    }
  }
}

/**
 * Recursively translate a Gemini-style parameter schema into a
 * JSON-Schema-shaped object that Anthropic's `tools[].input_schema`
 * expects. The Gemini SDK exposes its types as uppercase enum strings
 * ('OBJECT', 'STRING', …); JSON Schema (and Anthropic) want lowercase
 * ('object', 'string', …). We also recurse into `properties` and
 * `items` so nested types are translated correctly.
 *
 * Pass-through fields preserved verbatim: description, enum, required,
 * minItems, maxItems, default. Anything else we don't recognise is
 * preserved as-is so future schema attributes don't get silently
 * dropped.
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

/** Map Gemini-style FunctionDeclaration[] into Anthropic's tools[]. */
function geminiToolsToAnthropic(tools) {
  return tools
    .filter((t) => t && typeof t === 'object' && t.name)
    .map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: translateSchema(
        t.parameters || { type: 'object', properties: {} },
      ),
    }));
}

function extractToolCalls(result) {
  /** @type {Array<{ name: string, args: any }>} */
  const calls = [];
  const blocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of blocks) {
    if (block?.type === 'tool_use' && block.name) {
      calls.push({ name: block.name, args: block.input || {} });
    }
  }
  return calls;
}

function extractText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const buf = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') buf.push(block.text);
  }
  return buf.join('');
}

/**
 * Pull a universal `{ provider, model, inputTokens, outputTokens }`
 * payload out of an Anthropic Messages-API response. Anthropic
 * exposes the figures under `result.usage.{input_tokens, output_tokens}`.
 *
 * Returns `null` when the SDK didn't include usage metadata (e.g.
 * a streaming response that's been short-circuited, or a future SDK
 * version that changes the field name). The consumer side (see the
 * usage accumulator) treats null as "no usage to record" so this
 * never blows up a Coach tick — invariant #2 of the cost-tracking
 * plan.
 *
 * `model` is captured from the provider instance (this.model) rather
 * than the response. The two should always match in practice but the
 * instance is the authoritative value the user/settings actually
 * chose, so we prefer it.
 */
function extractUsage(result, model) {
  if (!result || !result.usage || typeof result.usage !== 'object') return null;
  return {
    provider: 'anthropic',
    model,
    inputTokens: Number(result.usage.input_tokens) || 0,
    outputTokens: Number(result.usage.output_tokens) || 0,
  };
}

function friendlyError(err) {
  // Anthropic SDK errors expose `.message` and often `.status`. Surface
  // the message verbatim; the renderer is the layer that adds context.
  return err?.message || String(err);
}
