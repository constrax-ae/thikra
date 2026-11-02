import { flag } from '../lib/ops.ts';
import { DEATH_WAIT_HOURS, MAX_SEALED_MEDIA, SEALED_SELECT, SEAL_AUDIO, SEAL_MAX_MS, SEAL_MIN_MS, evidenceFor, releaseOne, sealedRow, sqlUtc } from '../lib/sealed.ts';
import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { blobs } from '../storage.ts';
import { circleAccess, isFrozen, isManager, limited, membership, systemMessage } from '../lib/helpers.ts';
import { cleanName, sniff } from '../sniff.ts';
import { dropBlobIfUnused } from '../lib/deletes.ts';
import { isFile } from '../lib/moments.ts';

// Seal a message for the circle (default) or for one member (delivered into your one-to-one chat; date trigger only).
// JSON for text, multipart (field `file`) for voice/video/photo. Fields: body, trigger (date|event|death), unlockAt, occasion, yearly, recipientId, duration.
app.post('/api/circles/:id/sealed', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!flag('sealed_enabled')) return c.json({ error: 'feature_off' }, 403);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (await limited(`seal:${a.user.id}`, 20, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const multipart = (c.req.header('content-type') ?? '').includes('multipart/form-data');
  const b: any = multipart ? await c.req.parseBody().catch(() => ({})) : await c.req.json().catch(() => ({}));
  const body = String(b.body ?? '').trim().slice(0, 4000);
  const trigger = b.trigger === 'event' || b.trigger === 'death' ? b.trigger : 'date';
  if (trigger === 'death' && !flag('sealed_after_death')) return c.json({ error: 'feature_off' }, 403);   // only event letters and scheduled letters are offered
  const occasion = String(b.occasion ?? '').trim().slice(0, 80) || null;
  const yearly = (b.yearly === true || b.yearly === 'true') && trigger === 'date';

  // content: text, or one voice/video/photo file
  let kind: 'text' | 'voice' | 'video' | 'image' = 'text';
  let media: { hash: string; size: number; mime: string; name: string | null; durationMs: number | null } | null = null;
  const file = b.file;
  if (isFile(file) && file.size > 0) {
    if (file.size > MAX_SEALED_MEDIA) return c.json({ error: 'attachment_too_large' }, 413);
    const buf = Buffer.from(await file.arrayBuffer());
    const claimed = file.type.split(';')[0].trim().toLowerCase();
    let mime: string;
    if (SEAL_AUDIO.has(claimed)) { kind = 'voice'; mime = claimed; }
    else {
      const sn = sniff(buf);
      if (!sn || !sn.inline || (sn.family !== 'video' && sn.family !== 'image')) return c.json({ error: 'invalid_attachment' }, 400);
      kind = sn.family === 'video' ? 'video' : 'image'; mime = sn.mime;
    }
    const { hash, size } = await blobs.put(buf);
    run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
    const dur = Number(b.duration);
    media = { hash, size, mime, name: cleanName(file.name || kind), durationMs: Number.isInteger(dur) && dur > 0 && dur <= 3600_000 ? dur : null };
  } else if (!body) return c.json({ error: 'empty' }, 400);

  // A scheduled letter opens on one date, or on several (`dates`: a JSON list or a comma-separated string, up to 12): one envelope per date.
  let unlocks: Array<string | null> = [null];
  if (trigger === 'date') {
    let listed: unknown[] = [];
    if (Array.isArray(b.dates)) listed = b.dates;
    else if (typeof b.dates === 'string' && b.dates.trim()) { try { const j = JSON.parse(b.dates); listed = Array.isArray(j) ? j : String(b.dates).split(','); } catch { listed = b.dates.split(','); } }
    const raw = listed.length ? listed : [b.unlockAt];
    if (raw.length > 12) return c.json({ error: 'invalid_date' }, 400);
    unlocks = [];
    for (const v of raw) {
      const at = Date.parse(String(v ?? '').trim());
      if (!Number.isFinite(at) || at < Date.now() + SEAL_MIN_MS || at > Date.now() + SEAL_MAX_MS) return c.json({ error: 'invalid_date' }, 400);
      unlocks.push(sqlUtc(at));
    }
    unlocks = [...new Set(unlocks)];
  } else {
    if (trigger === 'event' && !occasion) return c.json({ error: 'occasion_required' }, 400);
    // These letters open only when the AGENT concludes the event/death from the family's messages, so the agent must be on in a family circle.
    const ci = one('SELECT kind, agent_active FROM circles WHERE id = ?', a.circleId)!;
    if (ci.kind !== 'circle' || !ci.agent_active) return c.json({ error: 'agent_required' }, 409);
  }

  let recipient: number | null = null;
  if (b.recipientId !== undefined && b.recipientId !== null && b.recipientId !== '') {
    recipient = Number(b.recipientId);
    if (trigger !== 'date' || !Number.isInteger(recipient) || recipient === a.user.id || !membership(a.circleId, recipient)) return c.json({ error: 'not_found' }, 404);
  }
  const ids = unlocks.map(unlockAt => Number(run(
    `INSERT INTO sealed_messages (circle_id, author_id, recipient_id, trigger, occasion, kind, body, blob_hash, mime, name, duration_ms, unlock_at, yearly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.circleId, a.user.id, recipient, trigger, occasion, kind, body, media?.hash ?? null, media?.mime ?? null, media?.name ?? null, media?.durationMs ?? null, unlockAt, yearly && unlocks.length === 1 ? 1 : 0).lastInsertRowid));
  return c.json({ id: ids[0], ids }, 201);
});
// Your own sealed messages in this circle (only you can read them before they open).
app.get('/api/circles/:id/sealed', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  return c.json(all(`${SEALED_SELECT} WHERE s.circle_id = ? AND s.author_id = ? AND s.status IN ('sealed','waiting','stopped') ORDER BY COALESCE(s.unlock_at, '9999'), s.id`, a.circleId, a.user.id).map(sealedRow));
});
// All of your waiting sealed messages, across circles.
app.get('/api/me/sealed', c => c.json(all(`${SEALED_SELECT} WHERE s.author_id = ? AND s.status IN ('sealed','waiting','stopped') ORDER BY COALESCE(s.unlock_at, '9999'), s.id`, c.get('user').id).map(sealedRow)));
// Cancelling before it opens erases the content. Only the author, only while it is still sealed (not once the family is already confirming a death).
app.delete('/api/sealed/:id', async c => {
  const s = one("SELECT id, blob_hash FROM sealed_messages WHERE id = ? AND author_id = ? AND status IN ('sealed','stopped')", Number(c.req.param('id')), c.get('user').id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  run("UPDATE sealed_messages SET status = 'cancelled', body = '', blob_hash = NULL, name = NULL WHERE id = ?", s.id);
  if (s.blob_hash) await dropBlobIfUnused(s.blob_hash);
  return c.json({ ok: true });
});
/** What the family may know BEFORE a letter opens: that the envelope exists, for which event / after whose death, and how far the agent's evidence has come. Never the content. */
app.get('/api/circles/:id/sealed-envelopes', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const me = a.user.id;
  const events = all(
    `SELECT s.id, u.name AS author, s.author_id AS authorId, s.status, s.release_at AS releaseAt
       FROM sealed_messages s JOIN users u ON u.id = s.author_id WHERE s.circle_id = ? AND s.trigger = 'event' AND s.status IN ('sealed','waiting') AND s.recipient_id IS NULL ORDER BY s.id`, a.circleId)
    .map(r => ({ ...r, waiting: r.status === 'waiting', evidence: evidenceFor(a.circleId, 'event', r.id), canStop: r.status === 'waiting' && (r.authorId === me || isManager(a.role)) }));
  const deaths = all(
    `SELECT s.author_id AS authorId, u.name AS author, COUNT(*) AS count, MAX(s.status = 'waiting') AS waiting, MAX(s.release_at) AS releaseAt
       FROM sealed_messages s JOIN users u ON u.id = s.author_id
      WHERE s.circle_id = ? AND s.trigger = 'death' AND s.status IN ('sealed','waiting') AND s.recipient_id IS NULL GROUP BY s.author_id ORDER BY s.author_id`, a.circleId)
    .map(r => ({ ...r, waiting: !!r.waiting, evidence: evidenceFor(a.circleId, 'death', r.authorId), canStop: !!r.waiting && (r.authorId === me || isManager(a.role)) }));
  // Only a count for the teaser: no title, no kind, no content, for anyone but the author.
  const total = one("SELECT COUNT(*) AS n FROM sealed_messages WHERE circle_id = ? AND recipient_id IS NULL AND status IN ('sealed','waiting')", a.circleId)?.n ?? 0;
  return c.json({ events, deaths, total, deathEnabled: flag('sealed_after_death'), waitHours: DEATH_WAIT_HOURS, agentActive: !!one('SELECT agent_active FROM circles WHERE id = ?', a.circleId)?.agent_active });
});
// The author (alive) opens an envelope early, any trigger. Everyone then sees it, like any other opened letter.
app.post('/api/sealed/:id/open', async c => {
  const s = one("SELECT * FROM sealed_messages WHERE id = ? AND author_id = ? AND status = 'sealed' AND trigger != 'death'", Number(c.req.param('id')), c.get('user').id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  return (await releaseOne(s)) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
});
// The author (alive) or a circle manager stops an occasion's countdown (the agent was wrong). The evidence is wiped: it must build up again.
app.post('/api/sealed/:id/stop', c => {
  const s = one("SELECT * FROM sealed_messages WHERE id = ? AND trigger = 'event' AND status = 'waiting'", Number(c.req.param('id')));
  const m = s && membership(s.circle_id, c.get('user').id);
  if (!s || !m) return c.json({ error: 'not_found' }, 404);
  if (s.author_id !== c.get('user').id && !isManager(m.role)) return c.json({ error: 'forbidden' }, 403);
  run("UPDATE sealed_messages SET status = 'sealed', release_at = NULL WHERE id = ?", s.id);
  run("DELETE FROM sealed_evidence WHERE scope = 'event' AND ref_id = ?", s.id);
  systemMessage(s.circle_id, 'eventStopped', { name: c.get('user').name, occasion: s.occasion });
  return c.json({ ok: true });
});
// Death: the agent concludes from the family's messages (see collectSealedEvidence). Nothing here confirms it by hand.
// Stop a death countdown: the person says they are alive, or a circle manager is not convinced. We stop when in doubt, never guess.
app.post('/api/circles/:id/sealed/death/:uid/stop', c => {
  const a = circleAccess(c);
  const subject = Number(c.req.param('uid'));
  if (!a || !Number.isInteger(subject)) return c.json({ error: 'not_found' }, 404);
  if (a.user.id !== subject && !isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const r = run("UPDATE sealed_messages SET status = 'sealed', release_at = NULL WHERE circle_id = ? AND author_id = ? AND trigger = 'death' AND status = 'waiting'", a.circleId, subject);
  if (!Number(r.changes)) return c.json({ error: 'not_found' }, 404);
  run("DELETE FROM sealed_evidence WHERE scope = 'death' AND ref_id = ? AND circle_id = ?", subject, a.circleId);
  const who = one('SELECT name FROM users WHERE id = ?', subject)?.name ?? '';
  if (a.user.id === subject) systemMessage(a.circleId, 'imFine', { who }); else systemMessage(a.circleId, 'deathStopped', { name: a.user.name, who });
  return c.json({ ok: true });
});
