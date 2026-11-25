import { app } from '../app.ts';
import { one, run } from '../db.ts';
import { blobs } from '../storage.ts';
import { sniff } from '../sniff.ts';
import { announce, announceUpdate, circleAccess, insertMessage, isFrozen, limited, mayPost, membership, tx } from '../lib/helpers.ts';
import { blockedInDirect } from '../lib/moments.ts';
import { bumpRev } from '../lib/polls.ts';
import { cleanCard, cleanPoint, storeCard, type CardType } from '../lib/cards.ts';
import { UnsafeLink, cleanLink, previewOf } from '../lib/linkpreview.ts';
import { gifById, gifKnown, gifProvider, gifThumb, searchGifs } from '../lib/gifs.ts';
import { purgeLinkPreviews } from '../lib/deletes.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// ---- voice notes: "played" ---------------------------------------------------------------------
// A listener's device says it once, when the note starts playing. Everyone in the chat sees who has played it (the sender's mark turns).
app.post('/api/messages/:mid/played', c => {
  const user = c.get('user');
  const m = one('SELECT id, circle_id, user_id, kind, deleted_at, view_once FROM messages WHERE id = ?', Number(c.req.param('mid')));
  if (!m || !membership(m.circle_id, user.id) || m.kind !== 'voice' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  if (m.view_once) return c.json({ ok: true });   // opening replaces "played"
  if (m.user_id === user.id) return c.json({ ok: true });   // listening to your own note marks nothing
  const added = Number(run('INSERT OR IGNORE INTO voice_plays (message_id, user_id) VALUES (?, ?)', m.id, user.id).changes) > 0;
  if (added) { bumpRev(m.id); announceUpdate(m.circle_id, m.id); }
  return c.json({ ok: true });
});

// ---- link previews (the rules and the safety of the fetch are in lib/linkpreview.ts) ----------
// Asked by the sender's device while the person is still writing. The answer is null when the page gave nothing to show.
let lastPurge = 0;
app.post('/api/link-preview', async c => {
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const u = cleanLink(b.url);
  if (!u) return c.json({ error: 'unsafe_link' }, 400);
  if (await limited(`preview:${user.id}`, 30, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  // Housekeeping rides along, at most once an hour: previews older than a week are thrown away with their pictures.
  if (Date.now() - lastPurge > 3600_000) { lastPurge = Date.now(); purgeLinkPreviews().catch(e => console.error('[link previews]', e)); }
  try { return c.json({ preview: await previewOf(u) }); }
  catch (e) {
    if (e instanceof UnsafeLink) return c.json({ error: 'unsafe_link' }, 400);
    return c.json({ preview: null });   // the site did not answer: no card, and the message is sent as plain text
  }
});
// The picture of a stored preview, for the card above the message box (in a sent message it is a media row of that message).
app.get('/api/link-preview/image/:hash', async c => {
  const hash = c.req.param('hash');
  const row = /^[0-9a-f]{64}$/.test(hash) ? one('SELECT image_mime AS mime FROM link_previews WHERE image_hash = ?', hash) : undefined;
  const data = row && await blobs.get(hash);
  if (!row || !data) return c.json({ error: 'not_found' }, 404);
  return new Response(new Uint8Array(data), { headers: { 'content-type': row.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, max-age=86400' } });
});

// ---- GIFs --------------------------------------------------------------------------------------
// Without a provider key the answer is `configured: false` and an empty list: the panel says GIF search is not set up.
app.get('/api/gifs', async c => {
  if (!gifProvider()) return c.json({ configured: false, items: [] });
  if (await limited(`gifs:${c.get('user').id}`, 60, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  const off = Number(c.req.query('offset'));
  const items = await searchGifs(q, Number.isInteger(off) && off > 0 && off <= 500 ? off : 0);
  return c.json({ configured: true, items: items.map(g => ({ id: g.id, title: g.title, w: g.preview.w, h: g.preview.h })) });
});
app.get('/api/gifs/:gid/preview', async c => {
  if (!gifProvider()) return c.json({ error: 'gifs_off' }, 503);
  if (await limited(`gif-thumb:${c.get('user').id}`, 600, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const gid = c.req.param('gid');
  // An id the server has not just listed costs a call to the provider: a few are fine (recently used GIFs after a restart), guessing ids in bulk is not.
  if (!gifKnown(gid) && await limited(`gif-lookup:${c.get('user').id}`, 20, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const buf = await gifThumb(gid);
  const sn = buf ? sniff(buf) : null;
  if (!buf || sn?.family !== 'image' || !sn.inline) return c.json({ error: 'not_found' }, 404);
  return new Response(new Uint8Array(buf), { headers: { 'content-type': sn.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, max-age=86400' } });
});

// ---- cards: contact, location, sticker, GIF ---------------------------------------------------
// Each is an ordinary message (empty text) with one card beside it (lib/cards.ts), so it is ordered, synced, replied to and deleted
// like any other, and "only admins send" applies through the same check.
const GIF_MAX = 8 * 1024 * 1024;
app.post('/api/circles/:id/cards', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // an encrypted chat takes only ciphertext (POST /api/circles/:id/e2ee/messages)
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (blockedInDirect(a.circleId, a.user.id)) return c.json({ error: 'blocked' }, 403);
  if (!mayPost(a.circleId, a.user.id)) return c.json({ error: 'admins_only' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const cmid = typeof b.client_msg_id === 'string' && b.client_msg_id && b.client_msg_id.length <= 64 ? b.client_msg_id : null;
  const prev = cmid && one('SELECT id, seq FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', a.circleId, a.user.id, cmid);
  if (prev) return c.json({ id: prev.id, seq: prev.seq }, 200);   // a retry of one already stored is never refused
  if (await limited(`card:${a.user.id}`, 60, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const replyTo = Number.isInteger(b.reply_to) && one('SELECT 1 FROM messages WHERE id = ? AND circle_id = ?', b.reply_to, a.circleId) ? b.reply_to as number : null;

  let card: { type: CardType; data: Record<string, unknown> } | null;
  let gif: { hash: string; size: number; mime: string; w: number; h: number } | null = null;
  if (b.type === 'gif') {
    if (!gifProvider()) return c.json({ error: 'gifs_off' }, 503);
    // Only the id comes from the device. The address and the bytes come from the provider, fetched by the server.
    if (!gifKnown(String(b.id ?? '')) && await limited(`gif-lookup:${a.user.id}`, 20, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
    const g = await gifById(String(b.id ?? ''));
    if (!g) return c.json({ error: 'not_found' }, 404);
    const buf = await gifProvider()!.download(g.full.url, GIF_MAX);
    const sn = buf ? sniff(buf) : null;
    if (!buf || sn?.family !== 'image' || !sn.inline) return c.json({ error: 'gif_unavailable' }, 502);
    const put = await blobs.put(buf);
    run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', put.hash, put.size);
    gif = { ...put, mime: sn.mime, w: g.full.w, h: g.full.h };
    card = { type: 'gif', data: { provider: 'giphy', title: g.title } };
  } else card = cleanCard(b);
  if (!card) return c.json({ error: 'invalid_card' }, 400);

  const sent = tx(() => {
    const m = insertMessage({ circleId: a.circleId, userId: a.user.id, kind: 'text', body: '', clientMsgId: cmid, replyTo });
    if (m.duplicate) return m;
    storeCard(m.id, card!.type, card!.data);
    if (gif) run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, name, width, height) VALUES (?, ?, ?, ?, 'image', ?, ?, 'giphy.gif', ?, ?)",
      a.circleId, m.id, a.user.id, gif.hash, gif.mime, gif.size, gif.w || null, gif.h || null);
    run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', m.seq, m.seq, a.circleId, a.user.id);
    return m;
  });
  if (!sent.duplicate) announce(a.circleId, sent.id);
  return c.json({ id: sent.id, seq: sent.seq }, sent.duplicate ? 200 : 201);
});

// ---- live location ---------------------------------------------------------------------------
// The card made above with type 'live' is the whole of it: the sender's device sends a new point now and then, the
// server overwrites the one card, and everyone's screen is told. Nothing is kept but the LATEST point — there is no
// trail of where someone has been, because a trail is a thing that can be stolen. It stops by itself at `until`,
// or the moment the sender says stop; after that no new point is accepted.
const liveCard = (mid: number, userId: number) => {
  const m = one('SELECT id, circle_id, user_id, deleted_at FROM messages WHERE id = ?', mid);
  if (!m || m.deleted_at || m.user_id !== userId || !membership(m.circle_id, userId)) return null;
  const row = one("SELECT data FROM message_cards WHERE message_id = ? AND type = 'live'", m.id);
  if (!row) return null;
  try { return { m, data: JSON.parse(row.data as string) as { until: string; ended: boolean } }; } catch { return null; }
};

app.put('/api/messages/:mid/live', async c => {
  const found = liveCard(Number(c.req.param('mid')), c.get('user').id);
  if (!found) return c.json({ error: 'not_found' }, 404);
  const { m, data } = found;
  if (data.ended || Date.parse(data.until) <= Date.now()) return c.json({ error: 'live_over' }, 409);
  const point = cleanPoint(await c.req.json().catch(() => ({})));
  if (!point) return c.json({ error: 'invalid_card' }, 400);
  storeCard(m.id, 'live', { ...data, ...point, at: new Date().toISOString() });
  announceUpdate(m.circle_id, m.id);
  return c.json({ ok: true });
});

app.post('/api/messages/:mid/live/stop', c => {
  const found = liveCard(Number(c.req.param('mid')), c.get('user').id);
  if (!found) return c.json({ error: 'not_found' }, 404);
  const { m, data } = found;
  if (!data.ended) {
    storeCard(m.id, 'live', { ...data, ended: true, until: new Date().toISOString() });
    announceUpdate(m.circle_id, m.id);
  }
  return c.json({ ok: true });
});
