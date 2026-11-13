// Sending verification codes by SMS. The provider is chosen by configuration, so going live means setting environment
// variables, not changing code. NOT YET TRIED AGAINST A REAL PROVIDER: every adapter here is tested against a fake endpoint only.
//
//   THIKRA_SMS_PROVIDER=console      (default) prints the code to the server log. Development only.
//   THIKRA_SMS_PROVIDER=twilio       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (a number) or TWILIO_MESSAGING_SERVICE_SID
//   THIKRA_SMS_PROVIDER=http         any provider with an HTTP API, described by configuration alone (see httpProvider below).
//                                    Regional providers each have their own shape and no shared standard; this exists so a new
//                                    one is a secret to set rather than a release to wait for.
//
// Cost and fraud protection (SMS pumping is the classic way an app gets a huge bill):
//   THIKRA_SMS_ALLOWED_CODES="966,971,962"   only these country calling codes may receive codes (default: all)
//   THIKRA_SMS_DAILY_CAP=2000                the most messages this server will send per day (default 2000), whatever happens

export interface SmsProvider { name: string; send(to: string, text: string): Promise<void> }

export class SmsError extends Error { constructor(public code: 'sms_unavailable' | 'sms_failed' | 'sms_blocked', msg: string) { super(msg); } }

export const consoleProvider: SmsProvider = {
  name: 'console',
  async send(to, text) { console.log(`[sms:console] ${to} -> ${text}`); },
};

export function twilioProvider(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): SmsProvider {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN, from = env.TWILIO_FROM, service = env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || (!from && !service)) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID) are required');
  return {
    name: 'twilio',
    async send(to, text) {
      const body = new URLSearchParams({ To: to, Body: text });
      if (service) body.set('MessagingServiceSid', service); else body.set('From', from!);
      let res: Response;
      try {
        res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch { throw new SmsError('sms_failed', 'the SMS provider could not be reached'); }
      if (!res.ok) throw new SmsError('sms_failed', `the SMS provider answered ${res.status}`);
    },
  };
}

/**
 * Any SMS provider with an HTTP API, described entirely by configuration:
 *
 *   THIKRA_SMS_URL      https://api.example.com/send           required. May itself contain placeholders (for GET-style APIs).
 *   THIKRA_SMS_METHOD   POST (default) or GET
 *   THIKRA_SMS_HEADERS  {"Authorization":"Bearer xyz"}          a JSON object. content-type defaults to application/json.
 *   THIKRA_SMS_BODY     {"to":"{to}","message":"{text}"}        required for POST. Sent as written, with the placeholders filled.
 *   THIKRA_SMS_OK       "status":"queued"                       optional. Text that must appear in the answer for it to count as sent.
 *
 * Placeholders: {to} the number in E.164 (+9715…), {to_digits} the same without the plus (many regional APIs want that),
 * {text} the message. Each is escaped for where it lands: JSON-escaped in a JSON body, percent-encoded in a URL or a form body,
 * so an Arabic message or an unexpected character cannot break the request or smuggle fields into it.
 */
