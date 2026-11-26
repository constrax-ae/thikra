/**
 * The arithmetic behind editing a photo or a video before it is sent: boxes, strokes and time ranges.
 * No canvas and no DOM here, so every rule below is tested in web/edit.test.ts rather than by eye.
 * The drawing itself is in ImageEdit.tsx (photos) and VideoEdit.tsx (video).
 */

/** A rectangle over a picture, in fractions of its width and height (0..1), so it survives any resize. */
export interface Box { x: number; y: number; w: number; h: number }

/** The smallest box a person can make: 8% of each side. Smaller than this and the handles sit on top of each other. */
export const MIN_BOX = 0.08;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** Fractions are rounded here, once: 0.1 + 0.2 is 0.30000000000000004, and that reaches both the style attribute and the test. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Where a box lands after a drag of (dx, dy) — both fractions of the picture. It never leaves the picture. */
export function dragBox(start: Box, mode: DragMode, dx: number, dy: number): Box {
  let { x, y, w, h } = start;
  if (mode === 'move') return { x: r6(clamp(start.x + dx, 0, 1 - start.w)), y: r6(clamp(start.y + dy, 0, 1 - start.h)), w, h };
  if (mode.includes('w')) { x = clamp(start.x + dx, 0, start.x + start.w - MIN_BOX); w = start.x + start.w - x; }
  if (mode.includes('e')) { w = clamp(start.w + dx, MIN_BOX, 1 - start.x); }
  if (mode.includes('n')) { y = clamp(start.y + dy, 0, start.y + start.h - MIN_BOX); h = start.y + start.h - y; }
  if (mode.includes('s')) { h = clamp(start.h + dy, MIN_BOX, 1 - start.y); }
  return { x: r6(x), y: r6(y), w: r6(w), h: r6(h) };
}

/** The box in whole pixels of a picture that size, never empty and never outside it. */
export function boxPixels(box: Box, width: number, height: number) {
  const x = clamp(Math.round(box.x * width), 0, Math.max(0, width - 1));
  const y = clamp(Math.round(box.y * height), 0, Math.max(0, height - 1));
  return { x, y, w: clamp(Math.round(box.w * width), 1, width - x), h: clamp(Math.round(box.h * height), 1, height - y) };
}

/**
 * How coarse the mosaic over a hidden area is. We cover a face or an ID number with squares, NOT with a soft blur:
 * a Gaussian blur of a small area can be undone well enough to read a number back, and a mosaic this coarse cannot.
 * About 14 squares across the hidden area, and never finer than 8 pixels, whatever the picture's size.
 */
export function mosaicStep(boxW: number, boxH: number): number {
  return Math.max(8, Math.round(Math.max(boxW, boxH) / 14));
}

/** One freehand line drawn on a photo. Points and width are fractions, so the line lands in the same place at any size. */
export interface Stroke { colour: string; width: number; points: Array<[number, number]> }

/** The colours to draw with: they stay legible on a photograph of anything. */
export const INKS = ['#E11D48', '#F5F1E8', '#1F4D3F', '#111827'] as const;

/** The width of the pen as a fraction of the picture's shorter side. */
export const PEN = 0.012;

const APART = 0.004;   // points closer together than this add nothing but weight

/** The stroke with the point added, unless it is on top of the last one. */
export function addPoint(stroke: Stroke, x: number, y: number): Stroke {
  const p: [number, number] = [clamp(x, 0, 1), clamp(y, 0, 1)];
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < APART) return stroke;
  return { ...stroke, points: [...stroke.points, p] };
}

/** A stroke worth keeping: a tap (one point) is drawn as a dot, so one point is enough. */
export const drawable = (s: Stroke) => s.points.length > 0;

// ---- video ---------------------------------------------------------------------------------------

/** The shortest piece of video worth sending. */
export const MIN_CLIP = 0.5;

/**
 * A start and an end inside a clip of `duration` seconds, in order and at least MIN_CLIP apart.
 * Whichever end was moved is the one that gives way, so dragging never silently swaps the two handles.
 */
export function clampRange(start: number, end: number, duration: number, moved: 'start' | 'end' = 'end') {
  const d = Math.max(0, duration);
  const span = Math.min(MIN_CLIP, d);
  let s = clamp(start, 0, d), e = clamp(end, 0, d);
  if (e - s < span) { if (moved === 'start') s = clamp(e - span, 0, d); else e = clamp(s + span, 0, d); }
  if (e - s < span) { s = 0; e = Math.min(d, span); }
  return { start: s, end: e };
}

/** Whether a range is the whole clip (so there is nothing to cut). */
export const isWholeClip = (start: number, end: number, duration: number) => start <= 0.05 && end >= duration - 0.05;

/** The first container the browser can actually record, or null if it can record none. */
export function pickMime(supported: (type: string) => boolean, candidates: readonly string[] = VIDEO_MIMES): string | null {
  for (const m of candidates) if (supported(m)) return m;
  return null;
}
export const VIDEO_MIMES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] as const;

/** The name a trimmed clip is sent under: the same name, with the container's extension. */
export function clipName(name: string, mime: string): string {
  const ext = mime.startsWith('video/mp4') ? '.mp4' : '.webm';
  return name.replace(/\.[^.]+$/, '') + ext;
}

/** m:ss for a number of seconds, for the two handles and the length. */
export function secs(n: number): string {
  const whole = Math.max(0, Math.floor(n));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
