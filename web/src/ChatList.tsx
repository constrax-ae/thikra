import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, toDate, type CircleSummary, type Kind } from './api';
import { useI18n, intlLocale, systemText } from './i18n';
import { Dialog } from './Dialog';
import { ChatListSkeleton, ErrorState } from './States';
import { Icon, type IconName } from './icons';

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

export function ChatList({ onOpen, activeId }: { onOpen: (id: number) => void; activeId?: number }) {
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

  // A failed load used to be swallowed, which looked exactly like "you have no chats".
  // The flag is cleared on the next success, so a blip during the 8s refresh never
  // replaces a list that is already on screen.
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(() => api<CircleSummary[]>('/circles').then(l => { setList(l); setLoadFailed(false); }).catch(() => setLoadFailed(true)), []);
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

  // The preview line. Emoji used to stand in for the attachment kind; they render
  // differently on every platform and look cheap next to the rest of the app, so this
  // uses the line-icon set, which also takes the text colour in both themes.
  const KIND_ICON: Record<string, IconName> = { image: 'image', video: 'video', voice: 'mic', file: 'file', deleted: 'ban' };
  const Preview = ({ c }: { c: CircleSummary }) => {
    if (!c.lastKind) return <>{c.members === 1 ? t.oneMember : `${c.members} ${t.members}`}</>;
    const word = { image: t.photoWord, video: t.videoWord, voice: t.voiceWord, file: t.fileWord, deleted: t.deletedPreview, text: '' }[c.lastKind] ?? '';
    const body = c.lastKind === 'deleted' ? word : systemText(c.lastText, t) || word;
    const who = c.lastFromMe ? t.youLabel : c.lastAuthor && c.kind !== 'direct' ? c.lastAuthor : '';
    const ic = KIND_ICON[c.lastKind];
    return (
      <>
        {/* <bdi> isolates the name: a Latin name inside an Arabic line (or the reverse)
            otherwise drags the colon and the following text to the wrong side. */}
        {who && <span className="shrink-0"><bdi>{who}</bdi>:</span>}
        {ic && <Icon name={ic} className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{body}</span>
      </>
    );
  };

  // ⌘K / Ctrl+K jumps to the search, like every desktop messenger.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  const openSheet = (s: NonNullable<typeof sheet>) => { setSheet(s); setError(''); setField(''); };

  const chip = (k: Filter, label: string, n?: number) => {
    const on = filter === k;
    return (
      <button key={k} onClick={() => setFilter(k)} aria-pressed={on}
        className={`shrink-0 h-9 px-3.5 rounded-xl text-sm inline-flex items-center gap-1.5
          transition-[background-color,color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-standard)]
          ${on ? 'bg-green-soft text-green font-bold elevated-1' : 'text-muted hover:text-ink hover:bg-green-soft/50'}`}>
        {label}
        {!!n && <span className={`min-w-5 h-5 px-1.5 rounded-full text-caption font-bold inline-flex items-center justify-center
          ${on ? 'bg-brand text-white' : 'bg-line text-muted'}`}>{n > 99 ? '99+' : n}</span>}
      </button>
    );
  };

  const sheetTitle = { new: t.newChatTitle, chat: t.newChat, group: t.newGroup, circle: t.newFamilyCircle, join: t.joinWithInvite }[sheet ?? 'new'];

  const qa = 'p-2 rounded-lg text-muted hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]';
  const row = (c: CircleSummary, i: number) => {
    const unread = c.unread > 0 || c.markedUnread;
    const active = activeId === c.id;
    return (
      // animate-slide-up plays only when the <li> mounts, so a chat arriving animates in
      // while the 8s refresh, which reuses the same keys, leaves settled rows alone.
      <li key={c.id} className="group/row relative animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
        <button
          data-selected={active || undefined} aria-current={active ? 'true' : undefined}
          className="row-interactive w-full min-w-0 px-3 py-3 rounded-2xl text-start flex items-center gap-3.5"
          onClick={() => onOpen(c.id)}
          onContextMenu={e => { e.preventDefault(); setMenu(c); }}
          onTouchStart={() => { pressTimer.current = setTimeout(() => setMenu(c), 500); }}
          onTouchEnd={() => clearTimeout(pressTimer.current)} onTouchMove={() => clearTimeout(pressTimer.current)}>
          <Avatar c={c} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className={`truncate flex-1 text-[0.95rem] font-bold text-ink`}><bdi>{c.name}</bdi></span>
              <span className={`text-caption shrink-0 tabular-nums ${unread && !c.muted ? 'text-green font-bold' : 'text-muted'}`}>{listTime(c.lastAt, lang, t)}</span>
            </span>
            <span className="flex items-center gap-2 mt-1">
              <span className={`flex items-center gap-1.5 min-w-0 flex-1 text-sm ${unread ? 'text-ink' : 'text-muted'}`}>
                <Preview c={c} />
              </span>
              {c.muted && <Icon name="mute" className="w-3.5 h-3.5 text-muted shrink-0" />}
              {c.pinned && <Icon name="pin" className="w-3.5 h-3.5 text-muted shrink-0" />}
              {unread && (
                <span aria-label={`${c.unread} ${t.unreadCount}`}
                  className={`min-w-5 h-5 px-1.5 rounded-full text-caption font-bold flex items-center justify-center text-white shrink-0 animate-scale-in ${c.muted ? 'bg-muted-fill' : 'bg-brand'}`}>
                  {c.unread > 0 ? (c.unread > 99 ? '99+' : c.unread) : ''}
                </span>
              )}
            </span>
          </span>
        </button>
        {/* Quick actions float over the end of the row on hover (pointer) or focus (keyboard),
            so the row never reflows and the name never re-truncates under the cursor.
            Touch has no hover: it keeps the long-press, which opens the same menu. */}
        <span className="hidden sm:flex absolute end-2 top-1/2 -translate-y-1/2 items-center gap-0.5 p-1 rounded-xl bg-card border border-line elevated-2
          opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto
          transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]">
          <button className={qa} aria-label={c.pinned ? t.unpin : t.pin} title={c.pinned ? t.unpin : t.pin}
            onClick={() => pref(c, { pinned: !c.pinned })}><Icon name="pin" className="w-4 h-4" /></button>
          <button className={qa} aria-label={c.muted ? t.unmute : t.mute} title={c.muted ? t.unmute : t.mute}
            onClick={() => pref(c, { muted: !c.muted })}><Icon name="mute" className="w-4 h-4" /></button>
          <button className={qa} aria-label={c.archived ? t.unarchiveChat : t.archiveChat} title={c.archived ? t.unarchiveChat : t.archiveChat}
            onClick={() => pref(c, { archived: !c.archived })}><Icon name="archive" className="w-4 h-4" /></button>
          <button className={qa} aria-label={t.chatOptions} title={t.chatOptions} onClick={() => setMenu(c)}><Icon name="more" className="w-4 h-4" /></button>
        </span>
      </li>
    );
  };

  // The hash alone is not enough: when that chat is already open (or the hash is already
  // .../settings) changing it does nothing visible, so the open chat is also told directly.
  const goInvite = () => {
    const f = all.find(c => c.kind === 'circle');
    if (!f) { openSheet('circle'); return; }
    location.hash = `/circle/${f.id}/settings`;
    window.dispatchEvent(new CustomEvent('thikra:invite', { detail: f.id }));
  };

  return (
    <div className="flex flex-col min-h-full gap-4">
      {/* Page title: a quiet eyebrow over a confident heading, with the one primary action beside it. */}
      <div className="flex items-end justify-between gap-3 pt-2">
        <div className="min-w-0">
          <p className="text-caption font-bold uppercase tracking-[0.14em] text-muted">{t.hubEyebrow}</p>
          <h1 className="text-3xl font-bold text-ink tracking-tight leading-tight mt-1">{t.hubTitle}</h1>
        </div>
        <button
          className="w-12 h-12 shrink-0 rounded-2xl bg-brand text-white flex items-center justify-center elevated-2
            transition-transform duration-[var(--dur-fast)] ease-[var(--ease-emphasis)] hover:scale-105 active:scale-95"
          aria-label={t.newChatTitle} title={t.newChatTitle} onClick={() => openSheet('new')}>
          <Icon name="plus-circle" className="w-6 h-6" />
        </button>
      </div>

      <label className="group/search flex items-center gap-2.5 h-12 px-4 rounded-2xl bg-card border border-line elevated-1
        transition-[border-color,box-shadow] duration-[var(--dur-fast)]
        focus-within:border-green focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-focus)_16%,transparent)]">
        <Icon name="search" className="w-5 h-5 text-muted shrink-0" />
        <input ref={searchRef} type="search" value={query} placeholder={t.searchChats} aria-label={t.searchChats}
          onChange={e => setQuery(e.target.value)}
          className="bare-input flex-1 min-w-0 bg-transparent text-ink placeholder:text-muted" />
        <kbd className="hidden md:inline-flex items-center gap-1 h-6 px-1.5 rounded-md border border-line bg-paper text-caption text-muted font-sans shrink-0" aria-hidden>
          {isMac ? '⌘' : 'Ctrl'} K
        </kbd>
      </label>

      {all.length > 0 && (
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-0.5" role="group">
          {chip('all', t.filterAll)}
          {chip('unread', t.filterUnread, counts.unread)}
          {chip('favourites', t.filterFavourites, counts.favourites)}
          {chip('groups', t.filterGroups, counts.groups)}
          {counts.archived > 0 && chip('archived', t.archivedChats, counts.archived)}
        </div>
      )}

      {error && !sheet && <p role="alert" className="text-sm text-danger">{error}</p>}

      {list === null ? (loadFailed ? <ErrorState onRetry={load} /> : <ChatListSkeleton />) : (
        <div className="space-y-5">
          {shown.length === 0 && peopleShown.length === 0 && (all.length === 0 ? (
            <Onboarding onCreate={() => openSheet('circle')} onJoin={() => openSheet('join')} />
          ) : (
            <div className="py-14 flex flex-col items-center text-center gap-3 animate-fade-in">
              <span className="w-14 h-14 rounded-2xl bg-green-soft text-green flex items-center justify-center"><Icon name="search" className="w-7 h-7" /></span>
              <p className="font-bold text-ink">{t.chatNoMatch}</p>
            </div>
          ))}
          {sectioned ? (
            <>
              {fam.length > 0 && <Section title={t.sectionFamily}>{fam.map(row)}</Section>}
              {others.length > 0 && <Section title={t.sectionChats}>{others.map(row)}</Section>}
            </>
          ) : shown.length > 0 && <ul className="space-y-0.5">{shown.map(row)}</ul>}
          {peopleShown.length > 0 && (
            <Section title={t.sectionPeople} note={t.sectionPeopleNote}>
              {peopleShown.map((p, i) => (
                <li key={p.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
                  <button className="row-interactive w-full px-3 py-3 rounded-2xl text-start flex items-center gap-3.5" onClick={() => openPerson(p)}>
                    <span className="w-12 h-12 rounded-full bg-green-soft text-green flex items-center justify-center font-bold shrink-0 text-lg">{p.name.slice(0, 1)}</span>
                    <span className="min-w-0 flex-1"><b className="block truncate">{p.name}</b><span className="block text-sm text-muted truncate">{p.via}</span></span>
                    <Icon name="chats" className="w-5 h-5 text-muted shrink-0" />
                  </button>
                </li>
              ))}
            </Section>
          )}
        </div>
      )}

      {/* Sits at the foot of the list (and of the sidebar on desktop): the nudge that turns a quiet
          app into a busy one. When nobody else has joined yet it says so, in words. */}
      {list !== null && all.length > 0 && (
        <div className="mt-auto pt-2">
          <button onClick={goInvite}
            className="group/closer w-full text-start flex items-center gap-3.5 p-3.5 rounded-2xl bg-card border border-line elevated-1
              transition-[box-shadow,border-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-standard)]
              hover:shadow-[var(--shadow-e2)] hover:border-green/40 hover:-translate-y-0.5">
            <span className="w-11 h-11 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="group" className="w-6 h-6" /></span>
            <span className="min-w-0 flex-1">
              <b className="block text-ink">{t.closerTitle}</b>
              <span className="block text-sm text-muted">{people.length === 0 && fam.length > 0 ? t.lonelyAction : t.closerBody}</span>
            </span>
            <Icon name="arrow-out" className="w-5 h-5 text-muted shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/closer:translate-x-0.5 group-hover/closer:-translate-y-0.5 group-hover/closer:text-green rtl:-scale-x-100" />
          </button>
        </div>
      )}

      {menu && (
        <Dialog onClose={() => setMenu(null)} label={t.chatOptions}>
          <div className="flex items-center gap-3">
            <Avatar c={menu} />
            <h2 className="text-lg font-bold truncate">{menu.name}</h2>
          </div>
          <div className="mt-4 flex flex-col gap-2">
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
            <div className="mt-3 flex flex-col gap-1">
              {([['chat', 'chats', t.newChat], ['group', 'group', t.newGroup], ['circle', 'heart', t.newFamilyCircle], ['join', 'link', t.joinWithInvite]] as const).map(([k, ic, label]) => (
                <button key={k} className="row-interactive w-full flex items-center gap-3 p-2.5 rounded-xl text-start" onClick={() => setSheet(k)}>
                  <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name={ic} className="w-5 h-5" /></span>
                  <span className="flex-1 font-bold">{label}</span>
                  <Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90" />
                </button>
              ))}
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

/** A family circle is the heart of the product, so it is the one avatar that carries the brand
 *  fill and a gold ring. Groups are rounded squares with the group glyph, a person is a circle. */
function Avatar({ c }: { c: Pick<CircleSummary, 'kind' | 'name'> }) {
  return (
    <span className={`w-12 h-12 flex items-center justify-center font-bold shrink-0 text-lg
      ${c.kind === 'direct' ? 'rounded-full' : 'rounded-2xl'}
      ${c.kind === 'circle' ? 'bg-brand text-white ring-2 ring-gold/50 ring-offset-2 ring-offset-paper' : 'bg-green-soft text-green'}`}>
      {c.kind === 'group' ? <Icon name="group" className="w-6 h-6" /> : c.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The illustration used by the empty list and the desktop welcome pane: two stacked tiles and
 *  a pair of gold sparkles, drawn from the theme tokens so it follows light and dark. */
export function HeroArt({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const lg = size === 'lg';
  return (
    <div aria-hidden className={`relative ${lg ? 'w-48 h-40' : 'w-40 h-32'} animate-scale-in`}>
      <span className={`absolute end-2 top-0 ${lg ? 'w-32 h-32' : 'w-26 h-26'} rounded-[2rem] rotate-6 bg-line/70 border border-line flex items-center justify-center`}>
        <span className={`${lg ? 'w-14 h-14 border-[6px]' : 'w-11 h-11 border-[5px]'} rounded-full border-green/50`} />
      </span>
      <span className={`absolute start-4 bottom-0 ${lg ? 'w-24 h-24' : 'w-20 h-20'} rounded-[1.6rem] bg-brand text-white flex items-center justify-center elevated-3 ring-4 ring-paper`}>
        <Icon name="group" className={lg ? 'w-12 h-12' : 'w-10 h-10'} />
      </span>
      <span className="absolute start-0 top-2 text-gold-dark animate-pulse-soft"><Icon name="sparkle" className="w-5 h-5" /></span>
      <span className="absolute end-0 bottom-3 text-gold-dark animate-pulse-soft [animation-delay:600ms]"><Icon name="sparkle" className="w-4 h-4" /></span>
    </div>
  );
}

/** What Thekra is for, in three lines. Shown under the first-run empty state and the welcome pane. */
export function FeatureList({ layout = 'stack' }: { layout?: 'stack' | 'row' }) {
  const { t } = useI18n();
  const items: Array<[IconName, string, string]> = [
    ['heart', t.featCircleTitle, t.featCircleBody],
    ['memory', t.featMemoryTitle, t.featMemoryBody],
    ['envelope', t.featSealedTitle, t.featSealedBody],
  ];
  return (
    <ul className={layout === 'row' ? 'grid grid-cols-3 gap-3' : 'space-y-2'}>
      {items.map(([ic, title, body], i) => (
        <li key={ic} className={`animate-slide-up flex gap-3 p-3.5 rounded-2xl bg-card border border-line elevated-1 ${layout === 'row' ? 'flex-col text-start' : 'items-center text-start'}`}
          style={{ animationDelay: `${120 + i * 70}ms` }}>
          <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name={ic} className="w-5 h-5" /></span>
          <span className="min-w-0">
            <b className="block text-sm text-ink">{title}</b>
            <span className="block text-sm text-muted leading-snug mt-0.5">{body}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** First run: no chats at all. A composed welcome instead of an empty card at the top of a blank page. */
function Onboarding({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center text-center pt-4 pb-2 gap-6">
      <HeroArt />
      <div className="space-y-2 max-w-sm animate-slide-up">
        <p className="text-caption font-bold uppercase tracking-[0.16em] text-green">{t.hubWelcomeEyebrow}</p>
        <h2 className="text-2xl font-bold !text-ink tracking-tight">{t.onbTitle}</h2>
        <p className="text-sm text-muted leading-relaxed">{t.onbText}</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 w-full max-w-sm animate-slide-up [animation-delay:80ms]">
        <button className="btn flex-1 h-12 !rounded-2xl inline-flex items-center justify-center gap-2" onClick={onCreate}><Icon name="plus" className="w-5 h-5" />{t.newFamilyCircle}</button>
        <button className="btn btn-ghost flex-1 h-12 !rounded-2xl inline-flex items-center justify-center gap-2" onClick={onJoin}><Icon name="link" className="w-5 h-5" />{t.joinWithInvite}</button>
      </div>
      <div className="w-full max-w-sm"><FeatureList /></div>
    </div>
  );
}

/** The right-hand pane on a wide screen when no chat is open. */
export function ChatWelcome() {
  const { t } = useI18n();
  return (
    <div className="h-full flex flex-col">
      <header className="h-20 shrink-0 px-8 flex items-center gap-4 border-b border-line">
        <span className="w-12 h-12 rounded-2xl bg-green-soft text-green flex items-center justify-center"><Icon name="chats" className="w-6 h-6" /></span>
        <span className="min-w-0">
          <b className="block text-lg text-ink">{t.hubPaneTitle}</b>
          <span className="block text-sm text-muted">{t.hubPaneSub}</span>
        </span>
      </header>
      <div className="flex-1 overflow-y-auto flex items-center justify-center px-8 py-10">
        <div className="max-w-xl w-full flex flex-col items-center text-center gap-6">
          <HeroArt size="lg" />
          <div className="space-y-3 animate-slide-up">
            <p className="text-caption font-bold uppercase tracking-[0.16em] text-green">{t.hubWelcomeEyebrow}</p>
            <h2 className="text-4xl font-bold !text-ink tracking-tight">{t.hubWelcomeTitle}</h2>
            <p className="text-muted text-lg leading-relaxed max-w-lg mx-auto text-balance">{t.hubWelcomeBody}</p>
          </div>
          <div className="w-full pt-4"><FeatureList layout="row" /></div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-caption font-bold uppercase tracking-[0.12em] text-muted px-3 mb-1.5">{title}</h3>
      <ul className="space-y-0.5">{children}</ul>
      {note && <p className="text-xs text-muted px-3 mt-1.5">{note}</p>}
    </section>
  );
}
