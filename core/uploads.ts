// The media outbox: photos, videos, files and voice notes that the server has not confirmed yet. Like the text outbox, it is saved
// on the device (web/src/mediastore.ts), so a recording or a half-sent video survives a dropped network, a closed tab or a restart.
//
// A file goes up in pieces (the server's resumable upload, docs/LIVE-FRAMES.md). Rules:
//  - The message is created only by the LAST request, after every byte of every file has arrived. So cancelling at any moment
//    leaves nothing in the chat: there is no half message to clean up.
//  - No answer (offline, a dropped connection): wait and try again, with pauses that grow to 30 seconds, for as long as it takes.
//    Before continuing, ask the server how much it holds and go on from there; bytes it already has are never sent again.
//  - "Too fast" or a server error: tried again 5 times, then marked failed.
//  - Any other refusal (too large, not allowed, chat frozen): marked failed at once, with the server's reason. A failed job waits
//    for the person (retry or discard).
//  - One job at a time, oldest first, so things arrive in the order they were sent.
// Every job keeps ONE id (`cid`, sent as client_msg_id): the server stores it once, whatever is retried.

export interface UploadFile {
  name: string; type: string; size: number; blob: Blob; thumb: Blob | null; w: number | null; h: number | null;
  /** The server's id for this file's resumable upload, once it has started. */
  uploadId?: string;
  /** MED-05: the SHA-256 of these bytes, worked out once on this device and declared when the upload opens. */
  sha256?: string | null;
}
export interface UploadJob {
  cid: string; circle: number; at: number; kind: 'files' | 'voice';
  caption: string; replyTo: number | null; files: UploadFile[];
  voice?: { durationMs: number; waveform: number[]; transcript: string };
  /** Opened one time by each recipient (no caption, no thumbnail). */
  viewOnce?: boolean;
  /** Set when it was refused or kept failing: it waits for the person. */
  failed?: string;
  /** For a refused file: the limit the server named, in bytes. */
  max?: number;
}
export interface JobStore { all(): Promise<UploadJob[]>; put(job: UploadJob): Promise<void>; remove(cid: string): Promise<void> }
export interface UploadError { code: string; offset?: number; max?: number }
export interface UploadTransport {
  open(circle: number, name: string, size: number, checksum: string | null, signal: AbortSignal): Promise<{ id: string }>;
  /** How many bytes the server holds, or null if it no longer knows this upload. */
  offset(id: string, signal: AbortSignal): Promise<number | null>;
  /** Send one piece; resolves with the server's new offset. Rejects with UploadError ('network' when there was no answer). */
  piece(id: string, offset: number, bytes: Blob, signal: AbortSignal): Promise<number>;
  /** The last step: make the message from the finished uploads (or send the voice note). */
  finish(job: UploadJob, signal: AbortSignal): Promise<void>;
  cancel(id: string): Promise<void>;
}
export interface UploadEvent { type: 'progress' | 'sent' | 'failed' | 'changed'; cid: string; circle: number }
export interface UploaderOptions { pieceSize?: (size: number) => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; tries?: number }

