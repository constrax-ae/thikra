// Sending verification codes by SMS. The provider is chosen by configuration, so going live means setting environment
// variables, not changing code. NOT YET TRIED AGAINST A REAL PROVIDER: the Twilio adapter is tested against a fake endpoint only.
//
//   THIKRA_SMS_PROVIDER=console      (default) prints the code to the server log. Development only.
//   THIKRA_SMS_PROVIDER=twilio       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (a number) or TWILIO_MESSAGING_SERVICE_SID
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

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const name = (env.THIKRA_SMS_PROVIDER ?? 'console').toLowerCase();
  if (name === 'console') return consoleProvider;
  if (name === 'twilio') return twilioProvider(env);
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
