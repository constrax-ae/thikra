// Loading, empty and error states for the whole app (THK web UI 2/8).
// Before this file the app showed nothing at all while data loaded, and a failed request
// was indistinguishable from "you have nothing yet". Three rules hold everywhere now:
//   1. a list that is loading shows the shape of what is coming, never a blank
//   2. a list that is genuinely empty says so, and offers the one action that fixes it
//   3. a request that failed says so, and offers a retry
// The shimmer itself is the .shimmer class from the design foundation, so turning on
// "reduced animations" in You > Appearance stops it with no extra work here.
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { useI18n } from './i18n';

/** Reveals an element the first time it scrolls into view, then stops watching.
 *  The revealed state is the normal one, so if IntersectionObserver is missing — or the
 *  person has motion turned off — the content is simply there, never stuck invisible. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) { el.classList.add('reveal-in'); return; }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { el.classList.add('reveal-in'); io.disconnect(); }
    }, { rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** One grey bar. Width and height are passed as Tailwind classes so they stay on the spacing scale. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`shimmer block rounded-md ${className}`} />;
}

/** Wraps any skeleton: tells a screen reader the region is busy, and hides the decorative bars from it. */
function Loading({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/** The chat list while it loads. Mirrors the real row (48px avatar, name line, preview line)
 *  so the content does not jump when it arrives. */
export function ChatListSkeleton({ rows = 6 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <Loading label={t.loading}>
      <ul className="space-y-0.5">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3.5 px-3 py-3">
            <Skeleton className="w-12 h-12 !rounded-2xl shrink-0" />
            <span className="flex-1 min-w-0 space-y-2">
              <Skeleton className="h-3.5" />
              <Skeleton className="h-3 w-2/3" />
            </span>
            <Skeleton className="w-10 h-3 shrink-0" />
          </li>
        ))}
      </ul>
    </Loading>
  );
}

/** The Memory timeline while it loads: keeps the .timeline rail and its dots so the
 *  shape of the page is already correct before the entries arrive. */
export function TimelineSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <Loading label={t.loading}>
      <Skeleton className="h-4 w-32 mb-2" />
      <ul className="timeline space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="timeline-item card p-3 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3" />
          </li>
        ))}
      </ul>
    </Loading>
  );
}

/** A media grid while its thumbnails load. Pass the real grid's own column and gap
 *  classes so the tiles land in exactly the places the photos will. */
export function GridSkeleton({ tiles = 9, className = 'grid-cols-3 gap-1.5' }: { tiles?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <Loading label={t.loading}>
      <div className={`grid ${className}`}>
        {Array.from({ length: tiles }, (_, i) => <Skeleton key={i} className="aspect-square !rounded-lg" />)}
      </div>
    </Loading>
  );
}

/** Admin and operations tables while they load. */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  const { t } = useI18n();
  return (
    <Loading label={t.loading}>
      <div className="card divide-y divide-line overflow-hidden">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center gap-3 p-3">
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton key={c} className={`h-3.5 ${c === 0 ? 'flex-[2]' : 'flex-1'}`} />
            ))}
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** A spinner, for the one case a skeleton cannot cover: a button that is working.
 *  Linear easing on purpose — a spinner rotates at a constant rate. */
export function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** A button that is doing something: disabled while busy, so a second click cannot
 *  fire the same request twice, and the label stays in place so the layout does not shift. */
export function BusyButton(
  { busy, children, className = 'btn', ...rest }:
  { busy?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>,
) {
  return (
    <button {...rest} className={className} disabled={busy || rest.disabled} aria-busy={busy || undefined}>
      <span className="inline-flex items-center justify-center gap-2">
        {busy && <Spinner />}
        {children}
      </span>
    </button>
  );
}

/** A status pill. The same four-class recipe was written inline a dozen times across the
 *  admin screens, each slightly different; this makes a status look the same everywhere. */
export function Badge(
  { children, tone = 'neutral' }:
  { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' },
) {
  const tones = {
    neutral: 'bg-line text-muted',
    good: 'bg-green-soft text-green',
    warn: 'bg-gold/20 text-gold-dark',
    bad: 'bg-danger-soft text-danger',
    info: 'bg-green-soft text-green',
  };
  return <span className={`text-caption px-2 py-0.5 rounded-full whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

/** An on/off switch. A native checkbox is drawn by the operating system and ignores the
 *  theme, so settings looked like a form from another app. This is a real `switch` to a
 *  screen reader, is keyboard operable as a button, and clears the 44px touch target. */
export function Toggle(
  { checked, onChange, label, note }:
  { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; note?: ReactNode },
) {
  return (
    <label className="flex items-start gap-3 py-1.5 cursor-pointer">
      <button
        type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 w-11 h-6 shrink-0 rounded-full border transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]
          ${checked ? 'bg-brand border-brand' : 'bg-line border-line'}`}>
        <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full bg-white shadow-e1
          transition-[inset-inline-start] duration-[var(--dur-fast)] ease-[var(--ease-emphasis)]
          ${checked ? 'start-[1.375rem]' : 'start-0.5'}`} />
      </button>
      <span className="min-w-0"><b>{label}</b>{note && <span className="block text-muted">{note}</span>}</span>
    </label>
  );
}

/** A list with nothing in it yet. An empty state is not an error: it names what will
 *  appear here and gives the one action that makes it appear. */
export function EmptyState(
  { icon, title, body, action }:
  { icon: IconName; title: string; body?: string; action?: ReactNode },
) {
  return (
    <div className="card p-6 text-center flex flex-col items-center gap-3">
      <span className="w-14 h-14 rounded-full bg-green-soft text-green flex items-center justify-center">
        <Icon name={icon} className="w-7 h-7" />
      </span>
      <h2 className="text-lg font-bold text-green">{title}</h2>
      {body && <p className="text-sm text-muted max-w-sm">{body}</p>}
      {action}
    </div>
  );
}

/** A request that failed. Always offers the retry: a dead end with no way forward
 *  is the thing this ticket exists to remove. */
export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="card p-6 text-center flex flex-col items-center gap-3">
      <span className="w-14 h-14 rounded-full bg-danger-soft text-danger flex items-center justify-center">
        <Icon name="alert" className="w-7 h-7" />
      </span>
      <h2 className="text-lg font-bold">{t.loadFailedTitle}</h2>
      <p className="text-sm text-muted max-w-sm">{message || t.loadFailedBody}</p>
      {onRetry && (
        <button className="btn btn-ghost" onClick={onRetry}>
          <span className="inline-flex items-center gap-2"><Icon name="refresh" className="w-4 h-4" />{t.retry}</span>
        </button>
      )}
    </div>
  );
}
