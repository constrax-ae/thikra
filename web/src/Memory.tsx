import { useCallback, useEffect, useState } from 'react';
import { api, type CircleSummary } from './api';
import { useI18n, intlLocale } from './i18n';
import { TimelineSkeleton, ErrorState, useReveal } from './States';
import { Icon } from './icons';

interface Entry { id: number; title: string; summary: string; category: string | null; eventDate: string; kind: string; circleId: number; circleName: string }

/** The "Memory" tab: Thekra's own addition. One timeline of everything the agent documented across all your family circles. */
export function Memory({ onOpenArchive }: { onOpenArchive: (id: number) => void }) {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  // A failed load used to be turned into an empty timeline, which told the person
  // their family had no history rather than that the request failed.
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(() => {
    api<Entry[]>('/me/memory').then(e => { setEntries(e); setLoadFailed(false); }).catch(() => setLoadFailed(true));
    api<CircleSummary[]>('/circles').then(l => setCircles(l.filter(c => c.kind === 'circle'))).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const month = (d: string) => new Date(`${d.slice(0, 7)}-01T00:00:00`).toLocaleDateString(intlLocale(lang), { month: 'long', year: 'numeric' });
  const groups = (entries ?? []).reduce<Array<[string, Entry[]]>>((acc, e) => {
    const k = month(e.eventDate); const last = acc[acc.length - 1];
    if (last && last[0] === k) last[1].push(e); else acc.push([k, [e]]);
    return acc;
  }, []);

  const hasEntries = groups.length > 0;
  return (
    <div className="space-y-6 pt-2">
      {/* Same page title pattern as Messages: a quiet eyebrow over a confident heading. */}
      <div>
        <p className="text-caption font-bold uppercase tracking-[0.14em] text-muted">{t.memEyebrow}</p>
        <h1 className="text-3xl font-bold text-ink tracking-tight leading-tight mt-1">{t.memoryTitle}</h1>
        <p className="text-sm text-muted mt-2">{t.memoryIntro}</p>
      </div>

      {entries === null ? (loadFailed ? <ErrorState onRetry={load} /> : <TimelineSkeleton />) : !hasEntries ? (
        <MemoryEmpty noCircles={circles.length === 0} />
      ) : groups.map(([label, list]) => (
        <section key={label} className="space-y-2">
          <h3><span className="timeline-month">{label}</span></h3>
          <ul className="timeline space-y-3">
            {list.map(e => <Event key={`${e.circleId}-${e.id}`} e={e} onOpen={() => onOpenArchive(e.circleId)} />)}
          </ul>
        </section>
      ))}

      {circles.length > 0 && (
        <section>
          <h3 className="text-caption font-bold uppercase tracking-[0.12em] text-muted px-1 mb-2">{t.memoryCircles}</h3>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {circles.map((c, i) => (
              <li key={c.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <button className="group/arch w-full p-4 rounded-2xl bg-card border border-line elevated-1 text-start flex items-center gap-3.5
                  transition-[box-shadow,border-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)]
                  hover:shadow-[var(--shadow-e2)] hover:border-green/40 hover:-translate-y-0.5" onClick={() => onOpenArchive(c.id)}>
                  <span className="w-12 h-12 rounded-2xl bg-brand text-white ring-2 ring-gold/50 ring-offset-2 ring-offset-card flex items-center justify-center font-bold text-lg shrink-0">{c.name.slice(0, 1).toUpperCase()}</span>
                  <span className="flex-1 min-w-0">
                    <b className="block truncate text-ink"><bdi>{c.name}</bdi></b>
                    <span className="mt-1 inline-flex items-center gap-1.5 text-caption text-muted">
                      <span className={`w-2 h-2 rounded-full ${c.agentActive ? 'bg-brand animate-pulse-soft' : 'bg-line'}`} />
                      {c.agentActive ? t.memAgentOnShort : t.memoryAgentOff}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-sm text-green shrink-0">
                    {t.openArchive}
                    <Icon name="chevron" className="w-4 h-4 -rotate-90 rtl:rotate-90 transition-transform duration-[var(--dur-fast)] group-hover/arch:translate-x-0.5 rtl:group-hover/arch:-translate-x-0.5" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Nothing documented yet: say what this page will hold and the three steps that fill it,
 *  instead of a single sentence in an otherwise empty card. */
function MemoryEmpty({ noCircles }: { noCircles: boolean }) {
  const { t } = useI18n();
  const steps = [t.memStep1, t.memStep2, t.memStep3];
  return (
    <div className="rounded-3xl bg-card border border-line elevated-1 p-6 sm:p-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 text-center sm:text-start">
        <div aria-hidden className="relative w-28 h-28 shrink-0 animate-scale-in">
          <span className="absolute inset-0 rounded-[2rem] rotate-6 bg-line/70 border border-line" />
          <span className="absolute inset-2 rounded-[1.6rem] bg-brand text-white flex items-center justify-center elevated-3">
            <Icon name="memory" className="w-11 h-11" />
          </span>
          <span className="absolute -top-2 -start-2 text-gold-dark animate-pulse-soft"><Icon name="sparkle" className="w-5 h-5" /></span>
        </div>
        <div className="min-w-0 space-y-2">
          <h2 className="text-xl font-bold !text-ink tracking-tight">{t.memEmptyTitle}</h2>
          <p className="text-sm text-muted leading-relaxed">{noCircles ? t.memoryEmpty : t.memoryNoEntries}</p>
        </div>
      </div>
      <div className="mt-6 pt-6 border-t border-line">
        <p className="text-caption font-bold uppercase tracking-[0.12em] text-muted mb-3">{t.memHowTitle}</p>
        <ol className="grid gap-3 sm:grid-cols-3">
          {steps.map((s, i) => (
            <li key={i} className="flex sm:flex-col gap-3 p-3.5 rounded-2xl bg-paper/60 border border-line animate-slide-up" style={{ animationDelay: `${120 + i * 70}ms` }}>
              <span className="w-8 h-8 rounded-full bg-green-soft text-green font-bold flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
              <span className="text-sm text-ink leading-snug">{s}</span>
            </li>
          ))}
        </ol>
        {/* On desktop the chat list is already beside this page, so the shortcut is phone-only. */}
        <div className="mt-5 lg:hidden"><button className="btn h-11 !rounded-xl" onClick={() => { location.hash = '/'; }}>
          <Icon name="chats" className="w-5 h-5" />{t.memStartCircle}
        </button></div>
      </div>
    </div>
  );
}

/** One documented life event. A memory object rather than a list row: the day is set
 *  in its own column like a diary entry, the category is a quiet chip, and the whole
 *  card reveals as the thread scrolls past it. */
function Event({ e, onOpen }: { e: Entry; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const ref = useReveal<HTMLLIElement>();
  const d = new Date(e.eventDate);
  return (
    <li ref={ref} className="timeline-item reveal">
      <button
        className="card card-interactive w-full p-3 text-start flex gap-3"
        onClick={onOpen}>
        <span className="shrink-0 w-11 text-center leading-tight">
          <span className="block text-lg font-bold text-green">{d.toLocaleDateString(intlLocale(lang), { day: 'numeric' })}</span>
          <span className="block text-caption text-muted uppercase">{d.toLocaleDateString(intlLocale(lang), { month: 'short' })}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-caption text-muted">
            <span className="truncate">{e.circleName}</span>
            {e.category && <span className="px-1.5 rounded-full bg-green-soft text-green shrink-0">{t.cat[e.category] ?? e.category}</span>}
          </span>
          <b className="block mt-0.5">{e.title}</b>
          <span className="block text-sm text-muted line-clamp-2">{e.summary}</span>
        </span>
      </button>
    </li>
  );
}
