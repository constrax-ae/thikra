import { safeGet } from './linkpreview.ts';

// ---- GIFs --------------------------------------------------------------------------------------
// Search and thumbnails go THROUGH this server (with the provider key, which never reaches a device), so the provider sees the
// server and not the person. A GIF that is sent is copied into the chat like a photo. Provider: GIPHY (set GIPHY_API_KEY).
// Without a key everything here answers "not set up" and the rest of the app is unaffected.

export interface Gif { id: string; title: string; preview: { url: string; w: number; h: number }; full: { url: string; w: number; h: number } }
export interface GifProvider {
  search(q: string, offset: number): Promise<Gif[]>;
  byId(id: string): Promise<Gif | null>;
  /** The bytes of one of the provider's own picture addresses, or null. */
  download(url: string, maxBytes: number): Promise<Buffer | null>;
}

const num = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 4000 ? n : 0; };
function fromGiphy(g: any): Gif | null {
  const full = g?.images?.fixed_height, small = g?.images?.fixed_height_small ?? g?.images?.fixed_width_small ?? full;
  if (typeof g?.id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(g.id) || typeof full?.url !== 'string' || typeof small?.url !== 'string') return null;
  return { id: g.id, title: String(g.title ?? '').slice(0, 120), preview: { url: small.url, w: num(small.width), h: num(small.height) }, full: { url: full.url, w: num(full.width), h: num(full.height) } };
}
export function giphy(key: string): GifProvider {
  const call = async (path: string, params: Record<string, string>) => {
    const u = new URL(`https://api.giphy.com/v1/gifs${path}`);
    for (const [k, v] of Object.entries({ api_key: key, rating: 'g', ...params })) u.searchParams.set(k, v);
    const res = await fetch(u, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (!res?.ok) return [];
    const data = (await res.json().catch(() => ({})) as any).data;
    return (Array.isArray(data) ? data : []).map(fromGiphy).filter((g): g is Gif => !!g);
  };
  return {
    search: (q, offset) => (q ? call('/search', { q, limit: '24', offset: String(offset) }) : call('/trending', { limit: '24', offset: String(offset) })),
    byId: async id => (await call('', { ids: id }))[0] ?? null,
    async download(url, maxBytes) {
      let u: URL; try { u = new URL(url); } catch { return null; }
      if (u.protocol !== 'https:' || !/(^|\.)giphy\.com$/.test(u.hostname)) return null;   // only the provider's own picture hosts
      const res = await safeGet(u, { maxBytes, accept: 'image/*' }).catch(() => null);
      return res && !res.truncated ? res.body : null;
    },
  };
}

let provider: GifProvider | null | undefined;
export const gifProvider = (): GifProvider | null => (provider !== undefined ? provider : (provider = process.env.GIPHY_API_KEY?.trim() ? giphy(process.env.GIPHY_API_KEY.trim()) : null));
/** Tests (and a different provider later) replace it. */
export const setGifProvider = (p: GifProvider | null) => { provider = p; seen.clear(); thumbs.clear(); };

// What search results said about each GIF, and the thumbnails already fetched: small, in memory, oldest out first.
const seen = new Map<string, Gif>(), thumbs = new Map<string, Buffer>();
const remember = <T>(map: Map<string, T>, k: string, v: T, max: number) => { map.delete(k); map.set(k, v); if (map.size > max) map.delete(map.keys().next().value!); };

export async function searchGifs(q: string, offset: number): Promise<Gif[]> {
  const p = gifProvider(); if (!p) return [];
  const found = await p.search(q, offset);
  for (const g of found) remember(seen, g.id, g, 3000);
  return found;
}
/** Has a search just listed this GIF (so that using it costs the provider nothing more)? */
export const gifKnown = (id: string) => seen.has(id) || thumbs.has(id);
export async function gifById(id: string): Promise<Gif | null> {
  const p = gifProvider(); if (!p || !/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
  const g = seen.get(id) ?? await p.byId(id);
  if (g) remember(seen, g.id, g, 3000);
  return g;
}
export async function gifThumb(id: string): Promise<Buffer | null> {
  const had = thumbs.get(id); if (had) return had;
  const g = await gifById(id); if (!g) return null;
  const buf = await gifProvider()!.download(g.preview.url, 2 * 1024 * 1024);
  if (buf) remember(thumbs, id, buf, 400);
  return buf;
}
