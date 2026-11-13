// One way in to a language model, whichever provider the owner pays for. Thikra's two model features (the family's story book and
// the owner's operations agent) speak THIS interface, never a provider's own dialect, so switching provider is a secret change and
// not a code change — and a provider we have no key for simply does not exist as far as the rest of the server is concerned.
//
//   THIKRA_AI_PROVIDER=anthropic   ANTHROPIC_API_KEY=sk-ant-…
//   THIKRA_AI_PROVIDER=openai      OPENAI_API_KEY=sk-…
//   THIKRA_AI_MODEL=…              the model's name. ALWAYS SET THIS: the defaults below are only a starting point and model names
//                                  are retired by their makers far faster than this file is edited.
//   THIKRA_AI_BASE_URL=…           an OpenAI-compatible endpoint instead of OpenAI's own (Azure, a gateway, a local server).
//   THIKRA_AI_USD_IN / _OUT        dollars per million tokens, for the cost guide on the owner's screen only (never billing).
//
// Anything unset means no model: every caller must keep working without one, and both of them do (the book falls back to the
// chapters its rules write, the agent to the answers its rules give).

export type Provider = 'anthropic' | 'openai';

/** A tool the model may call. Described once, in neither provider's words. */
export interface AiToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: 'string' | 'integer' | 'number' | 'boolean' | 'object' }>;
  required?: string[];
}
export interface AiToolCall { id: string; name: string; input: Record<string, unknown> }

/** The conversation so far, in neither provider's words. */
export type AiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: AiToolCall[] }
  | { role: 'tool'; results: Array<{ id: string; content: string }> };

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  tools?: AiToolDef[];
  /** Ask for a lone JSON object back. The system prompt must still say so (and must contain the word JSON for OpenAI). */
  json?: boolean;
}
export interface AiTurn { text: string; toolCalls: AiToolCall[]; usage: { input: number; output: number } }

export class AiError extends Error {
  constructor(public reason: 'not_configured' | 'http' | 'bad_answer', msg: string, public status?: number) { super(msg); }
}

// ---- what is configured -------------------------------------------------------------------------------------------------

const env = (k: string) => (process.env[k] ?? '').trim();

/** The provider the owner configured AND has a key for, or null. Anything else (unset, 'off', a typo) is null: never a half-configured model. */
export function provider(): Provider | null {
  const name = env('THIKRA_AI_PROVIDER').toLowerCase();
  if (name === 'anthropic') return env('ANTHROPIC_API_KEY') ? 'anthropic' : null;
  if (name === 'openai') return env('OPENAI_API_KEY') ? 'openai' : null;
  return null;
}
export const configured = () => provider() !== null;

const KEY: Record<Provider, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
// A starting point only; THIKRA_AI_MODEL overrides it and should always be set in production.
const DEFAULT_MODEL: Record<Provider, string> = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5' };
const DEFAULT_BASE: Record<Provider, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };
/** Dollars per million tokens: the guide for the owner's budget screen, not a bill. Rates change; THIKRA_AI_USD_IN/_OUT override. */
const DEFAULT_PRICE: Record<Provider, { in: number; out: number }> = { anthropic: { in: 3, out: 15 }, openai: { in: 1.25, out: 10 } };

export const model = () => env('THIKRA_AI_MODEL') || DEFAULT_MODEL[provider() ?? 'anthropic'];
const baseUrl = (p: Provider) => (env('THIKRA_AI_BASE_URL') || DEFAULT_BASE[p]).replace(/\/+$/, '');

/** Dollars per million tokens in and out, for the cost estimate on the owner's screen. */
export function price(): { in: number; out: number } {
  const d = DEFAULT_PRICE[provider() ?? 'anthropic'];
  // An UNSET variable must not read as zero: Number('') is 0, which would quietly price every model at nothing.
  const n = (k: string, dflt: number) => { const raw = env(k); if (!raw) return dflt; const v = Number(raw); return Number.isFinite(v) && v >= 0 ? v : dflt; };
  return { in: n('THIKRA_AI_USD_IN', d.in), out: n('THIKRA_AI_USD_OUT', d.out) };
}

/** What the owner's machine-room screen shows about the model (never the key itself). */
export const aiInfo = () => { const p = provider(); return { configured: !!p, provider: p, model: p ? model() : null, ...price() }; };

