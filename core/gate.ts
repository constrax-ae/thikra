// The AI gate: decides which messages may reach any AI layer, and which consumer they are for.
// It never affects delivery or storage. Dropped messages are ordinary chat. Everything here is
// cheap and structural; scoring and understanding live behind the gate (agent.ts and later layers).

import { normalize, hasSignal } from './agent.ts';

/** Consumers a message can be routed to. */
export type Route = 'archive' | 'reply' | 'schedule';

export type DropReason = 'no_text' | 'link_only' | 'chain_message' | 'repeated' | 'no_signal';

export interface GateResult {
  pass: boolean;
  routes: Route[];
  reason: DropReason | 'sensitive' | 'signal';
}

export interface GateContext {
  /** Normalised texts of the most recent messages in the same conversation. */
  recent?: string[];
}

// Mass-forwarded greetings and supplications: the biggest noise in family groups.
// Data, not logic, so the list can be tuned without touching the rules below.
const CHAIN_PHRASES = [
  'جمعة مباركة', 'جمعة طيبة', 'صباح الخير', 'مساء الخير', 'صباح النور', 'مساء النور',
  'تصبحون على خير', 'تصبح على خير', 'سبحان الله وبحمده', 'سبحان الله العظيم', 'لا إله إلا الله',
  'أستغفر الله', 'اللهم صل وسلم على نبينا محمد', 'لا حول ولا قوة إلا بالله', 'عيد مبارك',
  'كل عام وأنتم بخير', 'رمضان كريم', 'تقبل الله طاعاتكم', 'good morning', 'good night',
].map(normalize);

// Death and illness must never be filtered out, even inside a forwarded template.
const SENSITIVE = ['passing', 'health'] as const;

const URL_RE = /(https?:\/\/|www\.)\S+/g;
const letters = (s: string) => s.replace(/[^\p{L}]/gu, '');

const QUESTION_RE = /[?؟]|^(وين|متي|كيف|ليش|شو|ايش|هل|كم|وش)\b|(ممكن|تقدر|ابغاك|ابغي|ابي|لو سمحت|عطني|ارسل)/;
const SCHEDULE_RE = /(\d{1,2}[:.]\d{2}|\d{1,2}\/\d{1,2}|الساعه|بكره|بكرا|غدا|الليله|الاسبوع|يوم (الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت)|موعد|اجتماع|ذكرني|تذكير)/;

export function gate(rawText: string, ctx: GateContext = {}): GateResult {
  const drop = (reason: DropReason): GateResult => ({ pass: false, routes: [], reason });
  const text = normalize(rawText);

  if (letters(text).length < 3) return drop('no_text');
  if (letters(text.replace(URL_RE, '')).length < 3) return drop('link_only');

  if (hasSignal(rawText, [...SENSITIVE])) return { pass: true, routes: ['archive'], reason: 'sensitive' };

  let rest = text;
  for (const p of CHAIN_PHRASES) rest = rest.split(p).join(' ');
  if (letters(rest).length < 8) return drop('chain_message');

  if ((ctx.recent ?? []).filter(t => t === text).length >= 2) return drop('repeated');

  const routes: Route[] = [];
  if (hasSignal(rawText)) routes.push('archive');
  if (QUESTION_RE.test(text)) routes.push('reply');
  if (SCHEDULE_RE.test(text)) routes.push('schedule');

  return routes.length ? { pass: true, routes, reason: 'signal' } : drop('no_signal');
}
