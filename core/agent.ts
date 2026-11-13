// Deterministic archive agent (report §5). Rules + weights, no LLM call.
// An LLM can later be blended in at `scoreWithModel` (60% model / 40% engine).

export type Category =
  | 'birth' | 'marriage' | 'graduation' | 'achievement'
  | 'travel' | 'health' | 'passing' | 'family_news';

export type Sensitivity = 'strict' | 'medium' | 'lenient';

export const THRESHOLDS: Record<Sensitivity, number> = { strict: 70, medium: 42, lenient: 26 };
export const ABSOLUTE_FLOOR = 14;

export type Verdict = 'archived' | 'skipped' | 'rejected';

export interface Assessment {
  score: number;
  category: Category | null;
  verdict: Verdict;
  reason: string;
  signals: string[];
}

/** Arabic normalisation: strip tashkeel/tatweel, unify alef/ya/ta-marbuta/hamza forms. */
export function normalize(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .toLowerCase()
    .trim();
}

// Keywords are normalised at load time. [keyword, weight]
// Keywords are normalised at load time. [keyword, weight]
// Both languages are first-class. English phrases are multi-word or distinctive on purpose:
// matching is substring-based, so a bare "won" would also fire on "wonderful".
const raw: Record<Category, Array<[string, number]>> = {
  birth: [
    ['ولادة', 34], ['ولدت', 30], ['مولود', 34], ['مولودة', 34], ['رزقت', 30], ['رزقنا', 30],
    ['حفيد', 24], ['حفيدة', 24], ['سلامة الأم', 26], ['يتربى في عزكم', 30],
    ['newborn', 30], ['baby girl', 28], ['baby boy', 28], ['had a baby', 30],
    ['had her baby', 32], ['had his baby', 30], ['انجبت', 30], ['was born', 32], ['were born', 32],
    ['gave birth', 34], ['giving birth', 30], ['birth of', 30], ['welcomed a', 26],
    ['new arrival', 24], ["it's a girl", 32], ["it's a boy", 32], ['its a girl', 32], ['its a boy', 32],
    ['grandson', 24], ['granddaughter', 24], ['expecting a baby', 26], ['baby is here', 30],
  ],
  marriage: [
    ['زواج', 32], ['زفاف', 34], ['عرس', 32], ['خطوبة', 32], ['خطبة', 28], ['ملكة', 28], ['عقد القران', 36],
    ['العروس', 22], ['العريس', 22],
    ['wedding', 32], ['engaged', 30], ['engagement', 30], ['married', 30], ['getting married', 34],
    ['got married', 34], ['tied the knot', 32], ['nikah', 34], ['walima', 30], ['proposed to', 28],
    ['the bride', 22], ['the groom', 22], ['our wedding', 34],
  ],
  graduation: [
    ['تخرج', 34], ['تخرجت', 34], ['تخرجنا', 34], ['حفل التخرج', 38], ['شهادة', 14], ['ماجستير', 28],
    ['دكتوراه', 30], ['بكالوريوس', 26],
    ['graduat', 32], ['degree', 16], ['masters', 26], ['phd', 28], ['doctorate', 30],
    ['bachelor of', 26], ['convocation', 30], ['diploma', 22], ['finished university', 28],
    ['finished school', 24], ['final year', 16],
  ],
  achievement: [
    ['نجاح', 22], ['نجح', 24], ['نجحت', 24], ['فوز', 24], ['فاز', 24], ['ترقية', 30], ['وظيفة جديدة', 32],
    ['تعيين', 22], ['إنجاز', 26], ['جائزة', 26], ['تكريم', 26], ['اختبار', 8],
    ['promotion', 30], ['promoted', 30], ['new job', 30], ['award', 26], ['first job', 30],
    ['got the job', 32], ['got a job', 30], ['landed a job', 30], ['job at', 24], ['was hired', 28],
    ['got hired', 28], ['new position', 26], ['new role', 24], ['started work', 22],
    // "passed his/her …" is safe next to passing's "passed away", which scores higher anyway.
    ['passed the', 24], ['passed his', 24], ['passed her', 24], ['driving test', 26],
    ['first place', 26], ['came first', 26], ['top of his class', 28], ['top of her class', 28],
    ['scholarship', 28], ['accepted into', 26], ['won the', 26],
  ],
  travel: [
    ['سفر', 22], ['مسافر', 22], ['مسافرة', 22], ['وصلنا', 14], ['رحلة', 20], ['عمرة', 30], ['حج', 28],
    ['مطار', 14], ['هجرة', 32], ['انتقلنا', 32],
    ['trip', 16], ['flight', 14], ['moved to', 32], ['moving to', 32], ['relocating', 32],
    ['umrah', 30], ['hajj', 28], ['pilgrimage', 28], ['landed in', 20], ['arrived in', 20],
    ['travelling to', 20], ['traveling to', 20], ['the airport', 14], ['got the visa', 24],
  ],
  health: [
    ['عملية', 22], ['مستشفى', 24], ['مريض', 18], ['تنويم', 24], ['شفاء', 28], ['الحمدلله على السلامة', 34],
    ['سلامتك', 20], ['شافاك', 24], ['تعافى', 26],
    ['hospital', 24], ['surgery', 26], ['recovered', 28], ['recovering', 24], ['operation', 22],
    ['discharged', 26], ['out of hospital', 30], ['intensive care', 28], ['diagnosed', 24],
    ['get well', 20], ['back home from', 18], ['the doctors', 14],
  ],
  passing: [
    ['وفاة', 40], ['توفي', 40], ['توفيت', 40], ['انتقل إلى رحمة الله', 44], ['إلى رحمة الله', 36],
    ['رحمه الله', 28], ['رحل عنا', 36], ['عزاء', 36], ['جنازة', 36], ['إنا لله وإنا إليه راجعون', 40],
    ['اللهم ارحمه', 24],
    ['passed away', 38], ['funeral', 34], ['condolences', 30], ['rest in peace', 34],
    ['janazah', 36], ['janaza', 36], ['burial', 30], ['we lost', 26], ['has died', 38],
    ['inna lillahi', 40], ['may god have mercy', 30], ['our deepest', 24],
  ],
  family_news: [
    ['خبر', 12], ['أخبركم', 14], ['أعلن', 16], ['يسعدني', 12], ['بشرى', 22], ['مفاجأة', 14],
    ['العائلة', 10], ['اجتماع العائلة', 26], ['اجتماع', 10],
    ['announce', 14], ['good news', 20], ['big news', 20], ['family gathering', 26],
    ['family reunion', 26], ['get together', 14], ['everyone is invited', 18], ['save the date', 20],
  ],
};

