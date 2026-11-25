import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { addPoint, boxPixels, dragBox, INKS, mosaicStep, PEN, type Box, type DragMode, type Stroke } from './edit';

// Editing a photo before it is sent: turn it, cut it to the part that matters, hide a face or a number, draw on it.
// Everything happens on this device; the result is a new picture that then goes through the usual compression (and
// loses any location). The arithmetic is in edit.ts, where it is tested; this file is the canvas and the screen.

export type { Box } from './edit';

const decode = (file: Blob) => createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
const save = (canvas: HTMLCanvasElement, like: File) => new Promise<File>((res, rej) => {
  const png = like.type === 'image/png';
  canvas.toBlob(b => (b ? res(new File([b], like.name.replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg'), { type: png ? 'image/png' : 'image/jpeg' })) : rej(new Error('encode'))),
    png ? 'image/png' : 'image/jpeg', 0.92);
});
const sheet = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** The photo turned a quarter clockwise. */
export async function rotate(file: File): Promise<File> {
  const img = await decode(file);
  const c = sheet(img.height, img.width);
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0);
  img.close();
  return save(c, file);
}

/** The part of the photo inside the box. */
export async function crop(file: File, box: Box): Promise<File> {
  const img = await decode(file);
  const { x, y, w, h } = boxPixels(box, img.width, img.height);
  const c = sheet(w, h);
  c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h);
  img.close();
  return save(c, file);
}

/**
 * The area inside the box covered by a coarse mosaic — for a face, a door number, a card. It is painted into the
 * picture itself, so what it covers is gone from the file that leaves this device; there is nothing underneath to recover.
 */
export async function blurBox(file: File, box: Box): Promise<File> {
  const img = await decode(file);
  const c = sheet(img.width, img.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const { x, y, w, h } = boxPixels(box, img.width, img.height);
  const step = mosaicStep(w, h);
  const cols = Math.max(1, Math.round(w / step)), rows = Math.max(1, Math.round(h / step));
  const small = sheet(cols, rows);
  small.getContext('2d')!.drawImage(c, x, y, w, h, 0, 0, cols, rows);   // each square becomes the average of what it covered
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, cols, rows, x, y, w, h);
  img.close();
  return save(c, file);
}

/** Draw the strokes onto a picture that size. The same lines the person saw, because the preview uses this too. */
export function paint(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], w: number, h: number) {
  const unit = Math.min(w, h);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (!s.points.length) continue;
    ctx.strokeStyle = s.colour; ctx.fillStyle = s.colour; ctx.lineWidth = Math.max(1, s.width * unit);
    if (s.points.length === 1) {   // a tap is a dot
      ctx.beginPath(); ctx.arc(s.points[0][0] * w, s.points[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s.points[0][0] * w, s.points[0][1] * h);
    for (const [px, py] of s.points.slice(1)) ctx.lineTo(px * w, py * h);
    ctx.stroke();
  }
}

/** The photo with the drawing burnt into it. */
export async function applyStrokes(file: File, strokes: readonly Stroke[]): Promise<File> {
  const img = await decode(file);
  const c = sheet(img.width, img.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  paint(ctx, strokes, img.width, img.height);
  img.close();
  return save(c, file);
}

/** The picture at the size it is shown, with something laid over it. Both editors sit on this. */
function Stage({ url, children, onLoad }: { url: string; children?: React.ReactNode; onLoad?: (el: HTMLImageElement) => void }) {
  return (
    <div className="relative rounded-2xl overflow-hidden bg-paper border border-line h-[min(20rem,45vh)] flex items-center justify-center select-none">
      <div className="relative max-w-full max-h-full">
        {url && <img src={url} alt="" draggable={false} onLoad={e => onLoad?.(e.currentTarget)} className="block max-w-full max-h-[min(20rem,45vh)] object-contain" />}
        {children}
      </div>
    </div>
  );
}
const useBlobUrl = (src: File) => {
  const [url, setUrl] = useState('');
  useEffect(() => { const u = URL.createObjectURL(src); setUrl(u); return () => URL.revokeObjectURL(u); }, [src]);
  return url;
};

/**
 * A frame over the photo: drag inside it to move it, drag a corner to resize it. Arrow keys move it too (with Shift
 * they resize it), so it works without a mouse. Cropping keeps what is inside; hiding covers what is inside.
 */
export function BoxFrame({ src, help, action, label, onDone, onCancel, whole }: {
  src: File; help: string; action: string; label: string; onDone: (box: Box) => void; onCancel: () => void; whole?: string;
}) {
  const { t } = useI18n();
  const url = useBlobUrl(src);
  const [box, setBox] = useState<Box>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: DragMode; px: number; py: number; start: Box } | null>(null);

  const down = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, start: box };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current, el = area.current; if (!d || !el) return;
    const r = el.getBoundingClientRect();
    setBox(dragBox(d.start, d.mode, (e.clientX - d.px) / r.width, (e.clientY - d.py) / r.height));
  };
  const key = (e: React.KeyboardEvent) => {
    const step = 0.02;
    const dir = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!dir) { if (e.key === 'Enter') { e.preventDefault(); onDone(box); } return; }
    e.preventDefault();
    const [dx, dy] = document.documentElement.dir === 'rtl' && dir[0] ? [-dir[0], dir[1]] : dir;
    setBox(b => dragBox(b, e.shiftKey ? 'se' : 'move', dx, dy));
  };
  const pct = (v: number) => `${v * 100}%`;
  const corner = (k: 'nw' | 'ne' | 'sw' | 'se') => (
    <span aria-hidden onPointerDown={down(k)}
      className={`absolute w-5 h-5 -m-2.5 rounded-full bg-white border-2 border-brand shadow touch-none ${k === 'nw' || k === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
      style={{ left: k.includes('w') ? 0 : '100%', top: k.includes('n') ? 0 : '100%' }} />
  );
  return (
    <div className="mt-3">
      <div ref={area} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <Stage url={url}>
          <div aria-hidden className="absolute inset-0 bg-black/50 pointer-events-none"
            style={{ clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${pct(box.x)} ${pct(box.y)}, ${pct(box.x)} ${pct(box.y + box.h)}, ${pct(box.x + box.w)} ${pct(box.y + box.h)}, ${pct(box.x + box.w)} ${pct(box.y)}, ${pct(box.x)} ${pct(box.y)})` }} />
          <div role="slider" tabIndex={0} aria-label={label} aria-valuetext={`${Math.round(box.w * 100)}% × ${Math.round(box.h * 100)}%`} aria-valuenow={Math.round(box.w * 100)}
            onPointerDown={down('move')} onKeyDown={key}
            className="absolute border-2 border-white outline-none focus-visible:ring-2 focus-visible:ring-focus cursor-move touch-none"
            style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h), boxShadow: '0 0 0 1px rgba(0,0,0,.35)' }}>
            <span aria-hidden className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(to right, transparent 33.2%, rgba(255,255,255,.45) 33.3%, transparent 33.5%, transparent 66.5%, rgba(255,255,255,.45) 66.6%, transparent 66.8%), linear-gradient(to bottom, transparent 33.2%, rgba(255,255,255,.45) 33.3%, transparent 33.5%, transparent 66.5%, rgba(255,255,255,.45) 66.6%, transparent 66.8%)' }} />
            {corner('nw')}{corner('ne')}{corner('sw')}{corner('se')}
          </div>
        </Stage>
      </div>
      <p className="mt-2 text-xs text-muted">{help}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary flex-1 inline-flex items-center justify-center gap-2" onClick={() => onDone(box)}><Icon name="check" className="w-4 h-4" />{action}</button>
        {whole && <button type="button" className="btn btn-ghost" onClick={() => setBox({ x: 0, y: 0, w: 1, h: 1 })}>{whole}</button>}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

