import { type Context } from 'hono';
import { blobs } from '../storage.ts';
import { type Row } from '../db.ts';

// ---- attachments (images, video, documents) ----------------------------------------------------
// One message can carry up to 10 files plus a caption. What a file is comes from its BYTES (server/sniff.ts), never from its
// name or the type the client claims. Prototype limits: one request per message, so 64 MB per video/document and 16 MB per
// image; the resumable chunked upload for big files is backlog D-03.

export const MAX_FILES = 10;
export const MAX_IMAGE = 16 * 1024 * 1024;
export const MAX_OTHER = 64 * 1024 * 1024;
export const MAX_THUMB = 300 * 1024;

/** Serve a stored file to someone who is already known to be allowed. Content-addressed, so cacheable forever; images and videos of known types (and now audio) are shown inline, anything else is a download, never rendered. Supports Range. */
export async function serveMedia(c: Context, m: Row): Promise<Response> {
  const data = await blobs.get(m.blob_hash);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const inline = (m.kind === 'image' || m.kind === 'thumb' || m.kind === 'video' || m.kind === 'audio') && /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(ogg|mpeg|mp4|wav|webm))$/.test(m.mime);
  const headers: Record<string, string> = {
    'content-type': inline ? m.mime : 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    'content-disposition': inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(m.name ?? 'file')}`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (range && (range[1] || range[2])) {
    const total = data.length;
    let start = range[1] ? Number(range[1]) : total - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : total - 1;
    start = Math.max(0, start); end = Math.min(total - 1, end);
    if (start > end || start >= total) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    return new Response(new Uint8Array(data.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(new Uint8Array(data), { headers: { ...headers, 'content-length': String(data.length) } });
}
