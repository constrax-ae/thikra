import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useI18n } from './i18n';
import { Dialog } from './Dialog';
import { useE2ee } from './e2ee';
import { Icon } from './icons';
import { Spinner } from './States';

interface ListRow { id: number; name: string; count: number }
interface Person { id: number; name: string; via: string }

/**
 * Broadcast lists: one message, sent to each person on the list as an ordinary private message. THIS device does the sending, one
 * message into each person's own chat, so the server never sees the text as "a broadcast" and recipients cannot see each other.
 * The answer carries no count of who received it, so a block is never revealed.
 */
export function BroadcastLists({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { on: encOn, e2ee } = useE2ee();   // encryption on: each person's ENCRYPTED private chat, encrypted here
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [view, setView] = useState<{ kind: 'lists' } | { kind: 'edit'; id: number | null } | { kind: 'send'; id: number }>({ kind: 'lists' });
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [pick, setPick] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [batch, setBatch] = useState<string | null>(null);   // kept until a send finishes, so a retry never doubles a message
  const sentTo = useRef(new Set<string>());
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  const load = useCallback(() => api<ListRow[]>('/broadcast-lists').then(setLists).catch(() => setLists([])), []);
  useEffect(() => { load(); api<Person[]>('/people').then(setPeople).catch(() => {}); }, [load]);

  async function edit(id: number | null) {
    setError(''); setName(''); setPick([]);
    if (id !== null) { try { const l = await api<{ name: string; members: Array<{ id: number }> }>(`/broadcast-lists/${id}`); setName(l.name); setPick(l.members.map(m => m.id)); } catch (e) { return fail(e); } }
    setView({ kind: 'edit', id });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (!pick.length) return setError(t.priv.broadcastNoPeople);
    try {
      if (view.kind === 'edit' && view.id !== null) await api(`/broadcast-lists/${view.id}`, { method: 'PATCH', body: { name, members: pick } });
      else await api('/broadcast-lists', { body: { name, members: pick } });
      await load(); setView({ kind: 'lists' });
    } catch (err) { fail(err); }
  }
  async function remove(id: number) { try { await api(`/broadcast-lists/${id}`, { method: 'DELETE' }); await load(); setView({ kind: 'lists' }); } catch (e) { fail(e); } }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (view.kind !== 'send' || !text.trim() || busy) return;
    setBusy(true); setError('');
    const id = batch ?? crypto.randomUUID(); setBatch(id);
    try {
      if (encOn && !e2ee) { setError(t.errors.generic); return; }   // encryption is on but this device is not ready yet: never fall back to readable chats
      const { chats } = await api<{ chats: Array<{ userId: number; circleId: number }> }>(`/broadcast-lists/${view.id}/chats`, { body: encOn ? { encrypted: true } : {} });
      let trouble = false;
      const done = sentTo.current;   // people who already have this batch: a retry after a failure never sends them a second copy
      for (const c of chats) {
        const cid = `bc-${id}-${c.userId}`;
        if (done.has(`${id}:${c.userId}`)) continue;
        try {
          if (encOn && e2ee) { await e2ee.startChat(c.circleId); await e2ee.sendText(c.circleId, text.trim(), { cid }); }   // the same cid on a retry: nothing twice
          else await api(`/circles/${c.circleId}/messages`, { body: { body: text.trim(), client_msg_id: cid } });
          done.add(`${id}:${c.userId}`);
        }
        catch (err) { if (!(err instanceof ApiError && err.code === 'blocked')) trouble = true; }   // a block is left out in silence
      }
      if (trouble) { setError(t.errors.generic); return; }   // the same batch id is kept: sending again delivers only what is missing
      setText(''); setBatch(null); setDone(true);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  return (
    <Dialog onClose={onClose} label={t.priv.broadcast}>
      <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="megaphone" className="w-5 h-5 text-green" />{t.priv.broadcast}</h2>
      {view.kind === 'lists' && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted">{encOn ? t.e2ee.broadcastNote : t.priv.broadcastNote}</p>
          {!lists && <p role="status" className="text-sm text-muted flex items-center gap-2"><Spinner />{t.loading}</p>}
          {lists && lists.length === 0 && <p className="text-sm text-muted">{t.priv.broadcastEmpty}</p>}
          <ul className="space-y-1.5">
            {(lists ?? []).map(l => (
              <li key={l.id} className="px-3 py-2.5 rounded-2xl bg-card border border-line elevated-1 flex items-center gap-3">
                <span aria-hidden className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="megaphone" className="w-5 h-5" /></span>
                <span className="min-w-0 flex-1"><b className="block truncate">{l.name}</b><span className="block text-xs text-muted">{l.count} {t.members}</span></span>
                <button className="btn !rounded-full !w-9 !h-9 !p-0 shrink-0 inline-flex items-center justify-center" aria-label={t.priv.broadcastSend} title={t.priv.broadcastSend}
                  onClick={() => { setText(''); setDone(false); setError(''); setBatch(null); setView({ kind: 'send', id: l.id }); }}><Icon name="send" className="w-4 h-4 rtl:-scale-x-100" /></button>
                <button className="w-9 h-9 rounded-xl flex items-center justify-center text-green hover:bg-green-soft transition-colors duration-[var(--dur-instant)]" aria-label={t.edit} title={t.edit} onClick={() => edit(l.id)}><Icon name="pen" className="w-5 h-5" /></button>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <button className="btn btn-ghost w-full inline-flex items-center justify-center gap-2" onClick={() => edit(null)}><Icon name="plus-circle" className="w-5 h-5" />{t.priv.broadcastNew}</button>
          <button className="btn btn-ghost w-full" onClick={onClose}>{t.close}</button>
        </div>
      )}
      {view.kind === 'edit' && (
        <form onSubmit={save} className="mt-3 space-y-2">
          <input className="field" required maxLength={60} autoFocus placeholder={t.priv.broadcastName} value={name} onChange={e => setName(e.target.value)} />
          <h3 className="text-sm font-bold">{t.priv.broadcastPeople}</h3>
          {people.length === 0 && <p className="text-sm text-muted">{t.priv.broadcastNoOne}</p>}
          <ul className="max-h-56 overflow-y-auto">
            {people.map(p => (
              <li key={p.id}><label className="row-interactive flex items-center gap-2.5 px-2 py-2 rounded-xl cursor-pointer">
                <input type="checkbox" className="w-5 h-5 accent-[var(--color-brand)]" checked={pick.includes(p.id)} disabled={!pick.includes(p.id) && pick.length >= 100} onChange={e => setPick(l => e.target.checked ? [...l, p.id] : l.filter(x => x !== p.id))} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span><span className="text-xs text-muted truncate">{p.via}</span>
              </label></li>
            ))}
          </ul>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <button className="btn flex-1">{t.save}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setView({ kind: 'lists' })}>{t.back}</button>
          </div>
          {view.id !== null && <button type="button" className="text-sm font-bold text-danger inline-flex items-center gap-1.5 py-1" onClick={() => remove(view.id!)}><Icon name="trash" className="w-5 h-5" />{t.priv.broadcastDelete}</button>}
        </form>
      )}
      {view.kind === 'send' && (
        <form onSubmit={send} className="mt-3 space-y-2">
          <p className="text-xs text-muted">{encOn ? t.e2ee.broadcastNote : t.priv.broadcastNote}</p>
          <textarea className="field" rows={4} maxLength={4000} autoFocus placeholder={t.priv.broadcastWrite} value={text} onChange={e => { setText(e.target.value); setDone(false); }} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {done && <p role="status" className="text-sm text-green font-bold flex items-center gap-1.5 animate-fade-in"><Icon name="check" className="w-5 h-5" />{t.priv.broadcastSent}</p>}
          <div className="flex gap-2">
            <button className="btn flex-1 inline-flex items-center justify-center gap-2" disabled={busy || !text.trim()}>{busy ? <Spinner /> : <Icon name="send" className="w-5 h-5" />}{t.priv.broadcastSend}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setView({ kind: 'lists' })}>{t.back}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
