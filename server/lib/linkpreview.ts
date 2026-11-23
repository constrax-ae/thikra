import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { lookup } from 'node:dns/promises';
import { blobs } from '../storage.ts';
import { one, run } from '../db.ts';
import { sniff } from '../sniff.ts';

// ---- link previews -----------------------------------------------------------------------------
// The SENDER's device asks for a preview of a link it is about to send; the server fetches the page itself, so the site never
// learns who the person is or where they are. Because the server is made to fetch an address a person typed, the fetch is the
// dangerous part: it must never reach this machine, the private network around it or a cloud metadata address.
// Rules (tested in server/media.test.ts): http/https only, ports 80/443 only, no credentials in the address; the host is
// resolved first and EVERY address must be public; the connection is made to that checked address; each redirect is checked again.

export class UnsafeLink extends Error { code = 'unsafe_link'; constructor(why: string) { super(why); } }

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// Inside 2000::/3 (the only IPv6 space allowed at all): documentation, Teredo, 6to4 and other ranges that tunnel to an IPv4 address or are not real hosts.
const V6_BLOCKED: Array<[string, number]> = [['2001:db8::', 32], ['2001::', 23], ['2002::', 16], ['3fff::', 20]];
const v4Block = new net.BlockList(), v6Block = new net.BlockList(), v6Global = new net.BlockList();
for (const [a, n] of V4_BLOCKED) v4Block.addSubnet(a, n, 'ipv4');
for (const [a, n] of V6_BLOCKED) v6Block.addSubnet(a, n, 'ipv6');
v6Global.addSubnet('2000::', 3, 'ipv6');

/** Is this a public internet address? Anything that is not plainly one (loopback, private, link-local, mapped, tunnelled, reserved, malformed) is not. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !v4Block.check(ip, 'ipv4');
  if (net.isIPv6(ip) && !ip.includes('%')) return v6Global.check(ip, 'ipv6') && !v6Block.check(ip, 'ipv6');
  return false;
}

/** A link a person may ask a preview for, in one canonical form; null if it is not one. */
export function cleanLink(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  if (!u.hostname || !u.hostname.includes('.') && !u.hostname.includes(':')) return null;   // a bare name ("localhost", "intranet") is never a public site
  u.hash = '';
  return u;
}

type Addr = { address: string; family: number };
export interface FetchOptions { maxBytes: number; timeoutMs?: number; accept?: string; /** Tests only: replaces the address rule. */ allow?: (ip: string) => boolean }

async function resolvePublic(host: string, allow: (ip: string) => boolean): Promise<Addr> {
  const name = host.replace(/^\[|\]$/g, '');
  if (net.isIP(name)) {
    if (!allow(name)) throw new UnsafeLink('address');
    return { address: name, family: net.isIPv6(name) ? 6 : 4 };
  }
  const found = await lookup(name, { all: true, verbatim: true }).catch(() => [] as Addr[]);
  if (!found.length) throw new UnsafeLink('unresolved');
  if (found.some(a => !allow(a.address))) throw new UnsafeLink('address');   // one private answer among public ones is how a rebinding attack looks
  return found.find(a => a.family === 4) ?? found[0];
}

function requestOnce(u: URL, addr: Addr, o: FetchOptions, deadline: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      // The connection goes to the address that was checked, whatever DNS says a moment later.
      lookup: ((_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [addr]) : cb(null, addr.address, addr.family))) as any,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; TamtimLinkPreview/1.0)',   // says what it is; it does not pretend to be a browser or another company's crawler
        accept: o.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': 'en,ar;q=0.8', 'accept-encoding': 'gzip, deflate, br',
      },
      agent: false,
    }, res => {
      const chunks: Buffer[] = []; let size = 0, truncated = false;
      res.on('data', (d: Buffer) => {
        size += d.length; chunks.push(d);
        if (size > o.maxBytes) { truncated = true; res.destroy(); done(); }
      });
      res.on('end', done); res.on('error', () => done());
      function done() { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, o.maxBytes), truncated }); }
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); }, Math.max(1, deadline - Date.now()));
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

