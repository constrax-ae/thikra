import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type CircleDetail } from './api';
import { useI18n } from './i18n';
import { prepare } from './media';
import { Icon } from './icons';
import { Toggle } from './States';

// Each person has their own colour (their name in a group, and their initial when they have no photo). All reach 4.5:1 on white.
export const MEMBER_COLOURS = ['#b0235a', '#00796b', '#5b3fc4', '#c2410c', '#1565c0', '#7b4a2a', '#2e7d32', '#8e24aa', '#9a6700', '#c0392b'];
export const personColour = (userId: number) => MEMBER_COLOURS[Math.abs(userId) % MEMBER_COLOURS.length];

/** A person's face: their profile picture, or their initial on their own colour when they have none (or it cannot be loaded). */
export function PersonAvatar({ id, name, avatarAt, className = 'w-8 h-8 text-sm' }: { id: number; name: string; avatarAt?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [avatarAt]);
  if (avatarAt && !broken) {
    return <img src={`/api/users/${id}/avatar?v=${encodeURIComponent(avatarAt)}`} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)}
      className={`${className} rounded-full object-cover shrink-0 bg-green-soft`} />;
  }
  return (
    <span aria-hidden className={`${className} rounded-full shrink-0 flex items-center justify-center font-bold text-white select-none`} style={{ background: personColour(id) }}>
      {([...name.trim()][0] ?? '?').toUpperCase()}
    </span>
  );
}

/** A chat's picture: the group's photo if it has one, otherwise its first letter (or the people sign for a plain group). */
export function Avatar({ name, kind, photo, person, className = 'w-12 h-12 text-lg' }: { name: string; kind: string; photo?: number | null; /** A private chat: the other person (their face stands for the chat). */ person?: { id: number; avatarAt?: string | null } | null; className?: string }) {
  if (kind === 'direct' && person) return <PersonAvatar id={person.id} name={name} avatarAt={person.avatarAt} className={className} />;
  // A family circle is the heart of the product, so it is the one avatar that carries the brand
  // fill and a gold ring. Groups are rounded squares with the group glyph, a person is a circle.
  const shape = kind === 'direct' ? 'rounded-full' : 'rounded-2xl';
  const ring = kind === 'circle' ? 'ring-2 ring-gold/50 ring-offset-2 ring-offset-paper' : '';
  if (photo) return <img src={`/api/media/${photo}`} alt="" className={`${className} ${shape} ${ring} object-cover shrink-0 bg-green-soft`} />;
  return (
    <span aria-hidden className={`${className} ${shape} ${ring} flex items-center justify-center font-bold shrink-0 ${kind === 'circle' ? 'bg-brand text-white' : 'bg-green-soft text-green'}`}>
      {kind === 'group' ? <Icon name="group" className="w-1/2 h-1/2" /> : ([...name][0] ?? '?').toUpperCase()}
    </span>
  );
}

