// How the agent concludes that someone has died, or that an occasion has happened, from what the family writes in the circle.
// Pure text rules (no network, no model): deliberately conservative, because a wrong conclusion opens a letter nobody was ready for.
// A single message is never enough: the server counts messages from several members over time (server/index.ts, sealed evidence).

import { normalize } from './agent.ts';

/** More than three messages ("اكثر من ثلاث رسائل"), from at least three members, or two if the circle has exactly three others. */
export const MIN_MESSAGES = 4;
export function requiredMembers(others: number): number {
  if (others >= 4) return 3;
  if (others === 3) return 2;
  return Math.max(1, others); // tiny circles: every other member (a lone survivor still counts, since nobody else exists to ask)
}

const tokens = (text: string) => normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const bare = (t: string) => t.replace(/^ال/, '');
/** A token as written and without a one-letter Arabic prefix (ل، ب، و، ف، ك: "لخالد" is "خالد"), so names and words are still found. */
const variants = (t: string) => { const v = [t, bare(t)]; if (t.length > 3 && /^[لبوفك]/.test(t)) { v.push(t.slice(1), bare(t.slice(1))); } return v; };

// Words that make a mention about a RELATIVE of the person, not the person ("والد ناصر توفي" is not "ناصر توفي").
const KIN = new Set(['والد', 'والدة', 'ابو', 'ام', 'اب', 'جد', 'جدة', 'عم', 'عمة', 'خال', 'خالة', 'زوج', 'زوجة', 'ابن', 'بنت', 'اخو', 'اخت', 'اخ', 'حفيد', 'حفيدة', 'father', 'mother', 'dad', 'mom', 'wife', 'husband', 'son', 'daughter', 'brother', 'sister', 'grandfather', 'grandmother', 'uncle', 'aunt', "father's", "mother's"].map(normalize));

const DEATH_CUES = [
  'توفي', 'توفيت', 'وفاه', 'وفاته', 'وفاتها', 'انتقل الي رحمه الله', 'انتقلت الي رحمه الله', 'رحمه الله', 'رحمها الله', 'الله يرحمه', 'الله يرحمها', 'الله يرحمك', 'الله يرحم', 'رحم الله', 'يرحمه الله', 'يرحمها الله', 'غفر الله له', 'غفر الله لها',
  'البقاء لله', 'انا لله وانا اليه راجعون', 'عظم الله اجركم', 'اعظم الله اجركم', 'مات', 'ماتت', 'فارقنا', 'فارقتنا', 'رحل عنا', 'رحلت عنا', 'تغمده الله', 'تغمدها الله',
  'passed away', 'has passed', 'died', 'rest in peace', 'condolences', 'my condolences', ' rip ', 'passed on',
].map(normalize);
const NOT_DEATH = [
  'لم يتوف', 'لم تتوف', 'ما توفي', 'ما توفيت', 'لا سمح الله', 'حفظه الله', 'حفظها الله', 'اطال الله عمره', 'اطال الله عمرها', 'اشاعه', 'يشاع', 'كذب', 'غير صحيح', 'مو صحيح', 'ليس صحيح', 'لم يمت', 'ما مات', 'بخير والحمد لله',
  'not dead', 'rumor', 'rumour', 'fake news', 'is alive', 'not true', 'hope', 'god forbid', 'if he dies', 'when he dies',
].map(normalize);

const mentionsName = (toks: string[], nameToks: string[]): number[] => {
  const hits: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (variants(toks[i]).includes(nameToks[0])) {
      // every following name part must follow directly (full name), or the name is a single token
      if (nameToks.slice(1).every((n, k) => variants(toks[i + 1 + k] ?? '').includes(n))) hits.push(i);
    }
  }
  return hits;
};

/** The name forms to look for: the full name, and the first name when it is distinctive (3+ letters). */
export function nameForms(names: string[]): string[][] {
  const out: string[][] = [];
  for (const n of names) {
    const t = tokens(n).map(bare).filter(x => x.length >= 2);
    if (t.length) out.push(t);
    if (t.length > 1 && t[0].length >= 3) out.push([t[0]]);
  }
  return out;
}

/** Does this message say that the person (one of `names`) has died? A mention of the name next to a death phrase, not about a relative, not negated or doubtful. */
export function mentionsDeath(text: string, names: string[]): boolean {
  const norm = ` ${normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  if (!DEATH_CUES.some(c => norm.includes(` ${c.trim()} `) || norm.includes(c.trim()))) return false;
  if (NOT_DEATH.some(c => norm.includes(c.trim()))) return false;
  const toks = tokens(text);
  for (const form of nameForms(names)) {
    for (const i of mentionsName(toks, form)) {
      const before = toks[i - 1] ?? '', before2 = toks[i - 2] ?? '';
      if (KIN.has(before) || KIN.has(before2) && before.length <= 2) continue;   // "والد ناصر", "ام محمد"
      return true;
    }
  }
  return false;
}

const STOP = new Set(['في', 'من', 'على', 'عن', 'الي', 'يوم', 'عند', 'بعد', 'قبل', 'the', 'of', 'a', 'an', 'at', 'on', 'my', 'our', 'his', 'her', 'for', 'to', 'and', 'و'].map(normalize));
const HAPPENED = ['مبروك', 'تبارك', 'التهاني', 'تهانينا', 'الف مبروك', 'تم ', 'صار', 'حصل', 'رزق', 'اتم', 'تزوج', 'تخرج', 'اتخرج', 'نجح', 'ولد', 'ولدت', 'congrat', 'congratulations', 'it happened', 'just got', 'finally', 'got married', 'graduated', 'was born'].map(normalize);
const FUTURE = ['قريبا', 'سيكون', 'سوف', 'غدا', 'بكره', 'موعد', 'عقبال', 'ان شاء الله يتم', 'ان شاءالله', 'will ', 'upcoming', 'next ', 'soon', 'inshallah', 'planning', 'hope'].map(normalize);

/** Does this message say that the occasion (e.g. "زواج خالد") has happened? Every meaningful word of the occasion, plus a "it happened / congratulations" cue, and not a future-tense wish. */
export function mentionsOccurrence(text: string, occasion: string): boolean {
  const need = tokens(occasion).filter(t => !STOP.has(t)).map(bare).filter(t => t.length >= 3);
  if (!need.length) return false;
  const norm = ` ${normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  if (FUTURE.some(c => norm.includes(c.trim()))) return false;
  if (!HAPPENED.some(c => norm.includes(c.trim()))) return false;
  const toks = tokens(text);
  return need.every(n => toks.some(raw => variants(raw).some(t => t.startsWith(n) || (t.length >= 3 && n.startsWith(t)))));
}
