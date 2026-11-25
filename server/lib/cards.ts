import { all, one, run, type Row } from '../db.ts';
import { findSticker } from '../../core/stickers.ts';
import { cachedPreview, cleanLink } from './linkpreview.ts';
import { isEncrypted } from './e2ee.ts';

// ---- cards: what makes an ordinary message a link preview, GIF, sticker, contact or location ----
// One envelope for all of them: the message is a normal message (ordered, synced, replied to, deleted like any other) and ONE row
// beside it says what it carries. The server never reads a message's text to build a card: the sender's device names it.

export type CardType = 'link' | 'gif' | 'sticker' | 'contact' | 'location' | 'live';
export type Card =
  | { type: 'link'; url: string; title: string; description: string; site: string; image: number | null }
  | { type: 'gif'; provider: string; title: string }
  | { type: 'sticker'; pack: string; id: string }
  | { type: 'contact'; name: string; phones: string[] }
  | { type: 'location'; lat: number; lng: number; accuracy: number | null; label: string | null }
  | { type: 'live'; lat: number; lng: number; accuracy: number | null; until: string; ended: boolean; at: string };

/** How long a live location may run for. */
export const LIVE_MINUTES = [15, 60, 480];

/** A point on the earth as given by a device, or null if it is not one. Six decimals is about 10 cm: more is noise, not accuracy. */
export function cleanPoint(b: Row): { lat: number; lng: number; accuracy: number | null } | null {
  const { lat, lng } = b;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const acc = typeof b.accuracy === 'number' && Number.isFinite(b.accuracy) && b.accuracy >= 0 ? Math.min(Math.round(b.accuracy), 1_000_000) : null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy: acc };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A contact, location or sticker as given by a client, cleaned; null if it does not make one. (A GIF and a link are made by the server from what it fetched itself.) */
export function cleanCard(b: Row): { type: CardType; data: Record<string, unknown> } | null {
  if (b.type === 'contact') {
    const name = text(b.name, 100);
    if (!name || !Array.isArray(b.phones) || b.phones.length < 1 || b.phones.length > 5) return null;
    const phones = b.phones.map(p => text(p, 40));
    if (phones.some(p => !/^\+?[\d\s().-]{3,30}$/.test(p) || p.replace(/\D/g, '').length < 3)) return null;
    return { type: 'contact', data: { name, phones } };
  }
  if (b.type === 'location') {
    const point = cleanPoint(b);
    return point ? { type: 'location', data: { ...point, label: text(b.label, 100) || null } } : null;
  }
  if (b.type === 'live') {
    // Live location: the same point as a plain location, plus the moment it stops. It never runs on and on —
    // the longest anyone can share is eight hours, and the sender can stop it at any time.
    const point = cleanPoint(b);
    if (!point) return null;
    const minutes = LIVE_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : 0;
    if (!minutes) return null;
    return { type: 'live', data: { ...point, until: new Date(Date.now() + minutes * 60_000).toISOString(), ended: false, at: new Date().toISOString() } };
  }
  if (b.type === 'sticker') {
    const s = findSticker(b.pack, b.id);
    return s ? { type: 'sticker', data: { pack: b.pack, id: s.id } } : null;
  }
  return null;
}
export const storeCard = (messageId: number, type: CardType, data: Record<string, unknown>) =>
  run('INSERT OR REPLACE INTO message_cards (message_id, type, data) VALUES (?, ?, ?)', messageId, type, JSON.stringify(data));

/** The cards of these messages, by message id. A link card's picture is a media row of the message (fetched with GET /api/media/:id). */
export function cardsOf(ids: number[]): Map<number, Card> {
  const out = new Map<number, Card>();
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  const rows = all(`SELECT message_id AS mid, type, data FROM message_cards WHERE message_id IN (${marks})`, ...ids);
  if (!rows.length) return out;
  const pics = new Map(all(`SELECT message_id AS mid, id FROM media WHERE kind = 'thumb' AND thumb_of IS NULL AND message_id IN (${marks})`, ...ids).map(r => [r.mid as number, r.id as number]));
  for (const r of rows) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(r.data as string); } catch { continue; }
    out.set(r.mid as number, { ...(data as object), type: r.type, ...(r.type === 'link' ? { image: pics.get(r.mid as number) ?? null } : {}) } as Card);
  }
  return out;
}
/** Which of these messages carry a card, and of what type (for a quoted reply, the chat list, a notification). */
export const cardTypeOf = (messageId: number): CardType | null => (one('SELECT type FROM message_cards WHERE message_id = ?', messageId)?.type as CardType | undefined) ?? null;

/**
 * The sender's device asked for a preview of this link a moment ago and now sends the message with it. The card is built from what the
 * SERVER fetched (never from fields the client sends), and only if the link really is in the text.
 */
export function attachLinkPreview(circleId: number, messageId: number, userId: number, body: string, raw: unknown): boolean {
  if (isEncrypted(circleId)) return false;   // the device puts the card inside the ciphertext; the server never attaches one
  const u = cleanLink(raw);
  if (!u || typeof raw !== 'string' || !body.includes(raw.trim())) return false;
  const p = cachedPreview(u);
  if (!p) return false;
  storeCard(messageId, 'link', { url: p.url, title: p.title, description: p.description, site: p.site });
  if (p.image) {
    const row = one('SELECT l.image_mime AS mime, b.size FROM link_previews l JOIN blobs b ON b.hash = l.image_hash WHERE l.url = ?', u.href);
    if (row) run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size) VALUES (?, ?, ?, ?, 'thumb', ?, ?)", circleId, messageId, userId, p.image, row.mime, row.size);
  }
  return true;
}
/** A message was edited: its link card goes if the link is no longer in the text. True if something was removed. */
export function pruneLinkCard(messageId: number, body: string): boolean {
  const c = one("SELECT data FROM message_cards WHERE message_id = ? AND type = 'link'", messageId);
  if (!c) return false;
  let url = ''; try { url = String(JSON.parse(c.data as string).url ?? ''); } catch { /* damaged: remove it */ }
  if (url && (body.includes(url) || body.includes(url.replace(/\/$/, '')))) return false;
  run('DELETE FROM message_cards WHERE message_id = ?', messageId);
  run("DELETE FROM media WHERE message_id = ? AND kind = 'thumb' AND thumb_of IS NULL", messageId);
  return true;
}
