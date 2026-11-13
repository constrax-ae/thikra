// Turns an imported chat history into a DRAFT of archive events. Nothing is saved here: the person
import { excerpt } from './excerpt.ts';
// importing reviews the draft and only what they tick goes to the circle.
//
// Deliberately left out of an import: conflicts. Old quarrels are not brought back to life.

import { assess, normalize, type Category, type Sensitivity } from './agent.ts';
import { gate } from './gate.ts';
import type { ImportedMessage } from './whatsapp.ts';

export interface DraftEvent {
  date: string;
  title: string;
  summary: string;
  category: Category | null;
  score: number;
  /** Other messages about the same event close in time (congratulations and the like). */
  reactions: number;
}

export interface Draft {
  events: DraftEvent[];
  stats: { messages: number; texts: number; media: number; gatedOut: number; candidates: number; events: number };
}

const DAY = 24 * 3600_000;

export function buildDraft(messages: ImportedMessage[], sensitivity: Sensitivity = 'medium'): Draft {
  const recent: string[] = [];
  const candidates: Array<{ ts: number; date: string; sender: string; text: string; category: Category | null; score: number }> = [];
  let texts = 0, media = 0, gatedOut = 0;

  for (const m of messages) {
    if (m.kind === 'media' || m.kind === 'voice') { media++; continue; }
    if (m.kind !== 'text') continue;
    texts++;

    const g = gate(m.text, { recent: recent.slice(-30) });
    recent.push(normalize(m.text));
    if (!g.pass || !g.routes.includes('archive')) { gatedOut++; continue; }

    const r = assess(m.text, sensitivity);
    if (r.verdict === 'archived') candidates.push({ ts: m.ts, date: m.date, sender: m.sender, text: m.text, category: r.category, score: r.score });
  }

  // Merge: messages of the same category within a day of the first one describe one event.
  const events: DraftEvent[] = [];
  const open = new Map<Category | null, { start: number; best: (typeof candidates)[number]; n: number }>();
  const flush = (key: Category | null) => {
    const g = open.get(key);
    if (!g) return;
    open.delete(key);
    events.push({
      date: g.best.date,
      title: excerpt(g.best.text, 60),
      summary: `${g.best.sender}: ${excerpt(g.best.text, 400)}`,
      category: g.best.category,
      score: g.best.score,
      reactions: g.n - 1,
    });
  };

  for (const c of candidates) {
    const g = open.get(c.category);
    if (g && c.ts - g.start <= DAY) {
      g.n++;
      if (c.score > g.best.score) g.best = c;
    } else {
      flush(c.category);
      open.set(c.category, { start: c.ts, best: c, n: 1 });
    }
  }
  [...open.keys()].forEach(flush);

  events.sort((a, b) => a.date.localeCompare(b.date));
  return { events, stats: { messages: messages.length, texts, media, gatedOut, candidates: candidates.length, events: events.length } };
}