/** Kept so the crop frame reads as itself at the place it is used. */
export function CropFrame({ src, onDone, onCancel }: { src: File; onDone: (box: Box) => void; onCancel: () => void }) {
  const { t } = useI18n();
  return <BoxFrame src={src} onDone={onDone} onCancel={onCancel} label={t.photoEdit.cropFrame} help={t.photoEdit.cropHelp} action={t.photoEdit.applyCrop} whole={t.photoEdit.whole} />;
}

/** The frame used to hide part of the photo. */
export function BlurFrame({ src, onDone, onCancel }: { src: File; onDone: (box: Box) => void; onCancel: () => void }) {
  const { t } = useI18n();
  return <BoxFrame src={src} onDone={onDone} onCancel={onCancel} label={t.photoEdit.hideFrame} help={t.photoEdit.hideHelp} action={t.photoEdit.applyHide} />;
}

/**
 * Drawing on the photo with a finger or a mouse: four colours, undo, and start again. The lines are kept as fractions
 * of the picture, so what is drawn on a small preview lands in exactly the same place on the full-size photo.
 */
export function MarkupPad({ src, onDone, onCancel }: { src: File; onDone: (strokes: Stroke[]) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const url = useBlobUrl(src);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [colour, setColour] = useState<string>(INKS[0]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<Stroke | null>(null);

  // One drawing path for the preview and for the file: the picture is redrawn whenever a line changes.
  useEffect(() => {
    const c = canvas.current; if (!c || !size.w) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    paint(ctx, live.current ? [...strokes, live.current] : strokes, size.w, size.h);
  }, [strokes, size.w, size.h]);

  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as const;
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    live.current = addPoint({ colour, width: PEN, points: [] }, x, y);
    setStrokes(s => [...s]);   // redraw with the new line
  };
  const move = (e: React.PointerEvent) => {
    if (!live.current) return;
    const [x, y] = at(e);
    live.current = addPoint(live.current, x, y);
    setStrokes(s => [...s]);
  };
  const end = () => { const s = live.current; live.current = null; if (s) setStrokes(list => [...list, s]); };

  return (
    <div className="mt-3">
      <Stage url={url} onLoad={el => setSize({ w: el.clientWidth, h: el.clientHeight })}>
        <canvas ref={canvas} aria-label={t.photoEdit.drawArea} className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
          onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} style={{ width: size.w || undefined, height: size.h || undefined }} />
      </Stage>
      <div role="toolbar" aria-label={t.photoEdit.draw} className="mt-2 flex items-center gap-2 flex-wrap">
        {INKS.map(c => (
          <button key={c} type="button" aria-pressed={colour === c} aria-label={t.photoEdit.inkNames[INKS.indexOf(c)]} title={t.photoEdit.inkNames[INKS.indexOf(c)]} onClick={() => setColour(c)}
            className={`w-7 h-7 rounded-full border-2 transition-transform duration-[var(--dur-instant)] ${colour === c ? 'border-green scale-110' : 'border-line'}`} style={{ background: c }} />
        ))}
        <span className="flex-1" />
        <button type="button" disabled={!strokes.length} onClick={() => setStrokes(s => s.slice(0, -1))} className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-sm text-ink hover:bg-green-soft hover:text-green disabled:opacity-40"><Icon name="undo" className="w-4 h-4" />{t.photoEdit.undo}</button>
        <button type="button" disabled={!strokes.length} onClick={() => setStrokes([])} className="h-9 px-3 rounded-xl text-sm text-ink hover:bg-green-soft hover:text-green disabled:opacity-40">{t.photoEdit.clearDrawing}</button>
      </div>
      <p className="mt-2 text-xs text-muted">{t.photoEdit.drawHelp}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={!strokes.length} className="btn btn-primary flex-1 inline-flex items-center justify-center gap-2" onClick={() => onDone(strokes)}><Icon name="check" className="w-4 h-4" />{t.photoEdit.applyDraw}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}
