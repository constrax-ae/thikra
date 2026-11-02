import { Hono } from 'hono';
import { type Row } from './db.ts';
import { count, log, observe } from './metrics.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizePhone } from '../core/phone.ts';
import { logError } from './lib/jobs.ts';

// A published deployment (Replit sets REPLIT_DEPLOYMENT there) is production even if NODE_ENV was never set: it is on the open internet.
export const PROD = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT;
/** Where new people's and circles' data is placed (LAUNCH-PLAN D4). Stored only for now; unset means unassigned. */
export const REGION = (process.env.THIKRA_REGION ?? '').trim().toLowerCase() || null;
// Who may administer the platform. Set THIKRA_ADMIN_PHONES="+9665...,+9715..." to name them explicitly (required in production).
// Without it (development only) the first person to register becomes admin, which is exactly the hole this closes for real deployments.
export const ADMIN_PHONES = new Set((process.env.THIKRA_ADMIN_PHONES ?? '').split(',').map(x => normalizePhone(x.trim())).filter((x): x is string => !!x));
if (PROD && ADMIN_PHONES.size === 0) console.warn('[admin] THIKRA_ADMIN_PHONES is not set: nobody can administer this platform (and nobody is made admin by registering first).');
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const today = () => new Date().toISOString().slice(0, 10);
export type Env = { Variables: { user: Row } };
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
// Security headers on every response (THREAT-MODEL: "رؤوس الأمان"). The CSP allows only this site's own scripts and the Google
// font host, so an injected script cannot run or phone home. Attachment responses set their own stricter CSP and keep it.
const FRAME_ANCESTORS = process.env.THIKRA_FRAME_ANCESTORS?.trim() || "'none'";
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self' ws: wss:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`,
].join('; ');
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('content-security-policy')) h.set('content-security-policy', CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('permissions-policy', 'microphone=(self), camera=(self), geolocation=()');
  if (FRAME_ANCESTORS === "'none'") h.set('x-frame-options', 'DENY');
  if (PROD) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
});
// An unexpected error: the caller gets a plain JSON 500 (never a stack), and the route pattern plus a short message go to the durable error log.
app.onError((err, c) => {
  logError('http', c.req.routePath ?? null, err instanceof Error ? err.message : err);
  console.error('[http]', c.req.method, c.req.routePath, err);
  return c.json({ error: 'server' }, 500);
});
// Liveness for a load balancer or uptime check: no data, no auth.
app.get('/healthz', c => c.json({ ok: true }));
