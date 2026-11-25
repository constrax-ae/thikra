import { useState } from 'react';
import { askConfirm } from './confirm';
import { api, ApiError, type CircleSummary } from './api';
import { useI18n } from './i18n';
import { Dialog } from './Dialog';
import { Icon } from './icons';

/**
 * Chat lists: the filters a person makes for themselves ("Siblings", "School run"). They are private — the server
 * keeps them per person, nobody is told a list exists, and removing a chat from a list does nothing to the chat.
 */

export interface ChatListRow { id: number; name: string; circleIds: number[] }

export const load = () => api<ChatListRow[]>('/lists');

export function ListsDialog({ lists, chats, onChange, onClose }: {
  lists: ChatListRow[]; chats: CircleSummary[]; onChange: (lists: ChatListRow[]) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<number | null>(lists.length === 1 ? lists[0].id : null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); onChange(await load()); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const toggle = (list: ChatListRow, circleId: number) => {
    const ids = list.circleIds.includes(circleId) ? list.circleIds.filter(i => i !== circleId) : [...list.circleIds, circleId];
    return run(() => api(`/lists/${list.id}`, { method: 'PATCH', body: { circleIds: ids } }));
  };

  return (
    <Dialog onClose={onClose} label={t.lists.title}>
      <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="list" className="w-5 h-5 text-green" />{t.lists.title}</h2>
      <p className="text-xs text-muted mt-1">{t.lists.note}</p>

      <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); const n = name.trim(); if (n) run(async () => { await api('/lists', { body: { name: n } }); setName(''); }); }}>
        <input className="field flex-1" value={name} maxLength={40} placeholder={t.lists.newName} aria-label={t.lists.newName} onChange={e => setName(e.target.value)} />
        <button className="btn" disabled={busy || !name.trim()}>{t.lists.create}</button>
      </form>

      <div className="mt-3 space-y-2 max-h-[55vh] overflow-y-auto">
        {!lists.length && <p className="text-sm text-muted">{t.lists.none}</p>}
        {lists.map(list => {
          const open = editing === list.id;
          return (
            <section key={list.id} className="rounded-2xl border border-line bg-card">
              <div className="flex items-center gap-2 px-3 py-2">
                {renaming?.id === list.id ? (
                  <form className="flex-1 flex gap-2" onSubmit={e => { e.preventDefault(); const next = renaming.value.trim(); if (next) run(async () => { await api(`/lists/${list.id}`, { method: 'PATCH', body: { name: next } }); setRenaming(null); }); }}>
                    <input className="field flex-1" autoFocus value={renaming.value} maxLength={40} aria-label={t.lists.rename} onChange={e => setRenaming({ id: list.id, value: e.target.value })} />
                    <button className="btn !py-1" disabled={busy || !renaming.value.trim()}>{t.priv.done}</button>
                    <button type="button" className="btn btn-ghost !py-1" onClick={() => setRenaming(null)}>{t.cancel}</button>
                  </form>
                ) : (
                  <button type="button" className="flex-1 text-start font-bold" aria-expanded={open} onClick={() => setEditing(open ? null : list.id)}>
                    <bdi>{list.name}</bdi> <span className="text-xs text-muted font-normal">{list.circleIds.length}</span>
                  </button>
                )}
                <button type="button" aria-label={`${t.lists.rename} ${list.name}`} disabled={busy} className="p-2 rounded-lg text-muted hover:text-green hover:bg-green-soft"
                  onClick={() => setRenaming(renaming?.id === list.id ? null : { id: list.id, value: list.name })}><Icon name="pen" className="w-4 h-4" /></button>
                <button type="button" aria-label={`${t.lists.remove} ${list.name}`} disabled={busy} className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10"
                  onClick={async () => { if (await askConfirm(t.lists.removeConfirm.replace('{name}', list.name), { danger: true })) run(() => api(`/lists/${list.id}`, { method: 'DELETE' })); }}><Icon name="trash" className="w-4 h-4" /></button>
              </div>
              {open && (
                <ul className="px-3 pb-3 space-y-1 max-h-56 overflow-y-auto">
                  {!chats.length && <li className="text-sm text-muted">{t.lists.noChats}</li>}
                  {chats.map(c => (
                    <li key={c.id}>
                      <label className="flex items-center gap-2 py-1 cursor-pointer">
                        <input type="checkbox" checked={list.circleIds.includes(c.id)} disabled={busy} onChange={() => toggle(list, c.id)} />
                        <span className="truncate"><bdi>{c.name}</bdi></span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
      <button className="btn w-full mt-4" onClick={onClose}>{t.priv.done}</button>
    </Dialog>
  );
}
