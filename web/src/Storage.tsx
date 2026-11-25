import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { sizeText } from './UploadUi';

/**
 * What each chat is using, and clearing out the big old files.
 *
 * Seeing the numbers is private and harmless. Clearing is not: media lives on the server and belongs to everyone in
 * the chat, so only a manager can do it, it always counts before it deletes, and the family's archive is never swept.
 */

interface ChatUse { id: number; name: string; kind: string; role: string; bytes: number; imageBytes: number; videoBytes: number; voiceBytes: number; fileBytes: number; archivedBytes: number; files: number }
const KINDS = ['image', 'video', 'audio', 'file'] as const;
const AGES = [0, 30, 90, 365];
const SIZES = [0, 5, 25];

export function StorageByChat() {
  const { t } = useI18n();
  const [rows, setRows] = useState<ChatUse[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const load = () => api<ChatUse[]>('/storage/chats').then(setRows).catch(e => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic));
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p role="alert" className="text-danger">{error}</p>;
  if (!rows) return <p className="text-muted">{t.store.loading}</p>;
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  if (!total) return <p className="text-muted">{t.store.none}</p>;

  return (
    <div className="space-y-2">
      <p className="text-muted">{t.store.total}: <b className="text-ink tabular-nums" dir="ltr">{sizeText(total)}</b></p>
      <ul className="space-y-2">
        {rows.filter(r => r.bytes > 0).map(r => (
          <li key={r.id} className="rounded-2xl border border-line bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate font-bold"><bdi>{r.name}</bdi></span>
              <span className="tabular-nums text-sm" dir="ltr">{sizeText(r.bytes)}</span>
            </div>
            {/* one bar, in the order photos, videos, voice, files */}
            <div className="mt-2 h-2 rounded-full bg-line overflow-hidden flex" dir="ltr" aria-hidden>
              {([['imageBytes', 'bg-green'], ['videoBytes', 'bg-brand'], ['voiceBytes', 'bg-gold'], ['fileBytes', 'bg-muted']] as const).map(([k, cls]) =>
                r[k] > 0 ? <span key={k} className={cls} style={{ width: `${(r[k] / r.bytes) * 100}%` }} /> : null)}
            </div>
            <p className="mt-1 text-xs text-muted">
              {[[t.store.photos, r.imageBytes], [t.store.videos, r.videoBytes], [t.store.voice, r.voiceBytes], [t.store.files, r.fileBytes]]
                .filter(([, v]) => (v as number) > 0).map(([label, v]) => `${label} ${sizeText(v as number)}`).join(' · ')}
              {r.archivedBytes > 0 && ` · ${t.store.archived} ${sizeText(r.archivedBytes)}`}
            </p>
            {r.role === 'owner' || r.role === 'admin'
              ? <button type="button" className="btn btn-ghost !py-1 mt-2 text-sm" onClick={() => setOpen(open === r.id ? null : r.id)}>{t.store.free}</button>
              : <p className="mt-2 text-xs text-muted">{t.store.managersOnly}</p>}
            {open === r.id && <Sweep circleId={r.id} onDone={() => { setOpen(null); load(); }} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Choose what to clear, count it, then say it out loud before anything is deleted. */
function Sweep({ circleId, onDone }: { circleId: number; onDone: () => void }) {
  const { t } = useI18n();
  const [kinds, setKinds] = useState<string[]>(['video']);
  const [days, setDays] = useState(90);
  const [mb, setMb] = useState(0);
  const [found, setFound] = useState<{ messages: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = () => ({ kinds, olderThanDays: days, minBytes: mb * 1024 * 1024 });
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);

  const count = async () => {
    setBusy(true); setError('');
    try { setFound(await api(`/circles/${circleId}/media/cleanup`, { body: body() })); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const sweep = async () => {
    if (!found || !confirm(t.store.deleteConfirm.replace('{n}', String(found.messages)).replace('{size}', sizeText(found.bytes)))) return;
    setBusy(true); setError('');
    try { await api(`/circles/${circleId}/media/cleanup`, { body: { ...body(), preview: false } }); onDone(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const chip = (on: boolean) => `h-8 px-3 rounded-xl text-sm border transition-colors duration-[var(--dur-instant)] ${on ? 'border-green text-green font-bold bg-green-soft' : 'border-line text-muted'}`;

  return (
    <div className="mt-2 pt-2 border-t border-line space-y-2">
      <p className="text-xs text-muted">{t.store.freeNote}</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.store.what}>
        {KINDS.map(k => (
          <button key={k} type="button" aria-pressed={kinds.includes(k)} className={chip(kinds.includes(k))}
            onClick={() => { setFound(null); setKinds(list => list.includes(k) ? list.filter(x => x !== k) : [...list, k]); }}>{t.store.kindNames[k]}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.store.olderThan}>
        {AGES.map((d, i) => <button key={d} type="button" aria-pressed={days === d} className={chip(days === d)} onClick={() => { setFound(null); setDays(d); }}>{t.store.ages[i]}</button>)}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.store.biggerThan}>
        {SIZES.map((m, i) => <button key={m} type="button" aria-pressed={mb === m} className={chip(mb === m)} onClick={() => { setFound(null); setMb(m); }}>{t.store.sizes[i]}</button>)}
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2 flex-wrap items-center">
        <button type="button" className="btn btn-ghost !py-1 text-sm" disabled={busy || !kinds.length} onClick={count}><Icon name="search" className="w-4 h-4" />{t.store.count}</button>
        {found && (
          <>
            <span role="status" className="text-sm">{(found.messages === 1 ? t.store.found1 : t.store.found).replace('{n}', String(found.messages)).replace('{size}', sizeText(found.bytes))}</span>
            {found.messages > 0 && <button type="button" className="btn !py-1 text-sm !bg-danger !border-danger" disabled={busy} onClick={sweep}><Icon name="trash" className="w-4 h-4" />{t.store.deleteNow}</button>}
          </>
        )}
      </div>
    </div>
  );
}
