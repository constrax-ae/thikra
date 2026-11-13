import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, normalize, THRESHOLDS, type Category, type Sensitivity } from './agent.ts';

test('normalize unifies Arabic letter variants and strips tashkeel', () => {
  assert.equal(normalize('مَبْرُوك'), 'مبروك');
  assert.equal(normalize('أحمد إبراهيم آل'), 'احمد ابراهيم ال');
  assert.equal(normalize('ولادة'), 'ولاده');
});

test('birth announcement is archived at strict sensitivity', () => {
  const r = assess('الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي', 'strict');
  assert.equal(r.verdict, 'archived');
  assert.equal(r.category, 'birth');
});

test('passing news is categorised', () => {
  const r = assess('إنا لله وإنا إليه راجعون، توفي جدي الليلة والعزاء غداً', 'medium');
  assert.equal(r.verdict, 'archived');
  assert.equal(r.category, 'passing');
});

test('small talk is rejected even when manually requested', () => {
  const r = assess('هلا', 'lenient', true);
  assert.equal(r.verdict, 'rejected');
});

test('a bare question is rejected', () => {
  assert.equal(assess('وين كلكم متى نتجمع؟', 'lenient').verdict, 'rejected');
});

test('below-threshold message is skipped, but archived on manual request', () => {
  const text = 'وصلنا المطار';
  assert.equal(assess(text, 'strict').verdict, 'skipped');
  assert.equal(assess(text, 'strict', true).verdict, 'archived');
});

test('lenient threshold admits what strict does not', () => {
  const text = 'نجحت بنتي في الاختبار';
  assert.equal(assess(text, 'strict').verdict, 'skipped');
  assert.equal(assess(text, 'lenient').verdict, 'archived');
});

test('score is clamped 0..100', () => {
  const r = assess('زواج زفاف عرس خطوبة عقد القران العروس العريس مبروك ابني 2025 wedding engaged married', 'strict');
  assert.ok(r.score <= 100 && r.score >= 0);
});

// ---- both languages -------------------------------------------------------------------
// The agent used to score English announcements on the keyword alone: the kinship, date and
// congratulation bonuses were Arabic-only patterns, so "Our daughter Sara was born today"
// reached 32 against a medium threshold of 42 and was silently dropped. These tests pin
// every category in both languages so that cannot come back unnoticed.

const EVENTS: Array<[Category, string, string]> = [
  ['birth', 'رزقنا بمولود اليوم، ألف مبروك لأخوي', 'My brother and his wife had a baby boy today, congratulations'],
  ['marriage', 'زواج بنتي يوم الجمعة، ألف مبروك', 'My daughter is getting married on Friday, congratulations'],
  ['graduation', 'تخرجت بنتي اليوم من الجامعة', 'My daughter graduated from university today'],
  ['achievement', 'ترقية لأخوي في العمل اليوم', 'My brother got a promotion at work today'],
  ['health', 'طلع أبوي من المستشفى والحمدلله تعافى', 'My father is out of hospital, thank god he recovered'],
  ['passing', 'توفي جدي اليوم، الجنازة غدا', 'My grandfather passed away today, the funeral is tomorrow'],
  ['family_news', 'بشرى، اجتماع العائلة يوم الجمعة', 'Big news, family gathering on Friday'],
];

for (const [category, ar, en] of EVENTS) {
  test(`${category}: archived and categorised in Arabic`, () => {
    const r = assess(ar, 'medium');
    assert.equal(r.verdict, 'archived', `"${ar}" scored ${r.score}`);
    assert.equal(r.category, category);
  });

  test(`${category}: archived and categorised in English`, () => {
    const r = assess(en, 'medium');
    assert.equal(r.verdict, 'archived', `"${en}" scored ${r.score}`);
    assert.equal(r.category, category);
  });
}

test('the same announcement reaches the same verdict in either language', () => {
  // Scores need not match — the languages word things differently — but a family writing in
  // English must not get a different outcome from one writing in Arabic.
  for (const [category, ar, en] of EVENTS) {
    const a = assess(ar, 'medium'), e = assess(en, 'medium');
    assert.equal(a.verdict, e.verdict, `${category}: Arabic ${a.verdict} (${a.score}) vs English ${e.verdict} (${e.score})`);
    assert.equal(a.category, e.category, `${category}: Arabic filed as ${a.category}, English as ${e.category}`);
  }
});

test('English picks up the same kinds of supporting signal as Arabic', () => {
  const r = assess('My daughter was born yesterday, congratulations to my wife', 'medium');
  assert.ok(r.signals.some(s => s.startsWith('birth:')), 'no category keyword');
  assert.ok(r.signals.includes('+صلة قرابة'), 'kinship not detected in English');
  assert.ok(r.signals.includes('+تاريخ'), 'date not detected in English');
  assert.ok(r.signals.includes('+تهنئة'), 'congratulation not detected in English');
});

test('Arabic "today" counts as a date, as its other day words already did', () => {
  assert.ok(assess('ترقية لأخوي في العمل اليوم', 'medium').signals.includes('+تاريخ'));
});

test('the detail bonus is measured in words, not characters', () => {
  // Counting characters quietly favoured English, which needs far more of them to say
  // the same thing. Two announcements of equal length in words should both qualify.
  const ar = assess('تخرجت بنتي اليوم من الجامعة بتقدير ممتاز', 'medium');
  const en = assess('My daughter graduated from university today with honours', 'medium');
  assert.ok(ar.signals.includes('+تفصيل'), 'Arabic missed the detail bonus');
  assert.ok(en.signals.includes('+تفصيل'), 'English missed the detail bonus');
});

