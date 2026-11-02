import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, toDate, type CircleSummary, type Kind } from './api';
import { useI18n, intlLocale, systemText } from './i18n';
import { Dialog } from './Dialog';

interface Person { id: number; name: string; via: string; chatId: number | null }
type Filter = 'all' | 'unread' | 'favourites' | 'groups' | 'archived';

/** WhatsApp-style list time: time today, "Yesterday", weekday within the week, otherwise the date. */
function listTime(iso: string, lang: string, t: { today: string; yesterday: string }) {
  const d = toDate(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const loc = intlLocale(lang);
  if (diff <= 0) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return t.yesterday;
  if (diff < 7) return d.toLocaleDateString(loc, { weekday: 'long' });
  return d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function ChatList({ onOpen }: { onOpen: (id: number) => void }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<CircleSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<CircleSummary | null>(null);
  const [sheet, setSheet] = useState<null | 'new' | 'chat' | 'group' | 'circle' | 'join'>(null);
  const [field, setField] = useState('');
  const [error, setError] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => api<CircleSummary[]>('/circles').then(setList).catch(() => {}), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 8000); // the badges and previews stay fresh while the list is on screen
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => { api<Person[]>('/people').then(setPeople).catch(() => {}); }, [list?.length]);

  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  const all = list ?? [];
  const visible = all.filter(c => !c.archived);
  const counts = {
    unread: visible.filter(c => c.unread > 0 || c.markedUnread).length,
    favourites: visible.filter(c => c.favourite).length,
    groups: visible.filter(c => c.kind !== 'direct').length,
    archived: all.filter(c => c.archived).length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = all.filter(c => {
      if (filter === 'archived' ? !c.archived : c.archived) return false;
      if (filter === 'unread' && !(c.unread > 0 || c.markedUnread)) return false;
      if (filter === 'favourites' && !c.favourite) return false;
      if (filter === 'groups' && c.kind === 'direct') return false;
      return !q || c.name.toLowerCase().includes(q) || c.lastText.toLowerCase().includes(q);
    });
    // Family circles stay at the top of the main list (only those: groups and people keep their order by time). A search or a filter shows plain results.
    return filter === 'all' && !q ? [...rows.filter(c => c.kind === 'circle'), ...rows.filter(c => c.kind !== 'circle')] : rows;
  }, [all, filter, query]);

  const sectioned = filter === 'all' && !query.trim();
  const fam = shown.filter(c => c.kind === 'circle');
  const others = shown.filter(c => c.kind !== 'circle');
  // People from your circles you have no chat with yet: offered under the chats, and found by search.
  const peopleShown = useMemo(() => {
    if (filter !== 'all') return [];
    const q = query.trim().toLowerCase();
    return people.filter(p => !p.chatId && (!q || p.name.toLowerCase().includes(q)));
  }, [people, filter, query]);
  async function openPerson(p: Person) {
    setError('');
    try { const r = await api<{ id: number }>('/direct', { body: { userId: p.id } }); onOpen(r.id); } catch (e) { fail(e); }
  }

  async function pref(c: CircleSummary, body: object) {
    setMenu(null); setError('');
    try { await api(`/circles/${c.id}/prefs`, { method: 'PATCH', body }); await load(); } catch (e) { fail(e); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      let r: { id: number };
      if (sheet === 'chat') r = await api('/direct', { body: { phone: field.trim() } });
      else if (sheet === 'join') r = await api('/circles/join', { body: { code: field.trim() } });
      else r = await api('/circles', { body: { name: field, kind: (sheet === 'group' ? 'group' : 'circle') as Kind } });
      setSheet(null); setField(''); onOpen(r.id);
    } catch (err) { fail(err); }
  }

  const preview = (c: CircleSummary) => {
    const icon = { image: '📷', video: '🎥', voice: '🎙', file: '📄', deleted: '🚫', text: '' }[c.lastKind ?? 'text'];
    const word = { image: t.photoWord, video: t.videoWord, voice: t.voiceWord, file: t.fileWord, deleted: t.deletedPreview, text: '' }[c.lastKind ?? 'text'];
    const body = c.lastKind === 'deleted' ? word : systemText(c.lastText, t) || word;
    const who = c.lastFromMe ? `${t.youLabel}: ` : c.lastAuthor && c.kind !== 'direct' ? `${c.lastAuthor}: ` : '';
    return c.lastKind ? `${who}${icon ? icon + ' ' : ''}${body}` : (c.members === 1 ? t.oneMember : `${c.members} ${t.members}`);
  };

  const chip = (k: Filter, label: string, n?: number) => (
    <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k}
      className={`shrink-0 px-3 py-1 rounded-full border text-sm ${filter === k ? 'bg-green-soft border-green text-green font-bold' : 'border-line bg-card text-ink'}`}>
      {label}{n ? ` ${n}` : ''}
    </button>
  );

  const sheetTitle = { new: t.newChatTitle, chat: t.newChat, group: t.newGroup, circle: t.newFamilyCircle, join: t.joinWithInvite }[sheet ?? 'new'];

  const row = (c: CircleSummary) => (
    <li key={c.id} className="flex items-center">
              <button
                className="flex-1 min-w-0 p-3 text-start flex items-center gap-3 hover:bg-green-soft/50"
                onClick={() => onOpen(c.id)}
                onContextMenu={e => { e.preventDefault(); setMenu(c); }}
                onTouchStart={() => { pressTimer.current = setTimeout(() => setMenu(c), 500); }}
                onTouchEnd={() => clearTimeout(pressTimer.current)} onTouchMove={() => clearTimeout(pressTimer.current)}>
                <span className={`w-12 h-12 flex items-center justify-center font-bold shrink-0 text-lg ${c.kind === 'direct' ? 'rounded-full' : 'rounded-2xl'} ${c.kind === 'circle' ? 'bg-brand text-white' : 'bg-green-soft text-green'}`}>
                  {c.kind === 'direct' ? c.name.slice(0, 1) : c.kind === 'group' ? '👥' : c.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <b className="truncate flex-1">{c.name}</b>
                    <span className={`text-xs shrink-0 ${c.unread > 0 && !c.muted ? 'text-green font-bold' : 'text-muted'}`}>{listTime(c.lastAt, lang, t)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="block text-sm text-muted truncate flex-1">{preview(c)}</span>
                    {c.muted && <span aria-hidden className="text-xs">🔕</span>}
                    {c.pinned && <span aria-hidden className="text-xs">📌</span>}
                    {(c.unread > 0 || c.markedUnread) && (
                      <span aria-label={`${c.unread} ${t.unreadCount}`}
                        className={`min-w-6 h-6 px-1.5 rounded-full text-xs font-bold flex items-center justify-center text-white ${c.muted ? 'bg-muted-fill' : 'bg-brand'}`}>
                        {c.unread > 0 ? (c.unread > 99 ? '99+' : c.unread) : ''}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <button className="px-3 py-4 text-muted text-lg leading-none" aria-label={t.chatOptions} onClick={() => setMenu(c)}>⋯</button>
            </li>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input className="field !rounded-full" type="search" value={query} placeholder={t.searchChats} aria-label={t.searchChats} onChange={e => setQuery(e.target.value)} />
        <button className="btn !rounded-full !px-4 text-xl leading-none" aria-label={t.newChatTitle} onClick={() => { setSheet('new'); setError(''); setField(''); }}>＋</button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="group">
        {chip('all', t.filterAll)}
        {chip('unread', t.filterUnread, counts.unread)}
        {chip('favourites', t.filterFavourites, counts.favourites)}
        {chip('groups', t.filterGroups, counts.groups)}
        {counts.archived > 0 && chip('archived', t.archivedChats, counts.archived)}
      </div>

      {error && !sheet && <p role="alert" className="text-sm text-danger">{error}</p>}

      {list === null ? null : (
        <>
          {shown.length === 0 && peopleShown.length === 0 && (all.length === 0 ? (
            <div className="card p-5 space-y-3 text-center">
              <h2 className="text-lg font-bold text-green">{t.onbTitle}</h2>
              <p className="text-sm text-muted">{t.onbText}</p>
              <div className="flex flex-col gap-2"><button className="btn" onClick={() => { setSheet('circle'); setError(''); setField(''); }}>{t.newFamilyCircle}</button><button className="btn btn-ghost" onClick={() => { setSheet('join'); setError(''); setField(''); }}>{t.joinWithInvite}</button></div>
            </div>
          ) : <p className="card p-4 text-muted">{t.chatNoMatch}</p>)}
          {sectioned ? (
            <>
              {fam.length > 0 && <Section title={t.sectionFamily}>{fam.map(row)}</Section>}
              {others.length > 0 && <Section title={t.sectionChats}>{others.map(row)}</Section>}
            </>
          ) : shown.length > 0 && <ul className="card divide-y divide-line overflow-hidden">{shown.map(row)}</ul>}
          {sectioned && fam.length > 0 && people.length === 0 && (
            <div className="card p-4 space-y-2 text-center">
              <p className="text-sm text-muted">{t.lonelyHint}</p>
              <button className="btn" onClick={() => { location.hash = `/circle/${fam[0].id}/settings`; }}>{t.lonelyAction}</button>
            </div>
          )}
          {peopleShown.length > 0 && (
            <Section title={t.sectionPeople} note={t.sectionPeopleNote}>
              {peopleShown.map(p => (
                <li key={p.id}><button className="w-full p-3 text-start flex items-center gap-3 hover:bg-green-soft/50" onClick={() => openPerson(p)}>
                  <span className="w-12 h-12 rounded-full bg-green-soft text-green flex items-center justify-center font-bold shrink-0 text-lg">{p.name.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1"><b className="block truncate">{p.name}</b><span className="block text-sm text-muted truncate">{p.via}</span></span>
                </button></li>
              ))}
            </Section>
          )}
        </>
      )}

      {menu && (
        <Dialog onClose={() => setMenu(null)} label={t.chatOptions}>
          <h2 className="text-lg font-bold truncate">{menu.name}</h2>
          <div className="mt-3 flex flex-col gap-2">
            <button className="btn btn-ghost" onClick={() => pref(menu, { pinned: !menu.pinned })}>{menu.pinned ? t.unpin : t.pin}</button>
            {menu.muted
              ? <button className="btn btn-ghost" onClick={() => pref(menu, { muted: false })}>{t.unmute}{menu.mutedUntil ? ` (${t.mutedUntilWord} ${toDate(menu.mutedUntil).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' })})` : ''}</button>
              : <>
                  <button className="btn btn-ghost" onClick={() => pref(menu, { muted: true, muteHours: 8 })}>{t.mute8h}</button>
                  <button className="btn btn-ghost" onClick={() => pref(menu, { muted: true, muteHours: 168 })}>{t.mute1w}</button>
                  <button className="btn btn-ghost" onClick={() => pref(menu, { muted: true })}>{t.muteAlways}</button>
                </>}
            <button className="btn btn-ghost" onClick={() => pref(menu, { favourite: !menu.favourite })}>{menu.favourite ? t.removeFavourite : t.addFavourite}</button>
            <button className="btn btn-ghost" onClick={() => pref(menu, { archived: !menu.archived })}>{menu.archived ? t.unarchiveChat : t.archiveChat}</button>
            {menu.unread === 0 && !menu.markedUnread && <button className="btn btn-ghost" onClick={() => pref(menu, { markedUnread: true })}>{t.markUnread}</button>}
            <button className="btn btn-ghost" onClick={() => setMenu(null)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}

      {sheet && (
        <Dialog onClose={() => setSheet(null)} label={sheetTitle}>
          <h2 className="text-lg font-bold">{sheetTitle}</h2>
          {sheet === 'new' ? (
            <div className="mt-3 flex flex-col gap-2">
              <button className="btn btn-ghost !text-start" onClick={() => setSheet('chat')}>💬 {t.newChat}</button>
              <button className="btn btn-ghost !text-start" onClick={() => setSheet('group')}>👥 {t.newGroup}</button>
              <button className="btn btn-ghost !text-start" onClick={() => setSheet('circle')}>🌳 {t.newFamilyCircle}</button>
              <button className="btn btn-ghost !text-start" onClick={() => setSheet('join')}>🔗 {t.joinWithInvite}</button>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-3 space-y-2">
              <input className="field" autoFocus required dir={sheet === 'group' || sheet === 'circle' ? undefined : 'ltr'}
                inputMode={sheet === 'chat' ? 'tel' : undefined} maxLength={60}
                placeholder={sheet === 'chat' ? t.phoneNumber : sheet === 'join' ? t.inviteCode : t.circleName}
                value={field} onChange={e => setField(e.target.value)} />
              {sheet === 'circle' && <p className="text-xs text-muted">{t.kindCircle}</p>}
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <div className="flex gap-2">
                <button className="btn flex-1">{sheet === 'chat' ? t.startChat : sheet === 'join' ? t.join : t.create}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setSheet('new')}>{t.back}</button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-bold text-muted px-1 mb-1">{title}</h3>
      <ul className="card divide-y divide-line overflow-hidden">{children}</ul>
      {note && <p className="text-xs text-muted px-1 mt-1">{note}</p>}
    </section>
  );
}