/** The top of the group's info: its photo and description, with editing for those the group allows. */
export function GroupFace({ circle, canEdit, reload, onError, title }: { circle: CircleDetail; canEdit: boolean; reload: () => void; onError: (code: string) => void; /** The name and kind line, drawn between the photo and the description. */ title?: React.ReactNode }) {
  const { t } = useI18n();
  const file = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(circle.description ?? '');
  const [busy, setBusy] = useState(false);
  // Someone else changed the description: follow it, unless this person is in the middle of writing their own.
  useEffect(() => { if (!editing) setText(circle.description ?? ''); }, [circle.description, editing]);
  const fail = (err: unknown) => onError(err instanceof ApiError ? err.code : 'generic');

  async function setPhoto(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const p = await prepare(f);   // the same on-device shrinking as a photo sent in the chat
      const form = new FormData();
      form.append('file', p.file);
      await api(`/circles/${circle.id}/photo`, { method: 'PUT', form });
      reload();
    } catch (err) { fail(err); }
    finally { setBusy(false); if (file.current) file.current.value = ''; }
  }
  async function saveDescription(e: React.FormEvent) {
    e.preventDefault();
    try { await api(`/circles/${circle.id}`, { method: 'PATCH', body: { description: text } }); setEditing(false); reload(); } catch (err) { fail(err); }
  }
  return (
    <>
      {/* The photo, with its camera badge on the corner (as in every messenger) rather than a button laid over it. */}
      <div className="relative">
        <Avatar name={circle.name} kind={circle.kind} photo={circle.photo} className="w-20 h-20 text-3xl" />
        {canEdit && (
          <>
            <input ref={file} type="file" hidden accept="image/*" onChange={e => setPhoto(e.target.files)} />
            <button type="button" disabled={busy} onClick={() => file.current?.click()} aria-label={t.changePhoto} title={t.changePhoto}
              className="absolute -bottom-1 -end-1 w-8 h-8 rounded-full bg-brand text-white border-2 border-card flex items-center justify-center elevated-2 hover:scale-105 transition-transform duration-[var(--dur-fast)] disabled:opacity-60">
              <Icon name="image" className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
      {canEdit && circle.photo && (
        <button type="button" className="mt-2 text-xs text-danger inline-flex items-center gap-1 hover:underline" disabled={busy}
          onClick={() => api(`/circles/${circle.id}/photo`, { method: 'DELETE' }).then(reload).catch(fail)}><Icon name="trash" className="w-3.5 h-3.5" />{t.removePhoto}</button>
      )}
      {title}
      {editing ? (
        <form onSubmit={saveDescription} className="mt-3 w-full max-w-md space-y-2 text-start animate-fade-in">
          <textarea className="field" rows={3} maxLength={500} autoFocus aria-label={t.groupDescription} placeholder={t.addDescription} value={text} onChange={e => setText(e.target.value)} />
          <div className="flex gap-2"><button className="btn flex-1">{t.save}</button><button type="button" className="btn btn-ghost" onClick={() => { setEditing(false); setText(circle.description ?? ''); }}>{t.cancel}</button></div>
        </form>
      ) : circle.description ? (
        <p className="mt-3 max-w-md text-sm text-ink whitespace-pre-wrap break-words">{circle.description}{canEdit && <button className="ms-2 text-xs text-green font-bold inline-flex items-center gap-1 align-middle" onClick={() => setEditing(true)}><Icon name="pen" className="w-3.5 h-3.5" />{t.edit}</button>}</p>
      ) : canEdit && <button className="mt-3 btn btn-ghost !py-1 mx-auto inline-flex items-center gap-1.5 text-sm" onClick={() => setEditing(true)}><Icon name="plus" className="w-4 h-4" />{t.addDescription}</button>}
    </>
  );
}

/** The managers' rules for a group: who sends, who edits its face, and whether newcomers need approval, with the people waiting. */
export function GroupRules({ circle, patch, reload }: { circle: CircleDetail; patch: (body: object) => Promise<void>; reload: () => void }) {
  const { t } = useI18n();
  const [waiting, setWaiting] = useState<Array<{ id: number; name: string }>>([]);
  // Asked again every time the group's details are reloaded (a `join_requests` frame does that): the count alone can stay the same
  // while the people behind it change.
  useEffect(() => {
    if (!circle.joinRequests) { setWaiting([]); return; }
    api<Array<{ id: number; name: string }>>(`/circles/${circle.id}/join-requests`).then(setWaiting).catch(() => {});
  }, [circle]);
  const decide = (uid: number, approve: boolean) => api(`/circles/${circle.id}/join-requests/${uid}`, { body: { approve } }).then(reload).catch(reload);
  const who = (value: string, key: 'sendPolicy' | 'editPolicy', label: string) => (
    <label className="block">
      <span className="block text-sm font-bold text-ink mb-1">{label}</span>
      <select className="field" value={value} onChange={e => patch({ [key]: e.target.value })}>
        <option value="all">{t.optAllMembers}</option>
        <option value="admins">{t.optOnlyAdmins}</option>
      </select>
    </label>
  );
  return (
    <section className="rounded-2xl bg-card border border-line elevated-1 p-4 space-y-3">
      {waiting.length > 0 && (
        <div>
          <h3 className="font-bold mb-1 flex items-center gap-2"><span aria-hidden className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="group" className="w-5 h-5" /></span>{t.pendingRequests} ({waiting.length})</h3>
          <ul className="divide-y divide-line">
            {waiting.map(p => (
              <li key={p.id} className="py-2 flex items-center gap-2 animate-fade-in">
                <span className="flex-1 min-w-0 truncate font-medium text-ink">{p.name}</span>
                <button className="btn !py-1 text-sm" onClick={() => decide(p.id, true)}>{t.approve}</button>
                <button className="btn btn-ghost !py-1 text-sm !text-danger" onClick={() => decide(p.id, false)}>{t.reject}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {who(circle.sendPolicy, 'sendPolicy', t.setSendWho)}
      {who(circle.editPolicy, 'editPolicy', t.setEditWho)}
      <Toggle checked={circle.joinApproval} onChange={v => patch({ joinApproval: v })} label={<b>{t.joinApproval}</b>} note={<span className="text-sm">{t.joinApprovalNote}</span>} />
    </section>
  );
}
