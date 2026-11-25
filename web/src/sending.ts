import { api, ApiError } from './api';
import { live } from './live';
import { createOutbox, type Outbox } from './outbox';
import { createSender, type Sender } from './sender';
import { createUploader, type UploadError, type UploadJob, type Uploader } from './uploads';
import { guardPlain } from './e2ee/known';
import { openMediaStore, type MediaStore } from './mediastore';

// The app's one outbox and one sender, for the signed-in person. Started when someone is signed in and stopped when they sign out,
// so messages go out from any screen (not only while their chat is open), and one account never sends another's unsent words.

interface Sending { userId: number; box: Outbox; sender: Sender; uploader: Uploader; media: MediaStore; stop(): void }
let current: Sending | null = null;

export function startSending(userId: number): Sending {
  if (current?.userId === userId) return current;
  current?.stop();
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* private mode: the outbox lives in memory for this visit */ }
  const box = createOutbox(storage, userId);
  const sender = createSender(box, {
    connected: () => live.connected,
    socketSend: i => { try { guardPlain('POST', `/circles/${i.circle}/messages`); } catch { return false; } return live.send({ t: 'send', circle: i.circle, client_msg_id: i.cid, body: i.body, reply_to: i.replyTo, mentions: i.mentions ?? [], ...(i.preview ? { preview: i.preview } : {}) }); },
    httpSend: async i => {
      try { await api(`/circles/${i.circle}/messages`, { body: { body: i.body, client_msg_id: i.cid, reply_to: i.replyTo, mentions: i.mentions ?? [], ...(i.preview ? { preview: i.preview } : {}) } }); }
      catch (e) { throw { code: e instanceof ApiError ? e.code : 'generic' }; }
    },
  });
  const off = live.on(f => {
    if (f.t === 'open') sender.kick();
    else if (f.t === 'close') sender.socketClosed();
    else if (f.t === 'ack' && typeof f.client_msg_id === 'string') sender.acked(f.client_msg_id);
    else if (f.t === 'err' && typeof f.client_msg_id === 'string') sender.errored(f.client_msg_id, String(f.error ?? 'generic'));
  });
  const timer = setInterval(sender.kick, 3000);
  const media = openMediaStore(userId);
  const uploader = createUploader(media.jobs, uploadTransport);
  const online = () => { sender.kick(); uploader.kick(); };
  window.addEventListener('online', online);
  sender.kick();
  // What an earlier visit left unsent is picked up by ONE tab only (the first to hold the lock), so two open tabs do not both upload it.
  let release: (() => void) | null = null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) locks.request(`thikra_uploader_${userId}`, { ifAvailable: true }, lock => (lock ? (uploader.start(), new Promise<void>(res => { release = res; })) : undefined)).catch(() => { uploader.start(); });
  else uploader.start();
  current = { userId, box, sender, uploader, media, stop() { off(); clearInterval(timer); uploader.stop(); release?.(); window.removeEventListener('online', online); if (current?.userId === userId) current = null; } };
  return current;
}
/** Signing out or deleting the account: stop sending and leave nothing unsent on this device. */
export function endSending() {
  current?.box.clear();
  const c = current;
  c?.uploader.clear().then(() => c.media.wipe()).catch(() => {});
  c?.stop();
}

// ---- the media outbox's way to the server (web/src/uploads.ts has the rules) ----
const fail = (e: unknown): UploadError => (e instanceof ApiError ? { code: e.code, offset: e.data.offset, max: e.data.max } : { code: 'generic' });
const uploadTransport = {
  async open(circle: number, name: string, size: number, checksum: string | null, signal: AbortSignal) {
    try { return await api<{ id: string }>(`/circles/${circle}/uploads`, { body: { name, size, ...(checksum ? { checksum } : {}) }, signal }); } catch (e) { throw fail(e); }
  },
  async offset(id: string, signal: AbortSignal) {
    try { return (await api<{ offset: number }>(`/uploads/${id}`, { signal })).offset; }
    catch (e) { if (e instanceof ApiError && e.code === 'upload_not_found') return null; throw fail(e); }
  },
  async piece(id: string, offset: number, bytes: Blob, signal: AbortSignal) {
    try { return (await api<{ offset: number }>(`/uploads/${id}?offset=${offset}`, { method: 'PUT', raw: bytes, signal })).offset; } catch (e) { throw fail(e); }
  },
  async finish(job: UploadJob, signal: AbortSignal) {
    const fd = new FormData();
    fd.append('client_msg_id', job.cid);
    if (job.replyTo) fd.append('reply_to', String(job.replyTo));
    if (job.viewOnce) fd.append('view_once', '1');
    try {
      if (job.kind === 'voice') {
        const f = job.files[0];
        fd.append('audio', new File([f.blob], 'voice', { type: f.type }));
        fd.append('duration', String(job.voice?.durationMs ?? 0));
        fd.append('waveform', JSON.stringify(job.voice?.waveform ?? []));
        fd.append('transcript', job.viewOnce ? '' : job.voice?.transcript ?? '');
        await api(`/circles/${job.circle}/voice`, { form: fd, signal });
        return;
      }
      for (const f of job.files) { fd.append('upload', f.uploadId ?? ''); fd.append('thumb', f.thumb ?? new Blob([]), 't.jpg'); fd.append('w', String(f.w ?? '')); fd.append('h', String(f.h ?? '')); }
      if (job.caption && !job.viewOnce) fd.append('caption', job.caption);
      await api(`/circles/${job.circle}/attachments`, { form: fd, signal });
    } catch (e) { throw fail(e); }
  },
  async cancel(id: string) { await api(`/uploads/${id}`, { method: 'DELETE' }).catch(() => {}); },
};
