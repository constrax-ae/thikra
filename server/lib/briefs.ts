import { all, one, run } from '../db.ts';
import { pushToUser } from '../push.ts';
import { textLang } from './lang.ts';
import { digest, type Item } from './opsagent.ts';

// The agent writes to the owner without being asked: a morning and an evening summary kept in the Assistant tab, and a push only when something new and serious appears.
const HOURS_UTC: Record<'morning' | 'evening', number> = { morning: 5, evening: 16 };   // 09:00 and 20:00 in the Gulf
const today = () => new Date().toISOString().slice(0, 10);

function store(kind: 'morning' | 'evening' | 'alert' | 'manual', items: Item[], pushed: number) {
  const id = Number(run('INSERT INTO agent_briefs (kind, items, pushed) VALUES (?, ?, ?)', kind, JSON.stringify(items), pushed).lastInsertRowid);
  run('DELETE FROM agent_briefs WHERE id <= (SELECT MAX(id) FROM agent_briefs) - 60');
  return id;
}
export interface Brief { id: number; at: string; kind: string; items: Item[]; pushed: number }
export const listBriefs = (limit = 14): Brief[] => all('SELECT id, at, kind, items, pushed FROM agent_briefs ORDER BY id DESC LIMIT ?', limit).map(r => ({ id: r.id, at: r.at, kind: r.kind, pushed: r.pushed, items: JSON.parse(r.items) as Item[] }));

/** Write a summary now (the owner pressed the button, or it is time). */
export async function makeBrief(kind: 'morning' | 'evening' | 'manual'): Promise<number> {
  const d = await digest();
  return store(kind, d.items, 0);
}

/** Tell every owner, on every device, about new serious items: in their language, short, opening the admin screen. */
async function pushOwners(items: Item[]): Promise<number> {
  let sent = 0;
  for (const o of all("SELECT id, lang FROM users WHERE admin_role = 'owner' AND suspended_at IS NULL")) {
    const body = items.slice(0, 3).map(i => (textLang(o.lang) === 'en' ? i.en : i.ar)).join(' · ');
    sent += await pushToUser(o.id, { title: textLang(o.lang) === 'en' ? 'Thekra: needs you' : 'ذكرى: يحتاج قرارك', body, circle: 0, tag: 'agent-alert', url: '/#/admin' }).catch(() => 0);
  }
  return sent;
}

/**
 * Run every 30 minutes. Writes the morning and evening summaries (once each per day, after their hour), and checks for NEW serious items: a push goes out only for a code
 * that was not already in the previous alert, and at most once an hour, so a problem that stays does not nag.
 */
export async function briefTick(now = new Date()): Promise<{ made: string[]; pushed: number }> {
  const made: string[] = [];
  const d = await digest();
  for (const kind of ['morning', 'evening'] as const) {
    if (now.getUTCHours() >= HOURS_UTC[kind] && !one("SELECT 1 FROM agent_briefs WHERE kind = ? AND date(at) = ?", kind, today())) { store(kind, d.items, 0); made.push(kind); }
  }
  const high = d.items.filter(i => i.sev === 'high');
  const lastAlert = one("SELECT items, at FROM agent_briefs WHERE kind = 'alert' ORDER BY id DESC LIMIT 1");
  const known = new Set<string>(lastAlert ? (JSON.parse(lastAlert.items) as Item[]).map(i => i.code) : []);
  const fresh = high.filter(i => !known.has(i.code));
  const recently = !!one("SELECT 1 FROM agent_briefs WHERE kind = 'alert' AND items != '[]' AND at > datetime('now', '-1 hour')");
  let pushed = 0;
  if (fresh.length && !recently) { pushed = await pushOwners(fresh); store('alert', high, pushed > 0 ? 1 : 0); made.push('alert'); }
  else if (!high.length && lastAlert && known.size) store('alert', [], 0);   // it is calm again: the next serious item counts as new
  return { made, pushed };
}
