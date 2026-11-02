export class ApiError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('network', 0); // the request never got an answer: offline, or the server is asleep
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? (res.status >= 500 ? 'server' : 'generic'), res.status);
  return data as T;
}

export interface Me { id: number; phone: string; name: string; lang: string; is_admin: number; read_receipts: number; push_preview: number; has_pin?: number; admin_role?: 'owner' | 'moderator' | 'support' | null }
export type Kind = 'circle' | 'group' | 'direct';
export interface CircleSummary {
  id: number; kind: Kind; name: string; sensitivity: string; agentActive: number; role: string; members: number; unread: number;
  pinned: boolean; muted: boolean; mutedUntil: string | null; archived: boolean; favourite: boolean; markedUnread: boolean;
  lastKind: 'text' | 'voice' | 'image' | 'video' | 'file' | 'deleted' | null; lastText: string; lastAt: string; lastAuthor: string | null; lastFromMe: boolean;
}
export interface CircleDetail {
  id: number; kind: Kind; name: string; sensitivity: 'strict' | 'medium' | 'lenient'; agentActive: number; role: string; ownerId: number;
  inviteCode?: string; invitePolicy: 'admins' | 'members'; inviteEnabled: boolean;
  members: Array<{ id: number; name: string; role: string; deliveredSeq: number; readSeq: number | null }>;
  lastSeq: number; createdAt?: string; storyTitle?: string | null; muted?: boolean; mutedUntil?: string | null; favourite?: boolean;
}
export interface Billing {
  stripe?: boolean;
  plan: 'free' | 'family' | 'heritage'; status: 'free' | 'active' | 'grace' | 'readonly'; sponsor: string | null; periodEnd: string | null;
  archivedBytes: number; chatBytes: number; quotaBytes: number; bonusBytes?: number; request?: { plan: string; status: 'open' | 'granted' | 'declined'; createdAt: string } | null;
}
export interface Message {
  id: number; seq?: number; rev?: number; cid?: string; pending?: boolean; userId: number | null; author: string | null; kind: 'text' | 'voice' | 'system'; body: string; transcript: string | null;
  hasAudio: number; archiveStatus: string; score: number | null; category: string | null; reason: string | null; createdAt: string;
  deleted: number; deletedBy: number | null;
  replyToId?: number | null; editedAt?: string | null; forwardCount?: number;
  replyTo?: { id: number; author: string | null; kind: string; deleted: boolean; text: string } | null;
  reactions?: Array<{ u: number; e: string }>;
  attachments?: Attachment[];
  audioMs?: number | null;
  sealedOn?: string | null;
}
export interface Attachment { id: number; kind: 'image' | 'video' | 'file'; mime: string; name: string | null; size: number; w: number | null; h: number | null; thumb: number | null }
export interface GalleryItem extends Attachment { messageId: number; seq: number; createdAt: string; author: string | null }
export interface ArchiveEntry {
  id: number; title: string; summary: string; category: string | null; eventDate: string; source: 'auto' | 'manual';
  kind: 'event' | 'funny' | 'debate' | 'conflict'; media?: Array<{ id: number; kind: 'image' | 'voice' | 'video' }>; status: 'open' | 'resolved' | 'faded' | null; pending: boolean; canAct: boolean; protected?: boolean;
}

/** SQLite stores UTC without a zone marker. */
export const toDate = (s: string) => new Date(s.replace(' ', 'T') + 'Z');
