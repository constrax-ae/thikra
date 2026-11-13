import { createHash } from 'node:crypto';
import { excerpt } from '../../core/excerpt.ts';
import { all, one, run, type Row } from '../db.ts';
import { archiveFor } from './archive.ts';
import { eventMedia } from './albums.ts';
import { flag } from './ops.ts';
import { callModel, configured as aiConfigured, jsonFromText } from './ai.ts';

// The family's year as a STORY: chapters, each narrated. Two writers behind one interface:
//  - the built-in rules: free, instant, always available, and honest about what they are (a warm draft built from the family's own words);
//  - a language model, when the owner configures one (Anthropic or OpenAI, see server/lib/ai.ts): real literary prose, written
//    ONLY from the documented facts.
// A model's chapter is stored (cost is paid once, and a person may edit it); the rules' chapters are made again on every read.

export type Lang = 'ar' | 'en';
export type Tone = 'joy' | 'grave' | 'plain';
export interface StoryEvent { id: number; title: string; summary: string; category: string | null; kind: string; date: string; tone: Tone; photos: Array<{ id: number }> }
export interface ChapterFacts { idx: number; from: string; to: string; events: StoryEvent[] }
export interface Chapter { idx: number; title: string; paragraphs: string[]; source: 'rules' | 'model' | 'edited'; photoStrip: number[]; albumStrip: number[] }

const GRAVE = new Set(['passing', 'death', 'health']);
const toneOf = (category: string | null, kind: string): Tone => (kind === 'funny' ? 'joy' : GRAVE.has(category ?? '') ? 'grave' : ['birth', 'marriage', 'graduation', 'achievement', 'travel'].includes(category ?? '') ? 'joy' : 'plain');

