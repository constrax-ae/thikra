// The shapes of a message and what it carries, shared by the web app, the phone app and the encryption engine.
// (The server's JSON; an encrypted chat's messages are rebuilt in this same shape on the device.)

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
  | { type: 'location'; lat: number; lng: number; accuracy: number | null; label: string | null }
  | { type: 'live'; lat: number; lng: number; accuracy: number | null; until: string; ended: boolean; at: string };
export interface LinkPreview { url: string; title: string; description: string; site: string; image: string | null }
/** For the author of a message: everyone else in the chat, in exactly one of the three lists. `at` is null for receipts from before times were stored. */
export interface MessageInfo { readBy: Array<{ id: number; name: string; at: string | null }>; deliveredTo: Array<{ id: number; name: string; at: string | null }>; pending: Array<{ id: number; name: string }> }
export interface Attachment { id: number; kind: 'image' | 'video' | 'file'; mime: string; name: string | null; size: number; w: number | null; h: number | null; thumb: number | null;
  /** An encrypted chat: the file on the server is ciphertext. `k` is its key, `hash` the SHA-256 of what the server holds, `thumb` a preview made on the sender's device. */
  enc?: { k: string; hash: string; thumb?: string } }
