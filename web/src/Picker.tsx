// A themed dropdown. The native <select> is drawn by the operating system: it ignores the
// theme, opens a grey system menu on desktop, and looked like a form from another app next
// to the rest of the UI. This is a real listbox to a screen reader and works by keyboard
// (arrows, Home/End, Enter, Escape), and closes on an outside click.
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';

export interface PickerOption<T extends string | number> { value: T; label: string }

export function Picker<T extends string | number>(
  { value, options, onChange, label, icon, columns = 1, align = 'start', className = '' }:
  { value: T; options: PickerOption<T>[]; onChange: (v: T) => void; label: string; icon?: IconName; columns?: number; /** Which edge of the button the menu lines up with. */ align?: 'start' | 'end'; className?: string },
) {
  const [open, setOpen] = useState(false);
  // Phones get a bottom sheet: a popover inside a scrolling pane gets clipped at the edges,
  // and a sheet is where a thumb already is. Decided when it opens, so a resize mid-open is fine.
  const [sheet, setSheet] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    requestAnimationFrame(() => list.current?.focus());
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (i: number) => { onChange(options[i].value); setOpen(false); };
  function onKey(e: React.KeyboardEvent) {
    const step = { ArrowDown: columns, ArrowUp: -columns, ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step !== undefined) { e.preventDefault(); setActive(a => Math.min(options.length - 1, Math.max(0, a + (document.dir === 'rtl' && Math.abs(step) === 1 ? -step : step)))); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
  }

  const ul = (inSheet: boolean) => (
        <ul ref={list} id={id} role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} onKeyDown={onKey}
          className={`${inSheet ? 'max-h-[60dvh] overflow-y-auto outline-none' : `absolute z-30 top-full mt-2 ${align === 'end' ? 'end-0' : 'start-0'} min-w-full w-max max-h-72 overflow-y-auto p-1.5 rounded-2xl bg-card border border-line elevated-3 origin-top animate-scale-in outline-none`} ${columns > 1 ? 'grid gap-1.5' : 'flex flex-col gap-0.5'}`}
          style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(4.5rem, 1fr))` } : undefined}>
          {options.map((o, i) => {
            const sel = o.value === value;
            return (
              <li key={String(o.value)} id={`${id}-${i}`} role="option" aria-selected={sel}
                onMouseEnter={() => setActive(i)} onClick={() => pick(i)}
                className={`cursor-pointer select-none rounded-xl px-3 ${inSheet ? 'py-3 text-base' : 'py-2 text-sm'} flex items-center gap-2 tabular-nums
                  transition-colors duration-[var(--dur-instant)]
                  ${columns > 1 ? 'justify-center' : 'justify-between'}
                  ${sel ? 'bg-brand text-white font-bold' : i === active ? 'bg-green-soft text-green' : 'text-ink'}`}>
                {o.label}
                {sel && columns === 1 && <Icon name="check" className="w-4 h-4" />}
              </li>
            );
          })}
        </ul>
  );

  return (
    <div ref={root} className={`relative ${className}`}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-label={`${label}: ${current?.label ?? ''}`}
        onClick={() => { setSheet(matchMedia('(max-width: 639px)').matches); setOpen(o => !o); }}
        className={`h-11 w-full px-3.5 rounded-xl bg-card border flex items-center gap-2 text-ink elevated-1
          transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-standard)]
          ${open ? 'border-green shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-focus)_16%,transparent)]' : 'border-line hover:border-green/40'}`}>
        {icon && <Icon name={icon} className="w-[18px] h-[18px] text-muted shrink-0" />}
        <span className="flex-1 text-start font-bold tabular-nums">{current?.label}</span>
        <Icon name="chevron" className={`w-4 h-4 text-muted shrink-0 transition-transform duration-[var(--dur-fast)] ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && !sheet && ul(false)}
      {open && sheet && createPortal(
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end animate-fade-in" onMouseDown={() => setOpen(false)}>
          <div className="sheet w-full rounded-t-3xl bg-card border-t border-line elevated-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]" onMouseDown={e => e.stopPropagation()}>
            <span aria-hidden className="block mx-auto mb-3 w-10 h-1.5 rounded-full bg-line" />
            <p className="px-1 mb-3 text-caption font-bold uppercase tracking-[0.12em] text-muted">{label}</p>
            {ul(true)}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
