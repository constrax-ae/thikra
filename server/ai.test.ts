import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError, aiInfo, callModel, configured, jsonFromText, model, price, provider, type AiMessage, type AiToolDef } from './lib/ai.ts';

// The model layer is the one place where a provider's dialect exists. These tests pin BOTH dialects on the wire, because the
// whole promise of the file is that swapping provider is a change of secrets and not of code — and nobody can see the wire
// in production without a key for each.

const clear = () => { for (const k of ['THIKRA_AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'THIKRA_AI_MODEL', 'THIKRA_AI_BASE_URL', 'THIKRA_AI_USD_IN', 'THIKRA_AI_USD_OUT']) delete process.env[k]; };
const asAnthropic = () => { clear(); process.env.THIKRA_AI_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; };
const asOpenai = () => { clear(); process.env.THIKRA_AI_PROVIDER = 'openai'; process.env.OPENAI_API_KEY = 'sk-test'; };

/** A fake network that records what was sent and answers with whatever is given. */
function record(answer: unknown, status = 200) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const f = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  }) as typeof fetch;
  return { f, seen };
}

const TOOLS: AiToolDef[] = [{ name: 'find_people', description: 'search', properties: { q: { type: 'string' }, limit: { type: 'integer' } } },
  { name: 'propose_action', description: 'propose', properties: { kind: { type: 'string' }, args: { type: 'object' } }, required: ['kind', 'args'] }];

// ---- what counts as configured -------------------------------------------------------------------------------------------

test('a provider counts only when its own key is present', () => {
  clear();
  assert.equal(provider(), null, 'nothing configured');
  process.env.THIKRA_AI_PROVIDER = 'anthropic';
  assert.equal(provider(), null, 'a provider without its key is no provider: never half-configured');
  process.env.OPENAI_API_KEY = 'sk-test';
  assert.equal(provider(), null, 'the other provider\'s key does not count');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  assert.equal(provider(), 'anthropic');
  process.env.THIKRA_AI_PROVIDER = 'OpenAI';           // case and spacing are forgiven
  assert.equal(provider(), 'openai');
  process.env.THIKRA_AI_PROVIDER = 'anthropik';        // a typo is not a model
  assert.equal(provider(), null);
  process.env.THIKRA_AI_PROVIDER = 'off';
  assert.equal(provider(), null);
  clear();
  assert.equal(configured(), false);
});

test('the model name defaults per provider and is always overridable', () => {
  asAnthropic(); assert.match(model(), /^claude-/);
  asOpenai(); assert.match(model(), /^gpt-/);
  process.env.THIKRA_AI_MODEL = 'some-model-9';
  assert.equal(model(), 'some-model-9', 'the owner can name a model this file has never heard of');
  clear();
});

test('an unset price override does not read as zero', () => {
  // Number('') is 0, which is finite and not negative: a naive check would price every model at nothing and hide the whole bill.
  asAnthropic();
  assert.deepEqual(price(), { in: 3, out: 15 });
  asOpenai();
  const o = price();
  assert.ok(o.in > 0 && o.out > 0, 'OpenAI has its own default rates');
  process.env.THIKRA_AI_USD_IN = '2'; process.env.THIKRA_AI_USD_OUT = '8';
  assert.deepEqual(price(), { in: 2, out: 8 });
  process.env.THIKRA_AI_USD_IN = 'abc';
  assert.equal(price().in, o.in, 'nonsense falls back to the default');
  clear();
});

test('the machine-room summary names the provider and model, and never the key', () => {
  asOpenai();
  const i = aiInfo();
  assert.equal(i.configured, true); assert.equal(i.provider, 'openai'); assert.ok(i.model);
  assert.ok(!JSON.stringify(i).includes('sk-test'), 'the key is never in what the screen shows');
  clear();
  assert.deepEqual(aiInfo().provider, null);
});

// ---- Anthropic on the wire -----------------------------------------------------------------------------------------------

test('Anthropic: system, tools and a tool answer take Anthropic\'s shape', async () => {
  asAnthropic();
  const { f, seen } = record({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 11, output_tokens: 3 } });
  const messages: AiMessage[] = [
    { role: 'user', text: 'who is Bob?' },
    { role: 'assistant', text: 'looking', toolCalls: [{ id: 't1', name: 'find_people', input: { q: 'Bob' } }] },
    { role: 'tool', results: [{ id: 't1', content: '{"data":[]}' }] },
  ];
  const turn = await callModel({ system: 'be brief', maxTokens: 900, tools: TOOLS, messages }, f);
  const b = seen[0];
  assert.match(b.url, /api\.anthropic\.com\/v1\/messages$/);
  assert.equal(b.headers['x-api-key'], 'sk-ant-test');
  assert.equal(b.headers['anthropic-version'], '2023-06-01');
  assert.equal(b.body.system, 'be brief', 'Anthropic takes the system prompt as its own field');
  assert.equal(b.body.max_tokens, 900);
  assert.deepEqual(b.body.tools[0].input_schema, { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } } });
  assert.deepEqual(b.body.tools[1].input_schema.required, ['kind', 'args']);
  assert.deepEqual(b.body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'find_people', input: { q: 'Bob' } }] });
  assert.deepEqual(b.body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"data":[]}' }] });
  assert.deepEqual(turn, { text: 'done', toolCalls: [], usage: { input: 11, output: 3 } });
  clear();
});

test('Anthropic: tool calls and a text block with no type tag are both read', async () => {
  asAnthropic();
  const { f } = record({ content: [{ text: 'untagged' }, { type: 'tool_use', id: 'x1', name: 'find_people', input: { q: 'Ali' } }] });
  const turn = await callModel({ system: 's', maxTokens: 10, messages: [{ role: 'user', text: 'hi' }] }, f);
  assert.equal(turn.text, 'untagged', 'a block with a text and no type is text: some gateways leave the tag off');
  assert.deepEqual(turn.toolCalls, [{ id: 'x1', name: 'find_people', input: { q: 'Ali' } }]);
  assert.deepEqual(turn.usage, { input: 0, output: 0 }, 'an answer with no usage counts as nothing, not NaN');
  clear();
});

// ---- OpenAI on the wire --------------------------------------------------------------------------------------------------

test('OpenAI: the system prompt is a message, tools are functions, and each tool answer is its own message', async () => {
  asOpenai();
  const { f, seen } = record({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
  const messages: AiMessage[] = [
    { role: 'user', text: 'who is Bob?' },
    { role: 'assistant', text: 'looking', toolCalls: [{ id: 't1', name: 'find_people', input: { q: 'Bob' } }, { id: 't2', name: 'propose_action', input: { kind: 'set_flag', args: {} } }] },
    { role: 'tool', results: [{ id: 't1', content: '{"data":[]}' }, { id: 't2', content: '{"ok":true}' }] },
  ];
  const turn = await callModel({ system: 'be brief', maxTokens: 900, tools: TOOLS, messages }, f);
  const b = seen[0];
  assert.match(b.url, /api\.openai\.com\/v1\/chat\/completions$/);
  assert.equal(b.headers.authorization, 'Bearer sk-test');
  assert.equal(b.headers['x-api-key'], undefined, 'OpenAI is told the key one way only');
  assert.deepEqual(b.body.messages[0], { role: 'system', content: 'be brief' }, 'OpenAI has no system field: it is the first message');
  assert.equal(b.body.max_completion_tokens, 900, 'the current field, not the retired max_tokens');
  assert.equal(b.body.tools[0].type, 'function');
  assert.equal(b.body.tools[0].function.name, 'find_people');
  assert.deepEqual(b.body.tools[0].function.parameters, { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } } });
  assert.deepEqual(b.body.tools[1].function.parameters.required, ['kind', 'args']);
  assert.equal(b.body.tool_choice, 'auto');
  // the assistant's turn carries its calls with the arguments as a JSON string, which is OpenAI's shape
  assert.deepEqual(b.body.messages[2].tool_calls[0], { id: 't1', type: 'function', function: { name: 'find_people', arguments: '{"q":"Bob"}' } });
  // two tool answers become two messages, each naming the call it answers
  assert.deepEqual(b.body.messages.slice(3), [
    { role: 'tool', tool_call_id: 't1', content: '{"data":[]}' },
    { role: 'tool', tool_call_id: 't2', content: '{"ok":true}' },
  ]);
  assert.deepEqual(turn, { text: 'done', toolCalls: [], usage: { input: 11, output: 3 } });
  clear();
});

