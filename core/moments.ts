// Conversation-level detection: "moments" (funny stories, heated debates, conflicts).
// Works on counts and simple markers only, with no text understanding, so it is cheap and
// could run on the device. A language model can later write the real story on top of it.

import { normalize } from './agent.ts';

export interface WindowMessage { userId: number; text: string }
export type MomentKind = 'funny' | 'debate' | 'conflict';
export interface Moment { kind: MomentKind; parties: number[]; anonymous: boolean; reason: string }
export interface DetectOptions {
  members: number;
  /** Typical number of messages per 15 minutes in this circle. */
  baselinePer15: number;
}

const LAUGH = [
  'ههه', '😂', '🤣', '😹', 'ضحكتني', 'مت ضحك', 'مت من الضحك', 'اموت من الضحك', 'lol', 'haha',
].map(normalize);

const TENSION = [
  'كذاب', 'وقح', 'ما احترمك', 'ما يهمني', 'اسكت', 'طفشتني', 'زهقت منك', 'اطلع من القروب', 'بلوك',
  'ما اكلمك', 'حرام عليك', 'غلطان', 'ما تفهم', 'قله ادب', 'تافه', 'ما اطيقك', 'ابعد عني', 'لا تكلمني',
].map(normalize);

const RECONCILE = [
  'سامحني', 'سامحتك', 'مسامح', 'تصافينا', 'تصالحنا', 'صلح', 'ما عليك', 'الله يسامحك', 'حقك علي',
  'عفا الله', 'نسيناها', 'انسى الموضوع', 'تعال نتصالح',
].map(normalize);

// Topics we never document by name (money, divorce, politics, sect). Matched as whole words.
const SENSITIVE = new Set(
  ['طلاق', 'الطلاق', 'سياسه', 'السياسه', 'انتخابات', 'حزب', 'مذهب', 'سني', 'شيعي', 'ميراث', 'الميراث', 'قرض', 'القرض', 'ديون', 'دين', 'الدين'],
);

const letters = (s: string) => s.replace(/[^\p{L}]/gu, '').length;
const tokens = (s: string) => s.split(/[^\p{L}]+/u).filter(Boolean);
const laughs = (t: string) => LAUGH.some(w => t.includes(w));

export function isReconciliation(text: string): boolean {
  const t = normalize(text);
  return RECONCILE.some(w => t.includes(w));
}

export function detectMoment(win: WindowMessage[], opts: DetectOptions): Moment | null {
  // Unusual activity: more messages in the window than this circle normally produces.
  if (win.length < Math.max(6, Math.ceil(opts.baselinePer15 * 2.5))) return null;

  const msgs = win.map(m => ({ userId: m.userId, text: normalize(m.text) }));

  const laughers = new Set(msgs.filter(m => laughs(m.text)).map(m => m.userId));
  if (laughers.size >= Math.max(3, Math.ceil(opts.members * 0.4))) {
    return { kind: 'funny', parties: [...laughers], anonymous: false, reason: `${laughers.size} members laughed within the window` };
  }

  const counts = new Map<number, number>();
  for (const m of msgs) counts.set(m.userId, (counts.get(m.userId) ?? 0) + 1);
  if (counts.size < 2 || counts.size > 4) return null;

  const parties = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
  const mine = msgs.filter(m => parties.includes(m.userId));
  if (mine.length / msgs.length < 0.75) return null; // two people must dominate
  if (mine.reduce((s, m) => s + letters(m.text), 0) / mine.length < 40) return null; // and write at length

  const sensitive = msgs.some(m => tokens(m.text).some(t => SENSITIVE.has(t)));
  const tense = mine.filter(m => !laughs(m.text) && (TENSION.some(w => m.text.includes(w)) || /[!؟?]{2,}/.test(m.text))).length;

  if (tense >= 3) return { kind: 'conflict', parties, anonymous: sensitive, reason: `${tense} tense messages between the two main speakers` };
  if (sensitive) return null; // a heated talk on a sensitive topic is never archived
  return { kind: 'debate', parties, anonymous: false, reason: 'long back-and-forth between two members' };
}

// ---- wording ------------------------------------------------------------------------

export type ConflictStage = 'open' | 'resolved' | 'faded';

const join = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join('، ')} و${names[names.length - 1]}`;

/** Conflicts are only hinted at: names and mood, no cause, no quote, no blame. */
export function momentText(kind: MomentKind, names: string[], anonymous: boolean, stage: ConflictStage = 'open') {
  if (kind === 'funny') {
    const who = names.length > 5 ? `${names.slice(0, 5).join('، ')} وآخرون` : join(names);
    return { title: 'لحظة ضحك جماعية', text: `لحظة ضحك جماعية في القروب، شارك فيها ${who}.` };
  }
  if (kind === 'debate') {
    return { title: 'نقاش حامٍ', text: `نقاش حامٍ بين ${join(names)} في القروب.` };
  }
  const who = anonymous || names.length < 2 ? 'أفراد من العائلة' : join(names);
  const base = `حدث خلاف بين ${who}، وكان الجو متوتراً في القروب`;
  if (stage === 'resolved') return { title: 'خلاف ثم صلح', text: `${base}، ثم عادت المياه إلى مجاريها والحمد لله.` };
  if (stage === 'faded') return { title: 'خلاف وتعدّى', text: `${base}، ثم تعدّت المشكلة والحمد لله.` };
  return { title: 'خلاف', text: `${base}. نتمنى أن ينتهي وتعود المحبة.` };
}
