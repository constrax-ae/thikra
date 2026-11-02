// Property tests for PROTOCOL.md invariants I1-I5 (backlog F-06).
// Each scenario is generated from a seed, so a failure prints the seed and can be replayed:
//   THIKRA_PROP_SEED=12345 pnpm test        THIKRA_PROP_RUNS=2000 pnpm test   (default 150 scenarios)
// A scenario mixes senders, circles, retries (including "the server crashed before the ack"),
// deletions, and a receiving client that suffers dropped, duplicated and reordered pushes.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(pjoin(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../core/timeline.ts';

const { app, sendText, messagesChanged, SYNC_PAGE } = await import('./index.ts');
const { all, one, run } = await import('./db.ts');
const { join } = await import('./live.ts');

// Small deterministic PRNG (mulberry32): same seed, same scenario.
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: T[]) => { const r = [...xs]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; },
  };
}

let phoneCounter = 0;
async function user(name: string) {
  const phone = `+9665${String(5_000_000 + phoneCounter++)}`.padEnd(13, '0').slice(0, 13);
  const post = (path: string, body: unknown, cookie = '') => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const me = await (await app.request('/api/me', { headers: { cookie } })).json() as any;
  return { id: me.id as number, cookie, post: (p: string, b: unknown) => post(p, b, cookie) };
}

// A pool of users shared by all scenarios. Circles and memberships are created straight in the database:
// the join endpoint is rate-limited (20 per 10 minutes), which is right for production and wrong for a generator.
const users = await Promise.all(Array.from({ length: 4 }, (_, i) => user(`u${i}`)));
let codeCounter = 0;
function freshCircle() {
  const id = Number(run("INSERT INTO circles (name, owner_id, invite_code) VALUES ('prop', ?, ?)", users[0].id, `p${codeCounter++}`).lastInsertRowid);
  users.forEach((u, i) => run('INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)', id, u.id, i === 0 ? 'owner' : 'member'));
  return id;
}

const RUNS = Number(process.env.THIKRA_PROP_RUNS ?? 150);
const SEED0 = process.env.THIKRA_PROP_SEED ? Number(process.env.THIKRA_PROP_SEED) : undefined;

