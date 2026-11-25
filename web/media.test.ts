// Step 3 on the web: the media outbox (uploads and voice notes), the recorder's decisions, links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploader, tooLarge, type JobStore, type UploadJob, type UploadTransport } from './src/uploads.ts';
import { bars, gesture, nextSpeed } from './src/voice.ts';
import { firstLink, splitLinks, vcard, mapLinks } from './src/links.ts';

const memoryStore = () => {
  const kept = new Map<string, UploadJob>();
  const store: JobStore = { all: async () => [...kept.values()].map(j => ({ ...j, files: j.files.map(f => ({ ...f })) })), put: async j => { kept.set(j.cid, { ...j, files: j.files.map(f => ({ ...f })) }); }, remove: async c => { kept.delete(c); } };
  return { kept, store };
};
/** A pretend server: it holds bytes per upload, and can be told to drop the connection or refuse. */
function fakeServer() {
  const held = new Map<string, number[]>();
  const messages: Array<{ cid: string; files: number[][]; caption: string }> = [];
  const voices: string[] = [];
  const log: string[] = [];
  let n = 0;
  const s = {
    held, messages, voices, log, offline: false, dropAfterPieces: Infinity, loseAnswerOnce: false, refuse: null as null | { code: string; max?: number }, failFinish: 0,
    transport: {
      async open(_c, name, size) { if (s.offline) throw { code: 'network' }; if (s.refuse) throw s.refuse; const id = `u${++n}`; held.set(id, []); log.push(`open ${name} ${size}`); return { id }; },
      async offset(id) { if (s.offline) throw { code: 'network' }; log.push(`offset ${id}`); return held.has(id) ? held.get(id)!.length : null; },
      async piece(id, offset, bytes, signal) {
        if (s.offline) throw { code: 'network' };
        if (signal.aborted) throw { code: 'cancelled' };
        const h = held.get(id); if (!h) throw { code: 'upload_not_found' };
        if (offset !== h.length) throw { code: 'offset_mismatch', offset: h.length };
        h.push(...new Uint8Array(await bytes.arrayBuffer()));
        log.push(`piece ${id} @${offset}+${bytes.size}`);
        if (--s.dropAfterPieces <= 0) { s.offline = true; throw { code: 'network' }; }   // the bytes arrived, the answer did not
        if (s.loseAnswerOnce) { s.loseAnswerOnce = false; throw { code: 'network' }; }
        return h.length;
      },
      async finish(job) {
        if (s.offline) throw { code: 'network' };
        if (s.failFinish-- > 0) throw { code: 'server' };
        if (job.kind === 'voice') { if (!voices.includes(job.cid)) voices.push(job.cid); return; }
        if (messages.some(m => m.cid === job.cid)) return;   // the server stores a client id once
        for (const f of job.files) { const h = held.get(f.uploadId!); if (!h) throw { code: 'upload_not_found' }; if (h.length !== f.size) throw { code: 'upload_incomplete' }; }   // like the real server
        messages.push({ cid: job.cid, caption: job.caption, files: job.files.map(f => held.get(f.uploadId!)!) });
        for (const f of job.files) held.delete(f.uploadId!);
      },
      async cancel(id) { log.push(`cancel ${id}`); held.delete(id); },
    } as UploadTransport,
  };
  return s;
}
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 7 + seed) % 251);
const file = (name: string, n: number, seed = 1) => ({ name, type: 'image/jpeg', size: n, blob: new Blob([bytes(n, seed)]), thumb: null, w: null, h: null });
const job = (cid: string, files: ReturnType<typeof file>[], at = 1): UploadJob => ({ cid, circle: 5, at, kind: 'files', caption: 'وصف', replyTo: null, files });
// A pause in the tests is 3 ms (or less, if it is cut short), so a waiting job gives the clock back instead of spinning.
const nap = (_ms: number, signal: AbortSignal) => new Promise<void>(res => { const t = setTimeout(res, 3); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
const opts = { pieceSize: () => 100, sleep: nap };
const until = async (pred: () => boolean) => { for (let i = 0; i < 500; i++) { if (pred()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('never happened'); };

test('uploads: files go up in pieces and become ONE message, byte for byte, with progress on the way', async () => {
  const s = fakeServer(), { kept, store } = memoryStore();
  const up = createUploader(store, s.transport, opts);
  const seen: number[] = [];
  up.subscribe(e => { if (e.type === 'progress') seen.push(up.progress(e.cid)); });
  await up.add(job('a', [file('1.jpg', 250, 1), file('2.jpg', 130, 2)]));
  await until(() => s.messages.length === 1);
  assert.deepEqual(s.messages[0].files[0], [...bytes(250, 1)]); assert.deepEqual(s.messages[0].files[1], [...bytes(130, 2)]);
  assert.equal(s.messages[0].caption, 'وصف');
  assert.ok(seen.some(p => p > 0 && p < 1), 'progress was reported between the start and the end');
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'progress never goes backwards');
  await until(() => kept.size === 0);
  assert.deepEqual(up.list(5), [], 'nothing waits once the server has it');
});

test('uploads: a dropped network resumes from what the server holds, without sending a byte twice', async () => {
  const s = fakeServer(), { store } = memoryStore();
  const up = createUploader(store, s.transport, opts);
  s.dropAfterPieces = 2;   // the connection dies as the second piece's answer is on its way back
  await up.add(job('a', [file('v.mp4', 450)]));
  await until(() => up.isWaiting('a'));
  assert.equal(s.messages.length, 0);
  assert.equal(up.list(5)[0].failed, undefined, 'no connection is never a failure: it waits');
  s.offline = false; s.dropAfterPieces = Infinity; up.kick();
  await until(() => s.messages.length === 1);
  assert.deepEqual(s.messages[0].files[0], [...bytes(450)], 'the file is whole and in order');
  const pieces = s.log.filter(l => l.startsWith('piece'));
  assert.deepEqual(pieces, ['piece u1 @0+100', 'piece u1 @100+100', 'piece u1 @200+100', 'piece u1 @300+100', 'piece u1 @400+50'], 'continued at 200: the first 200 bytes went once');
  assert.equal(s.log.filter(l => l.startsWith('open')).length, 1, 'the same upload was continued, not started again');
});

test('uploads: closing the app in the middle loses nothing: the next visit continues the same upload', async () => {
  const s = fakeServer(), { kept, store } = memoryStore();
  const first = createUploader(store, s.transport, opts);
  s.dropAfterPieces = 3;
  await first.add(job('a', [file('v.mp4', 500)]));
  await until(() => first.isWaiting('a'));
  assert.ok(kept.get('a')?.files[0].uploadId, 'the device remembers which upload it was');
  // The tab is closed here. A new visit: a new uploader over the same storage.
  first.stop();
  s.offline = false; s.dropAfterPieces = Infinity;
  const second = createUploader(store, s.transport, opts);
  await second.start();
  await until(() => s.messages.length === 1);
  assert.deepEqual(s.messages[0].files[0], [...bytes(500)]);
  assert.equal(s.log.filter(l => l.startsWith('open')).length, 1);
});

test('uploads: cancelling at any moment leaves no message, deletes what the server held, and the next job goes on', async () => {
  const s = fakeServer(), { kept, store } = memoryStore();
  let pieces = 0;
  const up = createUploader(store, s.transport, opts);
  up.subscribe(e => { if (e.type === 'progress' && e.cid === 'a' && ++pieces === 3) up.cancel('a'); });
  await up.add(job('a', [file('big.mp4', 1000)], 1));
  await up.add(job('b', [file('small.jpg', 50, 9)], 2));
  await until(() => s.messages.length === 1);
  assert.equal(s.messages[0].cid, 'b', 'only the one that was not cancelled became a message');
  assert.ok(s.log.includes('cancel u1'), 'the server was told to throw the partial file away');
  assert.equal(s.held.size, 0);
  assert.equal(kept.size, 0);
  assert.deepEqual(up.list(5), []);
});

test('uploads: a refusal is shown with its reason and waits for the person; retry continues, discard removes', async () => {
  const s = fakeServer(), { kept, store } = memoryStore();
  const up = createUploader(store, s.transport, opts);
  s.refuse = { code: 'attachment_too_large', max: 100 * 1024 * 1024 };
  const events: string[] = [];
  up.subscribe(e => events.push(e.type));
  await up.add(job('a', [file('film.mp4', 300)]));
  await until(() => !!up.list(5)[0]?.failed);
  assert.equal(up.list(5)[0].failed, 'attachment_too_large'); assert.equal(up.list(5)[0].max, 100 * 1024 * 1024);
  assert.equal(kept.get('a')?.failed, 'attachment_too_large', 'still failed after a reload');
  assert.ok(events.includes('failed'));
  s.refuse = null;
  await up.retry('a');
  await until(() => s.messages.length === 1);
  // A server hiccup at the last step is retried by itself; five in a row give up.
  s.failFinish = 2;
  await up.add(job('b', [file('x.jpg', 10)], 2));
  await until(() => s.messages.length === 2);
  s.failFinish = 99;
  await up.add(job('c', [file('y.jpg', 10)], 3));
  await until(() => up.list(5)[0]?.failed === 'server');
  await up.cancel('c');
  assert.deepEqual(up.list(5), []);
  assert.equal(s.messages.length, 2);
});

test('voice notes wait in the same outbox: a recording made offline is sent when the network returns, once', async () => {
  const s = fakeServer(), { kept, store } = memoryStore();
  s.offline = true;
  const up = createUploader(store, s.transport, opts);
  const voice: UploadJob = { cid: 'v1', circle: 5, at: 1, kind: 'voice', caption: '', replyTo: null, files: [{ name: 'voice', type: 'audio/webm', size: 40, blob: new Blob([bytes(40)]), thumb: null, w: null, h: null }], voice: { durationMs: 3000, waveform: [1, 2, 3, 4], transcript: '' } };
  await up.add(voice);
  await until(() => up.isWaiting('v1'));
  assert.equal(kept.size, 1, 'the recording is on the device');
  s.offline = false; up.kick();
  await until(() => s.voices.length === 1);
  assert.equal(s.log.filter(l => l.startsWith('open')).length, 0, 'a voice note is small: one request, no pieces');
  await until(() => kept.size === 0);
});

// The figures of MED-05 in the chat specification: 20 MB an image, 100 MB a video or a document. The device
// knows them so a file that would be refused is never carried all the way to the server to be told so.
test('uploads: the limits are known before anything is sent, and they are the ones in the specification', () => {
  assert.equal(tooLarge({ type: 'image/jpeg', size: 20 * 1024 * 1024 }), null);
  assert.equal(tooLarge({ type: 'image/jpeg', size: 20 * 1024 * 1024 + 1 }), 20 * 1024 * 1024);
  assert.equal(tooLarge({ type: 'video/mp4', size: 100 * 1024 * 1024 }), null);
  assert.equal(tooLarge({ type: 'video/mp4', size: 100 * 1024 * 1024 + 1 }), 100 * 1024 * 1024);
  assert.equal(tooLarge({ type: 'application/pdf', size: 100 * 1024 * 1024 }), null);
  assert.equal(tooLarge({ type: 'application/pdf', size: 120 * 1024 * 1024 }), 100 * 1024 * 1024);
});

test('voice: the waveform is the loudest moment of each stretch, scaled; the gestures; the speeds', () => {
  assert.deepEqual(bars([], 8), []);
  const b = bars([0, 0, 10, 0, 50, 0, 100, 0], 4);
  assert.deepEqual(b, [4, 10, 50, 100]);
  assert.equal(bars(Array.from({ length: 1000 }, (_, i) => i % 37), 48).length, 48);
  assert.ok(bars([3, 3, 3], 48).every(v => v === 100), 'fewer samples than bars still fills every bar');
  assert.deepEqual(bars([0, 0, 0, 0], 4), [4, 4, 4, 4], 'silence is a flat line, not nothing');
  assert.equal(gesture(0, 0, false), 'none'); assert.equal(gesture(-40, -10, false), 'none');
  assert.equal(gesture(-120, -5, false), 'cancel', 'English: the mic is on the right, slide left to cancel');
  assert.equal(gesture(120, -5, false), 'none');
  assert.equal(gesture(120, 5, true), 'cancel', 'Arabic: the mic is on the left, slide right to cancel');
  assert.equal(gesture(-120, 0, true), 'none');
  assert.equal(gesture(5, -90, false), 'lock'); assert.equal(gesture(-10, -90, true), 'lock');
  assert.equal(gesture(-100, -200, false), 'lock', 'mostly upwards is a lock, not a cancel');
  assert.deepEqual([nextSpeed(1), nextSpeed(1.5), nextSpeed(2), nextSpeed(7)], [1.5, 2, 1, 1]);
});

test('links: the first link of a text, as written; a contact file; the two map addresses', () => {
  assert.equal(firstLink('شوفوا https://example.com/a?b=1، حلو'), 'https://example.com/a?b=1');
  assert.equal(firstLink('(see http://example.com/x).'), 'http://example.com/x');
  assert.equal(firstLink('https://a.example.com https://b.example.com'), 'https://a.example.com');
  for (const none of ['no link here', 'www.example.com', 'http://localhost', 'https://', 'ftp://example.com/a', 'javascript:alert(1)']) assert.equal(firstLink(none), null, none);
  assert.deepEqual(splitLinks('a https://example.com/x. b'), [{ text: 'a ' }, { text: 'https://example.com/x', href: 'https://example.com/x' }, { text: '. b' }]);
  assert.deepEqual(splitLinks('plain'), [{ text: 'plain' }]);
  const v = vcard('أبو خالد; الثاني', ['+966 50 123 4567', '050-123-4567']);
  assert.ok(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:أبو خالد\\; الثاني\r\n'));
  assert.ok(v.includes('TEL;TYPE=CELL:+966501234567\r\n') && v.includes('TEL;TYPE=CELL:0501234567\r\n') && v.endsWith('END:VCARD\r\n'));
  const m = mapLinks(24.713552, 46.675296);
  assert.equal(m.google, 'https://www.google.com/maps/search/?api=1&query=24.713552,46.675296');
  assert.equal(m.apple, 'https://maps.apple.com/?ll=24.713552,46.675296&q=24.713552,46.675296');
});
