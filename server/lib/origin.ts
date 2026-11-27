// A second layer against cross-site request forgery. The session cookie is SameSite=Lax, which already stops a page on another
// SITE; this also stops a page on a sibling sub-domain (same site, different origin) and does not depend on the browser's cookie rules.
//
// The rule: a request that changes something, and the live-socket upgrade, may carry an `Origin` header only if it is this server's own
// address (the Host the request came to, or the address in THIKRA_PUBLIC_URL, which is what a browser shows behind a proxy).
//
// A request with NO Origin is allowed, on purpose, even with a cookie: a browser always sends Origin on a cross-site POST/PUT/PATCH/DELETE
// and on a WebSocket, so a missing one cannot be a forged browser request. It is the phone app, a script or a test, and anyone who
// holds the session token could send the same request without a browser anyway.

/** The host (with port) of an address, or null if it is not a plain http(s) address. */
const hostOf = (url: string): string | null => {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.toLowerCase() : null; } catch { return null; }
};

/** `origin`: the request's Origin header (undefined when absent). `hosts`: the Host header(s) this request came to. */
export function originAllowed(origin: string | undefined, hosts: Array<string | undefined>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (origin === undefined) return true;
  const host = hostOf(origin);   // 'null' (a sandboxed page) and anything unparsable give null: refused
  if (!host) return false;
  if (hosts.some(h => h && h.toLowerCase() === host)) return true;
  const pub = env.THIKRA_PUBLIC_URL ? hostOf(env.THIKRA_PUBLIC_URL) : null;
  return !!pub && pub === host;
}

/** The Host headers worth comparing: the one the request came to, and (only behind a proxy we were told to trust) the forwarded one. */
export const requestHosts = (host: string | undefined, forwardedHost: string | undefined, env: NodeJS.ProcessEnv = process.env) =>
  env.THIKRA_TRUST_PROXY === '1' ? [host, forwardedHost?.split(',')[0].trim()] : [host];

export const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
