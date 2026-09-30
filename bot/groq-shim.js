// Groq adapter shaped like the Anthropic SDK client, so every existing
// `ai.messages.create(params)` call site works unchanged when the bot runs on
// Groq instead of Claude.
//
// Request: Anthropic Messages params → OpenAI-style /chat/completions.
// Response: → { content: [{ type: 'text', text }], model, stop_reason, usage },
// which is all the callers read (content[0].text, stop_reason, model, usage).
//
// Claude-only params (thinking, output_config effort, fallbacks, beta headers)
// are dropped. output_config.format json_schema becomes Groq's json_object
// mode plus the schema appended to the system prompt, so the niche report
// still gets parseable JSON; its digit/currency note guard applies as before.
//
// Models are overridable without a deploy: GROQ_MODEL / GROQ_VISION_MODEL.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Probed live 2026-09-29: the Llama 3.3 / Llama 4 Scout ids are gone from Groq.
// gpt-oss-120b is the strongest text model listed; qwen3.8-27b takes images
// (min 32px per side). Check GET /openai/v1/models if either starts 404ing.
const DEFAULT_TEXT_MODEL   = 'openai/gpt-oss-120b';
const DEFAULT_VISION_MODEL = 'qwen/qwen3.8-27b';

function toOpenAIContent(content) {
  if (typeof content === 'string') return { content, hasImage: false };
  let hasImage = false;
  const parts = [];
  for (const b of content || []) {
    if (b?.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b?.type === 'image' && b.source?.type === 'base64') {
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    } else if (b?.type === 'image' && b.source?.type === 'url') {
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url: b.source.url } });
    }
  }
  // Text-only block arrays collapse to a string: not every Groq model accepts parts.
  if (!hasImage) return { content: parts.map(p => p.text).join('\n'), hasImage };
  return { content: parts, hasImage };
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

// Pure: Anthropic params → Groq request body. Exported for tests.
function buildGroqBody(params, env = process.env) {
  let anyImage = false;
  const messages = [];
  let sys = systemText(params.system);

  const schema = params.output_config?.format?.type === 'json_schema' ? params.output_config.format.schema : null;
  if (schema) {
    sys += `${sys ? '\n\n' : ''}Respond with ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
  }
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of params.messages || []) {
    const { content, hasImage } = toOpenAIContent(m.content);
    if (hasImage) anyImage = true;
    messages.push({ role: m.role, content });
  }

  const body = {
    model: anyImage ? (env.GROQ_VISION_MODEL || DEFAULT_VISION_MODEL) : (env.GROQ_MODEL || DEFAULT_TEXT_MODEL),
    messages,
    max_tokens: Math.min(params.max_tokens || 1024, 8192),
  };
  // gpt-oss reasons before answering and that counts against max_tokens; at
  // the default effort the bot's 300-800 token budgets can end mid-thought.
  if (/gpt-oss/.test(body.model)) body.reasoning_effort = env.GROQ_REASONING_EFFORT || 'low';
  if (typeof params.temperature === 'number') body.temperature = params.temperature;
  if (schema) body.response_format = { type: 'json_object' };
  return body;
}

// Pure: Groq response → Anthropic-shaped message. Exported for tests.
function toAnthropicMessage(json) {
  const choice = json?.choices?.[0] || {};
  const text = choice.message?.content || '';
  const stop = choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: json?.id,
    type: 'message',
    role: 'assistant',
    model: json?.model || null,
    content: [{ type: 'text', text }],
    stop_reason: stop,
    usage: {
      input_tokens: json?.usage?.prompt_tokens || 0,
      output_tokens: json?.usage?.completion_tokens || 0,
    },
  };
}

// Groq's retry-after is in seconds. Missing or unparseable → 20s, a typical
// wait for the per-minute token budget to refill.
function retryAfterMs(res) {
  const secs = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 20000;
}

function createGroqClient(apiKey, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const client = {
    provider: 'groq',
    // Set on every 429. Groq limits are per KEY, not per member, so while this
    // is in the future any AI failure is almost certainly the rate limit;
    // aiUnavailableEmbed reads it to say "busy" instead of "unavailable".
    rateLimitedUntil: 0,
    messages: {
      async create(params /* , options — Anthropic headers ignored */) {
        const res = await fetchImpl(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildGroqBody(params)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await res.text();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON error page */ }
        if (!res.ok) {
          const msg = json?.error?.message || raw.slice(0, 300);
          const err = new Error(`Groq ${res.status}: ${msg}`);
          err.status = res.status;
          if (res.status === 429) {
            err.retryAfterMs = retryAfterMs(res);
            client.rateLimitedUntil = Date.now() + Math.max(err.retryAfterMs, 5000);
          }
          throw err;
        }
        return toAnthropicMessage(json);
      },
    },
  };
  return client;
}

module.exports = { createGroqClient, buildGroqBody, toAnthropicMessage, DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL };
