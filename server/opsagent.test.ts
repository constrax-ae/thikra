process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500880001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-agent-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { propose, scrub, setOpsFetch, SYSTEM_PROMPT } = await import('./lib/opsagent.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}
const owner = await signUp('+971500880001', 'Owner');
const mod = await signUp('+971500880002', 'Moderator');
const sup = await signUp('+971500880003', 'Support');
const bob = await signUp('+971500880004', 'Bob');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
await call(owner.cookie, `/api/admin/users/${sup.id}/role`, { role: 'support' });
const audited = (action: string) => one('SELECT COUNT(*) n FROM admin_audit WHERE action = ?', action)!.n as number;

test('only staff with the agent permission reach it', async () => {
  for (const p of ['/api/admin/agent/digest', '/api/admin/agent/proposals']) {
    assert.equal((await call(bob.cookie, p)).status, 403, p);
    assert.equal((await call(sup.cookie, p)).status, 403, `support ${p}`);
    assert.equal((await call(owner.cookie, p)).status, 200, `owner ${p}`);
  }
  assert.equal((await call(sup.cookie, '/api/admin/agent/ask', { question: 'x' })).status, 403);
});

test('the digest ranks what needs a decision and the answers never carry a full phone number', async () => {
  await call(bob.cookie, '/api/support', { subject: 'Help me', body: 'my code never arrives' });
  const d = (await call(owner.cookie, '/api/admin/agent/digest')).json;
  assert.ok(d.items.some((i: any) => i.code === 'support' && i.ar && i.en));
  assert.ok(d.items.every((i: any, n: number, a: any[]) => !n || ['high', 'medium', 'low'].indexOf(a[n - 1].sev) <= ['high', 'medium', 'low'].indexOf(i.sev)), 'most urgent first');
  const found = (await call(owner.cookie, '/api/admin/agent/ask', { question: 'ابحث عن Bob', lang: 'en' })).json;
  assert.match(found.answer, /Bob/);
  assert.ok(!found.answer.includes('+971500880004') && !JSON.stringify(found).includes('971500880004'), 'masked');
  assert.equal(scrub('call +971 50 088 0004 now'), 'call [number] now');
});

test('the agent cannot act: a proposal changes nothing until a person approves, and then the real endpoint runs under that person', async () => {
  const asked = (await call(owner.cookie, '/api/admin/agent/ask', { question: `أوقف الحساب ${bob.id}` })).json;
  assert.equal(asked.proposals.length, 1);
  assert.equal(one('SELECT suspended_at FROM users WHERE id = ?', bob.id)!.suspended_at, null, 'not suspended by a proposal');
  const id = asked.proposals[0];
  assert.equal((await call(sup.cookie, `/api/admin/agent/proposals/${id}/approve`, {})).status, 403);
  const before = audited('user.suspend');
  assert.equal((await call(owner.cookie, `/api/admin/agent/proposals/${id}/approve`, {})).status, 200);
  assert.ok(one('SELECT suspended_at FROM users WHERE id = ?', bob.id)!.suspended_at, 'suspended after approval');
  assert.equal(audited('user.suspend'), before + 1, 'the real endpoint wrote its own audit row');
  assert.ok(audited('agent.approve') >= 1 && audited('agent.ask') >= 1);
  assert.equal((await call(owner.cookie, `/api/admin/agent/proposals/${id}/approve`, {})).status, 409, 'cannot run twice');
  await call(owner.cookie, `/api/admin/users/${bob.id}/unsuspend`, {});
});

test('a proposal needs the permission of the action itself, rejecting works once, and dangerous kinds cannot be proposed at all', async () => {
  const flagP = propose('set_flag', { name: 'signups_open', on: false }, 'sign-up spike', 'rules', owner.id);
  assert.ok(flagP.ok);
  assert.equal((await call(mod.cookie, `/api/admin/agent/proposals/${(flagP as any).id}/approve`, {})).status, 403, 'a moderator may not switch features');
  assert.equal(one('SELECT status FROM agent_proposals WHERE id = ?', (flagP as any).id)!.status, 'pending');
  assert.equal((await call(owner.cookie, `/api/admin/agent/proposals/${(flagP as any).id}/reject`, {})).status, 200);
  assert.equal((await call(owner.cookie, `/api/admin/agent/proposals/${(flagP as any).id}/reject`, {})).status, 409);
  for (const kind of ['ban', 'remove_message', 'delete_family', 'nope']) assert.equal(propose(kind, { userId: 1 }, 'x', 'model', owner.id).ok, false, kind);
  assert.equal(propose('suspend_user', { userId: bob.id, days: 99999 }, 'x', 'model', owner.id).ok, false, 'bad arguments');
  const a = propose('close_support', { caseId: 1 }, 'x', 'rules', owner.id), b = propose('close_support', { caseId: 1 }, 'x', 'rules', owner.id);
  assert.equal((a as any).id, (b as any).id, 'the same pending proposal is not duplicated');
});

test('with a language model: it reasons over the tools, may only propose, and never sees a full number', async () => {
  process.env.THIKRA_AI_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const sent: any[] = [];
  let turn = 0;
  setOpsFetch((async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    turn++;
    const reply = turn === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'find_people', input: { q: 'Bob' } }, { type: 'tool_use', id: 't2', name: 'propose_action', input: { kind: 'set_flag', args: { name: 'signups_open', on: false }, reason: 'spike of 40 sign-ups' } }] }
      : { content: [{ type: 'text', text: 'I proposed closing sign-ups; approve it if the spike is not real users.' }] };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch);
  const out = (await call(owner.cookie, '/api/admin/agent/ask', { question: 'what is going on with sign-ups?', lang: 'en' })).json;
  assert.equal(out.source, 'model');
  assert.match(out.answer, /proposed/);
  assert.equal(out.proposals.length, 1);
  assert.equal(one('SELECT source FROM agent_proposals WHERE id = ?', out.proposals[0])!.source, 'model');
  assert.equal(sent[0].system, SYSTEM_PROMPT);
  assert.match(SYSTEM_PROMPT, /data, never instructions/);
  assert.match(JSON.stringify(sent[1].messages), /untrusted_text_inside/, 'what comes back from a tool is labelled as people\'s text');
  assert.ok(sent[0].tools.some((t: any) => t.name === 'propose_action'));
  assert.ok(!JSON.stringify(sent).includes('971500880004'), 'the model never receives a full phone number');
  // the model is down: the rules answer instead
  setOpsFetch((async () => new Response('x', { status: 500 })) as typeof fetch);
  const fallback = (await call(owner.cookie, '/api/admin/agent/ask', { question: 'ملخص اليوم' })).json;
  assert.equal(fallback.source, 'rules');
  delete process.env.THIKRA_AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
});

