import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment } from './api';
import { MediaFile, useMediaUrl } from './E2eeUi';
import { Icon } from './icons';
import { fill, LANG_INFO, useI18n } from './i18n';
import { clampPan, FIT, keyStep, spread, stepIndex, swipeStep, toggleZoom, zoomAt, MAX_SCALE, type View } from './viewer';

/** One photo (or video) the viewer can show: an attachment of a chat, or a plain address (the album). */
export interface ViewerItem {
  key: string | number;
  kind: 'image' | 'video';
  /** A chat attachment: shown (and, in an encrypted chat, decrypted) the same way as in the bubble. */
  att?: Attachment;
  /** Or a plain address. */
  src?: string;
  alt?: string;
  /** Who sent it and when, under the counter. */
  caption?: string;
  /** What to save it as. */
  name?: string;
}

/**
 * The full-screen photo viewer (MED-03 "photo zoom and gallery swipe"). Every photo of the chat is in it, in order: swipe, the
 * arrows or the arrow keys move between them; pinch, the mouse wheel, a double tap or the +/- buttons zoom; a zoomed photo is
 * dragged around and never off its own edge. Escape, the close button or the back of the dimmed area closes it.
 */
export function PhotoViewer({ items, start, onClose, actions }: {
  items: ViewerItem[]; start: number; onClose: () => void;
  /** Extra buttons for the photo being shown (for example "Show in chat", or the album's delete). */
  actions?: (item: ViewerItem, close: () => void) => ReactNode;
}) {
  const { t, lang } = useI18n();
  const rtl = LANG_INFO[lang]?.rtl ?? false;
  const [index, setIndex] = useState(() => stepIndex(start, 0, items.length));
  const [view, setView] = useState<View>(FIT);
  const [drag, setDrag] = useState(0);   // how far a swipe has pulled the photo sideways, so the finger feels it move
  const viewRef = useRef(view); viewRef.current = view;
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const item = items[index];

  // The list can change under the viewer (a new message, a deletion): keep showing the same photo if it is still there.
  const keyRef = useRef(item?.key);
  useEffect(() => {
    const at = items.findIndex(x => x.key === keyRef.current);
    if (at >= 0 && at !== index) setIndex(at);
    else if (at < 0 && index >= items.length) setIndex(Math.max(0, items.length - 1));
  }, [items]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { keyRef.current = item?.key; setView(FIT); setDrag(0); }, [item?.key]);
  useEffect(() => { if (!items.length) onClose(); }, [items.length, onClose]);

  const go = useCallback((step: number) => setIndex(i => stepIndex(i, step, items.length)), [items.length]);
  const size = () => ({ w: img.current?.offsetWidth ?? 1, h: img.current?.offsetHeight ?? 1 });
  /** A point on the screen, measured from the centre of the photo's box. */
  const local = (x: number, y: number) => {
    const r = stage.current!.getBoundingClientRect();
    return { px: x - (r.left + r.width / 2), py: y - (r.top + r.height / 2) };
  };
  const zoomBy = (factor: number, x?: number, y?: number) => {
    const { w, h } = size();
    const p = x === undefined || y === undefined ? { px: 0, py: 0 } : local(x, y);
    setView(v => zoomAt(v, factor, p.px, p.py, w, h));
  };

  // Keys: arrows move (the way the language reads), + and - zoom, 0 fits, Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      const s = keyStep(e.key, rtl);
      if (s) { e.preventDefault(); go(s); return; }
      if (item?.kind !== 'image') return;
      if (e.key === '+' || e.key === '=') zoomBy(1.4);
      else if (e.key === '-') zoomBy(1 / 1.4);
      else if (e.key === '0') setView(FIT);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Focus moves into the viewer, and back to what was focused (the photo in the chat) when it closes.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; before?.focus?.(); };
  }, []);

  // The wheel zooms where the mouse is. It is added by hand because React's wheel listener cannot stop the page scrolling.
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (item?.kind !== 'image') return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // Fingers and the mouse: one finger pans a zoomed photo or swipes an unzoomed one; two fingers pinch; a double tap zooms.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x0: number; y0: number; last: { x: number; y: number }; moved: boolean; pinch?: { d: number; view: View; mid: { x: number; y: number } } } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  // Only a plain click that BEGAN on the dark area closes the viewer. (Once the photo captures the pointer, the click that
  // follows a press on the photo is reported on the dark area too, so its target alone cannot tell them apart.)
  const backdropPress = useRef(false);
  const down = (e: React.PointerEvent) => {
    backdropPress.current = e.target === e.currentTarget;
    if (item?.kind !== 'image' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still follows while over the photo */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...pointers.current.values()];
    if (ps.length === 2) {
      setDrag(0);
      gesture.current = { x0: 0, y0: 0, last: ps[0], moved: true, pinch: { d: spread(ps[0], ps[1]), view: viewRef.current, mid: { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 } } };
    } else if (ps.length === 1) gesture.current = { x0: e.clientX, y0: e.clientY, last: { x: e.clientX, y: e.clientY }, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current, ps = [...pointers.current.values()];
    const { w, h } = size();
    if (g.pinch && ps.length >= 2) {
      const p = local(g.pinch.mid.x, g.pinch.mid.y);
      setView(zoomAt(g.pinch.view, spread(ps[0], ps[1]) / Math.max(1, g.pinch.d), p.px, p.py, w, h));
      return;
    }
    const dx = e.clientX - g.last.x, dy = e.clientY - g.last.y;
    g.last = { x: e.clientX, y: e.clientY };
    if (Math.abs(e.clientX - g.x0) > 6 || Math.abs(e.clientY - g.y0) > 6) g.moved = true;
    if (viewRef.current.scale > 1) setView(v => clampPan({ ...v, x: v.x + dx, y: v.y + dy }, w, h));
    else if (items.length > 1) setDrag(e.clientX - g.x0);
  };
  const up = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) {   // one finger of a pinch lifted: carry on panning with the other
      const [p] = [...pointers.current.values()];
      gesture.current = { x0: p.x, y0: p.y, last: p, moved: true };
      return;
    }
    gesture.current = null;
    setDrag(0);
    if (!g || e.type === 'pointercancel') return;
    if (!g.moved) {
      const now = Date.now(), tap = lastTap.current;
      if (tap && now - tap.at < 320 && Math.hypot(tap.x - e.clientX, tap.y - e.clientY) < 30) {
        lastTap.current = null;
        const p = local(e.clientX, e.clientY), { w, h } = size();
        setView(v => toggleZoom(v, p.px, p.py, w, h));
      } else lastTap.current = { at: now, x: e.clientX, y: e.clientY };
      return;
    }
    if (!g.pinch && viewRef.current.scale <= 1) {
      const s = swipeStep(e.clientX - g.x0, e.clientY - g.y0, rtl);
      if (s) go(s);
    }
  };

  // The photos either side are fetched ahead, so moving to them is instant.
  const nearby = [items[index - 1], items[index + 1]].filter((x): x is ViewerItem => !!x && x.kind === 'image');

  if (!item) return null;
  const zoomed = view.scale > 1.01;
  const prevDisabled = index <= 0, nextDisabled = index >= items.length - 1;
  const roundBtn = 'w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30 disabled:hover:bg-white/10 transition-colors duration-[var(--dur-instant)]';
  return createPortal(
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t.viewer.label} data-photo-viewer
      className="fixed inset-0 z-[60] bg-[#0b0b0b] text-white flex flex-col outline-none animate-fade-in select-none" onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <button type="button" className={roundBtn} onClick={onClose} aria-label={t.closePanel} title={t.closePanel}><Icon name="x" className="w-5 h-5" /></button>
        <div className="min-w-0 flex-1 text-center">
          {items.length > 1 && <p className="text-sm font-bold tabular-nums" aria-live="polite" data-viewer-count>{fill(t.viewer.count, { n: String(index + 1), total: String(items.length) })}</p>}
          {item.caption && <p className="text-xs text-white/70 truncate"><bdi>{item.caption}</bdi></p>}
        </div>
        {item.att
          ? <MediaFile att={{ ...item.att, name: item.name ?? item.att.name ?? 'photo.jpg' }} className={`${roundBtn} !w-11 justify-center`}><Icon name="down" className="w-5 h-5" /><span className="sr-only">{t.download}</span></MediaFile>
          : item.src && <a className={roundBtn} href={item.src} download={item.name ?? 'photo.jpg'} aria-label={t.download} title={t.download}><Icon name="down" className="w-5 h-5" /></a>}
      </div>

      <div ref={stage} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden touch-none"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onClick={() => { if (backdropPress.current && !zoomed) onClose(); backdropPress.current = false; }}>
        {item.kind === 'video'
          ? <ViewerVideo item={item} />
          : <ViewerImage item={item} imgRef={img} style={{
              transform: `translate3d(${view.x + drag}px, ${view.y}px, 0) scale(${view.scale})`,
              transition: gesture.current ? 'none' : 'transform var(--dur-fast) ease-out',
              cursor: zoomed ? 'grab' : items.length > 1 ? 'default' : 'zoom-in',
            }} />}
        {items.length > 1 && (
          <>
            <button type="button" className={`${roundBtn} absolute start-3 top-1/2 -translate-y-1/2 hidden sm:flex`} disabled={prevDisabled}
              onClick={() => go(-1)} aria-label={t.viewer.prev} title={t.viewer.prev}><Icon name="arrow-start" className="w-5 h-5 rtl:-scale-x-100" /></button>
            <button type="button" className={`${roundBtn} absolute end-3 top-1/2 -translate-y-1/2 hidden sm:flex`} disabled={nextDisabled}
              onClick={() => go(1)} aria-label={t.viewer.next} title={t.viewer.next}><Icon name="arrow-end" className="w-5 h-5 rtl:-scale-x-100" /></button>
          </>
        )}
        {nearby.map(n => <Prefetch key={n.key} item={n} />)}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {item.kind === 'image' && (
          <div className="flex items-center gap-1 rounded-full bg-white/10 p-1" role="group" aria-label={t.viewer.zoomIn}>
            <button type="button" className={`${roundBtn} !w-9 !h-9 !bg-transparent hover:!bg-white/15`} disabled={!zoomed} onClick={() => zoomBy(1 / 1.5)} aria-label={t.viewer.zoomOut} title={t.viewer.zoomOut}><span aria-hidden className="text-xl leading-none">−</span></button>
            <button type="button" className="min-w-14 h-9 px-2 rounded-full text-sm tabular-nums hover:bg-white/15" onClick={() => setView(FIT)} aria-label={t.viewer.fit} title={t.viewer.fit} data-viewer-zoom>{Math.round(view.scale * 100)}%</button>
            <button type="button" className={`${roundBtn} !w-9 !h-9 !bg-transparent hover:!bg-white/15`} disabled={view.scale >= MAX_SCALE - 0.01} onClick={() => zoomBy(1.5)} aria-label={t.viewer.zoomIn} title={t.viewer.zoomIn}><Icon name="plus" className="w-5 h-5" /></button>
          </div>
        )}
        {actions?.(item, onClose)}
      </div>
      <p className="sr-only">{t.viewer.hint}</p>
    </div>,
    document.body,
  );
}