/** Unpack a compressed body, but never more than `max` bytes of it: a few hundred bytes can claim to be a gigabyte. Null if it cannot be read. */
function decode(body: Buffer, encoding: string | undefined, max: number): Buffer | null {
  if (!encoding || encoding === 'identity') return body;
  const make = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip : encoding === 'deflate' ? zlib.createInflate : encoding === 'br' ? zlib.createBrotliDecompress : null;
  if (!make) return null;
  // Fed in small steps and stopped the moment enough has come out, so the work done is bounded by `max`, not by what the body claims to hold.
  const out: Buffer[] = []; let size = 0;
  try {
    const z = make({ chunkSize: 64 * 1024 }) as zlib.Gunzip & { _processChunk(chunk: Buffer, flush: number): Buffer };
    const flush = encoding === 'br' ? zlib.constants.BROTLI_OPERATION_FLUSH : zlib.constants.Z_SYNC_FLUSH;
    for (let at = 0; at < body.length && size < max; at += 4096) {
      const piece = z._processChunk(body.subarray(at, at + 4096), flush);
      out.push(piece); size += piece.length;
    }
    z.close();
  } catch { if (!size) return null; /* a body cut at the limit ends badly: what came out before is still good */ }
  return Buffer.concat(out).subarray(0, max);
}

/** Fetch a public web address safely. Follows at most 3 redirects, checking each one. Throws UnsafeLink for an address that must not be fetched. */
export async function safeGet(start: URL, o: FetchOptions): Promise<{ url: URL; type: string; body: Buffer; truncated: boolean } | null> {
  const allow = o.allow ?? isPublicAddress;
  const deadline = Date.now() + (o.timeoutMs ?? 5000);
  let u = start;
  for (let hop = 0; hop <= 3; hop++) {
    if (!o.allow && !cleanLink(u.href)) throw new UnsafeLink('address');
    const addr = await resolvePublic(u.hostname, allow);
    const res = await requestOnce(u, addr, o, deadline).catch(() => null);
    if (!res) return null;
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const to = res.headers.location;
      if (!to) return null;
      try { u = new URL(to, u); } catch { return null; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeLink('protocol');
      continue;
    }
    if (res.status < 200 || res.status >= 300) return null;
    const body = decode(res.body, String(res.headers['content-encoding'] ?? '').toLowerCase() || undefined, o.maxBytes);
    if (!body) return null;
    return { url: u, type: String(res.headers['content-type'] ?? '').toLowerCase(), body: body.subarray(0, o.maxBytes), truncated: res.truncated };
  }
  return null;   // too many redirects
}

