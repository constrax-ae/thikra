// Which mode the server runs in, said once at start-up. The behaviour itself (no on-screen codes, no automatic first admin)
// lives where it applies and reads `devMode()` from app.ts; this file only describes the choice so it can be printed and tested.
export type RunMode = 'production' | 'development' | 'closed';
export interface StartupMode { mode: RunMode; line: string; /** listen on this computer only */ localOnly: boolean }

export function startupMode(env: NodeJS.ProcessEnv = process.env, smsProvider = ''): StartupMode {
  const prod = env.NODE_ENV === 'production' || !!env.REPLIT_DEPLOYMENT;
  const dev = env.THIKRA_DEV === '1';
  if (prod) return {
    mode: 'production', localOnly: false,
    line: `[mode] PRODUCTION: sign-in codes are only sent by SMS${dev ? ' (THIKRA_DEV=1 is set but has no effect on codes or admins in production)' : ''}.`
      // No provider yet: say so loudly. The console provider prints neither the number nor the code in production (sms.ts).
      + (smsProvider === 'console' ? ' WARNING: no SMS provider is set (THIKRA_SMS_PROVIDER), so no codes are sent; codes are never printed to the log in production.' : ''),
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
