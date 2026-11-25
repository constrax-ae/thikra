import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, toDate, type Across, type CircleSummary, type Kind, type MessageHit } from './api';
import { useI18n, intlLocale, systemText } from './i18n';
import { Dialog } from './Dialog';
import { live } from './live';
import { ChatListSkeleton, ErrorState } from './States';
import { Icon, type IconName } from './icons';
import { typingLabel, useTyping } from './typing';
import { Avatar, PersonAvatar } from './Groups';
import { BroadcastLists } from './Broadcast';
import { PinGate, useLock } from './Privacy';
import { deviceLock } from './lock';
import { ListsDialog, load as loadLists, type ChatListRow } from './Lists';
import { onChatChange, openDirect, useE2ee } from './e2ee';
import { JUMP_KEY } from './reminders';
import { ChatTypeBadge } from './E2eeUi';
import { plainText } from '../../core/format';

interface Person { id: number; name: string; via: string; chatId: number | null; avatarAt?: string | null }
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

type Range = '' | 'today' | 'week' | 'month' | 'custom';
/** A day as the date input writes it, in THIS person's timezone (toISOString would roll over for anyone east of London). */
const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** What each named range means. "Custom" is handled by the two fields; the rest need no typing at all. */
function rangeDates(r: Range): { from: string; to: string } {
  const now = new Date(), today = dayStr(now);
  if (r === 'today') return { from: today, to: today };
  if (r === 'week') { const d = new Date(now); d.setDate(d.getDate() - 6); return { from: dayStr(d), to: today }; }
  if (r === 'month') return { from: dayStr(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  return { from: '', to: '' };
}
const RANGES: Array<[Exclude<Range, ''>, (t: { facet: { today: string; week: string; month: string; custom: string } }) => string]> = [
  ['today', t => t.facet.today], ['week', t => t.facet.week], ['month', t => t.facet.month], ['custom', t => t.facet.custom],
];

export function ChatList({ onOpen, activeId, onCount }: { onOpen: (id: number) => void; activeId?: number; onCount?: (n: number) => void }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<CircleSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // A list is a filter the person made themselves; it narrows whatever filter is chosen above it.
  const [lists, setLists] = useState<ChatListRow[]>([]);
  const [listId, setListId] = useState<number | null>(null);
  const [listsOpen, setListsOpen] = useState(false);
  useEffect(() => { loadLists().then(setLists).catch(() => { /* lists are a convenience: the chat list works without them */ }); }, []);
  const [query, setQuery] = useState('');
  // Searching the WORDS of every chat, not only their names: the server does it (GET /api/search) because the
  // history is not on this device. It cannot read an encrypted chat and will not open a locked one, and it says how
  // many it left out so the screen can tell the truth instead of implying there was nothing there.
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [skipped, setSkipped] = useState(0);
  // CHAT-02 facets: what kind of thing, and when. They narrow the message results only — the chats above are matched
  // by name as before.
  const [kind, setKind] = useState<'' | 'text' | 'photo' | 'video' | 'file' | 'voice' | 'link'>('');
  const [range, setRange] = useState<Range>('');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const { from, to } = range === 'custom' ? custom : rangeDates(range);
  const setFrom = (v: string) => setCustom(c => ({ ...c, from: v }));
  const setTo = (v: string) => setCustom(c => ({ ...c, to: v }));
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setSkipped(0); return; }
    let live = true;
    const h = setTimeout(() => {
      api<Across>(`/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`)
        .then(r => { if (live) { setHits(r.results); setSkipped(r.skipped); } })
        .catch(() => { if (live) { setHits([]); setSkipped(0); } });   // offline: the chats above still match by name
    }, 250);   // one request per pause in the typing, not one per letter
    return () => { live = false; clearTimeout(h); };
  }, [query, kind, from, to]);
  /** Open the chat this message is in and land on the message itself. */
  const openHit = (m: MessageHit) => {
    try { sessionStorage.setItem(JUMP_KEY, String(m.id)); } catch { /* the chat still opens, without the jump */ }
    onOpen(m.circleId);
  };
  const [menu, setMenu] = useState<CircleSummary | null>(null);
  const [sheet, setSheet] = useState<null | 'new' | 'chat' | 'group' | 'circle' | 'join'>(null);
  const [broadcast, setBroadcast] = useState(false);
  const [folder, setFolder] = useState(false);                         // the locked chats
  const [asking, setAsking] = useState(false);                         // the message requests
  const [locking, setLocking] = useState<CircleSummary | null>(null);   // a chat waiting for the PIN before it is locked
  const lock = useLock();
  const [field, setField] = useState('');
  const [error, setError] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { on: e2on, e2ee } = useE2ee();
  const [devicePreview, setDevicePreview] = useState<Record<number, { text: string; kind: string; userId: number | null }>>({});
  const me_id = useRef<number | null>(null);
  useEffect(() => { api<{ id: number }>('/me').then(m => { me_id.current = m.id; }).catch(() => {}); }, []);
  const typersOf = useTyping(0);   // "typing…" / "recording audio…" in place of the last message while it lasts

  // A failed load used to be swallowed, which looked exactly like "you have no chats".
  // The flag is cleared on the next success, so a blip during the 8s refresh never
  // replaces a list that is already on screen.
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(() => api<CircleSummary[]>('/circles').then(l => { setList(l); setLoadFailed(false); onCount?.(l.length); }).catch(() => setLoadFailed(true)), [onCount]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 8000); // the badges and previews stay fresh while the list is on screen
    // A chat made or joined elsewhere (someone opened a private chat with you, approved your request) appears at once.
    const off = live.on(f => { if (f.t === 'member_added') load(); });
    window.addEventListener('thikra:chats', load);   // a request accepted or declined inside the chat
    return () => { clearInterval(timer); off(); window.removeEventListener('thikra:chats', load); };
  }, [load]);

  // Hear every chat in the list live, including ones created or joined after the page loaded (and again after a reconnect).
  useEffect(() => {
    const ids = (list ?? []).map(c => c.id);
    live.join(ids);
    return live.on(f => { if (f.t === 'open') live.join(ids); });
  }, [list]);

  // An encrypted chat's last message is read here, on the device (the server only knows that there is one).
  const encKey = (list ?? []).filter(c => c.encrypted).map(c => `${c.id}:${c.lastAt}`).join();
  useEffect(() => {
    if (!e2ee || !list) return;
    let live = true;
    const refresh = async () => {
      const out: Record<number, { text: string; kind: string; userId: number | null }> = {};
      for (const c of list.filter(x => x.encrypted).slice(0, 30)) {
        let p = await e2ee.preview(c.id).catch(() => null);
        // Nothing read here yet, or a newer message arrived while this chat was closed (a broadcast, a message in another chat):
        // read the newest few on this device so the line under the name is the real last message, not the one before it.
        const ms = (v: string) => /(Z|[+-]\d\d:?\d\d)$/.test(v) ? Date.parse(v) : toDate(v).getTime();   // the server's "YYYY-MM-DD HH:MM:SS" (UTC) or a full ISO time
        const stale = !!p?.at && !!c.lastAt && ms(c.lastAt) > ms(p.at) + 1000;
        if ((!p && c.lastKind) || stale) { await e2ee.history(c.id, `after=0&limit=${stale ? 10 : 30}`).catch(() => []); p = await e2ee.preview(c.id).catch(() => null); }
        if (p) out[c.id] = p;
      }
      if (live) setDevicePreview(out);
    };
    refresh();
    const off = onChatChange(() => { refresh(); });
    return () => { live = false; off(); };
  }, [e2ee, encKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api<Person[]>('/people').then(setPeople).catch(() => {}); }, [list?.length]);

  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  // A locked chat is not in the main list, the filters or the search: it lives only under "Locked chats", behind the PIN of this device.
  const lockedChats = (list ?? []).filter(c => c.locked);
  // A message request is not in the main list either, so a stranger cannot push a chat into it: it waits under "Message requests".
  const requests = (list ?? []).filter(c => c.request && !c.locked);
  const all = (list ?? []).filter(c => !c.locked && !c.request);
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
      if (listId !== null && !(lists.find(l => l.id === listId)?.circleIds ?? []).includes(c.id)) return false;
      return !q || c.name.toLowerCase().includes(q) || c.lastText.toLowerCase().includes(q);
    });
    // Family circles stay at the top of the main list (only those: groups and people keep their order by time). A search or a filter shows plain results.
    return filter === 'all' && !q ? [...rows.filter(c => c.kind === 'circle'), ...rows.filter(c => c.kind !== 'circle')] : rows;
  }, [all, filter, query, listId, lists]);

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
    try { const r = await openDirect({ userId: p.id }); onOpen(r.id); } catch (e) { fail(e); }
  }

  async function pref(c: CircleSummary, body: object) {
    setMenu(null); setError('');
    try { await api(`/circles/${c.id}/prefs`, { method: 'PATCH', body }); await load(); } catch (e) { fail(e); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      let r: { id: number };
      if (sheet === 'chat') r = await openDirect({ phone: field.trim() });
      else if (sheet === 'join') r = await api('/circles/join', { body: { code: field.trim() } });
      else {
        // With encryption on, a group is private (encrypted) and a family circle is readable by the server: chosen here, once, never changed.
        r = await api('/circles', { body: { name: field, kind: (sheet === 'group' ? 'group' : 'circle') as Kind, ...(e2on && sheet === 'group' ? { encrypted: true } : {}) } });
        if (e2on && sheet === 'group') e2ee?.startChat(r.id).catch(() => undefined);
      }
      // Reload before navigating: the list drives the sidebar's onboarding card, and
      // without this the person who just made their first circle is still told to
      // "start with your family" until the 8s refresh catches up.
      setSheet(null); setField(''); setError(''); await load(); onOpen(r.id);
    } catch (err) { fail(err); }
  }

  // The preview line. Line icons from the app's set stand for the attachment kind (never
  // emoji: they render differently on every platform and ignore the theme's text colour).
  const KIND_ICON: Record<string, IconName> = { image: 'image', video: 'video', voice: 'mic', file: 'file', deleted: 'ban', contact: 'you', location: 'pin', live: 'location', sticker: 'smile', gif: 'smile', poll: 'chart' };
  const KIND_WORD = (k: string) => ({ image: t.photoWord, video: t.videoWord, voice: t.voiceWord, file: t.fileWord, deleted: t.deletedPreview, text: '', gif: t.gifWord, sticker: t.stickerWord, contact: t.contactWord, location: t.locationWord, live: t.liveWord, poll: t.newPoll } as Record<string, string>)[k] ?? '';
  const Preview = ({ c }: { c: CircleSummary }) => {
    const typing = typingLabel(typersOf(c.id), t, c.kind !== 'direct');
    if (typing) return <span className="truncate text-green font-medium">{typing}</span>;
    if (c.lastKind === 'encrypted') {
      // An encrypted chat's last message is read on this device; the server only knows there is one.
      const p = devicePreview[c.id];
      if (!p) return <><Icon name="lock" className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{t.e2ee.previewGeneric}</span></>;
      const ic = KIND_ICON[p.kind];
      return (
        <>
          {p.userId === me_id.current && <span className="shrink-0">{t.youLabel}:</span>}
          {ic && <Icon name={ic} className="w-3.5 h-3.5 shrink-0" />}
          <span className="truncate">{(p.text && plainText(p.text)) || KIND_WORD(p.kind)}</span>
        </>
      );
    }
    if (!c.lastKind) return <>{c.members === 1 ? t.oneMember : `${c.members} ${t.members}`}</>;
    const word = KIND_WORD(c.lastKind);
    const body = c.lastKind === 'deleted' ? word : (c.lastText.startsWith('sys:') ? systemText(c.lastText, t) : plainText(c.lastText)) || word;
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
  // The desktop shortcuts, on the chat that is open: mute, archive, pin, mark unread — the four things people do over
  // and over while reading through a list. They all take Ctrl/⌘ + Alt so nothing collides with typing in Arabic or
  // English, and they do nothing when no chat is open. The list of them is in You → Chats.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === 'Escape' && document.activeElement === searchRef.current && query) { e.preventDefault(); setQuery(''); return; }
      if (!mod || !e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'n') { e.preventDefault(); openSheet('new'); return; }
      const c = (list ?? []).find(x => x.id === activeId);
      if (!c) return;
      if (key === 'm') { e.preventDefault(); pref(c, { muted: !c.muted }); }
      else if (key === 'e') { e.preventDefault(); pref(c, { archived: !c.archived }); }
      else if (key === 'p') { e.preventDefault(); pref(c, { pinned: !c.pinned }); }
      else if (key === 'u') { e.preventDefault(); pref(c, { markedUnread: !c.markedUnread }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list, activeId, query]);   // eslint-disable-line react-hooks/exhaustive-deps
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  const openSheet = (s: NonNullable<typeof sheet>) => { setSheet(s); setError(''); setField(''); };

  const chip = (k: Filter, label: string, n?: number) => {
    // "All" means everything: it also lets go of a personal list, and is only lit when no list is narrowing the chats.
    const on = filter === k && !(k === 'all' && listId !== null);
    return (
      <button key={k} onClick={() => { setFilter(k); if (k === 'all') setListId(null); }} aria-pressed={on}
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
          <Avatar name={c.name} kind={c.kind} photo={c.photo} person={c.kind === 'direct' && c.peerId ? { id: c.peerId, avatarAt: c.peerAvatarAt } : null} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={`truncate flex-1 text-[0.95rem] font-bold text-ink`}><bdi>{c.name}</bdi></span>
              {e2on && <ChatTypeBadge encrypted={c.encrypted} kind={c.kind} />}
              <span className={`text-caption shrink-0 tabular-nums ${unread && !c.muted ? 'text-green font-bold' : 'text-muted'}`}>{listTime(c.lastAt, lang, t)}</span>
            </span>
            <span className="flex items-center gap-2 mt-1">
              <span className={`flex items-center gap-1.5 min-w-0 flex-1 text-sm ${unread ? 'text-ink' : 'text-muted'}`}>
                <Preview c={c} />
              </span>
              {c.mentioned && <span role="img" aria-label={t.mentionedYou} title={t.mentionedYou} className="shrink-0 w-5 h-5 rounded-full bg-brand text-white text-caption font-bold flex items-center justify-center">@</span>}
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
        focus-within:border-green focus-within:shadow-[inset_0_0_0_1px_var(--color-green)]">
        <Icon name="search" className="w-5 h-5 text-muted shrink-0" />
        {/* A search term is not prose: no spellcheck squiggle, no capitalising, no autocorrect fighting an Arabic name. */}
        <input ref={searchRef} type="search" value={query} placeholder={t.searchChats} aria-label={t.searchChats}
          spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
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
          {lists.map(l => {
            const on = listId === l.id;
            return (
              <button key={`list-${l.id}`} onClick={() => setListId(on ? null : l.id)} aria-pressed={on}
                className={`shrink-0 h-9 px-3.5 rounded-xl text-sm inline-flex items-center gap-1.5 transition-[background-color,color,box-shadow] duration-[var(--dur-fast)]
                  ${on ? 'bg-green-soft text-green font-bold elevated-1' : 'text-muted hover:text-ink hover:bg-green-soft/50'}`}><bdi>{l.name}</bdi></button>
            );
          })}
          <button onClick={() => setListsOpen(true)} aria-label={t.lists.manage} title={t.lists.manage}
            className="shrink-0 w-9 h-9 rounded-xl inline-flex items-center justify-center text-muted hover:text-green hover:bg-green-soft/50"><Icon name="list" className="w-4 h-4" /></button>
        </div>
      )}

      {listsOpen && <ListsDialog lists={lists} chats={all} onChange={next => { setLists(next); if (listId !== null && !next.some(l => l.id === listId)) setListId(null); }} onClose={() => setListsOpen(false)} />}

      {lockedChats.length > 0 && (
        <button className="row-interactive w-full px-3 py-3 rounded-2xl text-start flex items-center gap-3.5 bg-card border border-line elevated-1" onClick={() => setFolder(true)}>
          <span aria-hidden className="w-12 h-12 rounded-2xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="lock" className="w-6 h-6" /></span>
          <span className="min-w-0 flex-1"><b className="block">{t.priv.lockedChats}</b><span className="block text-sm text-muted">{t.priv.lockedCount.replace('{n}', String(lockedChats.length))}</span></span>
          <Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90" />
        </button>
      )}
      {requests.length > 0 && (
        <button className="row-interactive w-full px-3 py-3 rounded-2xl text-start flex items-center gap-3.5 bg-card border border-line elevated-1" onClick={() => setAsking(true)}>
          <span aria-hidden className="w-12 h-12 rounded-2xl bg-gold/15 text-gold-dark flex items-center justify-center shrink-0"><Icon name="envelope" className="w-6 h-6" /></span>
          <span className="min-w-0 flex-1"><b className="block">{t.req.title}</b><span className="block text-sm text-muted">{t.req.count.replace('{n}', String(requests.length))}</span></span>
          <Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90" />
        </button>
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
          {query.trim().length >= 2 && (
            <div className="space-y-1.5">
              {/* One scrolling line of facets, as the filter chips above do: on a phone these wrapped into three
                  ragged rows and pushed the results off the screen. */}
              <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-0.5" role="group" aria-label={t.searchMessages}>
                {([['', t.filterAll], ['text', t.facet.text], ['photo', t.photoWord], ['video', t.videoWord], ['voice', t.voiceWord], ['file', t.fileWord], ['link', t.facet.link]] as const).map(([k, label]) => (
                  <button key={k || 'any'} type="button" aria-pressed={kind === k} onClick={() => setKind(k as typeof kind)}
                    className={`shrink-0 h-8 px-3 rounded-xl text-sm transition-colors duration-[var(--dur-fast)] ${kind === k ? 'bg-green-soft text-green font-bold' : 'text-muted hover:text-ink hover:bg-green-soft/50'}`}>{label}</button>
                ))}
                <span aria-hidden className="shrink-0 self-center w-px h-5 bg-line mx-0.5" />
                {/* When, said the way people say it. A raw pair of date boxes was the first try and it looked like a form. */}
                {RANGES.map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={range === k} onClick={() => setRange(range === k ? '' : k)}
                    className={`shrink-0 h-8 px-3 rounded-xl text-sm inline-flex items-center gap-1.5 transition-colors duration-[var(--dur-fast)] ${range === k ? 'bg-green-soft text-green font-bold' : 'text-muted hover:text-ink hover:bg-green-soft/50'}`}>
                    {k === 'custom' && <Icon name="clock" className="w-4 h-4" />}{label(t)}
                  </button>
                ))}
              </div>
              {range === 'custom' && (
                <div className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl bg-card border border-line elevated-1 px-3 py-1.5 animate-slide-up">
                  <label className="inline-flex items-center gap-1.5">
                    <span className="text-caption text-muted">{t.facet.from}</span>
                    <input type="date" dir="ltr" className="bare-input bg-transparent text-sm text-ink w-[8.5rem]" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
                  </label>
                  <span aria-hidden className="text-muted">–</span>
                  <label className="inline-flex items-center gap-1.5">
                    <span className="text-caption text-muted">{t.facet.to}</span>
                    <input type="date" dir="ltr" className="bare-input bg-transparent text-sm text-ink w-[8.5rem]" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
                  </label>
                  {(from || to) && (
                    <button type="button" className="text-caption text-muted hover:text-ink underline underline-offset-2" onClick={() => { setFrom(''); setTo(''); }}>{t.facet.clear}</button>
                  )}
                </div>
              )}
            </div>
          )}
          {query.trim().length >= 2 && (hits.length > 0 || skipped > 0) && (
            <Section title={t.searchMessages}>
              {hits.map((m, i) => (
                <li key={m.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
                  <button className="row-interactive w-full px-3 py-2.5 rounded-2xl text-start" onClick={() => openHit(m)}>
                    <span className="flex items-baseline gap-2">
                      <b className="min-w-0 flex-1 truncate"><bdi>{m.circleName}</bdi></b>
                      <span className="text-caption text-muted shrink-0">{listTime(m.createdAt, lang, t)}</span>
                    </span>
                    <span className="block text-sm text-muted truncate">
                      {m.author ? <span className="text-ink">{m.author}: </span> : null}
                      {m.kind === 'voice' ? (m.transcript || t.voiceWord)
                        : m.body ? plainText(m.body)
                        : m.attachment === 'image' ? t.photoWord : m.attachment === 'video' ? t.videoWord : t.fileWord}
                    </span>
                  </button>
                </li>
              ))}
              {skipped > 0 && <li className="px-3 py-2 text-caption text-muted">{t.searchSkipped.replace('{n}', String(skipped))}</li>}
            </Section>
          )}
          {peopleShown.length > 0 && (
            <Section title={t.sectionPeople} note={t.sectionPeopleNote}>
              {peopleShown.map((p, i) => (
                <li key={p.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
                  <button className="row-interactive w-full px-3 py-3 rounded-2xl text-start flex items-center gap-3.5" onClick={() => openPerson(p)}>
                    <PersonAvatar id={p.id} name={p.name} avatarAt={p.avatarAt} className="w-12 h-12 text-lg" />
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
            <Avatar name={menu.name} kind={menu.kind} photo={menu.photo} person={menu.kind === 'direct' && menu.peerId ? { id: menu.peerId, avatarAt: menu.peerAvatarAt } : null} />
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
            <button className="btn btn-ghost" onClick={() => { const c = menu; setMenu(null); if (lock.unlocked) pref(c, { locked: true }); else setLocking(c); }}>{t.priv.lockChat}</button>
            <button className="btn btn-ghost" onClick={() => setMenu(null)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
      {locking && <PinGate onClose={() => setLocking(null)} onDone={() => { const c = locking; setLocking(null); pref(c, { locked: true }); }} />}
      {folder && (lock.unlocked ? (
        <Dialog onClose={() => setFolder(false)} label={t.priv.lockedChats}>
          <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="lock" className="w-5 h-5 text-green" />{t.priv.lockedChats}</h2>
          <ul className="mt-3 space-y-0.5 max-h-72 overflow-y-auto">
            {lockedChats.map(c => <li key={c.id}><button className="row-interactive w-full p-2 rounded-xl text-start flex items-center gap-3" onClick={() => { setFolder(false); onOpen(c.id); }}><Avatar name={c.name} kind={c.kind} photo={c.photo} person={c.kind === 'direct' && c.peerId ? { id: c.peerId, avatarAt: c.peerAvatarAt } : null} className="w-9 h-9 text-base" /><b className="truncate flex-1">{c.name}</b>
                    {e2on && <ChatTypeBadge encrypted={c.encrypted} kind={c.kind} />}{c.unread > 0 && <span className="w-2.5 h-2.5 rounded-full bg-brand" aria-label={t.unreadCount} />}</button></li>)}
          </ul>
          <div className="mt-4 flex gap-2"><button className="btn btn-primary flex-1" onClick={() => { deviceLock.lock(); setFolder(false); }}>{t.priv.lockNow}</button><button className="btn btn-ghost" onClick={() => setFolder(false)}>{t.close}</button></div>
        </Dialog>
      ) : <PinGate onClose={() => setFolder(false)} onDone={() => {}} otherDevice={!lock.hasPin} />)}
      {asking && (
        <Dialog onClose={() => setAsking(false)} label={t.req.title}>
          <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="envelope" className="w-5 h-5 text-gold-dark" />{t.req.title}</h2>
          <p className="mt-1 text-sm text-muted">{t.req.help}</p>
          <ul className="mt-3 space-y-0.5 max-h-80 overflow-y-auto">
            {requests.length === 0 && <li className="p-3 text-sm text-muted text-center">{t.req.none}</li>}
            {requests.map(c => (
              <li key={c.id}>
                <button className="row-interactive w-full p-2 rounded-xl text-start flex items-center gap-3" onClick={() => { setAsking(false); onOpen(c.id); }}>
                  <Avatar name={c.name} kind={c.kind} photo={c.photo} person={c.peerId ? { id: c.peerId, avatarAt: c.peerAvatarAt } : null} className="w-10 h-10 text-base" />
                  <span className="min-w-0 flex-1"><b className="block truncate">{c.name}</b><span className="flex items-center gap-1 text-sm text-muted min-w-0"><Preview c={c} /></span></span>
                  <Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost w-full mt-4" onClick={() => setAsking(false)}>{t.close}</button>
        </Dialog>
      )}
      {broadcast && <BroadcastLists onClose={() => setBroadcast(false)} />}

      {sheet && (
        <Dialog onClose={() => { setSheet(null); setError(''); }} label={sheetTitle}>
          <h2 className="text-lg font-bold">{sheetTitle}</h2>
          {sheet === 'new' ? (
            <div className="mt-3 flex flex-col gap-1">
              {e2on && <p className="text-xs text-muted px-1 pb-1">{t.e2ee.chooseFixed}</p>}
              {([
                ['chat', 'chats', e2on ? t.e2ee.optDirect : t.newChat, e2on ? t.e2ee.optDirectHelp : '', e2on],
                ['group', 'group', e2on ? t.e2ee.optGroup : t.newGroup, e2on ? t.e2ee.optGroupHelp : '', e2on],
                ['circle', 'heart', e2on ? t.e2ee.optCircle : t.newFamilyCircle, e2on ? t.e2ee.optCircleHelp : '', false],
                ['join', 'link', t.joinWithInvite, '', false],
                ['broadcast', 'send', t.priv.broadcast, '', false],
              ] as const).map(([k, ic, label, help, locked]) => (
                <button key={k} className="row-interactive w-full flex items-center gap-3 p-2.5 rounded-xl text-start"
                  onClick={() => { if (k === 'broadcast') { setSheet(null); setBroadcast(true); } else setSheet(k); }}>
                  <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name={ic} className="w-5 h-5" /></span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 font-bold">{label}{locked && <Icon name="lock" className="w-3.5 h-3.5 text-green" />}</span>
                    {help && <span className="block text-xs text-muted">{help}</span>}
                  </span>
                  <Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90" />
                </button>
              ))}
            </div>
          ) : (
            <form onSubmit={submit} className="mt-3 space-y-2">
              <input className="field" autoFocus required dir={sheet === 'group' || sheet === 'circle' ? undefined : 'ltr'}
                inputMode={sheet === 'chat' ? 'tel' : undefined} maxLength={60}
                placeholder={sheet === 'chat' ? t.phoneNumber : sheet === 'join' ? t.inviteCode : sheet === 'group' ? t.groupNameHint : t.circleName}
                value={field} onChange={e => setField(e.target.value)} />
              {sheet === 'circle' && <p className="text-xs text-muted">{t.kindCircle}</p>}
              {e2on && sheet === 'circle' && <p className="text-xs text-gold-dark">{t.e2ee.optCircleHelp}</p>}
              {e2on && sheet === 'group' && <><p className="text-xs text-green flex items-center gap-1.5"><Icon name="lock" className="w-3.5 h-3.5 shrink-0" />{t.e2ee.optGroupHelp}</p><p className="text-xs text-gold-dark">{t.e2ee.notAudited}</p><p className="text-xs text-gold-dark">{t.e2ee.lostWarn}</p></>}
              {e2on && sheet === 'chat' && <><p className="text-xs text-green flex items-center gap-1.5"><Icon name="lock" className="w-3.5 h-3.5 shrink-0" />{t.e2ee.optDirectHelp}</p><p className="text-xs text-gold-dark">{t.e2ee.notAudited}</p><p className="text-xs text-gold-dark">{t.e2ee.lostWarn}</p></>}
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

/** What Tamtim is for, in three lines. Shown under the first-run empty state and the welcome pane. */
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
/** `empty` is the first-run case: there is nothing to pick yet, so inviting the family
 *  is the only thing to say. Telling someone to pick a conversation they do not have
 *  reads as a broken screen. */
export function ChatWelcome({ empty }: { empty?: boolean } = {}) {
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
            <h2 className="text-4xl font-bold !text-ink tracking-tight">{empty ? t.onbTitle : t.hubWelcomeTitle}</h2>
            <p className="text-muted text-lg leading-relaxed max-w-lg mx-auto text-balance">{empty ? t.onbText : t.hubWelcomeBody}</p>
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
