import { BOOK_TEXT, esc } from '../lib/book.ts';
import { textLang } from '../lib/lang.ts';
import { all, one, type Row } from '../db.ts';
import { app } from '../app.ts';
import { circleAccess, isManager, limited } from '../lib/helpers.ts';
import { editChapter, modelConfigured, readStory, writeStory, type Lang } from '../lib/story.ts';

// The circle's year as a STORY (a normal web page styled for A4: use the browser's Print > Save as PDF).
// It shows only what EVERY member may see: conflicts are never put in it, and declined or hidden entries stay out.
// Chapters are narrated by the built-in rules, or by a language model when the owner has configured one (see lib/story.ts); a person's edit always wins.
const langOf = (c: { req: { query(k: string): string | undefined } }, userLang: string): Lang => { const q = c.req.query('lang'); return q ? textLang(q) : textLang(userLang); };
const yearOf = (v: unknown) => { const y = Number(v ?? new Date().getFullYear()); return Number.isInteger(y) && y >= 1900 && y <= 2200 ? y : null; };

app.get('/api/circles/:id/book', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const year = yearOf(c.req.query('year'));
  if (!year) return c.json({ error: 'invalid_year' }, 400);
  const L = langOf(c, a.user.lang);
  const T = BOOK_TEXT[L];
  const circle = one('SELECT name, story_title FROM circles WHERE id = ?', a.circleId)!;
  const title = String(circle.story_title || `${T.title} · ${circle.name}`);
  const chapters = readStory(a.circleId, year, L);
  const people = all('SELECT name, relation, birth_date AS birth, death_date AS death FROM persons WHERE circle_id = ? ORDER BY id', a.circleId);
  const born = people.filter(p => String(p.birth ?? '').startsWith(String(year)));
  const lost = people.filter(p => String(p.death ?? '').startsWith(String(year)));
  const personLine = (p: Row) => `${esc(p.name)}${p.relation ? ` <span class="rel">· ${esc(p.relation)}</span>` : ''} <span class="yrs">${esc([String(p.birth ?? '').slice(0, 4), String(p.death ?? '').slice(0, 4)].filter(Boolean).join(' – '))}</span>`;
  const anyDraft = chapters.some(ch => ch.source === 'rules');
  const strip = (ch: (typeof chapters)[number]) => [...ch.albumStrip.map(id => `/api/album-items/${id}/file?thumb=1`), ...ch.photoStrip.map(id => `/api/media/${id}`)];

  const html = `<!doctype html>
<html lang="${L}" dir="${L === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${year}</title>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root { --green:#1f4d3f; --gold:#b98a2f; --ink:#25302b; --paper:#fbf8f1; --muted:#6a746e; }
  * { box-sizing: border-box; } body { margin:0; background:#ece7da; color:var(--ink); font-family:"Amiri","Tajawal",Georgia,serif; font-size:19px; line-height:2; }
  .page { background:var(--paper); max-width:760px; margin:16px auto; padding:56px 64px; box-shadow:0 2px 12px rgba(0,0,0,.12); }
  .cover { min-height:880px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; border:1px solid var(--gold); outline:6px double var(--gold); outline-offset:-18px; }
  .cover .orn { color:var(--gold); font-size:34px; letter-spacing:12px; } .cover h1 { font-size:46px; margin:.4em 0; color:var(--green); font-weight:700; line-height:1.4; } .cover .y { font-size:60px; color:var(--gold); }
  h2 { color:var(--green); font-size:30px; margin:0 0 .6em; line-height:1.5; text-align:center; } h2:after { content:"✦"; display:block; color:var(--gold); font-size:16px; margin-top:.2em; }
  h3 { color:var(--green); text-align:center; font-size:22px; margin:1.6em 0 .4em; }
  p { margin:.7em 0; text-align:justify; } .chapter p:first-of-type:first-letter { font-size:2.4em; color:var(--gold); float:inline-start; line-height:1; padding-inline-end:8px; }
  .scenes { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:1.4em 0 .2em; } .scenes img { width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:4px; border:4px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,.2); }
  .cap { text-align:center; color:var(--muted); font-size:.75em; } .meta,.rel,.yrs { color:var(--muted); } .mercy { color:var(--muted); font-style:italic; text-align:center; }
  .cast { list-style:none; padding:0; text-align:center; } .cast li { margin:.1em 0; } .draft { color:var(--muted); font-size:.7em; text-align:center; border-top:1px dashed var(--muted); padding-top:8px; }
  .foot { margin-top:2em; color:var(--muted); font-size:.7em; text-align:center; }
  .noprint { text-align:center; margin:16px; } .noprint button { background:var(--green); color:#fff; border:0; border-radius:10px; padding:10px 20px; font:inherit; cursor:pointer; }
  @page { size:A4; margin:16mm; }
  @media print { body { background:#fff; } .page { box-shadow:none; margin:0; max-width:none; padding:0; page-break-after:always; } .noprint { display:none; } .cover { min-height:245mm; } .scenes img { break-inside:avoid; } }
  @media (max-width:600px) { .page { padding:32px 22px; } .cover h1 { font-size:34px; } }
</style></head><body>
<div class="noprint"><button id="print-book">${esc(T.print)}</button></div>
<section class="page cover"><div class="orn">✦ ✦ ✦</div><h1>${esc(title)}</h1><div class="y">${year}</div><div class="orn">✦ ✦ ✦</div></section>
<section class="page">
  <h2>${esc(T.foreword)}</h2>
  ${chapters.length === 0 ? `<p>${esc(T.empty)}</p>` : `<p>${esc(L === 'ar' ? `هذه حكاية عامٍ مضى من عمر العائلة، جمعناها من لحظاتها كما دوّنتها بأيديها. فيها أفراحٌ نتقاسمها، وأيامٌ ثقيلة تعلّمنا فيها أن نكون معاً. اقرؤوها على مهل، فكل سطرٍ فيها كان يوماً حقيقياً.` : `This is the story of a year in the life of the family, gathered from its moments as it recorded them itself. There are joys we share and heavy days in which we learned to stand together. Read it slowly: every line was once a real day.`)}</p>`}
  ${people.length ? `<h3>${esc(T.cast)}</h3><ul class="cast">${people.filter(p => !p.death).map(p => `<li>${personLine(p)}</li>`).join('')}</ul>` : ''}
  ${lost.length ? `<h3>${esc(T.lost)}</h3><ul class="cast">${lost.map(p => `<li>${personLine(p)}</li>`).join('')}</ul><p class="mercy">${esc(T.mercy)}</p>` : ''}
  ${born.length ? `<h3>${esc(T.born)}</h3><ul class="cast">${born.map(p => `<li>${personLine(p)}</li>`).join('')}</ul>` : ''}
</section>
${chapters.map(ch => `<section class="page chapter"><h2>${esc(ch.title)}</h2>${ch.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}
  ${strip(ch).length ? `<h3>${esc(T.scenes)}</h3><div class="scenes">${strip(ch).map(src => `<img alt="" src="${esc(src)}">`).join('')}</div>` : ''}
  ${ch.source === 'rules' ? `<p class="draft">${esc(T.draft)}</p>` : ''}</section>`).join('')}
<section class="page"><h2>${esc(T.epilogue)}</h2>
  <p>${esc(L === 'ar' ? 'وتمضي الأيام، وتبقى الحكاية. ما كُتب هنا شيءٌ مما عشناه معاً، وما لم يُكتب بعد ننتظره بقلوبٍ مفتوحة.' : 'The days go on, and the story stays. What is written here is only part of what we lived together, and what is not yet written we await with open hearts.')}</p>
  ${anyDraft ? '' : ''}<div class="foot">${esc(T.made)} · ${esc(title)} · ${year}</div>
</section>
<script src="/book.js"></script>
</body></html>`;
  return c.html(html);
});