function useItemSrc(item: ViewerItem | undefined) {
  const decrypted = useMediaUrl(item?.att);
  return item?.src ?? decrypted;
}
function ViewerImage({ item, imgRef, style }: { item: ViewerItem; imgRef: React.RefObject<HTMLImageElement | null>; style: React.CSSProperties }) {
  const src = useItemSrc(item);
  const thumb = useMediaUrl(item.att, true);   // the small version shows at once while the full one arrives
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [src]);
  if (!src && !thumb) return <div aria-hidden className="w-40 h-40 rounded-2xl bg-white/10 animate-pulse" />;
  return (
    <>
      {!loaded && thumb && <img alt="" aria-hidden className="absolute max-w-full max-h-full object-contain blur-sm opacity-70" src={thumb} draggable={false} />}
      <img ref={imgRef} alt={item.alt ?? ''} src={src ?? thumb ?? undefined} draggable={false} onLoad={() => setLoaded(true)} data-viewer-img
        className="relative max-w-full max-h-full object-contain will-change-transform" style={style} />
    </>
  );
}
function ViewerVideo({ item }: { item: ViewerItem }) {
  const src = useItemSrc(item);
  return src ? <video controls autoPlay playsInline preload="metadata" className="max-w-full max-h-full bg-black" src={src} /> : <div aria-hidden className="w-40 h-40 rounded-2xl bg-white/10 animate-pulse" />;
}
function Prefetch({ item }: { item: ViewerItem }) {
  const src = useItemSrc(item);
  useEffect(() => { if (src) { const i = new Image(); i.src = src; } }, [src]);
  return null;
}
