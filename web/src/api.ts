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

export interface Me { id: number; phone: string; name: string; lang: string; is_admin: number; read_receipts: number; push_preview: number; /** Optional second way to reach someone; the phone stays the identity. */ email?: string | null; last_seen_privacy?: 'everyone' | 'family' | 'nobody'; keep_archived?: number; has_pin?: number; avatar_at?: string | null; admin_role?: 'owner' | 'moderator' | 'support' | null }
export type Kind = 'circle' | 'group' | 'direct';
export interface CircleSummary {
  id: number; kind: Kind; name: string; sensitivity: string; agentActive: number; role: string; members: number; unread: number;
  /** End-to-end encrypted (a private chat or an ordinary group made so at creation). A family circle is never. */
  encrypted?: boolean;
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
  inviteCode?: string; invitePolicy: 'admins' | 'members'; inviteEnabled: boolean;
  description: string | null; photo: number | null; sendPolicy: 'all' | 'admins'; editPolicy: 'all' | 'admins'; joinApproval: boolean;
  /** How many people wait for approval (managers only). */
  joinRequests?: number;
  members: Array<{ id: number; name: string; role: string; deliveredSeq: number; readSeq: number | null; /** When their profile picture last changed (null: none); also busts the browser's copy. */ avatarAt?: string | null }>;
  lastSeq: number; createdAt?: string; storyTitle?: string | null; muted?: boolean; mutedUntil?: string | null; favourite?: boolean;
  disappearSeconds?: number | null; locked?: boolean; wallpaper?: string | null;
}
export interface Billing {
  stripe?: boolean;
  plan: 'free' | 'family' | 'heritage'; status: 'free' | 'active' | 'grace' | 'readonly'; sponsor: string | null; periodEnd: string | null;
  archivedBytes: number; chatBytes: number; quotaBytes: number; bonusBytes?: number; request?: { plan: string; status: 'open' | 'granted' | 'declined'; createdAt: string } | null;
}
export interface Message {
  id: number; seq?: number; rev?: number; cid?: string; pending?: boolean; failed?: string; userId: number | null; author: string | null; kind: 'text' | 'voice' | 'system'; body: string; transcript: string | null;
  hasAudio: number; archiveStatus: string; score: number | null; category: string | null; reason: string | null; createdAt: string;
  deleted: number; deletedBy: number | null;
  replyToId?: number | null; editedAt?: string | null; forwardCount?: number;
  replyTo?: { id: number; author: string | null; kind: string; deleted: boolean; text: string; card?: Card['type'] | null } | null;
  reactions?: Array<{ u: number; e: string }>;
  attachments?: Attachment[];
  /** The people this message @mentions, and its poll if it is one. */
  mentions?: Array<{ id: number; name: string }>;
  poll?: { multiple: boolean; closed: boolean; voters: number; options: Array<{ id: number; text: string; voters: number[] }>; names?: Record<number, string> } | null;
  audioMs?: number | null;
  /** A voice note: its shape (bars of 0-100, measured by the sender's device) and who has played it. */
  waveform?: number[] | null; playedBy?: number[];
  /** What makes this message a link preview, GIF, sticker, contact or location. */
  card?: Card | null;
  sealedOn?: string | null;
  /** An encrypted chat: this device could not read the message (it was sent before this device joined, or the keys are not here). */
  undecryptable?: boolean;
  /** Not readable yet but it may still arrive (its keys are on the way): the screen says "waiting". */
  waiting?: boolean;
  /** The message came out of an encrypted chat and was decrypted on this device. */
  encrypted?: boolean;
  /** Disappearing: when it goes, and whether it already went. View once: who has opened it. */
  expiresAt?: string | null; expired?: boolean; viewOnce?: { openedBy: number[] } | null;
}
export type Card =
  | { type: 'link'; url: string; title: string; description: string; site: string; image: number | null }
  | { type: 'gif'; provider: string; title: string }
  | { type: 'sticker'; pack: string; id: string }
  | { type: 'contact'; name: string; phones: string[] }
  | { type: 'location'; lat: number; lng: number; accuracy: number | null; label: string | null };
export interface LinkPreview { url: string; title: string; description: string; site: string; image: string | null }
/** For the author of a message: everyone else in the chat, in exactly one of the three lists. `at` is null for receipts from before times were stored. */
export interface MessageInfo { readBy: Array<{ id: number; name: string; at: string | null }>; deliveredTo: Array<{ id: number; name: string; at: string | null }>; pending: Array<{ id: number; name: string }> }
export interface Attachment { id: number; kind: 'image' | 'video' | 'file'; mime: string; name: string | null; size: number; w: number | null; h: number | null; thumb: number | null;
  /** An encrypted chat: the file on the server is ciphertext. `k` is its key, `hash` the SHA-256 of what the server holds, `thumb` a preview made on the sender's device. */
  enc?: { k: string; hash: string; thumb?: string } }
export interface GalleryItem extends Attachment { messageId: number; seq: number; createdAt: string; author: string | null }
export interface ArchiveEntry {
  id: number; title: string; summary: string; category: string | null; eventDate: string; source: 'auto' | 'manual';
  kind: 'event' | 'funny' | 'debate' | 'conflict'; media?: Array<{ id: number; kind: 'image' | 'voice' | 'video' }>; status: 'open' | 'resolved' | 'faded' | null; pending: boolean; canAct: boolean; protected?: boolean;
}

/** SQLite stores UTC without a zone marker. */
export const toDate = (s: string) => new Date(s.replace(' ', 'T') + 'Z');
