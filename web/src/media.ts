import { readQuality, type Quality } from './quality';
import { stripPng } from '../../core/metadata';

// ---- attachments: prepare on the device, so less is uploaded and the receiver sees a preview at once --------------

const loadImage = (file: Blob) => new Promise<HTMLImageElement>((res, rej) => {
  const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); }; img.src = url;
});
const toJpeg = (img: CanvasImageSource, srcW: number, srcH: number, max: number, quality: number) => new Promise<{ blob: Blob; w: number; h: number } | null>(res => {
  const scale = Math.min(1, max / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); if (!ctx) return res(null);
  ctx.drawImage(img, 0, 0, w, h);
  canvas.toBlob(b => res(b ? { blob: b, w, h } : null), 'image/jpeg', quality);
});

/**
 * Compression on the device. Standard: a phone photo of 4 MB becomes about 300 KB at 1600 px. HD: up to 4096 px at high quality.
 * Either way a 320 px thumbnail is made. A photo is always re-drawn, so where it was taken never leaves the phone (see below).
 * A video is not re-encoded (browsers cannot do it reliably): it gets a poster frame and is sent as it is. Anything that cannot be decoded is sent as it is.
 */
export async function prepare(file: File, quality: Quality = readQuality()): Promise<{ file: File; thumb: Blob | null; w: number | null; h: number | null }> {
  try {
    if (file.type.startsWith('image/') && file.type !== 'image/gif') {
      const img = await loadImage(file);
      const hd = quality === 'original';
      const big = await toJpeg(img, img.naturalWidth, img.naturalHeight, hd ? 4096 : 1600, hd ? 0.9 : 0.82), small = await toJpeg(img, img.naturalWidth, img.naturalHeight, 320, 0.7);
      // Location stays on the phone: a re-drawn picture carries no EXIF, XMP or GPS. So a camera photo is ALWAYS sent re-drawn,
      // even in the rare case the camera's own file is smaller. Only a PNG (a screenshot, a drawing) may go as it is, and then
      // without its metadata chunks.
      const png = file.type === 'image/png';
      const use = big && (!png || big.blob.size < file.size) ? big : null;
      if (use) return { file: new File([use.blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }), thumb: small?.blob ?? null, w: use.w, h: use.h };
      const clean = png ? new File([stripPng(new Uint8Array(await file.arrayBuffer())) as BlobPart], file.name, { type: file.type }) : file;
      return { file: clean, thumb: small?.blob ?? null, w: img.naturalWidth, h: img.naturalHeight };
    }
    if (file.type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      try {
        const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.src = url;
        await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('video')); setTimeout(() => rej(new Error('timeout')), 4000); });
        v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
        await new Promise<void>(res => { v.onseeked = () => res(); setTimeout(res, 1500); });
        const small = v.videoWidth ? await toJpeg(v, v.videoWidth, v.videoHeight, 320, 0.7) : null;
        return { file, thumb: small?.blob ?? null, w: v.videoWidth || null, h: v.videoHeight || null };
      } finally { URL.revokeObjectURL(url); }
    }
  } catch { /* undecodable: upload as is, without a thumbnail */ }
  return { file, thumb: null, w: null, h: null };
}
