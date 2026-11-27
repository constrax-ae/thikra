// Which mode the server runs in, said once at start-up. The behaviour itself (no on-screen codes, no automatic first admin)
// lives where it applies and reads `devMode()` from app.ts; this file only describes the choice so it can be printed and tested.
export type RunMode = 'production' | 'development' | 'closed';
export interface StartupMode { mode: RunMode; line: string; /** listen on this computer only */ localOnly: boolean; /** set when the server must not start: the reason, to print */ refuse?: string }

export function startupMode(env: NodeJS.ProcessEnv = process.env, smsProvider = ''): StartupMode {
  const prod = env.NODE_ENV === 'production' || !!env.REPLIT_DEPLOYMENT;
  const dev = env.THIKRA_DEV === '1';
  if (prod) return {
    mode: 'production', localOnly: false,
    // The console provider prints every phone number and code to the log: anyone who can read logs could sign in as anyone.
    // THIKRA_DEV=1 and THIKRA_SHOW_SIGNIN_CODES=1 are the two deliberate, noisy ways to run without a provider.
    ...(smsProvider === 'console' && !dev && env.THIKRA_SHOW_SIGNIN_CODES !== '1'
      ? { refuse: '[mode] Refusing to start in production with the console SMS provider: it prints each phone number and sign-in code to the log. Set THIKRA_SMS_PROVIDER (twilio or http), or THIKRA_DEV=1 if this is only a test.' } : {}),
    line: `[mode] PRODUCTION: sign-in codes are only sent by SMS${dev ? ' (THIKRA_DEV=1 is set but has no effect on codes or admins in production)' : ''}.`,
  };
  if (dev) return {
    mode: 'development', localOnly: true,
    line: '[mode] DEVELOPMENT MODE (THIKRA_DEV=1): anyone can sign in as anyone (the code is shown on screen) and the first person to register becomes admin. Listening on 127.0.0.1 only. Never use this for real families.',
  };
  return {
    mode: 'closed', localOnly: false,
    line: '[mode] NOT PRODUCTION and THIKRA_DEV is not set: sign-in codes are never shown and nobody becomes admin by registering first. Set NODE_ENV=production on a real server, or THIKRA_DEV=1 for local development.',
  };
}
