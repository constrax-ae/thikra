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
const raw: Record<Category, Array<[string, number]>> = {
  birth: [
    ['ولادة', 34], ['ولدت', 30], ['مولود', 34], ['مولودة', 34], ['رزقت', 30], ['رزقنا', 30],
    ['حفيد', 24], ['حفيدة', 24], ['سلامة الأم', 26], ['يتربى في عزكم', 30],
    ['newborn', 30], ['baby girl', 28], ['baby boy', 28], ['was born', 32], ['gave birth', 34],
  ],
  marriage: [
    ['زواج', 32], ['زفاف', 34], ['عرس', 32], ['خطوبة', 32], ['خطبة', 28], ['ملكة', 28], ['عقد القران', 36],
    ['العروس', 22], ['العريس', 22],
    ['wedding', 32], ['engaged', 30], ['engagement', 30], ['married', 30],
  ],
  graduation: [
    ['تخرج', 34], ['تخرجت', 34], ['تخرجنا', 34], ['حفل التخرج', 38], ['شهادة', 14], ['ماجستير', 28],
    ['دكتوراه', 30], ['بكالوريوس', 26], ['graduat', 32], ['degree', 16],
  ],
  achievement: [
    ['نجاح', 22], ['نجح', 24], ['نجحت', 24], ['فوز', 24], ['فاز', 24], ['ترقية', 30], ['وظيفة جديدة', 32],
    ['تعيين', 22], ['إنجاز', 26], ['جائزة', 26], ['تكريم', 26], ['اختبار', 8], ['promotion', 30], ['new job', 30], ['award', 26],
  ],
  travel: [
    ['سفر', 22], ['مسافر', 22], ['مسافرة', 22], ['وصلنا', 14], ['رحلة', 20], ['عمرة', 30], ['حج', 28],
    ['مطار', 14], ['هجرة', 26], ['انتقلنا', 26], ['trip', 16], ['flight', 14], ['moved to', 24],
  ],
  health: [
    ['عملية', 22], ['مستشفى', 24], ['مريض', 18], ['تنويم', 24], ['شفاء', 28], ['الحمدلله على السلامة', 34],
    ['سلامتك', 20], ['شافاك', 24], ['تعافى', 26], ['hospital', 24], ['surgery', 26], ['recovered', 28],
  ],
  passing: [
    ['وفاة', 40], ['توفي', 40], ['توفيت', 40], ['انتقل إلى رحمة الله', 44], ['إلى رحمة الله', 36],
    ['رحمه الله', 28], ['رحل عنا', 36], ['عزاء', 36], ['جنازة', 36], ['إنا لله وإنا إليه راجعون', 40],
    ['اللهم ارحمه', 24], ['passed away', 38], ['funeral', 34], ['condolences', 30],
  ],
  family_news: [
    ['خبر', 12], ['أخبركم', 14], ['أعلن', 16], ['يسعدني', 12], ['بشرى', 22], ['مفاجأة', 14],
    ['العائلة', 10], ['اجتماع العائلة', 20], ['اجتماع', 10], ['announce', 14], ['news', 8],
  ],
};

const KEYWORDS = Object.fromEntries(
  Object.entries(raw).map(([cat, list]) => [cat, list.map(([k, w]) => [normalize(k), w] as [string, number])]),
) as Record<Category, Array<[string, number]>>;

const SUPPORT: Array<[RegExp, number, string]> = [
  [/(الف مبروك|مبروك|تهاني|تبريك|congrat)/, 10, 'تهنئة'],
  [/(ابني|بنتي|اخوي|اختي|ابوي|امي|جدي|جدتي|عمي|خالي|عمتي|خالتي|زوجي|زوجتي|ولدي|my (son|daughter|brother|sister|father|mother|wife|husband))/, 10, 'صلة قرابة'],
  [/(\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?|\b20\d{2}\b|يوم (الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت)|غدا|امس|الاسبوع (الجاي|الماضي|القادم))/, 10, 'تاريخ'],
  [/(الله يرحمه|ما شاء الله|الحمدلله|بارك الله)/, 4, 'دعاء'],
];

const PENALTIES: Array<[RegExp, number, string]> = [
  [/^(هلا|مرحبا|السلام عليكم|صباح الخير|مساء الخير|اهلا|تمام|ok|اوكي|طيب|يب|اي|لا|هههه+|😂+|hi|hello|thanks|شكرا)\W*$/, -25, 'كلام عابر'],
  [/(وين|متى|كيف|ليش|شو|ايش|هل|كم|وش)\b[^.!]*[?؟]\s*$/, -20, 'سؤال مجرد'],
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
    if (text.length >= 40) { score += 6; signals.push('+تفصيل'); }
    if (text.length >= 120) score += 4;
  }
  for (const [re, w, label] of PENALTIES) if (re.test(text)) { score += w; signals.push(`-${label}`); }
  if (text.length < 12) { score -= 12; signals.push('-قصيرة'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const threshold = THRESHOLDS[sensitivity];

  if (score < ABSOLUTE_FLOOR) {
    return {
      score, category: null, verdict: 'rejected', signals,
      reason: manual
        ? 'رُفض التوثيق: لا يوجد محتوى إخباري كافٍ في الرسالة حتى مع الطلب اليدوي.'
        : 'لا يوجد محتوى إخباري.',
    };
  }
  if (score >= threshold) {
    return { score, category, verdict: 'archived', signals, reason: `الدرجة ${score} بلغت عتبة الدائرة (${threshold}).` };
  }
  if (manual) {
    return { score, category, verdict: 'archived', signals, reason: `وُثّق بطلب يدوي (الدرجة ${score} دون العتبة ${threshold}).` };
  }
  return { score, category, verdict: 'skipped', signals, reason: `الدرجة ${score} دون عتبة الدائرة (${threshold}).` };
}