const KEYWORDS = Object.fromEntries(
  Object.entries(raw).map(([cat, list]) => [cat, list.map(([k, w]) => [normalize(k), w] as [string, number])]),
) as Record<Category, Array<[string, number]>>;

// Context that corroborates a keyword. These were Arabic-only, which is why an English
// announcement scored the keyword and nothing else: "Our daughter Sara was born today"
// picked up `was born` (32) and missed the kinship and date bonuses entirely, landing
// under the medium threshold of 42. Every pattern below now covers both languages.
const SUPPORT: Array<[RegExp, number, string]> = [
  [/(الف مبروك|مبروك|تهاني|تبريك|congrat|well done|so happy for|so proud of|great news)/, 10, 'تهنئة'],
  [/(ابني|بنتي|اخوي|اختي|ابوي|امي|جدي|جدتي|عمي|خالي|عمتي|خالتي|زوجي|زوجتي|ولدي|\b(my|our|his|her|their)\s+(son|daughter|brother|sister|father|mother|mum|mom|dad|parents|wife|husband|uncle|aunt|cousin|nephew|niece|family|grand(son|daughter|father|mother|pa|ma))\b|\b(grandfather|grandmother|grandpa|grandma)\b)/, 10, 'صلة قرابة'],
  [/(\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?|\b20\d{2}\b|يوم (الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت)|غدا|بكره|امس|البارحه|اليوم|الليله|الاسبوع (الجاي|الماضي|القادم)|هذا الاسبوع|هالاسبوع|\b(today|tomorrow|yesterday|tonight|this (morning|afternoon|evening|week|weekend|month)|last (night|week|month)|next (week|month)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (january|february|march|april|june|july|august|september|october|november|december))\b)/, 10, 'تاريخ'],
  [/(الله يرحمه|ما شاء الله|الحمدلله|بارك الله|mashallah|alhamdulillah|inshallah|may god|thank god)/, 4, 'دعاء'],
];