// ---- reading the page --------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, e: string) => {
  const k = e.toLowerCase();
  if (k in ENTITIES) return ENTITIES[k];
  const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
});
const tidy = (s: string | undefined, max: number) => unescape(s ?? '').replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Every <meta ...> tag of a page, found by walking it once (a tag longer than 4000 characters, or never closed, is skipped). */
function metaTags(head: string): string[] {
  const out: string[] = [], low = head.toLowerCase();
  for (let at = low.indexOf('<meta'); at !== -1 && out.length < 400; at = low.indexOf('<meta', at + 5)) {
    const end = low.indexOf('>', at);
    if (end === -1) break;
    if (end - at <= 4000 && /\s/.test(low[at + 5] ?? '')) out.push(head.slice(at, end + 1));
  }
  return out;
}
function titleOf(head: string): string | undefined {
  const low = head.toLowerCase();
  const open = low.indexOf('<title'); if (open === -1) return undefined;
  const start = low.indexOf('>', open); if (start === -1) return undefined;
  const end = low.indexOf('</title', start);
  return end === -1 ? undefined : head.slice(start + 1, Math.min(end, start + 1 + 2000));
}
export interface PagePreview { title: string; description: string; site: string; image: string | null }
/** What a page says about itself (Open Graph, Twitter card, or its plain title). Null if it has no usable title. Pure: no network. */
export function parsePreview(html: string, base: URL): PagePreview | null {
  const head = html.slice(0, 300_000);
  const meta = new Map<string, string>();
  for (const tag of metaTags(head)) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
  }
  const pick = (...keys: string[]) => keys.map(k => meta.get(k)).find(v => v && v.trim());
  const title = tidy(pick('og:title', 'twitter:title') ?? titleOf(head), 200);
  if (!title) return null;
  let image: string | null = null;
  const rawImage = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (rawImage) { try { const u = new URL(unescape(rawImage.trim()), base); if (u.protocol === 'http:' || u.protocol === 'https:') image = u.href; } catch { /* no picture */ } }
  return { title, description: tidy(pick('og:description', 'twitter:description', 'description'), 300), site: tidy(pick('og:site_name'), 60) || base.hostname.replace(/^www\./, ''), image };
}
function htmlText(body: Buffer, type: string): string {
  const label = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8';
  try { return new TextDecoder(label).decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

// ---- the preview of a link, cached -------------------------------------------------------------

export interface Preview { url: string; title: string; description: string; site: string; image: string | null }
type Fetcher = (u: URL) => Promise<{ page: PagePreview; image: { buf: Buffer; mime: string } | null } | null>;

/** YouTube shows a consent page to an unknown visitor, so its videos are asked through its public "oEmbed" address, made for exactly this. */
const YOUTUBE = /^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/;
export function fromOembed(json: unknown, site: string): PagePreview | null {
  const o = json as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown } | null;
  const title = tidy(typeof o?.title === 'string' ? o.title : '', 200);
  if (!title) return null;
  let image: string | null = null;
  if (typeof o?.thumbnail_url === 'string') { try { const u = new URL(o.thumbnail_url); if (u.protocol === 'https:') image = u.href; } catch { /* no picture */ } }
  return { title, description: tidy(typeof o?.author_name === 'string' ? o.author_name : '', 300), site, image };
}
async function pictureOf(address: string | null): Promise<{ buf: Buffer; mime: string } | null> {
  if (!address) return null;
  const pic = await safeGet(new URL(address), { maxBytes: 1024 * 1024, accept: 'image/*' }).catch(() => null);
  const sn = pic && !pic.truncated ? sniff(pic.body) : null;
  return pic && sn?.family === 'image' && sn.inline ? { buf: pic.body, mime: sn.mime } : null;   // judged by its bytes, like any upload
}
const realFetcher: Fetcher = async u => {
  if (YOUTUBE.test(u.hostname)) {
    const res = await safeGet(new URL(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`), { maxBytes: 64 * 1024, accept: 'application/json' });
    let page: PagePreview | null = null;
    try { page = res ? fromOembed(JSON.parse(res.body.toString('utf8')), 'YouTube') : null; } catch { /* not JSON */ }
    return page ? { page, image: await pictureOf(page.image) } : null;
  }
  const res = await safeGet(u, { maxBytes: 512 * 1024 });
  if (!res || !/^(text\/html|application\/xhtml\+xml)/.test(res.type)) return null;
  const page = parsePreview(htmlText(res.body, res.type), res.url);
  if (!page) return null;
  const image = await pictureOf(page.image);
  return { page, image };
};
let fetcher: Fetcher = realFetcher;
/** Tests replace the network. */
export const setPreviewFetcher = (f: Fetcher | null) => { fetcher = f ?? realFetcher; };

const FRESH_MS = 7 * 24 * 3600_000, RETRY_MS = 3600_000;
const view = (r: any): Preview | null => (r?.title ? { url: r.url, title: r.title, description: r.description ?? '', site: r.site ?? '', image: r.image_hash ?? null } : null);
/** The stored preview of a link, if the server has a fresh one. */
export function cachedPreview(u: URL): Preview | null {
  return view(one('SELECT * FROM link_previews WHERE url = ? AND fetched_at > ?', u.href, Date.now() - FRESH_MS));
}
/** The preview of a link: from the store if fresh, otherwise fetched now. A link that gave nothing is not asked again for an hour. Throws UnsafeLink. */
export async function previewOf(u: URL): Promise<Preview | null> {
  const row = one('SELECT * FROM link_previews WHERE url = ?', u.href);
  if (row && row.fetched_at > Date.now() - (row.title ? FRESH_MS : RETRY_MS)) return view(row);
  const got = await fetcher(u);
  let hash: string | null = null;
  if (got?.image) { const put = await blobs.put(got.image.buf); hash = put.hash; run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', put.hash, put.size); }
  run('INSERT OR REPLACE INTO link_previews (url, title, description, site, image_hash, image_mime, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    u.href, got?.page.title ?? null, got?.page.description ?? null, got?.page.site ?? null, hash, got?.image?.mime ?? null, Date.now());
  return got ? { url: u.href, title: got.page.title, description: got.page.description, site: got.page.site, image: hash } : null;
}