/** The year's documented events (never conflicts, only what every member may see) grouped into up to four chapters by quarter. */
export function collect(circleId: number, year: number): ChapterFacts[] {
  const events = archiveFor(circleId, 'member', -1).filter(e => e.kind !== 'conflict' && String(e.eventDate).startsWith(String(year)));
  const media = eventMedia(circleId, events.map(e => ({ id: e.id, eventDate: e.eventDate })), 3);
  const list: StoryEvent[] = events.map(e => ({
    id: e.id, title: String(e.title), summary: String(e.summary ?? ''), category: e.category ?? null, kind: e.kind, date: String(e.eventDate), tone: toneOf(e.category ?? null, e.kind),
    photos: (media.get(e.id) ?? []).filter(m => m.kind === 'image').map(m => ({ id: m.id })),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const quarters: StoryEvent[][] = [[], [], [], []];
  for (const e of list) quarters[Math.min(3, Math.floor((Number(e.date.slice(5, 7)) - 1) / 3))].push(e);
  const nonEmpty = quarters.map((events, q) => ({ q, events })).filter(x => x.events.length);
  // very few events make one chapter, not four slivers
  const groups = list.length <= 3 && list.length > 0 ? [{ q: nonEmpty[0].q, events: list }] : nonEmpty;
  return groups.map((g, i) => ({
    idx: i + 1,
    from: g.events[0].date, to: g.events[g.events.length - 1].date,
    events: g.events,
  }));
}
export const hashFacts = (f: ChapterFacts) => createHash('sha256').update(JSON.stringify(f.events.map(e => [e.id, e.title, e.summary, e.date, e.category, e.kind]))).digest('hex').slice(0, 24);

// ---- the rules' voice --------------------------------------------------------------------------------------------------
const dayLabel = (date: string, lang: Lang) => new Date(`${date}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar' : 'en', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const ORD_AR = ['الأول', 'الثاني', 'الثالث', 'الرابع'];
const ORD_EN = ['One', 'Two', 'Three', 'Four'];
const monthName = (date: string, lang: Lang) => new Date(`${date}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar' : 'en', { month: 'long', timeZone: 'UTC' });

const OPEN: Record<Lang, Record<string, string[]>> = {
  ar: {
    birth: ['وفي {d} جاءت البشرى: {t}.', 'وأضاءت الدارَ فرحةٌ جديدة في {d}: {t}.', 'وفي {d} حلّ في العائلة ضيفٌ عزيز: {t}.'],
    marriage: ['وفي {d} اجتمع الأحبّة على فرحٍ كبير: {t}.', 'وكان {d} موعداً مع الزغاريد والدعوات الطيبة: {t}.', 'وفي {d} ارتفع صوت الفرح في البيت: {t}.'],
    graduation: ['وفي {d} جاء ثمرُ التعب والسهر: {t}.', 'وكتب {d} سطراً من فخرٍ في سجلّ العائلة: {t}.'],
    achievement: ['وفي {d} جاء ثمرُ التعب والسهر: {t}.', 'وكتب {d} سطراً من فخرٍ في سجلّ العائلة: {t}.'],
    travel: ['وفي {d} حملت الحقائبُ أحلامَها: {t}.', 'ومن {d} بدأت رحلةٌ تستحق أن تُروى: {t}.'],
    health: ['وفي {d} مرّت العائلة بوقتٍ يحتاج إلى الدعاء والسند: {t}.', 'وفي {d} أثقلَ القلوبَ خبرٌ يخصّ الصحة: {t}.'],
    passing: ['وفي {d} طوت العائلة صفحةً موجعة: {t}. رحمه الله وأسكنه فسيح جناته.', 'وفي {d} ودّعنا من نحب: {t}. رحمه الله وجمعنا به في جنّات النعيم.'],
    death: ['وفي {d} طوت العائلة صفحةً موجعة: {t}. رحمه الله وأسكنه فسيح جناته.'],
    funny: ['وفي {d} ضحكت الدار حتى دمعت العيون: {t}.', 'وفي {d} حدثت واحدة من تلك المواقف التي لن تُنسى ما دامت العائلة تتذكر: {t}.'],
    plain: ['وفي {d} جاء خبرٌ يخصّنا جميعاً: {t}.', 'وسجّلت الذاكرة في {d}: {t}.', 'وفي {d} تجدّد الحديث بيننا عن: {t}.'],
  },
  en: {
    birth: ['On {d}, the good news came: {t}.', 'On {d}, a new joy lit up the house: {t}.'],
    marriage: ['On {d}, the family gathered for a big celebration: {t}.', '{d} was a day of laughter and good wishes: {t}.'],
    graduation: ['On {d}, the long nights paid off: {t}.', '{d} added a line of pride to the family record: {t}.'],
    achievement: ['On {d}, the long nights paid off: {t}.', '{d} added a line of pride to the family record: {t}.'],
    travel: ['On {d}, the suitcases carried their dreams: {t}.', 'From {d}, a journey worth telling began: {t}.'],
    health: ['On {d}, the family went through a time that called for prayers and support: {t}.'],
    passing: ['On {d}, the family closed a painful page: {t}. May they rest in peace.', 'On {d}, we said goodbye to someone we love: {t}. May they rest in peace.'],
    death: ['On {d}, the family closed a painful page: {t}. May they rest in peace.'],
    funny: ['On {d}, the house laughed until the tears came: {t}.', 'On {d} came one of those moments the family will keep retelling: {t}.'],
    plain: ['On {d}, news came that touched us all: {t}.', 'On {d}, memory recorded: {t}.'],
  },
};
const GAP: Record<Lang, Array<[number, string]>> = {
  ar: [[0, 'وفي اليوم نفسه،'], [1, 'وفي اليوم التالي،'], [7, 'وبعد أيامٍ قليلة،'], [31, 'ولم يمضِ شهرٌ حتى تتابعت الأحداث.'], [90, 'ومرّت أسابيع هادئة، ثم'], [Infinity, 'وانقضت شهورٌ بين صفحات الأيام، حتى']],
  en: [[0, 'That same day,'], [1, 'The next day,'], [7, 'A few days later,'], [31, 'Barely a month passed before more followed.'], [90, 'Quiet weeks went by, and then'], [Infinity, 'Months turned over in the pages of the year, until']],
};
const SHIFT: Record<Lang, { toJoy: string; toGrave: string }> = {
  ar: { toJoy: 'وكأن الأيام أرادت أن تواسي القلوب.', toGrave: 'لكن الدنيا لا تصفو دائماً.' },
  en: { toJoy: 'As if the days meant to console our hearts.', toGrave: 'But life is never only bright.' },
};
const CLOSE: Record<Lang, Record<Tone, string>> = {
  ar: { joy: 'وهكذا أغلق هذا الفصل صفحاته على دفءٍ نحمله معنا.', grave: 'وبين الحزن والرجاء، بقي الأحبّة يداً في يد.', plain: 'وبقيت العائلة كما هي: قلوباً تتقاسم الأيام.' },
  en: { joy: 'And so this chapter closed on a warmth we carry with us.', grave: 'Between sorrow and hope, the family stayed hand in hand.', plain: 'And the family stayed as it is: hearts that share their days.' },
};

/** The built-in narrator: a warm, honest draft made only from the family's own words, with the right tone for each kind of event and bridges between them. */
export function narrateByRules(f: ChapterFacts, lang: Lang): { title: string; paragraphs: string[] } {
  const ord = (lang === 'ar' ? ORD_AR : ORD_EN)[f.idx - 1] ?? String(f.idx);
  const a = monthName(f.from, lang), b = monthName(f.to, lang);
  const title = lang === 'ar' ? `الفصل ${ord}: ${a === b ? a : `من ${a} إلى ${b}`}` : `Chapter ${ord}: ${a === b ? a : `${a} to ${b}`}`;
  const paragraphs: string[] = [];
  let prev: StoryEvent | null = null;
  f.events.forEach((e, i) => {
    const key = e.kind === 'funny' ? 'funny' : e.category && OPEN[lang][e.category] ? e.category : 'plain';
    const opens = OPEN[lang][key];
    const open = opens[(e.id + i) % opens.length].replace('{d}', dayLabel(e.date, lang)).replace('{t}', e.title);
    const parts: string[] = [];
    if (prev) {
      const gap = (Date.parse(e.date) - Date.parse(prev.date)) / 86400_000;
      const bridge = GAP[lang].find(([max]) => gap <= max)![1];
      if (bridge.endsWith('.')) parts.push(bridge);
      if (prev.tone === 'grave' && e.tone === 'joy') parts.push(SHIFT[lang].toJoy);
      if (prev.tone === 'joy' && e.tone === 'grave') parts.push(SHIFT[lang].toGrave);
      parts.push(bridge.endsWith('.') ? open : `${bridge} ${open.replace(/^(وفي|On) /, lang === 'ar' ? 'في ' : 'on ')}`);
    } else parts.push(open);
    if (e.summary && e.summary.trim() !== e.title.trim()) parts.push(lang === 'ar' ? `وكما رُوي في الدفتر: «${e.summary.trim()}»` : `As the record says: “${e.summary.trim()}”`);
    paragraphs.push(parts.join(' '));
    prev = e;
  });
  const tones = f.events.map(e => e.tone);
  paragraphs.push(CLOSE[lang][tones.includes('grave') ? 'grave' : tones.includes('joy') ? 'joy' : 'plain']);
  return { title, paragraphs };
}

// ---- the language model's voice ------------------------------------------------------------------------------------------
type AiFetch = typeof fetch;
let aiFetch: AiFetch = (...a) => fetch(...a);
/** Tests replace the network call. */
export const setAiFetch = (f: AiFetch) => { aiFetch = f; };
/** Whether ANY provider is configured (see server/lib/ai.ts): the book never cares which one it is. */
export const modelConfigured = () => aiConfigured();

const SYSTEM: Record<Lang, string> = {
  ar: `أنت كاتب أدبي محترف، تحوّل أحداث عائلة حقيقية إلى فصلٍ من قصتها. اكتب بعربية فصيحة سلسة دافئة ممتعة ومشوّقة، وانتقل من حدثٍ إلى آخر بجسور طبيعية تربط الأحداث بعضها ببعض بثقة وحرفية.
القواعد الصارمة: (1) استعمل الوقائع المعطاة فقط، ولا تخترع أسماء ولا أحداثاً ولا تفاصيل ولا حواراً ولا أسباباً. (2) النبرة تتبع الحدث: الفرح (ميلاد، زواج، تخرّج) دفءٌ وبهجة؛ الطرفة بخفة دمٍ ودعابة لطيفة لا تجرح أحداً؛ المرض والوفاة بوقارٍ وحزنٍ صادق ودعاء، بلا مبالغة ولا دعابة. (3) لا تذكر خلافات ولا أسراراً. (4) اجعل كل حدث فقرة أو أكثر، وابدأ بمقدمة قصيرة للفصل واختم بسطرٍ يغلقه. (5) لا تذكر أنك نموذج ذكاء اصطناعي. أجب بـJSON فقط بهذا الشكل: {"title":"عنوان أدبي للفصل","paragraphs":["...","..."]}`,
  en: `You are a professional literary writer turning the events of a real family into one chapter of its story. Write warm, vivid, engaging prose, and move from one event to the next with natural bridges that tie them together with confidence.
Strict rules: (1) Use ONLY the facts given; never invent names, events, details, dialogue or reasons. (2) Let the tone follow the event: joy (birth, wedding, graduation) is warm and bright; funny moments get gentle humour that hurts no one; illness and death get dignity, honest sorrow and a prayer, never exaggeration or jokes. (3) Never mention quarrels or secrets. (4) Give each event a paragraph or more, open the chapter with a short introduction and close it with a line that ends it. (5) Never mention being an AI. Reply with JSON only: {"title":"a literary chapter title","paragraphs":["...","..."]}`,
};

/** One chapter written by the model. Throws when the model is unavailable or answers badly: the caller then keeps the rules' chapter. */
export async function narrateByModel(f: ChapterFacts, lang: Lang, storyTitle: string, people: string[]): Promise<{ title: string; paragraphs: string[] }> {
  const turn = await callModel({
    system: SYSTEM[lang],
    maxTokens: 2500,
    json: true,
    messages: [{ role: 'user', text: JSON.stringify({ story: storyTitle, chapter: f.idx, people, events: f.events.map(e => ({ date: e.date, title: e.title, summary: e.summary, category: e.category, funny: e.kind === 'funny', tone: e.tone })) }) }],
  }, aiFetch);
  // Count the tokens against the month's cost like the ops agent does: writing a book is the costlier of the two features and
  // used to be invisible on the owner's budget screen.
  run('INSERT INTO agent_usage (input_tokens, output_tokens) VALUES (?, ?)', turn.usage.input, turn.usage.output);
  const out = jsonFromText<{ title?: unknown; paragraphs?: unknown }>(turn.text);
  const paragraphs = Array.isArray(out.paragraphs) ? out.paragraphs.map((p: unknown) => String(p).trim()).filter(Boolean).slice(0, 30) : [];
  if (!paragraphs.length) throw new Error('empty chapter');
  return { title: excerpt(String(out.title ?? ''), 120) || (narrateByRules(f, lang).title), paragraphs };
}

// ---- reading and writing the story ---------------------------------------------------------------------------------------
const stored = (circleId: number, year: number, lang: Lang) => all('SELECT idx, title, body, source, facts_hash AS hash FROM story_chapters WHERE circle_id = ? AND year = ? AND lang = ?', circleId, year, lang);

/** The chapters as the book shows them: a person's edit always; the model's text while the events are unchanged; otherwise the rules' draft. */
export function readStory(circleId: number, year: number, lang: Lang): Chapter[] {
  const rows = new Map(stored(circleId, year, lang).map(r => [Number(r.idx), r]));
  const chat = (f: ChapterFacts) => all(
    `SELECT COALESCE((SELECT t.id FROM media t WHERE t.thumb_of = m.id), m.id) AS src FROM media m JOIN messages x ON x.id = m.message_id
      WHERE m.circle_id = ? AND m.kind = 'image' AND x.deleted_at IS NULL AND date(x.created_at) >= ? AND date(x.created_at) <= ? ORDER BY m.id LIMIT 4`, circleId, f.from, f.to).map(r => Number(r.src));
  return collect(circleId, year).map(f => {
    const row = rows.get(f.idx);
    const keep = row && (row.source === 'edited' || row.hash === hashFacts(f));
    const base = keep ? { title: String(row!.title), paragraphs: String(row!.body).split(/\n{2,}/).filter(Boolean), source: row!.source as 'model' | 'edited' } : { ...narrateByRules(f, lang), source: 'rules' as const };
    return { idx: f.idx, ...base, photoStrip: chat(f), albumStrip: f.events.flatMap(e => e.photos.map(p => p.id)).slice(0, 6) };
  });
}

/** Ask the model to write the chapters (managers only, rate-limited by the caller). Returns how many were written; 0 when no model is configured. */
export async function writeStory(circleId: number, year: number, lang: Lang, userId: number, force: boolean): Promise<{ written: number; model: boolean }> {
  if (!modelConfigured() || !flag('agent_enabled')) return { written: 0, model: false };
  const circle = one('SELECT name, story_title, agent_active FROM circles WHERE id = ?', circleId) as Row;
  if (!circle.agent_active) return { written: 0, model: true };   // the family has not allowed the agent to read this circle's record
  const people = all('SELECT name FROM persons WHERE circle_id = ? ORDER BY id', circleId).map(r => String(r.name));
  const have = new Map(stored(circleId, year, lang).map(r => [Number(r.idx), r]));
  let written = 0;
  for (const f of collect(circleId, year)) {
    const cur = have.get(f.idx);
    if (cur?.source === 'edited') continue;                       // a person's words are never overwritten by a model
    if (!force && cur && cur.hash === hashFacts(f)) continue;
    try {
      const out = await narrateByModel(f, lang, circle.story_title || circle.name, people);
      run(`INSERT INTO story_chapters (circle_id, year, lang, idx, title, body, source, facts_hash, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'model', ?, ?)
           ON CONFLICT(circle_id, year, lang, idx) DO UPDATE SET title = excluded.title, body = excluded.body, source = 'model', facts_hash = excluded.facts_hash, updated_by = excluded.updated_by, updated_at = datetime('now')`,
        circleId, year, lang, f.idx, out.title, out.paragraphs.join('\n\n'), hashFacts(f), userId);
      written++;
    } catch (e) { console.error('[story]', e instanceof Error ? e.message : e); }
  }
  return { written, model: true };
}

/** A person edits a chapter: it is kept as theirs from then on. */
export function editChapter(circleId: number, year: number, lang: Lang, idx: number, title: string, body: string, userId: number): boolean {
  const f = collect(circleId, year).find(x => x.idx === idx);
  if (!f) return false;
  run(`INSERT INTO story_chapters (circle_id, year, lang, idx, title, body, source, facts_hash, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'edited', ?, ?)
       ON CONFLICT(circle_id, year, lang, idx) DO UPDATE SET title = excluded.title, body = excluded.body, source = 'edited', facts_hash = excluded.facts_hash, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    circleId, year, lang, idx, title.slice(0, 120), body.slice(0, 20000), hashFacts(f), userId);
  return true;
}