/** The chapters as the editor needs them: text, and who wrote it (rules, the model, or a person). Any member may read; only managers edit. */
app.get('/api/circles/:id/story', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const year = yearOf(c.req.query('year'));
  if (!year) return c.json({ error: 'invalid_year' }, 400);
  const lang: Lang = textLang(c.req.query('lang'));
  return c.json({ year, lang, model: modelConfigured(), chapters: readStory(a.circleId, year, lang).map(ch => ({ idx: ch.idx, title: ch.title, text: ch.paragraphs.join('\n\n'), source: ch.source })) });
});

/** Ask the literary writer (a language model, if the owner configured one and the family allowed the agent) to write this year's chapters. */
app.post('/api/circles/:id/story', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  if (await limited(`story:${a.circleId}`, 6, 86_400_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  const year = yearOf(b.year);
  if (!year) return c.json({ error: 'invalid_year' }, 400);
  const lang: Lang = textLang(b.lang);
  if (!modelConfigured()) return c.json({ written: 0, model: false });
  return c.json(await writeStory(a.circleId, year, lang, a.user.id, b.force === true));
});

/** A person rewrites a chapter by hand; from then on it is theirs and no model overwrites it. */
app.put('/api/circles/:id/story/:year/:idx', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const year = yearOf(c.req.param('year')), idx = Number(c.req.param('idx'));
  const b = await c.req.json().catch(() => ({}));
  const title = typeof b.title === 'string' ? b.title.trim() : '', text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!year || !Number.isInteger(idx) || !title || !text) return c.json({ error: 'invalid_value' }, 400);
  if (!editChapter(a.circleId, year, textLang(b.lang), idx, title, text, a.user.id)) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
