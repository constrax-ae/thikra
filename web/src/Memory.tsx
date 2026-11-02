import { useEffect, useState } from 'react';
import { api, type CircleSummary } from './api';
import { useI18n, intlLocale } from './i18n';

interface Entry { id: number; title: string; summary: string; category: string | null; eventDate: string; kind: string; circleId: number; circleName: string }

/** The "Memory" tab: Thekra's own addition. One timeline of everything the agent documented across all your family circles. */
export function Memory({ onOpenArchive }: { onOpenArchive: (id: number) => void }) {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  useEffect(() => {
    api<Entry[]>('/me/memory').then(setEntries).catch(() => setEntries([]));
    api<CircleSummary[]>('/circles').then(l => setCircles(l.filter(c => c.kind === 'circle'))).catch(() => {});
  }, []);

  const month = (d: string) => new Date(`${d.slice(0, 7)}-01T00:00:00`).toLocaleDateString(intlLocale(lang), { month: 'long', year: 'numeric' });
  const groups = (entries ?? []).reduce<Array<[string, Entry[]]>>((acc, e) => {
    const k = month(e.eventDate); const last = acc[acc.length - 1];
    if (last && last[0] === k) last[1].push(e); else acc.push([k, [e]]);
    return acc;
  }, []);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-green">{t.memoryTitle}</h2>
      <p className="text-sm text-muted">{t.memoryIntro}</p>

      {entries === null ? null : groups.length === 0 ? (
        <p className="card p-4 text-muted">{circles.length === 0 ? t.memoryEmpty : t.memoryNoEntries}</p>
      ) : groups.map(([label, list]) => (
        <section key={label} className="space-y-2">
          <h3 className="text-sm font-bold text-green">{label}</h3>
          <ul className="timeline space-y-3">
            {list.map(e => (
              <li key={`${e.circleId}-${e.id}`} className="timeline-item">
                <button className="card w-full p-3 text-start hover:bg-green-soft/50" onClick={() => onOpenArchive(e.circleId)}>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    <span>{new Date(e.eventDate).toLocaleDateString(intlLocale(lang), { day: 'numeric', month: 'short' })}</span>
                    <span>·</span><span className="truncate">{e.circleName}</span>
                    {e.category && <span className="px-1.5 rounded-full bg-green-soft text-green">{t.cat[e.category] ?? e.category}</span>}
                  </span>
                  <b className="block">{e.title}</b>
                  <span className="block text-sm text-muted line-clamp-2">{e.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {circles.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-bold text-green">{t.memoryCircles}</h3>
          <ul className="card divide-y divide-line overflow-hidden">
            {circles.map(c => (
              <li key={c.id}>
                <button className="w-full p-3 text-start flex items-center gap-3 hover:bg-green-soft/50" onClick={() => onOpenArchive(c.id)}>
                  <span className="w-10 h-10 rounded-full bg-green-soft text-green flex items-center justify-center font-bold">{c.name.slice(0, 1)}</span>
                  <span className="flex-1 min-w-0"><b className="block truncate">{c.name}</b><span className="text-xs text-muted">{c.agentActive ? t.agentOn : t.memoryAgentOff}</span></span>
                  <span className="text-sm text-green">{t.openArchive} ›</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