export function httpProvider(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): SmsProvider {
  const url = (env.THIKRA_SMS_URL ?? '').trim();
  if (!url) throw new Error('THIKRA_SMS_URL is required when THIKRA_SMS_PROVIDER=http');
  const method = (env.THIKRA_SMS_METHOD ?? 'POST').trim().toUpperCase();
  if (method !== 'POST' && method !== 'GET') throw new Error('THIKRA_SMS_METHOD must be POST or GET');
  let headers: Record<string, string> = {};
  if ((env.THIKRA_SMS_HEADERS ?? '').trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.THIKRA_SMS_HEADERS!); } catch { throw new Error('THIKRA_SMS_HEADERS must be a JSON object'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('THIKRA_SMS_HEADERS must be a JSON object');
    headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  const bodyTemplate = env.THIKRA_SMS_BODY ?? '';
  if (method === 'POST' && !bodyTemplate.trim()) throw new Error('THIKRA_SMS_BODY is required when THIKRA_SMS_METHOD=POST');
  if (method === 'POST' && !headers['content-type']) headers['content-type'] = 'application/json';
  const expect = (env.THIKRA_SMS_OK ?? '').trim();

  // How a value must be escaped depends on where it is being put, not on what it is.
  const fill = (template: string, to: string, text: string, how: 'json' | 'url') => {
    const esc = how === 'json' ? (v: string) => JSON.stringify(v).slice(1, -1) : encodeURIComponent;
    return template.replace(/\{(to|to_digits|text)\}/g, (_m, k) => esc(k === 'to' ? to : k === 'to_digits' ? to.replace(/^\+/, '') : text));
  };

  return {
    name: 'http',
    async send(to, text) {
      const bodyIsJson = (headers['content-type'] ?? '').includes('json');
      const target = fill(url, to, text, 'url');                            // a URL is always percent-encoded
      const body = method === 'POST' ? fill(bodyTemplate, to, text, bodyIsJson ? 'json' : 'url') : undefined;
      let res: Response;
      try {
        res = await fetchFn(target, { method, headers, body, signal: AbortSignal.timeout(10_000) });
      } catch { throw new SmsError('sms_failed', 'the SMS provider could not be reached'); }
      if (!res.ok) throw new SmsError('sms_failed', `the SMS provider answered ${res.status}`);
      if (expect) {
        // Some providers answer 200 with a failure in the body, which would silently swallow every code.
        const answer = await res.text().catch(() => '');
        if (!answer.includes(expect)) throw new SmsError('sms_failed', 'the SMS provider did not confirm the message');
      }
    },
  };
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const name = (env.THIKRA_SMS_PROVIDER ?? 'console').trim().toLowerCase();
  if (name === 'console' || name === '') return consoleProvider;
  if (name === 'twilio') return twilioProvider(env);
  if (name === 'http') return httpProvider(env);
  throw new Error(`unknown THIKRA_SMS_PROVIDER "${name}"`);
}

/** The calling code of an E.164 number among the allowed list, or null if it is not allowed. An empty list allows everyone. */
export function allowedCountry(phone: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const digits = phone.replace(/^\+/, '');
  return allowed.some(code => digits.startsWith(code));
}

let day = '', sentToday = 0;
/** Counts a message against today's cap. Returns false (and sends nothing) once the cap is reached. */
export function takeDailyBudget(cap: number, now = new Date()): boolean {
  const d = now.toISOString().slice(0, 10);
  if (d !== day) { day = d; sentToday = 0; }
  if (sentToday >= cap) return false;
  sentToday++;
  return true;
}
export const resetDailyBudget = () => { day = ''; sentToday = 0; };
export const sentTodayCount = () => (day === new Date().toISOString().slice(0, 10) ? sentToday : 0);

const OTP: Record<string, (code: string) => string> = {
  ar: c => `رمز ذكرى: ${c}. لا تشاركه مع أحد.`,
  en: c => `Thekra code: ${c}. Do not share it with anyone.`,
  ur: c => `Thekra کوڈ: ${c}۔ اسے کسی کے ساتھ شیئر نہ کریں۔`,
  hi: c => `Thekra कोड: ${c}। इसे किसी के साथ साझा न करें।`,
  tl: c => `Thekra code: ${c}. Huwag itong ibahagi kaninuman.`,
  fr: c => `Code Thekra : ${c}. Ne le partagez avec personne.`,
  ml: c => `Thekra കോഡ്: ${c}. ഇത് ആരുമായും പങ്കിടരുത്.`,
  bn: c => `Thekra কোড: ${c}। এটি কারো সঙ্গে শেয়ার করবেন না।`,
  fa: c => `کد Thekra: ${c}. آن را با کسی در میان نگذارید.`,
  tr: c => `Thekra kodu: ${c}. Kimseyle paylaşmayın.`,
  es: c => `Código de Thekra: ${c}. No lo compartas con nadie.`,
  ru: c => `Код Thekra: ${c}. Никому его не сообщайте.`,
  zh: c => `Thekra 验证码：${c}。请勿告诉任何人。`,
  de: c => `Thekra-Code: ${c}. Gib ihn an niemanden weiter.`,
  it: c => `Codice Thekra: ${c}. Non condividerlo con nessuno.`,
  pt: c => `Código Thekra: ${c}. Não o compartilhe com ninguém.`,
  nl: c => `Thekra-code: ${c}. Deel hem met niemand.`,
  pl: c => `Kod Thekra: ${c}. Nie udostępniaj go nikomu.`,
  uk: c => `Код Thekra: ${c}. Нікому його не повідомляйте.`,
  el: c => `Κωδικός Thekra: ${c}. Μην τον μοιραστείτε με κανέναν.`,
  sv: c => `Thekra-kod: ${c}. Dela den inte med någon.`,
};
/** The sign-in code message, in the person's language (Arabic by default when none is known; English for a language we have no template for). */
export const otpText = (code: string, lang: string = 'ar') => (OTP[lang] ?? OTP.en)(code);
