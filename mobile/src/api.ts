import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const KEY = 'thekra.session';
let cookie: string | null = null;
const web = Platform.OS === 'web';   // a browser sends its own cookies; it may not set the Cookie header by hand

export class ApiError extends Error { constructor(public code: string, public status: number) { super(code); } }

export const sessionCookie = () => cookie;
/**
 * The session as request headers. iOS may replace a hand-set Cookie with its own cookie store
 * (sometimes holding an old session), so the token also travels in x-thikra-session, a header
 * iOS leaves alone; the server accepts whichever of the two is valid.
 */
export const sessionHeaders = (): Record<string, string> | undefined =>
  (cookie && !web ? { cookie, 'x-thikra-session': cookie.slice(cookie.indexOf('=') + 1) } : undefined);
/** The session from memory, or from secure storage if memory lost it. */
async function ensureSession() {
  if (!cookie && !web) { try { cookie = await SecureStore.getItemAsync(KEY); } catch { /* none */ } }
  return cookie;
}
export async function loadSession(): Promise<boolean> {
  if (web) return true;   // the browser may already hold a session: /me decides
  try { cookie = await SecureStore.getItemAsync(KEY); } catch { cookie = null; }
  return !!cookie;
}
export async function clearSession() { cookie = null; try { await SecureStore.deleteItemAsync(KEY); } catch { /* nothing to clear */ } }

/** Calls the same API the web app uses. The session is the server's cookie, kept in the phone's secure storage and sent by hand (no shared cookie jar). */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  const sent = await ensureSession();
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...sessionHeaders() },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: web ? 'include' : 'omit',
    });
  } catch { throw new ApiError('offline', 0); }
  const set = web ? null : res.headers.get('set-cookie');
  if (set) { cookie = set.split(';')[0]; try { await SecureStore.setItemAsync(KEY, cookie); } catch { /* keep it in memory */ } }
  const text = await res.text();
  let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  if (res.status === 401) {
    // Forget the login only when this request carried it and the server refused it.
    console.warn('[api] 401', opts.method ?? (opts.body ? 'POST' : 'GET'), path, sent ? 'with a session' : 'without a session');
    if (sent && !web) await clearSession();
    throw new ApiError('unauthorized', 401);
  }
  if (!res.ok) throw new ApiError(json.error ?? 'generic', res.status);
  return json as T;
}

export interface Chat { id: number; kind: 'circle' | 'group' | 'direct'; name: string; members?: number; agentActive?: number; unread: number; muted: boolean; pinned: boolean; lastText: string; lastKind: string | null; lastAt: string; lastAuthor: string | null; lastFromMe: boolean;
  favourite?: boolean; archived?: boolean; markedUnread?: boolean; mutedUntil?: string | null;
  /** Set by the chat list's "Bring everyone closer" card: open this chat straight on its invite. */
  openInvite?: boolean;
  /** Set by the Memory tab: open this circle straight on its archive. */
  openArchive?: boolean }
export interface Attachment { id: number; kind: 'image' | 'video' | 'file'; name: string | null; w: number | null; h: number | null; thumb: number | null }
export interface Msg {
  id: number; seq?: number; rev?: number; userId: number | null; author: string | null;
  kind: 'text' | 'voice' | 'system'; body: string; transcript?: string | null;
  createdAt: string; deleted: number; hasAudio?: number; audioMs?: number | null;
  attachments?: Attachment[];
  /** What the message answers, as the server sends it (a short quote, not the whole message). */
  replyToId?: number | null; replyTo?: { id: number; author: string | null; kind: string; deleted: boolean; text: string } | null;
  editedAt?: string | null; forwardCount?: number;
  archiveStatus?: 'archived' | 'skipped' | 'rejected' | 'none' | null;
  category?: string | null; score?: number | null; reason?: string | null;
  /** One entry per person who reacted: who (u) and with what (e). */
  reactions?: Array<{ u: number; e: string }>;
  starred?: boolean;
}
/** A member of the chat open on screen, with how far they have received and read (for the ticks). */
export interface Member { id: number; name: string; role: string; deliveredSeq: number; readSeq: number | null; /** Set when they have a profile picture; changes with each new one. */ avatarAt?: string | null }
export interface CircleDetail {
  id: number; kind: 'circle' | 'group' | 'direct'; name: string; role: string; agentActive: number;
  sensitivity: 'strict' | 'medium' | 'lenient'; inviteCode?: string; invitePolicy: 'admins' | 'members'; inviteEnabled: boolean;
  members: Member[]; storyTitle?: string | null; muted?: boolean; mutedUntil?: string | null; favourite?: boolean;
}
export interface Me {
  id: number; name: string; phone?: string; lang?: string;
  /** Preferences that belong to the account, because they change what others see. */
  read_receipts?: number; push_preview?: number;
  is_admin?: number; has_pin?: number; email?: string | null;
  /** Set when there is a profile picture; changes with each new one (so a cached old one is not shown). */
  avatar_at?: string | null;
  created_at?: string;
}

/** What a picture or a voice file needs to be fetched: the session cookie (a browser sends its own). */
export const mediaSource = (path: string) => ({ uri: `${API_URL}${path}`, ...(sessionHeaders() ? { headers: sessionHeaders() } : {}) });