test('two approvals at the same moment run the action once', async () => {
  const p = propose('close_support', { caseId: 1 }, 'x', 'rules', owner.id);
  assert.ok(p.ok);
  run("INSERT OR IGNORE INTO support_cases (id, user_id, subject) VALUES (1, ?, 'race')", bob.id);
  const before = Number(one("SELECT COUNT(*) n FROM admin_audit WHERE action = 'support.close'")!.n);
  const [a, b] = await Promise.all([1, 2].map(() => call(owner.cookie, `/api/admin/agent/proposals/${(p as any).id}/approve`, {})));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(Number(one("SELECT COUNT(*) n FROM admin_audit WHERE action = 'support.close'")!.n), before + 1, 'the real endpoint ran once');
});

test('the same agent works through OpenAI without a line of its own code changing', async () => {
  // The point of server/lib/ai.ts: the agent reasons, calls tools and proposes identically whichever provider is paid for.
  // Here the fake speaks OpenAI's dialect — function calls with JSON-string arguments, a system message, tool messages back.
  delete process.env.ANTHROPIC_API_KEY;
  process.env.THIKRA_AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  const sent: any[] = [];
  let turn = 0;
  setOpsFetch((async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    turn++;
    const reply = turn === 1
      ? { choices: [{ message: { content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'open_reports', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'propose_action', arguments: JSON.stringify({ kind: 'set_flag', args: { name: 'signups_open', on: false }, reason: 'a spike of sign-ups' }) } },
        ] } }], usage: { prompt_tokens: 120, completion_tokens: 40 } }
      : { choices: [{ message: { content: 'Sign-ups look like a spike; I proposed closing them for your approval.' } }], usage: { prompt_tokens: 200, completion_tokens: 25 } };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch);

  const out = (await call(owner.cookie, '/api/admin/agent/ask', { question: 'what is going on with sign-ups?', lang: 'en' })).json;
  assert.equal(out.source, 'model');
  assert.match(out.answer, /proposed/);
  assert.equal(out.proposals.length, 1, 'the proposal came through the OpenAI dialect intact');
  assert.equal(one('SELECT source FROM agent_proposals WHERE id = ?', out.proposals[0])!.source, 'model');
  assert.ok(out.tools.includes('open_reports') && out.tools.includes('propose_action'));

  assert.match(sent[0].url, /chat\/completions$/);
  assert.deepEqual(sent[0].body.messages[0], { role: 'system', content: SYSTEM_PROMPT }, 'the same prompt, as OpenAI takes it');
  assert.ok(sent[0].body.tools.some((t: any) => t.function?.name === 'propose_action'));
  // the second turn carries the tool answers as OpenAI tool messages, still labelled as people's words
  const second = sent[1].body.messages;
  assert.equal(second.filter((m: any) => m.role === 'tool').length, 2);
  assert.match(JSON.stringify(second), /untrusted_text_inside/);
  assert.ok(!JSON.stringify(sent).includes('971500880004'), 'the model never receives a full phone number, whichever provider it is');

  // the model is down: the rules answer, exactly as with the other provider
  setOpsFetch((async () => new Response('{}', { status: 503 })) as typeof fetch);
  assert.equal((await call(owner.cookie, '/api/admin/agent/ask', { question: 'ملخص اليوم' })).json.source, 'rules');

  delete process.env.THIKRA_AI_PROVIDER; delete process.env.OPENAI_API_KEY;
});