test('OpenAI: tool calls come back parsed, and broken arguments do not crash the turn', async () => {
  asOpenai();
  const { f } = record({ choices: [{ message: { content: null, tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'find_people', arguments: '{"q":"Ali"}' } },
    { id: 'c2', type: 'function', function: { name: 'find_people', arguments: '{oops' } },
  ] } }] });
  const turn = await callModel({ system: 's', maxTokens: 10, tools: TOOLS, messages: [{ role: 'user', text: 'hi' }] }, f);
  assert.equal(turn.text, '', 'a null content is an empty answer, not the string "null"');
  assert.deepEqual(turn.toolCalls[0], { id: 'c1', name: 'find_people', input: { q: 'Ali' } });
  assert.deepEqual(turn.toolCalls[1].input, {}, 'arguments that are not JSON give an empty call, never a crash');
  clear();
});

test('OpenAI: a JSON-only answer is asked for in the way OpenAI understands', async () => {
  asOpenai();
  const { f, seen } = record({ choices: [{ message: { content: '{"title":"t","paragraphs":["p"]}' } }] });
  await callModel({ system: 'reply with JSON only', maxTokens: 10, json: true, messages: [{ role: 'user', text: 'x' }] }, f);
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
  assert.match(seen[0].body.messages[0].content, /JSON/, 'OpenAI refuses json_object unless a message says JSON');
  // with tools in play the format is left alone: the two cannot be combined
  await callModel({ system: 'reply with JSON only', maxTokens: 10, json: true, tools: TOOLS, messages: [{ role: 'user', text: 'x' }] }, f);
  assert.equal(seen[1].body.response_format, undefined);
  clear();
});

test('an OpenAI-compatible endpoint can be used instead of OpenAI\'s own', async () => {
  asOpenai();
  process.env.THIKRA_AI_BASE_URL = 'https://gateway.example.test/';   // a trailing slash must not double up
  const { f, seen } = record({ choices: [{ message: { content: 'ok' } }] });
  await callModel({ system: 's', maxTokens: 10, messages: [{ role: 'user', text: 'x' }] }, f);
  assert.equal(seen[0].url, 'https://gateway.example.test/v1/chat/completions');
  clear();
});

// ---- failing well --------------------------------------------------------------------------------------------------------

test('every way the model can fail is an AiError the caller can carry on from', async () => {
  clear();
  await assert.rejects(() => callModel({ system: 's', maxTokens: 1, messages: [] }), (e: any) => e instanceof AiError && e.reason === 'not_configured');
  asAnthropic();
  const over = record({}, 429);
  await assert.rejects(() => callModel({ system: 's', maxTokens: 1, messages: [] }, over.f), (e: any) => e instanceof AiError && e.reason === 'http' && e.status === 429);
  const junk = record('not json at all');
  await assert.rejects(() => callModel({ system: 's', maxTokens: 1, messages: [] }, junk.f), (e: any) => e instanceof AiError && e.reason === 'bad_answer');
  clear();
});

test('the JSON object is found however much prose is wrapped around it', () => {
  assert.deepEqual(jsonFromText('Here you go:\n{"a":1}\nhope that helps'), { a: 1 });
  assert.deepEqual(jsonFromText('{"a":{"b":2}}'), { a: { b: 2 } });
  assert.throws(() => jsonFromText('no object here'), (e: any) => e instanceof AiError);
  assert.throws(() => jsonFromText('{broken'), (e: any) => e instanceof AiError);
});