/**
 * POST a multipart form. On a phone this goes through XMLHttpRequest — React Native's own
 * networking, which reads `{ uri, name, type }` file parts from disk. The global fetch in this
 * Expo version rejects such parts ("Unsupported FormDataPart implementation"), which made every
 * voice note, photo and sealed letter fail. A browser keeps using fetch with real Blobs.
 * Failures are logged with the path, status and the server's answer.
 */
async function upload(path: string, form: FormData): Promise<any> {
  await ensureSession();
  const url = `${API_URL}/api${path}`;
  if (web) {
    let res: Response;
    try { res = await fetch(url, { method: 'POST', body: form, credentials: 'include' }); } catch { throw new ApiError('offline', 0); }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) { console.warn('[upload]', path, res.status, json); throw new ApiError(json.error ?? 'generic', res.status); }
    return json;
  }
  const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    // Off, or iOS manages cookies itself: it drops a hand-set Cookie header and sends its own
    // (empty) cookie store instead, and the server answers 401.
    xhr.withCredentials = false;
    const h = sessionHeaders();
    if (h) for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
    else console.warn('[upload]', path, 'no session in the app');
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => { console.warn('[upload]', path, 'network error'); reject(new ApiError('offline', 0)); };
    xhr.ontimeout = () => { console.warn('[upload]', path, 'timed out'); reject(new ApiError('offline', 0)); };
    xhr.timeout = 120_000;
    xhr.send(form);
  });
  let json: any = {};
  try { json = body ? JSON.parse(body) : {}; } catch { /* not JSON */ }
  if (status < 200 || status >= 300) { console.warn('[upload]', path, status, body.slice(0, 300)); throw new ApiError(json.error ?? 'generic', status); }
  return json;
}

/** Send one picture to a chat. `file` is what the picker gave us: on a phone a local file reference, in a browser a Blob. */
export async function sendPhoto(circleId: number, file: { uri: string; name: string; type: string }, blob?: Blob) {
  const form = new FormData();
  form.append('file', (blob ?? ({ uri: file.uri, name: file.name, type: file.type } as unknown)) as Blob, file.name);
  form.append('client_msg_id', `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await upload(`/circles/${circleId}/attachments`, form);
}

/** Send a recorded voice note. `durationMs` is what the recorder measured: the file itself
 *  usually has no usable length, and the server stores what we pass. */
export async function sendVoice(circleId: number, uri: string, durationMs: number, blob?: Blob) {
  const form = new FormData();
  // iOS records .m4a, which is audio/mp4 — one of the five types the server accepts.
  const name = `voice-${Date.now()}.m4a`;
  form.append('audio', (blob ?? ({ uri, name, type: 'audio/mp4' } as unknown)) as Blob, name);
  form.append('duration', String(Math.round(durationMs)));
  await upload(`/circles/${circleId}/voice`, form);
}

/** Send one or more files with an optional caption, optionally answering a message. */
export async function sendFiles(
  circleId: number,
  files: Array<{ uri: string; name: string; type: string; blob?: Blob }>,
  opts: { caption?: string; replyTo?: number } = {},
) {
  const form = new FormData();
  for (const f of files) form.append('file', (f.blob ?? ({ uri: f.uri, name: f.name, type: f.type } as unknown)) as Blob, f.name);
  if (opts.caption?.trim()) form.append('caption', opts.caption.trim());
  if (opts.replyTo) form.append('reply_to', String(opts.replyTo));
  form.append('client_msg_id', `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await upload(`/circles/${circleId}/attachments`, form);
}

/** Send a multipart form (a sealed letter with its recording, for example). */
export async function apiForm<T = any>(path: string, form: FormData): Promise<T> {
  return (await upload(path, form)) as T;
}

/**
 * Open a circle's family story in the system browser (where it can be printed or saved as PDF).
 * The browser does not share this app's session, so the server hands out a one-time link that
 * signs the browser in and lands on the book (server/routes/handoff.ts).
 */
export async function openBook(circleId: number, year: number, lang: string) {
  const { url } = await api<{ url: string }>(`/circles/${circleId}/book-link`, { body: { year, lang } });
  const { Linking } = await import('react-native');
  await Linking.openURL(`${API_URL}${url}`);
}

/**
 * Open a file someone sent (a PDF, a document): download it once into the app's cache with the
 * session, then hand it to iOS's share sheet, which offers Quick Look, Files, Books, Mail…
 */
export async function openFile(mediaId: number, name: string) { return openRemote(`/api/media/${mediaId}`, name, `files-${mediaId}`); }
/** The same for any protected file path (an album's video, for example). */
export async function openRemote(path: string, name: string, cacheKey: string) {
  const { File, Directory, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const safe = (name || cacheKey).replace(/[\\/:*?"<>|]+/g, '_');
  const dir = new Directory(Paths.cache, cacheKey);
  if (!dir.exists) dir.create({ intermediates: true });
  const target = new File(dir, safe);
  if (!target.exists) await File.downloadFileAsync(`${API_URL}${path}`, target, { headers: sessionHeaders() ?? {} });
  await Sharing.shareAsync(target.uri, { dialogTitle: name });
}

/** A person's profile picture, for an <Image>: only when they have one (`at` is their avatar_at / avatarAt, which also busts caches). */
export const avatarSource = (userId: number, at: string | null | undefined) =>
  (at ? mediaSource(`/api/users/${userId}/avatar?v=${encodeURIComponent(at)}`) : undefined);