const TRANSIENT = new Set(['server', 'too_many_requests', 'rate_limited']);
const defaultPiece = (size: number) => (size < 4 * 1024 * 1024 ? 256 * 1024 : 1024 * 1024);
const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>(res => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
const codeOf = (e: unknown): UploadError => (e && typeof e === 'object' && typeof (e as UploadError).code === 'string' ? e as UploadError : { code: 'generic' });

export function createUploader(store: JobStore, transport: UploadTransport, o: UploaderOptions = {}) {
  const pieceSize = o.pieceSize ?? defaultPiece, sleep = o.sleep ?? defaultSleep, tries = o.tries ?? 5;
  const jobs = new Map<string, UploadJob>();
  const sentBytes = new Map<string, number[]>();          // job -> bytes the server holds, per file
  const waiting = new Set<string>();                       // jobs paused on the network
  const listeners = new Set<(e: UploadEvent) => void>();
  let running: { cid: string; abort: AbortController } | null = null;
  let wake: AbortController | null = null;                 // cuts a pause short ("the network is back")
  let loaded: Promise<void> | null = null;
  const emit = (type: UploadEvent['type'], job: UploadJob) => listeners.forEach(l => { try { l({ type, cid: job.cid, circle: job.circle }); } catch { /* a screen's mistake must not stop sending */ } });
  const save = (job: UploadJob) => store.put(job).catch(() => {});   // storage full or forbidden: the job still goes while the tab lives

  async function pause(attempt: number, signal: AbortSignal) {
    wake = new AbortController();
    const both = new AbortController();
    const stop = () => both.abort();
    signal.addEventListener('abort', stop, { once: true }); wake.signal.addEventListener('abort', stop, { once: true });
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), both.signal);
    wake = null;
  }

  /** One file, from wherever the server says it has got to. */
  async function sendFile(job: UploadJob, i: number, signal: AbortSignal) {
    const f = job.files[i], sent = sentBytes.get(job.cid)!;
    let at = 0;
    if (f.uploadId) {
      const held = await transport.offset(f.uploadId, signal);
      if (held === null) f.uploadId = undefined; else at = held;
    }
    if (!f.uploadId) {
      // MED-05: tell the server what the bytes should add up to, so a file that arrives wrong never becomes a message.
      f.sha256 ??= await sha256Of(f.blob);
      f.uploadId = (await transport.open(job.circle, f.name, f.size, f.sha256 ?? null, signal)).id; at = 0; await save(job);
    }
    sent[i] = at; emit('progress', job);
    while (at < f.size) {
      if (signal.aborted) throw { code: 'cancelled' };
      try { at = await transport.piece(f.uploadId, at, f.blob.slice(at, Math.min(f.size, at + pieceSize(f.size))), signal); }
      catch (e) { const err = codeOf(e); if (err.code === 'offset_mismatch' && typeof err.offset === 'number') at = err.offset; else throw e; }
      sent[i] = at; emit('progress', job);
    }
  }
  async function attempt(job: UploadJob, signal: AbortSignal) {
    if (job.kind === 'files') {
      // Every file already has its upload: the last try may have got as far as the message (and only the answer was lost). Ask for the message first: the server
      // answers with the one it already made, or says what is missing, and only then is anything sent again.
      if (job.files.length && job.files.every(f => f.uploadId)) {
        try { await transport.finish(job, signal); return; }
        catch (e) { const c = codeOf(e).code; if (c !== 'upload_not_found' && c !== 'upload_incomplete') throw e; }
      }
      for (let i = 0; i < job.files.length; i++) await sendFile(job, i, signal);
    }
    if (signal.aborted) throw { code: 'cancelled' };
    await transport.finish(job, signal);
  }
  async function run(job: UploadJob, abort: AbortController) {
    let silences = 0, refusals = 0;
    for (;;) {
      try {
        await attempt(job, abort.signal);
        if (abort.signal.aborted) return;
        jobs.delete(job.cid); sentBytes.delete(job.cid); waiting.delete(job.cid);
        await store.remove(job.cid).catch(() => {});
        emit('sent', job);
        return;
      } catch (e) {
        if (abort.signal.aborted || !jobs.has(job.cid)) return;
        const err = codeOf(e);
        if (err.code === 'network') { waiting.add(job.cid); emit('changed', job); await pause(silences++, abort.signal); waiting.delete(job.cid); }
        else if (TRANSIENT.has(err.code) && ++refusals < tries) await pause(refusals, abort.signal);
        else {
          job.failed = err.code; if (err.max) job.max = err.max;
          await save(job); emit('failed', job);
          return;
        }
        if (abort.signal.aborted || !jobs.has(job.cid)) return;
        emit('changed', job);
      }
    }
  }
  function next() {
    if (running) return;
    const job = [...jobs.values()].filter(j => !j.failed).sort((a, b) => a.at - b.at)[0];
    if (!job) return;
    const abort = new AbortController();
    running = { cid: job.cid, abort };
    if (!sentBytes.has(job.cid)) sentBytes.set(job.cid, job.files.map(() => 0));
    run(job, abort).finally(() => { if (running?.cid === job.cid) running = null; next(); });
  }
  return {
    /** Read what was left on the device by an earlier visit and carry on with it. */
    start() {
      loaded ??= store.all().then(list => { for (const j of list) if (!jobs.has(j.cid)) jobs.set(j.cid, j); }, () => {}).then(() => { for (const j of jobs.values()) emit('changed', j); next(); });
      return loaded;
    },
    async add(job: UploadJob) { if (jobs.has(job.cid)) return; jobs.set(job.cid, job); await save(job); emit('changed', job); next(); },
    /** Everything waiting in this chat, oldest first (failed ones included). */
    list: (circle: number) => [...jobs.values()].filter(j => j.circle === circle).sort((a, b) => a.at - b.at),
    /** 0..1 of the bytes of this job that the server holds. */
    progress(cid: string) {
      const job = jobs.get(cid); if (!job) return 0;
      const total = job.files.reduce((n, f) => n + f.size, 0), sent = (sentBytes.get(cid) ?? []).reduce((n, x) => n + x, 0);
      return total > 0 ? Math.min(1, sent / total) : 0;
    },
    /** Is this job paused because there is no connection? */
    isWaiting: (cid: string) => waiting.has(cid),
    /** The person gives up on it, at any moment. Nothing was put in the chat, and the bytes already on the server are deleted. */
    async cancel(cid: string) {
      const job = jobs.get(cid); if (!job) return;
      jobs.delete(cid); sentBytes.delete(cid); waiting.delete(cid);
      if (running?.cid === cid) running.abort.abort();
      await store.remove(cid).catch(() => {});
      for (const f of job.files) if (f.uploadId) transport.cancel(f.uploadId).catch(() => {});
      emit('changed', job);
    },
    /** The person asks to try a failed job again. It continues from what the server already holds. */
    async retry(cid: string) { const job = jobs.get(cid); if (!job || !job.failed) return; delete job.failed; delete job.max; await save(job); emit('changed', job); next(); },
    /** The network may be back: stop waiting and try now. */
    kick() { wake?.abort(); next(); },
    /** Stop working (the app is closing or another person signs in). What waits stays on the device for the next visit. */
    stop() { const r = running; jobs.clear(); sentBytes.clear(); waiting.clear(); r?.abort.abort(); wake?.abort(); },
    /** Signing out: stop, and leave nothing unsent on this device. */
    async clear() { running?.abort.abort(); const all = [...jobs.values()]; jobs.clear(); sentBytes.clear(); for (const j of all) await store.remove(j.cid).catch(() => {}); },
    subscribe(fn: (e: UploadEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export type Uploader = ReturnType<typeof createUploader>;

/** The limits, checked on the device before anything is sent, so the person gets the reason at once (the server checks again). */

/** The SHA-256 of a file, as hex, computed on this device. Returns null where the browser has no WebCrypto (then the server simply has nothing to check). */
export async function sha256Of(blob: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

export const MAX_FILES = 20, MAX_IMAGE_BYTES = 20 * 1024 * 1024, MAX_FILE_BYTES = 100 * 1024 * 1024;   // MED-05, the same figures the server enforces
export function tooLarge(f: { type: string; size: number }): number | null {
  const max = f.type.startsWith('image/') && f.type !== 'image/heic' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  return f.size > max ? max : null;
}