// Things that look like news but are not. Also bilingual: an English greeting or a bare
// English question used to score whatever keyword happened to be in it, with no deduction.
const PENALTIES: Array<[RegExp, number, string]> = [
  [/^(هلا|مرحبا|السلام عليكم|صباح الخير|مساء الخير|اهلا|تمام|ok|okay|اوكي|طيب|يب|اي|لا|هههه+|😂+|hi|hey|hello|thanks|thank you|شكرا|yes|no|sure|lol|haha+|good morning|good night|how are you)\W*$/, -25, 'كلام عابر'],
  [/(وين|متى|كيف|ليش|شو|ايش|هل|كم|وش)\b[^.!]*[?؟]\s*$/, -20, 'سؤال مجرد'],
  [/^\s*(where|when|how|why|what|who|which|is|are|was|were|do|does|did|can|could|will|would|should|has|have|any)\b[^.!؟]*\?\s*$/, -20, 'سؤال مجرد'],
];

/** True if the text hits any keyword of the given categories (all categories by default). */
export function hasSignal(rawText: string, cats: Category[] = Object.keys(KEYWORDS) as Category[]): boolean {
  const text = normalize(rawText);
  return cats.some(cat => KEYWORDS[cat].some(([kw]) => text.includes(kw)));
}

export function assess(rawText: string, sensitivity: Sensitivity = 'medium', manual = false): Assessment {
  const text = normalize(rawText);
  const signals: string[] = [];
  let score = 0;
  let category: Category | null = null;
  let best = 0;

  for (const cat of Object.keys(KEYWORDS) as Category[]) {
    let catScore = 0;
    for (const [kw, w] of KEYWORDS[cat]) {
      if (text.includes(kw)) { catScore += w; signals.push(`${cat}:${kw}`); }
    }
    // Diminishing returns so a long keyword list can't dominate.
    catScore = Math.min(catScore, 60);
    if (catScore > best) { best = catScore; category = cat; }
  }
  score += best;

  if (best > 0) {
    for (const [re, w, label] of SUPPORT) if (re.test(text)) { score += w; signals.push(`+${label}`); }
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words >= 7) { score += 6; signals.push('+تفصيل'); }
    if (words >= 18) score += 4;
  }
  for (const [re, w, label] of PENALTIES) if (re.test(text)) { score += w; signals.push(`-${label}`); }
  if (text.split(/\s+/).filter(Boolean).length < 3) { score -= 12; signals.push('-قصيرة'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const threshold = THRESHOLDS[sensitivity];

  // `agent:<code>:<score>:<threshold>` — the UI turns this into a sentence in the reader's
  // own language. Rows written before this change hold Arabic prose and are shown as-is.
  const code = (c: string) => `agent:${c}:${score}:${threshold}`;

  if (score < ABSOLUTE_FLOOR) {
    return { score, category: null, verdict: 'rejected', signals, reason: code(manual ? 'rejectedManual' : 'rejected') };
  }
  if (score >= threshold) {
    return { score, category, verdict: 'archived', signals, reason: code('archived') };
  }
  if (manual) {
    return { score, category, verdict: 'archived', signals, reason: code('archivedManual') };
  }
  return { score, category, verdict: 'skipped', signals, reason: code('skipped') };
}
