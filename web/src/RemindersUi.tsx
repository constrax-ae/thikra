import { useEffect, useMemo, useState } from 'react';
import { useI18n, intlLocale, fill } from './i18n';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { forget, presets, readReminders, split, useReminders, JUMP_KEY, JUMP_EVENT, type Reminder } from './reminders';

const when = (at: number, lang: string) => new Date(at).toLocaleString(intlLocale(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// <input type="datetime-local"> speaks local time with no zone: "2026-11-23T20:30".
const localValue = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** "Remind me": the quick choices, or a day and time of your own. */
export function RemindSheet({ current, onClose, onPick, onClear }: { current?: Reminder; onClose: () => void; onPick: (at: number) => void; onClear: () => void }) {
  const { t, lang } = useI18n();
  const now = useMemo(() => new Date(), []);
  const [custom, setCustom] = useState(() => localValue(new Date(now.getTime() + 3600_000)));
  const [error, setError] = useState('');
  const choose = () => {
    const at = new Date(custom).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) { setError(t.rem.past); return; }
    onPick(at);
  };
  return (
    <Dialog onClose={onClose} label={t.rem.title}>
      <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="bell" className="w-5 h-5 text-green" />{t.rem.title}</h2>
      <p className="text-sm text-muted mt-1">{t.rem.note}</p>
      {current && (
        <p className="mt-3 text-sm rounded-xl bg-green-soft text-green px-3 py-2 flex items-center gap-2">
          <Icon name="clock" className="w-4 h-4 shrink-0" /><span className="flex-1">{fill(t.rem.at, { when: when(current.at, lang) })}</span>
          <button className="underline text-xs" onClick={onClear}>{t.rem.cancel}</button>
        </p>
      )}
      <ul className="mt-3 space-y-1">
        {presets(now).map(p => (
          <li key={p.k}>
            <button className="row-interactive w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-start" onClick={() => onPick(p.at)}>
              <Icon name="clock" className="w-5 h-5 text-muted shrink-0" />
              <span className="flex-1 font-medium">{t.rem[p.k]}</span>
              <span className="text-xs text-muted tabular-nums" dir="auto">{when(p.at, lang)}</span>
            </button>
          </li>
        ))}
      </ul>
      <label className="block mt-3 text-sm font-medium">{t.rem.custom}
        <input type="datetime-local" className="field mt-1" value={custom} min={localValue(new Date())} onChange={e => { setCustom(e.target.value); setError(''); }} />
      </label>
      {error && <p role="alert" className="text-sm text-danger mt-1">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn btn-primary flex-1" onClick={choose}>{t.rem.set}</button>
        <button className="btn btn-ghost" onClick={onClose}>{t.cancel}</button>
      </div>
    </Dialog>
  );
}

/**
 * Rings the reminders whose time has come: a card in the app, and a system notification too when the page is in the
 * background and notifications are allowed. One that came due while the app was closed rings the next time it opens.
 */
export function ReminderAlarm({ meId, onOpen }: { meId: number; onOpen: (circleId: number) => void }) {
  const { t, lang } = useI18n();
  const list = useReminders(meId);
  const [ringing, setRinging] = useState<Reminder[]>([]);
  useEffect(() => {
    const ring = () => {
      const { due } = split(readReminders(meId), Date.now());
      if (!due.length) return;
      for (const r of due) {
        forget(meId, r.id);
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          navigator.serviceWorker?.ready.then(sw => sw.showNotification(t.rem.ringing, { body: r.chat, tag: `reminder-${r.id}`, data: { circle: r.circleId } })).catch(() => {});
        }
      }
      setRinging(prev => [...prev, ...due.filter(d => !prev.some(p => p.id === d.id))]);
    };
    ring();
    const next = split(list, Date.now()).later[0];
    const timer = next ? setTimeout(ring, Math.min(next.at - Date.now() + 50, 2_147_000_000)) : undefined;
    const onShow = () => { if (!document.hidden) ring(); };   // a laptop that slept past the time
    document.addEventListener('visibilitychange', onShow);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onShow); };
  }, [list, meId]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!ringing.length) return null;
  const drop = (id: string) => setRinging(prev => prev.filter(r => r.id !== id));
  return (
    <div role="region" aria-label={t.rem.ringing} className="fixed z-50 bottom-4 inset-x-4 sm:inset-x-auto sm:end-6 sm:w-96 space-y-2">
      {ringing.map(r => (
        <div key={r.id} role="alert" className="rounded-2xl bg-card border border-line elevated-3 p-3 flex items-center gap-3 animate-slide-in">
          <span aria-hidden className="w-10 h-10 rounded-xl bg-gold/15 text-gold-dark flex items-center justify-center shrink-0"><Icon name="bell" className="w-5 h-5" /></span>
          <span className="min-w-0 flex-1">
            <b className="block text-sm">{t.rem.ringing}</b>
            <span className="block text-sm text-muted truncate"><bdi>{r.chat}</bdi> · <span dir="auto">{when(r.at, lang)}</span></span>
          </span>
          <button className="btn btn-primary !px-3 !py-1.5 text-sm" onClick={() => { drop(r.id); try { sessionStorage.setItem(JUMP_KEY, String(r.messageId)); } catch { /* opens the chat, without the jump */ } onOpen(r.circleId); window.dispatchEvent(new Event(JUMP_EVENT)); }}>{t.rem.open}</button>
          <button aria-label={t.rem.dismiss} title={t.rem.dismiss} className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:bg-green-soft hover:text-green" onClick={() => drop(r.id)}><Icon name="x" className="w-4 h-4" /></button>
        </div>
      ))}
    </div>
  );
}
