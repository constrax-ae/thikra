import { app } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { limited } from '../lib/helpers.ts';
import { TOOLS, ask, digest, execute, listProposals, modelOn, reject } from '../lib/opsagent.ts';
import { listBriefs, makeBrief } from '../lib/briefs.ts';

// The operations agent (see lib/opsagent.ts and docs/AGENT-OPS.md): it reads metadata, ranks what needs a decision and PROPOSES actions; a person approves.
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

app.get('/api/admin/agent/digest', requireAdmin('agent'), async c => c.json({ ...(await digest()), model: modelOn(), tools: Object.keys(TOOLS) }));

app.post('/api/admin/agent/ask', requireAdmin('agent'), async c => {
  const me = c.get('user');
  if (await limited(`agent:${me.id}`, 60, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  const question = text(b.question, 1000);
  if (!question) return c.json({ error: 'invalid_value' }, 400);
  const out = await ask(question, b.lang === 'en' ? 'en' : 'ar', me.id);
  audit(c, 'agent.ask', { type: 'agent', id: 'ask' }, { source: out.source, tools: out.tools, proposals: out.proposals });   // what was typed is not logged
  return c.json(out);
});

app.get('/api/admin/agent/proposals', requireAdmin('agent'), c => c.json(listProposals(c.req.query('status') || undefined)));

app.post('/api/admin/agent/proposals/:id/approve', requireAdmin('agent.act'), async c => {
  const id = Number(c.req.param('id'));
  const r = await execute(id, c.get('user'), { cookie: c.req.header('cookie'), forwarded: c.req.header('x-forwarded-for') });
  audit(c, 'agent.approve', { type: 'proposal', id }, { ok: r.ok, error: r.error ?? null });
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status as 400 | 403 | 404 | 409);
});
app.post('/api/admin/agent/proposals/:id/reject', requireAdmin('agent.act'), c => {
  const id = Number(c.req.param('id'));
  const ok = reject(id, c.get('user').id);
  audit(c, 'agent.reject', { type: 'proposal', id }, { ok });
  return ok ? c.json({ ok: true }) : c.json({ error: 'already_decided' }, 409);
});

/** The summaries the agent wrote by itself (morning, evening, alerts), and one on demand. */
app.get('/api/admin/agent/briefs', requireAdmin('agent'), c => c.json(listBriefs()));
app.post('/api/admin/agent/brief', requireAdmin('agent'), async c => {
  const id = await makeBrief('manual');
  audit(c, 'agent.brief', { type: 'agent', id: 'brief' }, { id });
  return c.json({ id }, 201);
});
