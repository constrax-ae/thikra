import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const KEY = 'thekra.session';
let cookie: string | null = null;
const web = Platform.OS === 'web';   // a browser sends its own cookies; it may not set the Cookie header by hand

export class ApiError extends Error { constructor(public code: string, public status: number) { super(code); } }

export const sessionCookie = () => cookie;
export async function loadSession(): Promise<boolean> {
  if (web) return true;   // the browser may already hold a session: /me decides
  try { cookie = await SecureStore.getItemAsync(KEY); } catch { cookie = null; }
  return !!cookie;
}
export async function clearSession() { cookie = null; try { await SecureStore.deleteItemAsync(KEY); } catch { /* nothing to clear */ } }

/** Calls the same API the web app uses. The session is the server's cookie, kept in the phone's secure storage and sent by hand (no shared cookie jar). */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(cookie && !web ? { cookie } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: web ? 'include' : 'omit',
    });
  } catch { throw new ApiError('offline', 0); }
  const set = web ? null : res.headers.get('set-cookie');
  if (set) { cookie = set.split(';')[0]; try { await SecureStore.setItemAsync(KEY, cookie); } catch { /* keep it in memory */ } }
  const text = await res.text();
  let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  if (res.status === 401) { await clearSession(); throw new ApiError('unauthorized', 401); }
  if (!res.ok) throw new ApiError(json.error ?? 'generic', res.status);
  return json as T;
}

export interface Chat { id: number; kind: 'circle' | 'group' | 'direct'; name: string; unread: number; muted: boolean; pinned: boolean; lastText: string; lastKind: string | null; lastAt: string; lastAuthor: string | null; lastFromMe: boolean }
export interface Attachment { id: number; kind: 'image' | 'video' | 'file'; name: string | null; w: number | null; h: number | null; thumb: number | null }
export interface Msg { id: number; userId: number | null; author: string | null; kind: 'text' | 'voice' | 'system'; body: string; createdAt: string; deleted: number; hasAudio?: number; audioMs?: number | null; attachments?: Attachment[] }
export interface Me { id: number; name: string }

/** What a picture or a voice file needs to be fetched: the session cookie (a browser sends its own). */
export const mediaSource = (path: string) => ({ uri: `${API_URL}${path}`, ...(cookie && !web ? { headers: { cookie } } : {}) });

/** Send one picture to a chat. `file` is what the picker gave us: on a phone a local file reference, in a browser a Blob. */
export async function sendPhoto(circleId: number, file: { uri: string; name: string; type: string }, blob?: Blob) {
  const form = new FormData();
  form.append('file', (blob ?? ({ uri: file.uri, name: file.name, type: file.type } as unknown)) as Blob, file.name);
  form.append('client_msg_id', `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const res = await fetch(`${API_URL}/api/circles/${circleId}/attachments`, { method: 'POST', headers: cookie && !web ? { cookie } : {}, body: form, credentials: web ? 'include' : 'omit' });
  if (!res.ok) { const j: any = await res.json().catch(() => ({})); throw new ApiError(j.error ?? 'generic', res.status); }
}