// ---- Anthropic's dialect ------------------------------------------------------------------------------------------------

function anthropicBody(r: AiRequest): unknown {
  const messages = r.messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') return {
      role: 'assistant',
      content: [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolCalls.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))],
    };
    // A tool's answer goes back as a user turn: that is Anthropic's shape, not a claim that a person wrote it.
    return { role: 'user', content: m.results.map(x => ({ type: 'tool_result', tool_use_id: x.id, content: x.content })) };
  });
  return {
    model: model(), max_tokens: r.maxTokens, system: r.system, messages,
    ...(r.tools?.length ? { tools: r.tools.map(t => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) } })) } : {}),
  };
}

function anthropicTurn(data: any): AiTurn {
  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  // A block with no `type` but a `text` is text: some gateways (and our own fakes) leave the tag off.
  const isText = (b: any) => b?.type === 'text' || (b?.type === undefined && typeof b?.text === 'string');
  return {
    text: blocks.filter(isText).map(b => String(b.text ?? '')).join('\n').trim(),
    toolCalls: blocks.filter(b => b?.type === 'tool_use').map(b => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: (b.input ?? {}) as Record<string, unknown> })),
    usage: { input: Math.max(0, Number(data?.usage?.input_tokens) || 0), output: Math.max(0, Number(data?.usage?.output_tokens) || 0) },
  };
}

// ---- OpenAI's dialect (Chat Completions: the shape every OpenAI-compatible endpoint also speaks) ------------------------

function openaiBody(r: AiRequest): unknown {
  const messages: any[] = [{ role: 'system', content: r.system }];
  for (const m of r.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') messages.push({
      role: 'assistant', content: m.text || null,
      ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}),
    });
    // OpenAI wants one message per tool answer, each naming the call it answers.
    else for (const x of m.results) messages.push({ role: 'tool', tool_call_id: x.id, content: x.content });
  }
  return {
    model: model(), messages, max_completion_tokens: r.maxTokens,
    ...(r.tools?.length ? { tools: r.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) } } })), tool_choice: 'auto' } : {}),
    ...(r.json && !r.tools?.length ? { response_format: { type: 'json_object' } } : {}),
  };
}

function openaiTurn(data: any): AiTurn {
  const msg = data?.choices?.[0]?.message ?? {};
  const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  return {
    text: String(msg.content ?? '').trim(),
    toolCalls: calls.filter(c => c?.function?.name).map(c => {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(String(c.function.arguments ?? '{}')) ?? {}; } catch { input = {}; }   // a model that writes broken arguments gets an empty call, not a crash
      return { id: String(c.id ?? ''), name: String(c.function.name), input };
    }),
    usage: { input: Math.max(0, Number(data?.usage?.prompt_tokens) || 0), output: Math.max(0, Number(data?.usage?.completion_tokens) || 0) },
  };
}

// ---- the one call -------------------------------------------------------------------------------------------------------

/**
 * One turn with the configured model. `fetchFn` is passed in so each caller keeps its own test seam.
 * Throws AiError; every caller is expected to catch it and carry on without a model.
 */
export async function callModel(r: AiRequest, fetchFn: typeof fetch = fetch): Promise<AiTurn> {
  const p = provider();
  if (!p) throw new AiError('not_configured', 'no language model is configured');
  const key = env(KEY[p]);
  const url = p === 'anthropic' ? `${baseUrl(p)}/v1/messages` : `${baseUrl(p)}/v1/chat/completions`;
  const headers: Record<string, string> = p === 'anthropic'
    ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(p === 'anthropic' ? anthropicBody(r) : openaiBody(r)) });
  if (!res.ok) throw new AiError('http', `model ${res.status}`, res.status);
  const data: any = await res.json().catch(() => null);
  if (!data) throw new AiError('bad_answer', 'the model did not answer with JSON');
  return p === 'anthropic' ? anthropicTurn(data) : openaiTurn(data);
}

/** The lone JSON object out of a model's answer, however much prose it wrapped around it. Throws when there is none. */
export function jsonFromText<T = any>(text: string): T {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('bad_answer', 'no JSON object in the answer');
  try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { throw new AiError('bad_answer', 'the JSON in the answer is broken'); }
}
