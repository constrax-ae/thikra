import { guardPlain } from './e2ee/known';

export class ApiError extends Error {
  /** `data` is the whole answer: some refusals say more than their code (the size limit, where an upload has got to). */
  constructor(public code: string, public status: number, public data: Record<string, any> = {}) { super(code); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; raw?: Blob; signal?: AbortSignal } = {}): Promise<T> {
  try { guardPlain(opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'), path); }   // a chat this device knows is encrypted never gets readable text, whatever the server says
  catch (e: any) { throw new ApiError(e.code ?? 'encrypted_chat', 409); }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
      signal: opts.signal,
      headers: opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': 'application/octet-stream' } : undefined,
      body: opts.raw ?? opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    if (opts.signal?.aborted) throw new ApiError('cancelled', 0);
    throw new ApiError('network', 0); // the request never got an answer: offline, or the server is asleep
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? (res.status >= 500 ? 'server' : 'generic'), res.status, data);
  return data as T;
}

export interface Me { id: number; phone: string; name: string; lang: string; is_admin: number; read_receipts: number; push_preview: number; /** Optional second way to reach someone; the phone stays the identity. */ email?: string | null; last_seen_privacy?: 'everyone' | 'family' | 'nobody'; keep_archived?: number; has_pin?: number; avatar_at?: string | null; /** An optional one-line bio others see under the name (AUTH-01). */ about?: string | null; admin_role?: 'owner' | 'moderator' | 'support' | null }
export type Kind = 'circle' | 'group' | 'direct';
export interface CircleSummary {
  id: number; kind: Kind; name: string; sensitivity: string; agentActive: number; role: string; members: number; unread: number;
  /** End-to-end encrypted (a private chat or an ordinary group made so at creation). A family circle is never. */
  encrypted?: boolean;
  /** A message request: a private chat from someone you do not know, waiting for you to accept it. */
  request?: boolean;
  /** A private chat: the other person, and when their profile picture last changed (null: none). */
  peerId?: number | null; peerAvatarAt?: string | null;
  pinned: boolean; muted: boolean; mutedUntil: string | null; archived: boolean; favourite: boolean; markedUnread: boolean;
  /** Chat lock (a flag; the PIN is on the device), my wallpaper for this chat, and the disappearing timer. */
  locked: boolean; wallpaper?: string | null; disappearSeconds?: number | null;
  /** The group's photo (a media id of this chat), and whether an unread message mentions me. */
  photo?: number | null; mentioned?: boolean;
  lastKind: 'text' | 'voice' | 'image' | 'video' | 'file' | 'deleted' | 'gif' | 'sticker' | 'contact' | 'location' | 'encrypted' | null; lastText: string; lastAt: string; lastAuthor: string | null; lastFromMe: boolean;
}
export interface CircleDetail {
  id: number; kind: Kind; name: string; sensitivity: 'strict' | 'medium' | 'lenient'; agentActive: number; role: string; ownerId: number;
  /** End-to-end encrypted: set once at creation, never changes. */
  encrypted?: boolean;
  /** A message request waiting for YOUR answer (see CircleSummary.request). */
  request?: boolean;
  inviteCode?: string; invitePolicy: 'admins' | 'members'; inviteExpiresAt?: string | null;
  historyPolicy?: 'all' | 'since_join';
  inviteEnabled: boolean;
  description: string | null; photo: number | null; sendPolicy: 'all' | 'admins'; editPolicy: 'all' | 'admins'; joinApproval: boolean;
  /** How many people wait for approval (managers only). */
  joinRequests?: number;
  members: Array<{ id: number; name: string; role: string; deliveredSeq: number; readSeq: number | null; /** When their profile picture last changed (null: none); also busts the browser's copy. */ avatarAt?: string | null; /** Their optional one-line bio (AUTH-01); null when none, or when they blocked you. */ about?: string | null }>;
  lastSeq: number; createdAt?: string; storyTitle?: string | null; muted?: boolean; mutedUntil?: string | null; favourite?: boolean;
  disappearSeconds?: number | null; locked?: boolean; wallpaper?: string | null;
  /** What this chat may interrupt me with: everything, only when my name is written, or nothing at all. */
  notify?: 'all' | 'mentions' | 'none';
}
export interface Billing {
  stripe?: boolean;
  plan: 'free' | 'family' | 'heritage'; status: 'free' | 'active' | 'grace' | 'readonly'; sponsor: string | null; periodEnd: string | null;
  archivedBytes: number; chatBytes: number; quotaBytes: number; bonusBytes?: number; request?: { plan: string; status: 'open' | 'granted' | 'declined'; createdAt: string } | null;
}
// Message, Card, Attachment, LinkPreview and MessageInfo live in core/ (shared with the phone app and the encryption engine).
import type { Message, Card, Attachment, LinkPreview, MessageInfo } from '../../core/chat-types.ts';
export type { Message, Card, Attachment, LinkPreview, MessageInfo };
/** A message found by the search that spans every chat (GET /api/search), or starred anywhere (GET /api/starred). */
export interface MessageHit {
  id: number; seq: number; kind: 'text' | 'voice' | 'system'; body: string; transcript: string | null; createdAt: string;
  userId: number | null; author: string | null; hasAudio: number;
  circleId: number; circleKind: Kind; circleName: string; attachment: 'image' | 'video' | 'file' | null;
}
/** `skipped`: how many of your chats the server could not look inside — encrypted (ciphertext only) or locked by you. */
export interface Across { results: MessageHit[]; skipped: number }
export interface GalleryItem extends Attachment { messageId: number; seq: number; createdAt: string; author: string | null }
export interface ArchiveEntry {
  id: number; title: string; summary: string; category: string | null; eventDate: string; source: 'auto' | 'manual';
  kind: 'event' | 'funny' | 'debate' | 'conflict'; media?: Array<{ id: number; kind: 'image' | 'voice' | 'video' }>; status: 'open' | 'resolved' | 'faded' | null; pending: boolean; canAct: boolean; protected?: boolean;
}

/** SQLite stores UTC without a zone marker. */
export const toDate = (s: string) => new Date(s.replace(' ', 'T') + 'Z');
