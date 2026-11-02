// Phone numbers, the way a global messenger needs them: one canonical form (E.164) used by the
// client and the server alike, a country list in the user's language, and a good first guess of the
// user's country so most people never have to open the picker.

import { AsYouType, getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export type { CountryCode };

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** "+966 50 000 0010", "00966500000010" and "+٩٦٦٥٠٠٠٠٠٠١٠" all become "+966500000010". Null if it cannot be a real number. */
export function normalizePhone(input: unknown): string | null {
  let s = String(input ?? '')
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, d => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (!s.startsWith('+')) s = `+${s}`;
  const parsed = parsePhoneNumberFromString(s);
  return parsed && parsed.isPossible() ? parsed.number : null;
}

/** Where a device physically is, as far as its time zone can tell. Covers the Arab world and the largest diaspora countries. */
const TIME_ZONE_COUNTRY: Record<string, CountryCode> = {
  'Asia/Riyadh': 'SA', 'Asia/Dubai': 'AE', 'Asia/Kuwait': 'KW', 'Asia/Qatar': 'QA', 'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM',
  'Africa/Cairo': 'EG', 'Asia/Amman': 'JO', 'Asia/Beirut': 'LB', 'Asia/Baghdad': 'IQ', 'Asia/Damascus': 'SY', 'Asia/Aden': 'YE',
  'Africa/Khartoum': 'SD', 'Africa/Tripoli': 'LY', 'Africa/Tunis': 'TN', 'Africa/Algiers': 'DZ', 'Africa/Casablanca': 'MA',
  'Asia/Gaza': 'PS', 'Asia/Hebron': 'PS', 'Europe/Istanbul': 'TR', 'Asia/Istanbul': 'TR', 'Asia/Karachi': 'PK', 'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN', 'Asia/Dhaka': 'BD', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Europe/London': 'GB', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'America/New_York': 'US', 'America/Chicago': 'US',
  'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'America/Sao_Paulo': 'BR', 'Australia/Sydney': 'AU',
};

const COUNTRIES = new Set<string>(getCountries());

/** Best guess: the time zone (where the person is), then a region in the device language ("ar-AE"), else the fallback. */
export function guessCountry(opts: { languages?: readonly string[]; timeZone?: string; fallback?: CountryCode }): CountryCode {
  if (opts.timeZone && TIME_ZONE_COUNTRY[opts.timeZone]) return TIME_ZONE_COUNTRY[opts.timeZone];
  for (const l of opts.languages ?? []) {
    const region = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(l)?.[1]?.toUpperCase();
    if (region && COUNTRIES.has(region)) return region as CountryCode;
  }
  return opts.fallback ?? 'SA';
}

export const callingCode = (country: CountryCode) => getCountryCallingCode(country);

/**
 * What to show in the phone box while the user types. The library only groups digits when the local
 * trunk zero is typed ("055 789 8998"), but in the Gulf most people leave it out, so the digits are grouped
 * the international way and the country code is cut off ("55 789 8998"). A number typed with a leading "+" stays international.
 */
export function formatTyped(value: string, country: CountryCode): string {
  if (value.trim().startsWith('+')) return new AsYouType().input(value);
  const digits = value.replace(/\D/g, '');
  if (!digits || digits.startsWith('0')) return new AsYouType(country).input(digits);
  const prefix = `+${getCountryCallingCode(country)}`;
  return new AsYouType().input(prefix + digits).slice(prefix.length).trim();
}

/** Regional-indicator flag emoji. Some systems show the two letters instead, which is still readable. */
export const flagEmoji = (country: string) =>
  String.fromCodePoint(...[...country.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));

export interface CountryOption { code: CountryCode; name: string; dial: string; flag: string }

/** Every country, named in the given language and sorted by that name. */
export function listCountries(locale: string): CountryOption[] {
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch { /* unknown locale: fall back to codes */ }
  return getCountries()
    .map(code => ({ code, name: names?.of(code) ?? code, dial: getCountryCallingCode(code), flag: flagEmoji(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
