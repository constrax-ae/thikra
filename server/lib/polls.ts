import { all, one, run, type Row } from '../db.ts';

// ---- mentions and polls: what hangs off a message --------------------------------------------

export const MAX_MENTIONS = 20;
/** Who a new message mentions: members of that chat only, never the sender, each once, at most MAX_MENTIONS. Anything else in the list is dropped. */
export function storeMentions(circleId: number, messageId: number, senderId: number, raw: unknown) {
  if (!Array.isArray(raw)) return;
  const ids = [...new Set(raw.filter((x): x is number => Number.isInteger(x) && x > 0 && x !== senderId))].slice(0, 200);
  let kept = 0;
  for (const id of ids) {
    if (kept >= MAX_MENTIONS) break;
    if (!one('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?', circleId, id)) continue;
    run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)', messageId, id);
    kept++;
  }
}
/** The mentions of these messages, by message id. */
export function mentionsOf(ids: number[]): Map<number, Array<{ id: number; name: string }>> {
  const out = new Map<number, Array<{ id: number; name: string }>>();
  if (!ids.length) return out;
  for (const r of all(`SELECT mm.message_id AS mid, u.id, u.name FROM message_mentions mm JOIN users u ON u.id = mm.user_id WHERE mm.message_id IN (${ids.map(() => '?').join(',')}) ORDER BY u.id`, ...ids)) {
    const list = out.get(r.mid as number) ?? [];
    list.push({ id: r.id as number, name: r.name as string });
    out.set(r.mid as number, list);
  }
  return out;
}

export const POLL_MAX_OPTIONS = 12;
export interface PollView { multiple: boolean; closed: boolean; voters: number; options: Array<{ id: number; text: string; voters: number[] }>;
  /** The voters' names by id: someone who has since left the group is still shown by name. */
  names: Record<number, string> }
/** The polls of these messages, by message id: options in order, and who voted for each (visible to members, as in WhatsApp). */
export function pollsOf(ids: number[]): Map<number, PollView> {
  const out = new Map<number, PollView>();
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  for (const p of all(`SELECT message_id AS mid, multiple, closed_at FROM polls WHERE message_id IN (${marks})`, ...ids)) out.set(p.mid as number, { multiple: !!p.multiple, closed: !!p.closed_at, voters: 0, options: [], names: {} });
  if (!out.size) return out;
  const byOption = new Map<number, number[]>();
  const people = new Map<number, Set<number>>();
  for (const v of all(`SELECT v.option_id AS oid, v.user_id AS uid, v.message_id AS mid, u.name FROM poll_votes v JOIN users u ON u.id = v.user_id WHERE v.message_id IN (${marks}) ORDER BY v.created_at, v.user_id`, ...ids)) {
    const view = out.get(v.mid as number); if (view) view.names[v.uid as number] = v.name as string;
    (byOption.get(v.oid as number) ?? byOption.set(v.oid as number, []).get(v.oid as number)!).push(v.uid as number);
    (people.get(v.mid as number) ?? people.set(v.mid as number, new Set()).get(v.mid as number)!).add(v.uid as number);
  }
  for (const o of all(`SELECT id, message_id AS mid, text FROM poll_options WHERE message_id IN (${marks}) ORDER BY message_id, pos`, ...ids)) {
    out.get(o.mid as number)?.options.push({ id: o.id as number, text: o.text as string, voters: byOption.get(o.id as number) ?? [] });
  }
  for (const [mid, p] of out) p.voters = people.get(mid)?.size ?? 0;
  return out;
}
/** A poll's question and options as given by a client, cleaned; null if they do not make a poll. */
export function cleanPoll(b: Row): { question: string; options: string[]; multiple: boolean } | null {
  const question = String(b.question ?? '').trim().slice(0, 300);
  if (!question || !Array.isArray(b.options)) return null;
  const options = b.options.filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, 100)).filter(Boolean);
  if (options.length !== b.options.length) return null;                 // an empty or non-text option is a mistake, not something to drop silently
  if (options.length < 2 || options.length > POLL_MAX_OPTIONS || new Set(options).size !== options.length) return null;
  return { question, options, multiple: b.multiple === true };
}
/** A message was edited: a mention whose "@Name" is no longer in the text is dropped (the highlight and the badge go with it). */
export function pruneMentions(messageId: number, body: string) {
  for (const m of all('SELECT mm.user_id AS id, u.name FROM message_mentions mm JOIN users u ON u.id = mm.user_id WHERE mm.message_id = ?', messageId)) {
    if (!body.includes(`@${m.name}`)) run('DELETE FROM message_mentions WHERE message_id = ? AND user_id = ?', messageId, m.id);
  }
}
/** A message changed in a way its own columns do not show (a vote): move its revision, so devices that sync by revision fetch it again. */
export const bumpRev = (messageId: number) =>
  run('UPDATE messages SET rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM messages m WHERE m.circle_id = messages.circle_id) WHERE id = ?', messageId);