async function scenario(seed: number) {
  const r = rng(seed);
  const circle = freshCircle();
  const circle2 = freshCircle(); // a second conversation, to prove sequences do not leak across circles
  const where = `seed=${seed}`;
  const lastSeq = () => one('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE circle_id = ?', circle)!.m as number;

  // A receiving client with a hostile network: pushes can be dropped, duplicated and delivered out of order.
  const timeline = new Timeline<{ seq: number; id: number; body: string }>();
  const inbox: any[] = [];
  const off = join(circle, ev => { const e = ev as any; if (e.t === 'msg' || e.t === 'update') inbox.push(e.m); });

  const acked = new Map<string, { id: number; seq: number; circle: number }>(); // what the server promised
  const attempts: Array<{ circle: number; user: number; cmid: string; body: string }> = [];
  const steps = 20 + r.int(60);

  // The receiving client was fully in sync at some random moment (a real client has a watermark from earlier);
  // from then on its live connection is hostile. This is what makes the rev watermark actually matter.
  const syncedAt = r.int(steps);
  for (let i = 0; i < steps; i++) {
    if (i === syncedAt) {
      inbox.length = 0;
      for (let rev = 0, more = true; more;) {
        const page = messagesChanged(circle, users[0].id, rev) as any[];
        more = timeline.applySync(page, SYNC_PAGE);
        rev = timeline.syncedRev;
      }
    }
    const c = r.chance(0.8) ? circle : circle2;
    const u = r.pick(users);
    const roll = r.next();
    if (roll < 0.6 || !attempts.length) {
      const a = { circle: c, user: u.id, cmid: `m${seed}-${i}`, body: `msg ${i}` };
      attempts.push(a);
      const res = sendText(c, u.id, a.body, a.cmid);
      assert.equal(res.duplicate, false, `${where}: a fresh client_msg_id was treated as a duplicate`);
      // "Server crashed before the Ack": sometimes the client never learns the result.
      if (!r.chance(0.2)) acked.set(`${c}|${u.id}|${a.cmid}`, { id: res.id, seq: res.seq, circle: c });
    } else if (roll < 0.9) {
      // Retry an earlier send (as a client does after a lost ack). Must return the original id and seq (I3).
      const a = r.pick(attempts);
      const first = one('SELECT id, seq FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', a.circle, a.user, a.cmid)!;
      const again = sendText(a.circle, a.user, a.body, a.cmid);
      assert.equal(again.duplicate, true, `${where}: retry created a new message`);
      assert.deepEqual({ id: again.id, seq: again.seq }, { id: first.id, seq: first.seq }, `${where}: retry returned a different id/seq`);
      acked.set(`${a.circle}|${a.user}|${a.cmid}`, { id: again.id, seq: again.seq, circle: a.circle });
    } else {
      // Changes to existing messages: delete-for-everyone, edit, reaction. A delete must leave its seq slot as a placeholder (I2).
      const target = one("SELECT id, user_id FROM messages WHERE circle_id = ? AND kind = 'text' AND deleted_at IS NULL ORDER BY RANDOM() LIMIT 1", circle);
      if (target) {
        const owner = users.find(x => x.id === target.user_id)!;
        const which = r.next();
        const req = (method: string, path: string, who: typeof owner, body?: unknown) =>
          app.request(path, { method, headers: { 'content-type': 'application/json', cookie: who.cookie }, body: body ? JSON.stringify(body) : undefined });
        if (which < 0.35) {
          const res = await req('DELETE', `/api/messages/${target.id}`, owner);
          assert.ok(res.status === 200 || res.status === 403, `${where}: unexpected delete status ${res.status}`);
        } else if (which < 0.7) {
          const res = await req('PATCH', `/api/messages/${target.id}`, owner, { body: `edited ${i}` });
          assert.equal(res.status, 200, `${where}: edit failed with ${res.status}`);
        } else {
          const res = await req('POST', `/api/messages/${target.id}/react`, r.pick(users), { emoji: r.pick(['👍', '❤️', '😂', null]) });
          assert.equal(res.status, 200, `${where}: react failed with ${res.status}`);
        }
      }
    }
  }
  off();

  // ---- I1 + I2: seq is unique and gap-free, per circle -------------------------------------------------
  for (const c of [circle, circle2]) {
    const seqs = all('SELECT seq FROM messages WHERE circle_id = ? ORDER BY seq', c).map(x => x.seq as number);
    const dupes = seqs.length - new Set(seqs).size;
    assert.equal(dupes, 0, `${where}: I1 violated in circle ${c}`);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `${where}: I2 violated in circle ${c}: ${seqs.join(',')}`);
  }

  // ---- I3: at most one message per (circle, sender, client_msg_id) ------------------------------------
  const dup = one('SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE client_msg_id IS NOT NULL GROUP BY circle_id, user_id, client_msg_id HAVING COUNT(*) > 1)')!;
  assert.equal(dup.n, 0, `${where}: I3 violated`);

  // ---- I4: everything the server acknowledged still exists with the promised seq -------------------------
  for (const [key, p] of acked) {
    const row = one('SELECT seq FROM messages WHERE id = ? AND circle_id = ?', p.id, p.circle);
    assert.ok(row, `${where}: I4 violated, acknowledged message ${key} is gone`);
    assert.equal(row!.seq, p.seq, `${where}: I4 violated, ${key} changed seq`);
  }

  // ---- I5 + revisions: a client on a hostile network converges to the server's order AND content --------------------
  // Pushes (new messages and updates) arrive shuffled, duplicated and partly lost. Syncs are whole replies that may also be lost.
  // Whenever the client sees a seq hole, or a "reply" is due, it syncs by rev from its last received watermark.
  const hostile = r.shuffle(inbox.flatMap(m => (r.chance(0.3) ? [] : r.chance(0.2) ? [m, m] : [m])));
  for (const m of hostile) timeline.add(m);
  // A client that connects late knows nothing: an empty timeline must still converge by syncing alone.
  const view = r.chance(0.2) ? new Timeline<any>() : timeline; // a late client has no watermark at all
  const maxRev = () => one('SELECT COALESCE(MAX(rev), 0) AS m FROM messages WHERE circle_id = ?', circle)!.m as number;
  for (let round = 0; round < 80 && (view.hasGap || view.syncedRev < maxRev() || view.contiguous < lastSeq()); round++) {
    const reply = messagesChanged(circle, users[0].id, view.syncedRev);
    if (r.chance(0.2)) continue;                       // the whole reply was lost; ask again
    view.applySync(reply as any[], SYNC_PAGE);
  }
  const server = all('SELECT seq FROM messages WHERE circle_id = ? ORDER BY seq', circle).map(x => x.seq as number);
  assert.deepEqual(view.ordered.map(m => m.seq), server, `${where}: I5 violated, the client did not converge to the server's order`);

  // Content, not just order: what the screen shows for every message equals the server's truth.
  for (const row of all('SELECT id, seq, body, edited_at, deleted_at IS NOT NULL AS deleted FROM messages WHERE circle_id = ?', circle)) {
    const shown = view.ordered.find(m => m.seq === row.seq)!;
    const rx = all('SELECT user_id AS u, emoji AS e FROM reactions WHERE message_id = ? ORDER BY user_id', row.id).map(x => ({ u: x.u, e: x.e }));
    assert.equal(shown.body, row.body, `${where}: seq ${row.seq} shows a stale body`);
    assert.equal(!!shown.deleted, !!row.deleted, `${where}: seq ${row.seq} shows a stale deletion state`);
    assert.equal(shown.editedAt ?? null, row.edited_at ?? null, `${where}: seq ${row.seq} shows a stale edited flag`);
    assert.deepEqual([...(shown.reactions ?? [])].sort((x: any, y: any) => x.u - y.u), rx, `${where}: seq ${row.seq} shows stale reactions`);
  }

  // ---- revisions: unique and increasing per circle -----------------------------------------------------------
  const revs = all('SELECT rev FROM messages WHERE circle_id = ?', circle).map(x => x.rev as number);
  assert.equal(new Set(revs).size, revs.length, `${where}: rev is not unique in circle ${circle}`);
}

test(`I1-I5 hold across ${RUNS} generated scenarios (seeded, replayable)`, async () => {
  const base = SEED0 ?? (Date.now() % 1_000_000);
  console.log(`  property seeds ${base}..${base + (SEED0 !== undefined ? 0 : RUNS - 1)}  (replay one with THIKRA_PROP_SEED=<n>)`);
  for (let i = 0; i < (SEED0 !== undefined ? 1 : RUNS); i++) await scenario(base + i);
});

test('Timeline: duplicates are ignored, order follows seq, a hole is reported', () => {
  const t = new Timeline<{ seq: number }>();
  for (const s of [3, 1, 3, 1]) t.add({ seq: s });
  assert.deepEqual(t.ordered.map(m => m.seq), [1, 3]);
  assert.equal(t.contiguous, 1);
  assert.equal(t.hasGap, true);
  t.add({ seq: 2 });
  assert.equal(t.contiguous, 3);
  assert.equal(t.hasGap, false);
});
