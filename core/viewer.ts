// The arithmetic of the full-screen photo viewer (MED-03 "photo zoom and gallery swipe"), kept apart from the screen so it can be
// tested: how far a photo may zoom, where it may be dragged to, and when a sideways swipe means "the next photo".

export interface View { scale: number; x: number; y: number }
export const FIT: View = { scale: 1, x: 0, y: 0 };
export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
/** A double tap / double click goes to this zoom, and back to fitting the screen. */
export const DOUBLE_TAP_SCALE = 2.5;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(s) ? s : 1));

/**
 * Keeps a zoomed photo covering its box: it can be dragged only as far as its own edge, never off into empty space.
 * `w`/`h` are the size of the photo as shown at scale 1; the offset is from the centre, in screen pixels.
 */
export function clampPan(v: View, w: number, h: number): View {
  const mx = Math.max(0, (w * v.scale - w) / 2), my = Math.max(0, (h * v.scale - h) / 2);
  const x = Math.min(mx, Math.max(-mx, v.x)), y = Math.min(my, Math.max(-my, v.y));
  const r = (n: number) => Math.round(n * 100) / 100 || 0;   // whole hundredths, and no -0 (it only confuses comparisons)
  return { scale: v.scale, x: r(x), y: r(y) };
}

/**
 * Zooms by `factor` keeping the point under the finger (or the mouse) where it is: (px, py) is measured from the centre of the
 * photo's box. Back at scale 1 the photo is centred again.
 */
export function zoomAt(v: View, factor: number, px: number, py: number, w: number, h: number): View {
  const scale = clampScale(v.scale * factor);
  if (scale === MIN_SCALE) return FIT;
  const k = scale / v.scale;
  return clampPan({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, w, h);
}

/** A double tap: in to DOUBLE_TAP_SCALE on that point, or out to fit when already zoomed. */
export const toggleZoom = (v: View, px: number, py: number, w: number, h: number): View =>
  v.scale > MIN_SCALE ? FIT : zoomAt(v, DOUBLE_TAP_SCALE / v.scale, px, py, w, h);

/** How far a swipe must go, and how much more sideways than up or down it must be, to turn the page. */
export const SWIPE_PX = 60;

/**
 * Which way a finished swipe turns: +1 the next photo, -1 the previous one, 0 neither. Next is the way the page reads, so in
 * Arabic (right to left) the next photo comes from the left and is reached by swiping right.
 */
export function swipeStep(dx: number, dy: number, rtl: boolean): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  const forward = rtl ? dx > 0 : dx < 0;
  return forward ? 1 : -1;
}

/** The arrow keys, read the same way: the arrow pointing where the text goes is "next". */
export function keyStep(key: string, rtl: boolean): -1 | 0 | 1 {
  if (key === 'ArrowRight') return rtl ? -1 : 1;
  if (key === 'ArrowLeft') return rtl ? 1 : -1;
  return 0;
}

/** The index after a step, staying in the list (the viewer does not wrap from the last photo back to the first). */
export const stepIndex = (i: number, step: number, length: number) => Math.min(Math.max(0, i + step), Math.max(0, length - 1));

/** Distance between two fingers, for a pinch. */
export const spread = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
