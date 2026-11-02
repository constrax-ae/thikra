// The languages Thekra speaks. The screens are translated into all of them; what the SERVER writes (codes by SMS, notifications) is written in the person's language
// where we have it, in Arabic for Arabic speakers, and in English for everybody else (never Arabic for someone who cannot read it).
export const LANGS = ['ar', 'en', 'ur', 'hi', 'tl', 'fr', 'ml', 'bn', 'fa', 'tr', 'es', 'ru', 'zh', 'de', 'it', 'pt', 'nl', 'pl', 'uk', 'el', 'sv'] as const;
export type AnyLang = typeof LANGS[number];
export const isLang = (v: unknown): v is AnyLang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);
/** A language code from outside (a request, a stored row), or the default. */
export const normLang = (v: unknown, dflt: AnyLang = 'ar'): AnyLang => (isLang(v) ? v : dflt);
/** Which of the two languages we write long server texts in: Arabic for Arabic, English for the rest. */
export const textLang = (v: unknown): 'ar' | 'en' => (v === 'ar' ? 'ar' : v === undefined || v === null ? 'ar' : 'en');
