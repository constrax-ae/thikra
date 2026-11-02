import { useEffect, useState } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { MachineNote } from './LangPicker';

interface Card { id: string; level: 'info' | 'warning' | 'consent' | 'maintenance'; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string }

/** Notices from the team above the main screens: news, a warning, scheduled maintenance, or new terms that need an explicit "I agree". */
export function Notices() {
  const { t, lang } = useI18n();
  const [cards, setCards] = useState<Card[]>([]);
  const load = () => api<Card[]>('/announcements').then(setCards).catch(() => {});
  useEffect(() => { load(); const timer = setInterval(load, 5 * 60_000); const onFocus = () => load(); window.addEventListener('focus', onFocus); return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); }; }, []);
  if (!cards.length) return null;
  const en = lang !== 'ar';   // anyone who does not read Arabic gets the English text (the notice is written in Arabic and English)
  async function close(c: Card, accepted: boolean) { try { await api(`/announcements/${c.id}/dismiss`, { body: { accepted } }); } catch { /* it comes back next time */ } load(); }
  return (
    <div className="space-y-2 pb-2" role="region" aria-label={t.noticeRegion}>
      {cards.map(c => {
        const title = en ? c.titleEn : c.titleAr, body = en ? c.bodyEn : c.bodyAr;
        const tone = c.level === 'warning' || c.level === 'maintenance' ? 'border-gold bg-gold/10' : c.level === 'consent' ? 'border-green bg-card' : 'border-line bg-card';
        return (
          <div key={c.id} className={`rounded-2xl border p-3 space-y-1.5 ${tone}`}>
            {title && <b className="block text-sm">{title}</b>}
            {body && <p className="text-sm text-muted whitespace-pre-wrap">{body}</p>}
            {c.level === 'consent' && <MachineNote />}
            {c.level === 'consent' ? <button className="btn" onClick={() => close(c, true)}>{t.noticeAgree}</button>
              : c.level !== 'maintenance' ? <button className="text-xs text-green underline" onClick={() => close(c, false)}>{t.noticeClose}</button> : null}
          </div>
        );
      })}
    </div>
  );
}
