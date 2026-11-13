// A setting that is present but blank is not a setting.
//
// Both ways secrets reach this server produce an EMPTY STRING for "left blank": a `.env` file where a line reads
// `THIKRA_DB=` with nothing after it, and a hosting dashboard where someone saves a field without typing in it. But
// `process.env.X ?? 'default'` only falls back when X is undefined, so an empty string wins over every default in the
// codebase. The results are quiet and nasty:
//
//   THIKRA_DB=              an empty database path
//   THIKRA_SMS_DAILY_CAP=   Number('') is 0, so the cap is zero and NOT ONE sign-in code is ever sent
//   PORT=                   Number('') is 0, so the server listens on a random port
//   THIKRA_PUSH_SUBJECT=    an empty VAPID subject, and push services reject the notification
//
// Rather than guard twenty-odd call sites and have the next one forget, blank is turned into absent once, here, before
// anything reads a setting. This module must be imported FIRST in server/index.ts: ES modules run in import order, so
// anything imported above it would read its settings before this ran.
export const BLANKED: string[] = [];
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && value.trim() === '') { delete process.env[key]; BLANKED.push(key); }
}
