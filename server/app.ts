import { Hono } from 'hono';
import { type Row } from './db.ts';
import { count, log, observe } from './metrics.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizePhone } from '../core/phone.ts';
import { logError } from './lib/jobs.ts';
import { STATE_CHANGING, originAllowed, requestHosts } from './lib/origin.ts';

// A published deployment (Replit sets REPLIT_DEPLOYMENT there) is production even if NODE_ENV was never set: it is on the open internet.
export const PROD = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT;
/**
 * Development mode is something somebody turns on ON PURPOSE (THIKRA_DEV=1), never something a missing setting leaves behind.
 * It is the only thing that (a) puts the sign-in code in the answer to /api/auth/request and (b) makes the first person to register
 * platform admin. Read at the moment of use so a test can switch it. It never applies in production.
 */
export const devMode = () => process.env.THIKRA_DEV === '1' && !PROD;
/** Where new people's and circles' data is placed (LAUNCH-PLAN D4). Stored only for now; unset means unassigned. */
export const REGION = (process.env.THIKRA_REGION ?? '').trim().toLowerCase() || null;
// Who may administer the platform. Set THIKRA_ADMIN_PHONES="+9665...,+9715..." to name them explicitly (required in production).
// Without it (development only) the first person to register becomes admin, which is exactly the hole this closes for real deployments.
export const ADMIN_PHONES = new Set((process.env.THIKRA_ADMIN_PHONES ?? '').split(',').map(x => normalizePhone(x.trim())).filter((x): x is string => !!x));
if (PROD && ADMIN_PHONES.size === 0) console.warn('[admin] THIKRA_ADMIN_PHONES is not set: nobody can administer this platform (and nobody is made admin by registering first).');
// Said at every start, because it is the kind of setting that gets switched on for an afternoon's demo and left on for a year.
if (PROD && process.env.THIKRA_SHOW_SIGNIN_CODES === '1') console.warn('[auth] THIKRA_SHOW_SIGNIN_CODES=1: the sign-in code is shown on screen for EVERY number. Anyone who knows a person\'s number can sign in as them. Turn this off before real families use this server.');
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const today = () => new Date().toISOString().slice(0, 10);
export type Env = { Variables: { user: Row; sessionId: number } };
export const app = new Hono<Env>();
// Every request gets an id (returned to the caller, so a bug report can quote it) and one log line:
// method, route pattern (not the URL, which can hold ids and codes), status and time. Never a body or a query string.
app.use('*', async (c, next) => {
  const id = c.req.header('x-request-id')?.slice(0, 64) || randomBytes(6).toString('hex');
  const t = performance.now();
  await next();
  const ms = performance.now() - t;
  c.header('x-request-id', id);
  if (c.req.path.startsWith('/api/')) { observe('http_ms', ms); count(`http_${Math.floor(c.res.status / 100)}xx`); }
  log('http', { id, method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Math.round(ms * 10) / 10 });
});
// Security headers on every response (THREAT-MODEL: "رؤوس الأمان"). The CSP allows only this site's own files, so an injected
// script cannot run or phone home. Attachment responses set their own stricter CSP and keep it.
// Tajawal is self-hosted (web/public/fonts), so NOTHING is fetched from Google any more: the policy names no outside host at all.
// It used to allow only fonts.gstatic.com for font-src, which silently blocked every one of the app's own font files and left
// this Arabic-first app rendering in whatever the device happened to have.
const FRAME_ANCESTORS = process.env.THIKRA_FRAME_ANCESTORS?.trim() || "'none'";
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self' ws: wss:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`,
].join('; ');
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('content-security-policy')) h.set('content-security-policy', CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('permissions-policy', 'microphone=(self), camera=(self), geolocation=(self)');
  if (FRAME_ANCESTORS === "'none'") h.set('x-frame-options', 'DENY');
  if (PROD) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
});
// Cross-site request forgery, second layer (see lib/origin.ts): a request that changes something must not come from another origin.
app.use('/api/*', async (c, next) => {
  if (STATE_CHANGING.has(c.req.method) && !originAllowed(c.req.header('origin'), requestHosts(c.req.header('host') ?? new URL(c.req.url).host, c.req.header('x-forwarded-host')))) return c.json({ error: 'bad_origin' }, 403);
  await next();
});
// An unexpected error: the caller gets a plain JSON 500 (never a stack), and the route pattern plus a short message go to the durable error log.
app.onError((err, c) => {
  if ((err as { code?: string })?.code === 'encrypted_chat') return c.json({ error: 'encrypted_chat' }, 409);   // readable text sent to an encrypted chat (lib/e2ee.ts)
  if ((err as { code?: string })?.code === 'admins_only') return c.json({ error: 'admins_only' }, 403);   // the group lets only admins send (lib/helpers.ts: mayPost)
  logError('http', c.req.routePath ?? null, err instanceof Error ? err.message : err);
  console.error('[http]', c.req.method, c.req.routePath, err);
  return c.json({ error: 'server' }, 500);
});
// Liveness for a load balancer or uptime check: no data, no auth.
app.get('/healthz', c => c.json({ ok: true }));
