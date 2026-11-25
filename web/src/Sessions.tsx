import { useEffect, useState } from 'react';
import { api, toDate } from './api';
import { useI18n, intlLocale } from './i18n';
import { Icon } from './icons';

interface Sess { id: number; userAgent: string | null; createdAt: string | null; lastSeenAt: string | null; current: boolean }

/** What a browser calls itself, said in words a person recognises. Nothing clever: the name of the app and the system. */
function deviceName(ua: string | null, unknown: string): string {
  if (!ua) return unknown;
  const sys = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const app = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [app, sys].filter(Boolean).join(' · ') || unknown;
}

/**
 * RT-03, the part a person sees: every place this account is signed in, when it was last used, and a way to end any
 * of them. (The encryption panel below lists the DEVICES of an encrypted chat, which is a different thing: one
 * carries keys, this one carries a session.)
 */
export function Sessions() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Sess[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => api<Sess[]>('/me/sessions').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const when = (iso: string | null) => (iso ? toDate(iso).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  async function end(s: Sess) {
    if (!confirm(s.current ? t.sess.endThisConfirm : t.sess.endConfirm)) return;
    setBusy(true); setMsg('');
    try {
      const r = await api<{ signedOutHere: boolean }>(`/me/sessions/${s.id}`, { method: 'DELETE' });
      if (r.signedOutHere) { location.reload(); return; }
      await load();
    } catch { setMsg(t.errors.generic); } finally { setBusy(false); }
  }
  async function endOthers() {
    if (!confirm(t.sess.endOthersConfirm)) return;
    setBusy(true); setMsg('');
    try { const r = await api<{ ended: number }>('/me/sessions/revoke-others', { body: {} }); setMsg(t.sess.ended.replace('{n}', String(r.ended))); await load(); }
    catch { setMsg(t.errors.generic); } finally { setBusy(false); }
  }
  if (rows === null) return <p className="text-muted">{t.loading}</p>;
  return (
    <div className="space-y-2">
      <p className="text-muted">{t.sess.note}</p>
      <ul className="divide-y divide-line">
        {rows.map(s => (
          <li key={s.id} className="py-2 flex items-center gap-2">
            <Icon name={/iPhone|Android|iPad/.test(s.userAgent ?? '') ? 'phone' : 'storage'} className="w-4 h-4 text-muted shrink-0" />
            <span className="min-w-0 flex-1">
              <b className="block">{deviceName(s.userAgent, t.sess.unknown)}{s.current && <span className="ms-2 text-xs text-green">{t.sess.thisOne}</span>}</b>
              <span className="block text-caption text-muted">{t.sess.lastUsed.replace('{when}', when(s.lastSeenAt ?? s.createdAt))}</span>
            </span>
            <button className="btn btn-ghost !py-1 text-xs shrink-0" disabled={busy} onClick={() => end(s)}>{s.current ? t.sess.endThis : t.sess.end}</button>
          </li>
        ))}
      </ul>
      {rows.length > 1 && <button className="btn btn-ghost" disabled={busy} onClick={endOthers}>{t.sess.endOthers}</button>}
      {msg && <p role="status" className="text-muted">{msg}</p>}
    </div>
  );
}