// ---- the agent must stay quiet about ordinary chatter ----------------------------------

const NOISE = [
  'ok', 'hello', 'thanks', 'haha', 'good morning', 'how are you',
  'where is everyone?', 'what time is the meeting?', 'did you see the news?',
  'هلا', 'شكرا', 'وين كلكم متى نتجمع؟',
  'I had a wonderful day',              // must not match "won"
  'the newspaper said it will rain',    // must not match "news" strongly
  'see you at the airport cafe',
  // Innocent uses of the phrases the English lists had to be widened to include.
  'can you pass the salt please',
  'I passed the shop on my way home today',
  'we hired a plumber to fix the sink yesterday',
  'his job at the office is really stressful these days',
  'I am moving to the other room, too noisy here',
  'the first place we visited was the museum',
  'my new position on the sofa is much better',
  'did my brother call you today?',
];

for (const text of NOISE) {
  test(`everyday chatter is not archived: ${text}`, () => {
    const r = assess(text, 'medium');
    assert.notEqual(r.verdict, 'archived', `scored ${r.score} as ${r.category}`);
  });
}

test('an English greeting is rejected outright, like the Arabic one', () => {
  for (const s of ['hello', 'thanks', 'good morning'] as const) {
    assert.equal(assess(s, 'lenient', true).verdict, 'rejected', s);
  }
});

test('an English bare question is penalised, like the Arabic one', () => {
  // A question containing a keyword should not be filed just for mentioning it.
  const plain = assess('When is the wedding?', 'medium');
  const news = assess('The wedding is on Friday, all the family is invited', 'medium');
  assert.notEqual(plain.verdict, 'archived');
  assert.equal(news.verdict, 'archived');
});

test('sensitivity still orders the same way in English', () => {
  const text = 'My brother got a new job';
  const seen = (['strict', 'medium', 'lenient'] as Sensitivity[]).map(s => assess(text, s).verdict);
  // Never stricter as the setting loosens.
  const rank = { rejected: 0, skipped: 1, archived: 2 } as const;
  assert.ok(rank[seen[0]] <= rank[seen[1]] && rank[seen[1]] <= rank[seen[2]], seen.join(' -> '));
});

// ---- how families actually word things ------------------------------------------------
// The category lists were first written as single dictionary words, which matched the
// phrasing in the tests and little else: "got the job" did not cover "got his first job",
// and the whole achievement category missed every natural sentence tried against it.
// These are the phrasings a family would really send.

const PHRASINGS: Array<[Category, string]> = [
  ['achievement', 'My son got his first job today, congratulations'],
  ['achievement', 'My son landed a job at Emirates today'],
  ['achievement', 'My daughter was hired as a teacher today'],
  ['achievement', 'My brother started his new position today'],
  ['achievement', 'My son passed his driving test today'],
  ['achievement', 'My daughter came first in her class today'],
  ['birth', 'My wife gave birth to a boy this morning'],
  ['birth', 'We had a baby girl last night, alhamdulillah'],
  ['birth', 'My sister had her baby today'],
  ['marriage', 'My son is getting engaged next week'],
  ['marriage', 'My cousin had her wedding yesterday'],
  ['marriage', 'We signed the nikah today, alhamdulillah'],
  ['graduation', 'My son finished his masters today'],
  ['graduation', 'My daughter is graduating this week'],
  ['health', 'My mother had surgery this morning, she is fine'],
  ['health', 'My father was admitted to hospital last night'],
  ['passing', 'We lost our grandmother this morning'],
  ['passing', 'My uncle died yesterday, the burial is today'],
  ['travel', 'We are moving to Canada next month with the family'],
  ['travel', 'My parents left for umrah today'],
  ['family_news', 'We are having a family reunion next week'],
  ['family_news', 'Big news, my brother is coming home tomorrow'],
];

for (const [category, text] of PHRASINGS) {
  test(`natural phrasing is archived as ${category}: ${text}`, () => {
    const r = assess(text, 'medium');
    assert.equal(r.verdict, 'archived', `scored ${r.score}`);
    assert.equal(r.category, category);
  });
}

test('a permanent move is an event; a trip is not', () => {
  // Relocation is a life event and scores as one. An ordinary journey should not, or every
  // airport run would end up in the family book.
  assert.equal(assess('We moved to Dubai yesterday', 'medium').verdict, 'archived');
  assert.equal(assess('My flight is at 6, see you at the airport', 'medium').verdict, 'skipped');
});

test('the reason is a language-neutral code, not Arabic prose', () => {
  // It is stored once per message and read by every member, so it cannot be written in
  // one language. The UI turns this into a sentence in the reader's own.
  const archived = assess('My daughter was born today, congratulations to my wife', 'medium');
  assert.match(archived.reason, /^agent:archived:\d+:\d+$/);
  assert.match(assess('see you at the airport cafe', 'medium').reason, /^agent:skipped:\d+:\d+$/);
  assert.match(assess('hello', 'medium').reason, /^agent:rejected:\d+:\d+$/);
  assert.match(assess('hello', 'medium', true).reason, /^agent:rejectedManual:\d+:\d+$/);
  assert.match(assess('وصلنا المطار', 'strict', true).reason, /^agent:archivedManual:\d+:\d+$/);
});

test('the reason carries the score and threshold it was judged against', () => {
  const r = assess('My daughter was born today, congratulations to my wife', 'medium');
  const [, , score, threshold] = r.reason.split(':');
  assert.equal(Number(score), r.score);
  assert.equal(Number(threshold), THRESHOLDS.medium);
});
