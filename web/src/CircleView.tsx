import { AlbumsSection } from './Album';
import { Picker } from './Picker';
import { chime, prefOn } from './prefs';
import { Fragment, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState, Suspense, lazy } from 'react';
import { api, ApiError, toDate, type Attachment, type GalleryItem, type ArchiveEntry, type Billing, type CircleDetail, type Me, type Message, type MessageInfo } from './api';
import { fill, useI18n, intlLocale, speechLocale, systemText, LANG_INFO, type Lang } from './i18n';
import { Dialog } from './Dialog';
import { live } from './live';
import { Icon, TickMark } from './icons';
import { QUICK_REACTIONS, ALL_REACTIONS } from '../../core/reactions';
import { Spinner, GridSkeleton, Skeleton, Toggle } from './States';
import { usePresence } from './presence';
import { typingLabel, useTyping } from './typing';
import { tickOf } from './ticks';
import type { OutboxItem } from './outbox';
import { startSending } from './sending';
import { mergeMessages } from './history';
import { mentionQuery, mentionedIds, pickMention, splitMentions } from './mentions';
import { PollBubble, PollComposer } from './Poll';
import { Avatar, GroupFace, GroupRules, PersonAvatar, personColour } from './Groups';
import { lastSeenText } from './lastseen';
import { VoiceMessage, VoiceRecorder, type Recorded } from './VoiceUi';
import { PendingUpload, SendSheet } from './UploadUi';
import { ContactCard, ContactSheet, LinkCard, LiveCard, LocationCard, LocationSheet, SharePanel, StickerView, cardWord, useLinkPreview } from './Cards';
import { beginShare } from './livelocation';
import { firstLink, splitLinks } from './links';
import { Formatted } from './Formatted';
import { PhotoViewer, type ViewerItem } from './PhotoViewer';
import { RemindSheet } from './RemindersUi';
import { forget as forgetReminder, remind, useReminders, JUMP_KEY } from './reminders';
import { unreadMark } from './unread.ts';
import { MAX_TEXT, plainText, toggleMark, type Style } from '../../core/format';
import type { UploadFile } from './uploads';
import { useE2ee, openDirect, onChatChange, E2eeError, NetError } from './e2ee';
import { isKnownEncrypted } from './e2ee/known';
import { ChatSecuritySheet, ChatTypeNote, MediaFile, MediaImg, MediaVideo, NoticeLine, useMediaUrl, useNotices } from './E2eeUi';
import { ChatOptions, PinGate, ViewOnceBubble, timerWord, useLock, wallProps } from './Privacy';
import { CallButton } from './CallUi';
import { CALLS_IN_UI } from './calls';

// The WhatsApp importer carries a chat parser and a draft builder that most families will never open, so it arrives
// only when someone actually taps Import.
const ImportPanel = lazy(() => import('./Import').then(m => ({ default: m.ImportPanel })));

type Tab = 'chat' | 'archive' | 'settings';
export type Panel = null | 'search' | 'starred' | 'media';

/** Delivery state, drawn the way a chat app draws it: one check sent, two delivered,
 *  two in the accent colour once everyone has read it. */
function Ticks({ kind, t }: { kind: 'pending' | 'sent' | 'delivered' | 'read'; t: { tickPending: string; tickSent: string; tickDelivered: string; tickRead: string } }) {
  // The marks everyone already reads: a clock while it leaves this device, one tick sent, two delivered, two in the accent colour read.
  const label = { pending: t.tickPending, sent: t.tickSent, delivered: t.tickDelivered, read: t.tickRead }[kind];
  return (
    <span role="img" aria-label={label} className={`inline-flex ${kind === 'read' ? 'text-[var(--bubble-tick)]' : ''}`}>
      <Icon name={kind === 'pending' ? 'clock' : kind === 'sent' ? 'check' : 'check-double'} className={kind === 'pending' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
    </span>
  );
}

/** The date a block of messages belongs to. Today and Yesterday are named rather than
 *  dated, which is how people actually refer to them. */
/** Reactions. WhatsApp hangs these off a button on the message rather than burying them
 *  in the options sheet, and offers the whole set rather than a fixed six. The six stay as
 *  a quick row; everything else is one scroll away. */
// QUICK_REACTIONS / ALL_REACTIONS come from core/reactions.ts, the same list the server
// validates against.

function ReactionPicker({ onPick, onClose, t }: { onPick: (e: string) => void; onClose: () => void; t: { react: string; cancel: string } }) {
  return (
    <Dialog onClose={onClose} label={t.react}>
      <h2 className="text-lg font-bold mb-3">{t.react}</h2>
      <div className="flex gap-1 pb-3 mb-2 border-b border-line" role="group">
        {QUICK_REACTIONS.map(e => (
          <button key={e} type="button" aria-label={e} onClick={() => onPick(e)}
            className="text-2xl w-11 h-11 rounded-xl hover:bg-green-soft transition-colors duration-[var(--dur-instant)]">{e}</button>
        ))}
      </div>
      <div className="grid grid-cols-8 gap-0.5 max-h-64 overflow-y-auto" role="group">
        {ALL_REACTIONS.map((e, i) => (
          <button key={`${e}-${i}`} type="button" aria-label={e} onClick={() => onPick(e)}
            className="text-xl w-9 h-9 rounded-lg hover:bg-green-soft transition-colors duration-[var(--dur-instant)]">{e}</button>
        ))}
      </div>
      <button className="btn btn-ghost w-full mt-3" onClick={onClose}>{t.cancel}</button>
    </Dialog>
  );
}

/**
 * "Unread messages": the line WhatsApp draws where you stopped reading last time. It is placed from the read mark the
 * chat was OPENED with, so it stays where it is while you read (the server is told at once, but the landmark must not
 * run away from under the eye). It is not drawn when the message just before it is not loaded, because then its
 * position would be a guess, nor in a chat nothing has ever been read in — there everything is new.
 */
function UnreadLine({ count, t }: { count: number; t: { unread: string; unread1: string } }) {
  return (
    <div data-unread-line className="flex items-center gap-2 my-3" role="separator" aria-label={count === 1 ? t.unread1 : t.unread.replace('{n}', String(count))}>
      <span className="h-px flex-1 bg-green/40" />
      <span className="text-caption text-green bg-green-soft rounded-full px-3 py-1 select-none">{count === 1 ? t.unread1 : t.unread.replace('{n}', String(count))}</span>
      <span className="h-px flex-1 bg-green/40" />
    </div>
  );
}

function DayDivider({ iso, lang, t }: { iso: string; lang: string; t: { today: string; yesterday: string } }) {
  const d = toDate(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const label = diff <= 0 ? t.today : diff === 1 ? t.yesterday
    : d.toLocaleDateString(intlLocale(lang), { day: 'numeric', month: 'long', year: diff > 300 ? 'numeric' : undefined });
  return (
    <div className="flex justify-center my-3">
      <span className="text-caption text-muted bg-card/90 border border-line rounded-full px-3 py-1 backdrop-blur-sm select-none">{label}</span>
    </div>
  );
}

/** Three dots that breathe, the universal "someone is writing". Stops with reduced motion. */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 160, 320].map(d => (
        <span key={d} className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-soft" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

// Opening a chat used to be two requests in a row (the chat, then its messages) with a blank
// screen and then a false "no messages yet" in between. Now the messages are asked for at the
// same moment as the chat, and the last page seen of each chat is kept for this session, so
// reopening a chat paints at once and is then brought up to date.
const circleCache = new Map<number, CircleDetail>();
const pageCache = new Map<number, Message[]>();
const firstPage = new Map<number, { at: number; page: Promise<Message[]> }>();
function prefetchMessages(id: number) {
  const held = firstPage.get(id);
  if (!held || Date.now() - held.at > 10_000) firstPage.set(id, { at: Date.now(), page: api<Message[]>(`/circles/${id}/messages?after=0&limit=${PAGE}`) });
  return firstPage.get(id)!.page;
}

/** The agent stores its verdict as `agent:<code>:<score>:<threshold>` so each reader sees it
 *  in their own language. Anything else is older Arabic prose, shown unchanged. */
function useAgentReason() {
  const { t } = useI18n();
  return (reason: string | null | undefined) => {
    if (!reason) return '';
    const m = /^agent:([a-zA-Z]+):(\d+):(\d+)$/.exec(reason);
    if (!m) return reason;
    const line = (t.agentReason as Record<string, string>)[m[1]];
    return line ? line.replace('{score}', m[2]).replace('{threshold}', m[3]) : reason;
  };
}

export function CircleView({ id, me, initialTab, onBack, onLeft, onTab, docked }: { id: number; me: Me; initialTab?: Tab; onBack: () => void; onLeft: () => void; /** Put the open tab in the URL, so it can be linked, reloaded and stepped back through. */ onTab?: (t: Tab) => void; docked?: boolean }) {
  const { t } = useI18n();
  const [circle, setCircle] = useState<CircleDetail | null>(() => circleCache.get(id) ?? null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'chat');
  // The URL owns which tab is open. This used to ignore an absent initialTab, so stepping
  // back from .../settings to the bare circle left Settings on screen while the address bar
  // said otherwise.
  useEffect(() => { setTab(initialTab ?? 'chat'); }, [initialTab, id]);

  /** Change tab through the router when it is wired, so the address bar keeps up. */
  const goTab = useCallback((t: Tab) => { if (onTab) onTab(t); else setTab(t); }, [onTab]);

  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<number>).detail === id) goTab('settings'); };
    window.addEventListener('thikra:invite', on);
    return () => window.removeEventListener('thikra:invite', on);
  }, [id]);
  // Search / starred / media belong beside the chat's name, the way a chat app puts them,
  // not in a toolbar sitting on top of the conversation. The state lives here so the
  // header can drive the panel that Chat renders.
  const [panel, setPanel] = useState<Panel>(null);
  useEffect(() => { setPanel(null); }, [tab, id]);
  // Escape closes the side panel, the way it closes a dialog. Without this the media
  // panel could only be dismissed by finding its toggle again.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);
  const [blocked, setBlocked] = useState(false);
  const [sealedTotal, setSealedTotal] = useState(0);
  const [options, setOptions] = useState(false);
  const [security, setSecurity] = useState(false);
  const [profile, setProfile] = useState(false);   // a one-to-one chat: the other person's card (photo, name, About)

  const loadCircle = useCallback(() => api<CircleDetail>(`/circles/${id}`).then(c => { circleCache.set(id, c); setCircle(c); }).catch(onBack), [id, onBack]);
  useEffect(() => { prefetchMessages(id).catch(() => {}); loadCircle(); }, [id, loadCircle]);
  // The group itself changed (name, photo, a rule, its members, someone asking to join): show it at once.
  useEffect(() => live.on(f => { if ((f.t === 'circle' || f.t === 'join_requests') && f.circle === id) loadCircle(); }), [id, loadCircle]);
  useEffect(() => {
    if (circle?.kind !== 'circle') return;
    api<{ total: number }>(`/circles/${id}/sealed-envelopes`).then(r => setSealedTotal(r.total)).catch(() => {});
  }, [id, circle?.kind]);
  const other = circle?.kind === 'direct' ? circle.members.find(m => m.id !== me.id) : undefined;
  useEffect(() => {
    if (!other) return;
    api<Array<{ id: number }>>('/me/blocks').then(l => setBlocked(l.some(x => x.id === other.id))).catch(() => {});
  }, [other?.id]);
  async function toggleBlock() {
    if (!other) return;
    const on = !blocked; setBlocked(on);
    try { await api(`/users/${other.id}/block`, { body: { on } }); window.dispatchEvent(new Event('thikra:blocks')); } catch { setBlocked(!on); }
  }
  const lock = useLock();
  if (!circle) return <ChatSkeleton docked={docked} />;
  // A locked chat opens only with the PIN of this device; until then nothing of it is loaded or shown.
  if (circle.locked && !lock.unlocked) return (
    <div className={docked ? 'chat-docked flex flex-col h-full' : 'flex flex-col h-[100dvh] py-2'}>
      <div className="chat-head flex items-center gap-2 mb-3">
        <button className="w-10 h-10 shrink-0 rounded-xl text-muted flex items-center justify-center hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]"
          onClick={onBack} aria-label={t.back} title={t.back}><Icon name="arrow-back" className="w-5 h-5 rtl:-scale-x-100" /></button>
      </div>
      <PinGate onClose={onBack} onDone={() => {}} otherDevice />
    </div>
  );

  // A circle has everything; a plain group has no archive; a one-to-one chat is just the chat.
  const tabs: Tab[] = circle.kind === 'direct' ? ['chat'] : circle.kind === 'group' ? ['chat', 'settings'] : ['chat', 'archive', 'settings'];
  return (
    <div className={docked ? 'chat-docked flex flex-col h-full' : 'flex flex-col h-[100dvh] py-2'}>
      <div className="chat-head flex items-center gap-2 mb-3">
        <button className="w-10 h-10 shrink-0 rounded-xl text-muted flex items-center justify-center hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]"
          onClick={onBack} aria-label={t.back} title={t.back}><Icon name="arrow-back" className="w-5 h-5 rtl:-scale-x-100" /></button>
        {other
          ? <button type="button" className="shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-green" onClick={() => setProfile(true)} aria-label={t.viewProfile.replace('{name}', circle.name)} title={t.viewProfile.replace('{name}', circle.name)}>
              <Avatar name={circle.name} kind={circle.kind} photo={circle.photo} person={{ id: other.id, avatarAt: other.avatarAt }} className="w-11 h-11 text-base" />
            </button>
          : <Avatar name={circle.name} kind={circle.kind} photo={circle.photo} person={null} className="w-11 h-11 text-base" />}
        <span className="min-w-0 flex-1">
          <h2 className="text-[1.05rem] font-bold !text-ink truncate leading-tight">{other
            ? <button type="button" className="max-w-full truncate text-start hover:underline" onClick={() => setProfile(true)} data-open-profile><bdi>{circle.name}</bdi></button>
            : <bdi>{circle.name}</bdi>}</h2>
          {/* One quiet line: who is here (or whether they are online), and the chat's kind as a small tag that opens the details.
              The full sentence about who can read it lives in that sheet, not across the header. */}
          <span className="mt-0.5 flex items-center gap-2 min-w-0 text-caption">
            {other && !blocked ? <PresenceLine userId={other.id} />
              : circle.kind !== 'direct' && <span className="text-muted truncate">{circle.members.length === 1 ? t.oneMember : `${circle.members.length} ${t.members}`}</span>}
            {(circle.encrypted || circle.kind === 'circle') && (
              <button type="button" onClick={() => setSecurity(true)} title={circle.encrypted ? (circle.kind === 'direct' ? t.e2ee.headerDirect : t.e2ee.headerGroup) : t.e2ee.headerCircle}
                className={`shrink-0 inline-flex items-center gap-1 h-5 px-2 rounded-full font-bold transition-colors duration-[var(--dur-instant)]
                  ${circle.encrypted ? 'bg-green-soft text-green hover:bg-green/15' : 'bg-gold/15 text-gold-dark hover:bg-gold/25'}`}>
                <Icon name={circle.encrypted ? 'lock' : 'heart'} className="w-3 h-3" />{circle.encrypted ? t.e2ee.private : t.infoKindCircle}
              </button>
            )}
          </span>
        </span>
        {tab === 'chat' && (
          <div className="flex items-center gap-1 shrink-0">
            {([['search', 'search', t.search], ['starred', 'star', t.starred], ['media', 'image', t.media]] as const).map(([key, icon, label]) => (
              <button key={key} aria-label={label} title={label} aria-pressed={panel === key}
                onClick={() => setPanel(p => (p === key ? null : key))}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors duration-[var(--dur-instant)]
                  ${panel === key ? 'bg-green-soft text-green' : 'text-muted hover:bg-green-soft/60 hover:text-green'}`}>
                <Icon name={icon} className="w-[18px] h-[18px]" />
              </button>
            ))}
          </div>
        )}
        {CALLS_IN_UI && other && !blocked && <CallButton circle={circle.id} name={other.name} peer={{ id: other.id, avatarAt: other.avatarAt }} />}
        {other && <button className="btn btn-ghost !py-1 text-sm" onClick={toggleBlock}>{blocked ? t.unblock : t.block}</button>}
        {!!circle.disappearSeconds && <button type="button" className="hidden sm:inline-flex shrink-0 items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-green-soft text-green" title={t.priv.timerBadge.replace('{when}', timerWord(circle.disappearSeconds, t))} onClick={() => setOptions(true)}><Icon name="clock" className="w-3.5 h-3.5" />{timerWord(circle.disappearSeconds, t)}</button>}
        {circle.kind === 'circle' && sealedTotal > 0 && <span className="hidden sm:inline-flex shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark" title={t.sealedCount.replace('{n}', String(sealedTotal))}><span className="inline-flex items-center gap-1"><Icon name="envelope" className="w-3.5 h-3.5" />{sealedTotal}</span></span>}
        {circle.kind === 'circle' && !!circle.agentActive && <span className="hidden sm:inline-flex shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark" title={t.agentModeHelp}><span className="inline-flex items-center gap-1"><Icon name="sparkle" className="w-3.5 h-3.5" />{t.agentOn}</span></span>}
        <button className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-muted hover:bg-green-soft/60 hover:text-green transition-colors duration-[var(--dur-instant)]"
          aria-label={t.priv.chatOptions} title={t.priv.chatOptions} onClick={() => setOptions(true)}><Icon name="more" className="w-[18px] h-[18px]" /></button>
      </div>
      {security && <ChatSecuritySheet circle={circle} me={me} onClose={() => setSecurity(false)} />}
      {profile && other && (
        <Dialog onClose={() => setProfile(false)} label={circle.name}>
          <div className="flex flex-col items-center text-center pt-2" data-profile-card>
            <PersonAvatar id={other.id} name={circle.name} avatarAt={other.avatarAt} className="w-24 h-24 text-4xl" />
            <h2 className="mt-3 text-xl font-bold !text-ink break-words"><bdi>{circle.name}</bdi></h2>
            {!blocked && <p className="mt-1 text-sm"><PresenceLine userId={other.id} /></p>}
            {other.about && (
              <div className="mt-4 w-full rounded-2xl bg-paper border border-line px-4 py-3 text-start">
                <span className="block text-xs text-muted">{t.about.label}</span>
                <p className="mt-0.5 text-ink break-words" dir="auto" data-about>{other.about}</p>
              </div>
            )}
          </div>
          <button className="btn btn-ghost w-full mt-4" onClick={() => setProfile(false)}>{t.closePanel}</button>
        </Dialog>
      )}
      {options && <ChatOptions circle={circle} meId={me.id} reload={loadCircle} onClose={() => setOptions(false)} />}
      {blocked && <p role="status" className="text-xs text-gold-dark bg-gold/15 rounded-lg p-2 mb-2">{t.blockedNote}</p>}
      {tabs.length > 1 && <div className="chat-tabs flex gap-1 mb-3 border-b border-line">
        {tabs.map(k => (
          <button key={k} onClick={() => goTab(k)}
            className={`px-4 py-2.5 -mb-px border-b-2 transition-colors duration-[var(--dur-instant)] ${tab === k ? 'border-green text-green font-bold' : 'border-transparent text-muted hover:text-ink'}`}>
            {t[k]}
          </button>
        ))}
      </div>}
      {tab === 'chat' && circle.kind === 'circle' && <TodayBanner circleId={circle.id} onOpen={() => goTab('archive')} />}
      <div className="flex-1 min-h-0">
        {tab === 'chat' && <Chat circle={circle} me={me} panel={panel} setPanel={setPanel} onOpenArchive={() => goTab('archive')} onLeave={onLeft} />}
        {tab === 'archive' && <Archive circle={circle} />}
        {tab === 'settings' && <Settings circle={circle} me={me} reload={loadCircle} onLeft={onLeft} openArchive={() => goTab('archive')} />}
      </div>
    </div>
  );
}

type TodayItem = { type: 'memory'; id: number; title: string; years: number } | { type: 'birthday'; id: number; name: string; age: number };
/** An announcement at the top of a family chat, only on a day that has something (a birthday, an event from earlier years). Dismissed for the day; no empty strip otherwise. */
function TodayBanner({ circleId, onOpen }: { circleId: number; onOpen: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<{ day: string; items: TodayItem[] } | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => { api<{ day: string; items: TodayItem[] }>(`/circles/${circleId}/today`).then(d => {
    setData(d);
    try { setHidden(localStorage.getItem(`today:${circleId}`) === d.day); } catch { /* private mode */ }
  }).catch(() => {}); }, [circleId]);
  if (!data || hidden || data.items.length === 0) return null;
  const it = data.items[0], more = data.items.length - 1;
  const text = it.type === 'birthday' ? t.todayBirthday.replace('{name}', it.name).replace('{age}', String(it.age))
    : t.todayMemory.replace('{n}', String(it.years)).replace('{title}', it.title);
  return (
    <div role="status" className="mb-2 flex items-center gap-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 text-sm">
      <Icon name={it.type === 'birthday' ? 'cake' : 'memory'} className="w-4 h-4 text-gold-dark shrink-0" />
      <button className="flex-1 min-w-0 text-start" onClick={it.type === 'memory' ? onOpen : undefined}><span className="line-clamp-2">{text}{more > 0 ? ` (+${more})` : ''}</span></button>
      <button aria-label={t.close} className="text-muted px-1" onClick={() => { setHidden(true); try { localStorage.setItem(`today:${circleId}`, data.day); } catch { /* ignore */ } }}>×</button>
    </div>
  );
}

// Each member has their own colour for their NAME only (messages stay white), like WhatsApp. All reach 4.5:1 on white.
const nameColour = personColour;

const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

// ---- people: the family record ----------------------------------------------------------------

interface Person { id: number; name: string; userId: number | null; relation: string | null; birthDate: string | null; deathDate: string | null }

/** The family record: people outlive accounts (the living and the departed). Managers edit; everyone reads. */
function PeoplePanel({ circle, manager }: { circle: CircleDetail; manager: boolean }) {
  const { t } = useI18n();
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const [f, setF] = useState({ name: '', relation: '', birthDate: '', deathDate: '' });
  const [error, setError] = useState('');
  const load = () => api<Person[]>(`/circles/${circle.id}/persons`).then(setPeople).catch(() => {});
  useEffect(() => { load(); }, [circle.id]);
  const open = (p: Person | 'new') => { setEditing(p); setError(''); setF(p === 'new' ? { name: '', relation: '', birthDate: '', deathDate: '' } : { name: p.name, relation: p.relation ?? '', birthDate: p.birthDate ?? '', deathDate: p.deathDate ?? '' }); };
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError('');
    const body = { name: f.name, relation: f.relation, birthDate: f.birthDate || null, deathDate: f.deathDate || null };
    try {
      if (editing === 'new') await api(`/circles/${circle.id}/persons`, { body });
      else if (editing) await api(`/persons/${editing.id}`, { method: 'PATCH', body });
      setEditing(null); load();
    } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }
  const years = (p: Person) => [p.birthDate?.slice(0, 4), p.deathDate?.slice(0, 4)].filter(Boolean).join(' – ');
  return (
    <section className="card p-4 space-y-2">
      <h3 className="font-bold">{t.peopleTitle}</h3>
      <p className="text-xs text-muted">{t.peopleNote}</p>
      <ul className="divide-y divide-line">
        {people.map(p => (
          <li key={p.id} className="py-2 flex items-center gap-2">
            <span className="flex-1 min-w-0">
              <b className="truncate">{p.name}</b>{p.deathDate && <span className="text-xs text-muted"> · {t.personDeceased}</span>}
              <span className="block text-xs text-muted">{[p.relation, years(p), p.userId ? t.linkedAccount : ''].filter(Boolean).join(' · ')}</span>
            </span>
            {manager && <button className="text-sm text-green underline" onClick={() => open(p)}>{t.editPerson}</button>}
          </li>
        ))}
      </ul>
      {manager && editing === null && <button className="btn btn-ghost w-full" onClick={() => open('new')}><Icon name="plus" className="w-4 h-4" />{t.addPerson}</button>}
      {editing !== null && (
        <form onSubmit={save} className="space-y-2 border-t border-line pt-2">
          <input className="field" required maxLength={60} placeholder={t.personName} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
          <input className="field" maxLength={40} placeholder={t.personRelation} value={f.relation} onChange={e => setF({ ...f, relation: e.target.value })} />
          <label className="block text-xs text-muted">{t.personBirth}<input className="field mt-1" type="date" dir="ltr" value={f.birthDate} onChange={e => setF({ ...f, birthDate: e.target.value })} /></label>
          <label className="block text-xs text-muted">{t.personDeath}<input className="field mt-1" type="date" dir="ltr" value={f.deathDate} onChange={e => setF({ ...f, deathDate: e.target.value })} /></label>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2"><button className="btn flex-1">{t.savePerson}</button><button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>{t.cancel}</button></div>
        </form>
      )}
    </section>
  );
}

/** "online" or "last seen today at 4:30 PM" under a person's name. Nothing at all when they hide it (or we may not see it). */
function PresenceLine({ userId }: { userId: number }) {
  const { t, lang } = useI18n();
  const p = usePresence([userId]).get(userId);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(n => n + 1), 60_000); return () => clearInterval(i); }, []);   // "today" becomes "yesterday" at midnight
  if (!p) return null;
  if (p.online) return <span className="text-green truncate inline-flex items-center gap-1"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-green" />{t.online}</span>;
  return p.lastSeen ? <span className="text-muted truncate">{lastSeenText(p.lastSeen, new Date(), lang, t)}</span> : null;
}

/** A receipt time: just the clock for today, the date and the clock otherwise. */
function infoTime(at: string, lang: string) {
  const d = toDate(at), now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return new Intl.DateTimeFormat(intlLocale(lang), sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

// ---- chat ------------------------------------------------------------------

/** A preview picture made on the device, as a data URL small enough to travel inside the encrypted message (a bigger one is left out: the receiver shows a plain frame). */
async function thumbUrl(b: Blob | null): Promise<string | undefined> {
  if (!b || b.size > 24_000) return undefined;
  const bytes = new Uint8Array(await b.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${b.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

/** How many messages a chat loads at a time (the same number the server pages by). */
const PAGE = 50;
const HUNT_PAGES = 8;   // how many older pages a jump may pull in before it gives up (see the jump effect)
const MANY_TIMES = 5;    // hops after which a forward is a chain message (the server uses the same number)
const CHAIN_CHARS = 280; // how much of a chain message is shown before "show the whole message"

/** The notices the device wrote (keys changed...) slotted into the thread by time; each stands in as a system line with a negative id. */
function withNotices(list: Message[], notices: Array<{ at: number }>): Message[] {
  if (!notices.length) return list;
  const out = [...list];
  notices.forEach((n, i) => {
    const line = { id: -1e9 - i, kind: 'system', body: '', createdAt: new Date(n.at).toISOString().replace('T', ' ').slice(0, 19), userId: null, author: null, transcript: null, hasAudio: 0, archiveStatus: 'none', score: null, category: null, reason: null, deleted: 0, deletedBy: null } as Message;
    const at = out.findIndex(m => m.id > -1e9 && !m.pending && toDate(m.createdAt).getTime() > n.at);
    if (at < 0) out.push(line); else out.splice(at, 0, line);
  });
  return out;
}
function Chat({ circle, me, panel, setPanel, onOpenArchive, onLeave }: { circle: CircleDetail; me: Me; panel: Panel; setPanel: React.Dispatch<React.SetStateAction<Panel>>; onOpenArchive: () => void; onLeave: () => void }) {
  // A message request from someone you do not know: read it, then accept, decline, block or report. Until then nothing is sent back.
  const [requestOpen, setRequestOpen] = useState(!!circle.request);
  useEffect(() => setRequestOpen(!!circle.request), [circle.id, circle.request]);
  const { t, lang } = useI18n();
  const agentReason = useAgentReason();
  const enc = !!circle.encrypted || isKnownEncrypted(circle.id);   // a server cannot talk this device out of a chat it knows is encrypted
  const { e2ee } = useE2ee();
  const encReady = !enc || !!e2ee;
  const [encState, setEncState] = useState<'ok' | 'stuck' | 'waiting' | 'not_member'>('ok');
  const [encWhy, setEncWhy] = useState<string | null>(null);
  const [encBusy, setEncBusy] = useState(false);
  /** Rows from the server -> messages to draw. In an encrypted chat they are decrypted here (and control messages applied); in any other chat they pass through untouched. */
  const dec = useCallback((rows: Message[]): Promise<Message[]> => (enc && e2ee ? e2ee.decryptRows(circle.id, rows as any) : Promise.resolve(rows)), [enc, e2ee, circle.id]);
  /** What an encryption mistake says to the person. */
  const encFail = useCallback((err: unknown) => {
    const code = err instanceof E2eeError || err instanceof NetError ? err.code : 'generic';
    if (code === 'keys_mismatch') return t.e2ee.keysMismatch;
    if (code === 'untrusted_commit' || code === 'bad_commit') return t.e2ee.stuck;
    if (code === 'not_member') return t.e2ee.notMember;
    if (code === 'peer_gone') return t.e2ee.goneNote;
    if (code === 'device_unconfirmed') return t.e2ee.unconfirmedSend;
    if (code === 'device_gone') return t.e2ee.notReady;
    if (code === 'not_ready' || code === 'no_key_packages' || code === 'send_failed') return t.e2ee.notReady;
    if (code === 'invalid_attachment') return t.errors.invalid_attachment ?? t.errors.generic;
    return t.errors[code] ?? t.errors.generic;
  }, [t]);
  useEffect(() => {
    if (!enc || !e2ee) return;
    let live = true;
    const look = () => e2ee.status(circle.id).then(s => { if (live) setEncState(s); }).catch(() => {}); e2ee.stuckReason(circle.id).then(w => { if (live) setEncWhy(w); }).catch(() => {});
    look();
    const off = onChatChange(c => { if (c === circle.id || c === null) look(); });
    return () => { live = false; off(); };
  }, [enc, e2ee, circle.id]);
  const notices = useNotices(circle.id, enc);
  const [safety, setSafety] = useState(false);
  // The last page seen of a readable chat is kept for this session so reopening it paints at once.
  // An encrypted chat keeps nothing outside its own engine: its messages are never cached here.
  const [msgs, setMsgs] = useState<Message[]>(() => (enc ? [] : pageCache.get(circle.id) ?? []));
  // False until the first page has arrived: an empty list before that means "loading",
  // not "this chat has no messages", and must not say so.
  const [loaded, setLoaded] = useState(() => !enc && pageCache.has(circle.id));
  useEffect(() => { if (!enc) pageCache.set(circle.id, msgs.filter(m => !m.pending)); }, [enc, circle.id, msgs]);
  // Drafts (M-13): what you were typing survives leaving the chat and closing the app. Per circle, on this device.
  const draftKey = `thikra_draft_${circle.id}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [onceVoice, setOnceVoice] = useState(false);                   // the next voice note is view once
  const [open, setOpen] = useState<number | null>(null);
  const [del, setDel] = useState<Message | null>(null);
  const [reminding, setReminding] = useState<Message | null>(null);   // the "Remind me" sheet, for this message
  const reminders = useReminders(me.id);
  const remindedHere = useMemo(() => new Map(reminders.filter(r => r.circleId === circle.id).map(r => [r.messageId, r])), [reminders, circle.id]);
  const [reacting, setReacting] = useState<Message | null>(null);
  // A machine transcript is a tool, not part of the message: shown only when asked for.
  const [transcribed, setTranscribed] = useState<Set<number>>(new Set());
  // Blocking is meant to work both ways: they cannot write to you, and in a group you share you do not have to read
  // them either. Their messages are folded away for you alone — nobody is told, and one tap opens any of them, because
  // hiding a message outright would leave replies to it hanging in the air.
  const [blockedIds, setBlockedIds] = useState<Set<number>>(new Set());
  const [shownBlocked, setShownBlocked] = useState<Set<number>>(new Set());
  // A chain message — passed along five times or more — is folded to its first lines. These things are long by
  // design; the family sees what it is and decides, instead of the whole thing taking over the screen.
  const [openChains, setOpenChains] = useState<Set<number>>(new Set());
  // MSG-02 "select multiple": chosen from a message's own menu, then the bar at the top does one thing to all of
  // them. `null` means the mode is off — an empty Set would hide every message's controls for nothing.
  const [chosen, setChosen] = useState<Set<number> | null>(null);
  const inPick = chosen !== null;
  useEffect(() => {
    const load = () => api<Array<{ id: number }>>('/me/blocks').then(l => setBlockedIds(new Set(l.map(x => x.id)))).catch(() => { /* the chat reads fine without it */ });
    load();
    window.addEventListener('thikra:blocks', load);
    return () => window.removeEventListener('thikra:blocks', load);
  }, []);
  const [marks, setMarks] = useState(circle.members);                 // each member's delivered/read "up to here"
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  useEffect(() => {
    try { if (text && !editing && !enc) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch { /* storage unavailable: no draft, everything else works */ }
  }, [text, editing, draftKey]);
  const typersOf = useTyping(me.id);                                  // who is typing or recording, shared with the chat list
  const marksRef = useRef(circle.members);
  useEffect(() => { marksRef.current = marks; }, [marks]);
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[]>([]);
  const [fwd, setFwd] = useState<Message | null>(null);
  const [reporting, setReporting] = useState<Message | null>(null);
  const [reported, setReported] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [pinIdx, setPinIdx] = useState(0);
  const [pinning, setPinning] = useState<Message | null>(null);
  const [polling, setPolling] = useState(false);                      // the "new poll" sheet
  const box2 = useRef<HTMLTextAreaElement>(null);                     // the message box (for the caret, when a name is picked)
  const [caret, setCaret] = useState(0);
  const [selEnd, setSelEnd] = useState(0);                            // with caret: the selected stretch, which the formatting bar acts on
  const names = useMemo(() => new Map(circle.members.map(x => [x.id, x.name])), [circle.members]);
  const memberById = useMemo(() => new Map(marks.map(x => [x.id, x])), [marks]);
  const fail = useCallback((code: string) => setError(t.errors[code] ?? t.errors.generic), [t]);
  const openPerson = useCallback((uid: number) => { if (uid !== me.id) openDirect({ userId: uid }).then(r => { location.hash = `/circle/${r.id}`; }).catch(() => {}); }, [me.id]);
  const [info, setInfo] = useState<MessageInfo | null>(null);         // "Info" on one of my messages: who read it, who received it
  const infoFor = useRef(0);                                          // the message whose info was asked for last: a slow answer for an earlier one is dropped
  const openInfo = useCallback((m: Message) => {
    infoFor.current = m.id;
    api<MessageInfo>(`/messages/${m.id}/info`).then(r => { if (infoFor.current === m.id) setInfo(r); }).catch(() => {});
  }, []);
  // Only a real change replaces the bar (and goes back to the first pin): the fallback poll below asks again and again.
  const loadPins = useCallback(() => api<Message[]>(`/circles/${circle.id}/pins`).then(dec).then(p => {
    setPins(prev => { if (prev.length === p.length && prev.every((x, i) => x.id === p[i].id)) return prev; setPinIdx(0); return p; });
  }).catch(() => {}), [circle.id, dec]);
  useEffect(() => { loadPins(); }, [loadPins]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [light, setLight] = useState<number | null>(null);           // the attachment open in the photo viewer
  const [picked, setPicked] = useState<File[] | null>(null);          // files chosen, shown in the sheet before sending
  const [attachMenu, setAttachMenu] = useState(false);
  const [sharing, setSharing] = useState<null | 'panel' | 'contact' | 'location'>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // The attach menu and the stickers panel close when you click anywhere outside the message box (as any popover does).
  useEffect(() => {
    if (!attachMenu && sharing !== 'panel') return;
    const away = (e: MouseEvent) => { if (!composerRef.current?.contains(e.target as Node)) { setAttachMenu(false); setSharing(sh => (sh === 'panel' ? null : sh)); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [attachMenu, sharing]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fwdTargets, setFwdTargets] = useState<Array<{ id: number; name: string }>>([]);
  const [fwdPick, setFwdPick] = useState<number[]>([]);
  const lastTypingSent = useRef(0);
  const reportedRead = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  // Disappearing messages leave the screen at their time, even offline: this clock moves every 10 seconds while any message has a time.
  const [clock, setClock] = useState(Date.now);
  const hasTimed = msgs.some(m => m.expiresAt && !m.expired);
  useEffect(() => { if (!hasTimed) return; const h = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(h); }, [hasTimed]);
  const wall = useRef<HTMLDivElement>(null);                    // the scrolling list of messages
  const anchor = useRef<{ top: number; height: number } | null>(null);   // where the list was just before an older page is added (to keep the reading position)
  const [older, setOlderState] = useState<'idle' | 'loading' | 'end'>('idle');
  const olderRef = useRef<'idle' | 'loading' | 'end'>('idle');  // read inside handlers without waiting for a render
  const setOlder = useCallback((v: 'idle' | 'loading' | 'end') => { olderRef.current = v; setOlderState(v); }, []);
  const content = useRef<HTMLDivElement>(null);                 // the thread inside the wall (watched for growth)
  const [atBottom, setAtBottom] = useState(true);               // shows the "jump to latest" button when false
  // Scroll the container itself rather than a sentinel element: scrollIntoView stops at the
  // sentinel's box, which left the newest message tucked under the composer.
  const toBottom = (smooth = true) => { const el = wall.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  const lastSeq = useRef(0);
  const lastRev = useRef(0);
  // Text messages the server has not confirmed yet wait in the outbox (saved on this device) and are sent by the app's one sender,
  // from whatever screen the person is on. This screen only DRAWS what waits for this chat: the bubbles are read from the outbox on
  // every change, never kept as a copy here, so a bubble cannot outlive its message.
  const { box, sender, uploader, media } = useMemo(() => startSending(me.id), [me.id]);
  const [boxTurn, turnBox] = useState(0);
  const waiting = useMemo<Message[]>(() => box.list(circle.id).map((i: OutboxItem) => ({
    id: i.at - 8e15, cid: i.cid, pending: true, failed: i.failed, userId: me.id, author: me.name, kind: 'text', body: i.body, transcript: null,
    hasAudio: 0, archiveStatus: 'none', score: null, category: null, reason: null, createdAt: new Date(i.at).toISOString(), deleted: 0, deletedBy: null,
    replyTo: i.quote ? { ...i.quote, deleted: false } : null,
  })), [box, circle.id, me.id, me.name, boxTurn]);   // eslint-disable-line react-hooks/exhaustive-deps
  const uploads = uploader.list(circle.id);            // photos, files and voice notes on their way (read on every redraw, like `waiting`)
  const oldestLoaded = useRef(0);                     // the seq this screen's window of history starts at (0 = the whole chat is loaded)
  const nearBottom = useRef(true);                    // is the person looking at the newest messages (then new ones keep the view down)
  // How far this person had read when they opened this chat: fixed for as long as the chat is on screen (see UnreadLine).
  const openedRead = useRef<{ id: number; seq: number }>({ id: 0, seq: 0 });
  if (openedRead.current.id !== circle.id) openedRead.current = { id: circle.id, seq: (circle.members.find(x => x.id === me.id)?.readSeq as number | null) ?? 0 };
  const unreadFrom = openedRead.current.seq;
  const jumpedUnread = useRef(0);                     // the chat whose unread line has already been jumped to
  // After you send something the view follows it down for a while, even while the upload bubble is swapped for the real
  // message and its photo loads (both briefly move the scroll position). Any scroll of your own (wheel, touch, keys) ends it.
  const followUntil = useRef(0);
  const follow = () => { nearBottom.current = true; followUntil.current = Date.now() + 20_000; };
  const manager = circle.role === 'owner' || circle.role === 'admin';

  // Merge messages into the screen by seq: a message we already show is replaced by its newer revision and new ones slot in order.
  // A change to a message older than what is loaded is left out (web/src/history.ts says why).
  const merge = useCallback((incoming: Message[]) => setMsgs(prev => mergeMessages(prev, incoming, oldestLoaded.current)), []);

  /**
   * Opening (`full`): the latest page. Catching up: everything new OR CHANGED since the last sync reply (rev), oldest first,
   * page by page. The watermark moves only on sync replies, never on pushes, so a lost push is repaired by the next sync.
   */
  const refresh = useCallback(async (full = false) => {
    if (full || lastRev.current === 0) {
      // The first page was already asked for alongside the chat itself (prefetchMessages): use that answer once, if it is fresh.
      const held = full && !enc ? firstPage.get(circle.id) : undefined;
      if (held) firstPage.delete(circle.id);
      const rows = held && Date.now() - held.at < 10_000
        ? await held.page.catch(() => api<Message[]>(`/circles/${circle.id}/messages?after=0&limit=${PAGE}`))
        : await api<Message[]>(`/circles/${circle.id}/messages?after=0&limit=${PAGE}`);
      const page = await dec(rows);
      const whole = rows.length < PAGE;   // fewer than a page came back: this IS the whole chat
      const first = whole ? 0 : Math.min(...rows.map(m => m.seq ?? Infinity));
      if (full || oldestLoaded.current === 0 || first < oldestLoaded.current) oldestLoaded.current = first;
      if (full) { setOlder(whole ? 'end' : 'idle'); nearBottom.current = true; setMsgs(page); }
      else merge(page);
      lastSeq.current = Math.max(0, ...rows.map(m => m.seq ?? 0));
      lastRev.current = Math.max(0, ...rows.map(m => m.rev ?? 0));
      return;
    }
    for (let guard = 0; guard < 50; guard++) {
      const got = await api<Message[]>(`/circles/${circle.id}/messages?after_rev=${lastRev.current}`);
      if (got.length) {
        merge(await dec(got));
        lastRev.current = Math.max(lastRev.current, ...got.map(m => m.rev ?? 0));
        lastSeq.current = Math.max(lastSeq.current, ...got.map(m => m.seq ?? 0));
      }
      if (got.length < 200) break;
    }
  }, [circle.id, merge, dec]);

  // What the sender did with this chat's messages. One sent over HTTP is not pushed back to this device, so fetch it.
  useEffect(() => {
    const onStorage = () => turnBox(n => n + 1);   // another tab of this person changed the outbox
    window.addEventListener('storage', onStorage);
    const off = sender.subscribe(e => {
      turnBox(n => n + 1);
      if (e.circle !== circle.id) return;
      if (e.type === 'sent' && e.via === 'http') refresh().catch(() => {});
      if (e.type === 'failed') { const code = box.list(circle.id).find(i => i.cid === e.cid)?.failed ?? 'generic'; setError(t.errors[code] ?? t.errors.generic); }
    });
    // The media outbox (photos, files, voice notes): redraw on every step; when one arrives, fetch the message it became.
    const offUp = uploader.subscribe(e => {
      turnBox(n => n + 1);
      if (e.circle === circle.id && e.type === 'sent') refresh().catch(() => {});
    });
    return () => { off(); offUp(); window.removeEventListener('storage', onStorage); };
  }, [sender, uploader, box, circle.id, refresh, t]);
  useEffect(() => {
    if (!encReady) return;
    refresh(true).catch(() => {}).finally(() => setLoaded(true));
    // Live: new messages arrive as pushed frames. Polling stays as the safety net: fast while the socket is down, rare while it is up.
    const off = live.on(f => {
      if (f.t === 'open') { live.join([circle.id]); refresh().catch(() => {}); } // (re)connected: catch up on what was missed
      else if (f.t === 'msg' && f.circle === circle.id) {
        const m = f.m as Message;
        if (m.userId && m.userId !== me.id && document.visibilityState === 'visible') chime();   // the in-app sound, if the person wants it
        // A hole in the sequence means a push was lost: sync now instead of waiting for the safety poll.
        const hole = m.seq !== undefined && lastSeq.current > 0 && m.seq > lastSeq.current + 1;
        lastSeq.current = Math.max(lastSeq.current, m.seq ?? 0);
        if (hole) refresh().catch(() => {});
        dec([m]).then(merge).catch(() => {});
      } else if (f.t === 'pins' && f.circle === circle.id) {
        loadPins();
      } else if (f.t === 'update' && f.circle === circle.id) {
        dec([f.m as Message]).then(merge).catch(() => {});
        if ((f.m as Message)?.deleted) loadPins();
      } else if ((f.t === 'receipt' || f.t === 'typing') && f.circle === circle.id && !marksRef.current.some(x => x.id === f.user)) {
        // Someone joined after this screen loaded: fetch the member list again (then their marks and name are known).
        api<CircleDetail>(`/circles/${circle.id}`).then(d => setMarks(d.members)).catch(() => {});
      } else if (f.t === 'receipt' && f.circle === circle.id) {
        setMarks(prev => prev.map(x => x.id !== f.user ? x : {
          ...x,
          deliveredSeq: Math.max(x.deliveredSeq, f.delivered_seq ?? 0),
          // Read marks are reciprocal: we only keep them if we share ours too.
          readSeq: f.read_seq !== undefined && me.read_receipts === 1 ? Math.max(x.readSeq ?? 0, f.read_seq) : x.readSeq,
        }));
      } else if (f.t === 'changed' && f.circle === circle.id) { refresh().catch(() => {}); loadPins(); }   // a deleted message also leaves the pinned bar
    });
    live.join([circle.id]);   // a chat made or joined after the page loaded is not in the socket's room yet
    let n = 0;
    // Without the live connection nothing announces a new pin, so the poll that fetches messages also checks the pins (every 3rd tick).
    const timer = setInterval(() => { n++; if (!live.connected || n % 10 === 0) refresh().catch(() => {}); if (!live.connected && n % 3 === 0) loadPins(); }, 3000);
    return () => { off(); clearInterval(timer); };
  }, [refresh, merge, dec, encReady, loadPins, circle.id, me.id, me.read_receipts]);

  useEffect(() => { api<Message[]>(`/circles/${circle.id}/starred`).then(r => setStarredIds(new Set(r.map(m => m.id)))).catch(() => {}); }, [circle.id]);   // ids only: nothing to decrypt

  // Search as you type (debounced); the "starred" panel lists your stars instead.
  useEffect(() => {
    if (panel === 'media') {
      if (enc) {   // the server lists no files of an encrypted chat: the gallery is made here from the messages this device can read
        setGallery(msgs.flatMap(m => (m.attachments ?? []).filter(a => !m.viewOnce && m.kind !== 'voice').map(a => ({ ...a, messageId: m.id, seq: m.seq ?? 0, createdAt: m.createdAt, author: m.author }))).reverse());
        return;
      }
      api<GalleryItem[]>(`/circles/${circle.id}/media`).then(setGallery).catch(() => setGallery([])); return;
    }
    if (panel === 'starred') { api<Message[]>(`/circles/${circle.id}/starred`).then(dec).then(setResults).catch(() => setResults([])); return; }
    if (panel !== 'search' || query.trim().length < 2) { setResults([]); return; }
    // An encrypted chat is searched here, over what this device can read; a readable chat by the server as before.
    const timer = setTimeout(() => (enc && e2ee ? e2ee.search(circle.id, query.trim()) : api<Message[]>(`/circles/${circle.id}/search?q=${encodeURIComponent(query.trim())}`)).then(setResults).catch(() => setResults([])), 250);
    return () => clearTimeout(timer);
  }, [panel, query, circle.id, enc, e2ee, dec]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleStar(m: Message) {
    const on = !starredIds.has(m.id);
    setDel(null);
    setStarredIds(prev => { const n = new Set(prev); if (on) n.add(m.id); else n.delete(m.id); return n; });
    try { await api(`/messages/${m.id}/star`, { body: { on } }); } catch { setStarredIds(prev => { const n = new Set(prev); if (on) n.delete(m.id); else n.add(m.id); return n; }); }
  }

  /**
   * What may be passed on: text, and now a photo, video, document or voice note (the server copies the stored bytes
   * into the other chat, so nothing is uploaded again). A poll, a live location, a view-once file and a message
   * deleted or still on its way stay where they are. In an encrypted chat the forward happens on this device, which
   * can re-encrypt text and cards but not files, so there it is text only.
   */
  const canForward = (m: Message) => !m.deleted && !m.poll && !m.viewOnce && !m.pending && m.id > 0
    && (m.kind === 'text' || m.kind === 'voice')
    && (!m.card || m.card.type === 'link' || enc)
    && (!enc || (m.kind === 'text' && !m.attachments?.length));

  const togglePick = (id: number) => setChosen(p => { const n = new Set(p ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** Forward everything chosen, one after another, into the chats the picker returns. */
  async function forwardPicked(targets: number[]) {
    const list = chosenMsgs.filter(canForward);
    setChosen(null); setFwd(null); setFwdPick([]);
    try {
      for (const m of list) await api(`/messages/${m.id}/forward`, { body: { circles: targets } });
      setError('');
      if (targets.includes(circle.id)) refresh().catch(() => {});
    } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }
  /** Delete everything chosen that I may delete: for me always, for everyone where the window allows it. */
  async function deletePicked(everyone: boolean) {
    const list = chosenMsgs.filter(m => (everyone ? canDeleteForEveryone(m) : !m.deleted));
    setChosen(null);
    try {
      for (const m of list) {
        if (everyone && enc && e2ee) await e2ee.remove(circle.id, m.id);
        else await api(`/messages/${m.id}${everyone ? '' : '/hide'}`, everyone ? { method: 'DELETE' } : { body: {} });
      }
      setError(''); refresh().catch(() => {});
    } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }
  /** Star (or unstar) everything chosen: one tap for a whole conversation's worth of keepers. */
  async function starPicked(on: boolean) {
    const list = chosenMsgs.filter(m => !m.deleted);
    setChosen(null);
    setStarredIds(prev => { const n = new Set(prev); for (const m of list) { if (on) n.add(m.id); else n.delete(m.id); } return n; });
    for (const m of list) await api(`/messages/${m.id}/star`, { body: { on } }).catch(() => {});
  }

  async function openForward(m: Message) {
    setDel(null); setFwd(m); setFwdPick([]);
    api<Array<{ id: number; name: string; locked?: boolean; encrypted?: boolean }>>('/circles').then(l => setFwdTargets(l.filter(c => !c.locked && (enc ? !!c.encrypted : !c.encrypted)))).catch(() => setFwdTargets([]));
  }
  async function doForward() {
    if (!fwd || !fwdPick.length) return;
    const m = fwd; setFwd(null);
    if (enc && e2ee) {   // forwarding from an encrypted chat is done here: decrypt (already done), encrypt again for each chosen encrypted chat. Text and cards only.
      try { for (const to of fwdPick) await e2ee.sendText(to, m.body, { ...(m.card && m.card.type !== 'link' ? { card: m.card } : {}) }); setError(''); if (fwdPick.includes(circle.id)) refresh().catch(() => {}); }
      catch (err) { setError(encFail(err)); }
      return;
    }
    try { await api(`/messages/${m.id}/forward`, { body: { circles: fwdPick } }); setError(''); if (fwdPick.includes(circle.id)) refresh().catch(() => {}); }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  // While recording a voice note the others see "recording audio…": a frame every 2.5 s, and "stopped" the moment it ends or is cancelled.
  useEffect(() => {
    if (!recording) return;
    const tell = () => live.send({ t: 'typing', circle: circle.id, on: true, kind: 'voice' });
    tell();
    const i = setInterval(tell, 2500);
    return () => { clearInterval(i); live.send({ t: 'typing', circle: circle.id, on: false, kind: 'voice' }); };
  }, [recording, circle.id]);

  // Tell the server how far we have read, whenever the chat is on screen and something newer arrived.
  useEffect(() => {
    if (requestOpen) return;   // a request not yet accepted is not "read" (the server ignores it too)
    const top = Math.max(0, ...msgs.map(m => m.seq ?? 0));
    if (top <= reportedRead.current || document.hidden) return;
    reportedRead.current = top;
    if (!live.send({ t: 'read', circle: circle.id, seq: top })) api(`/circles/${circle.id}/read`, { body: { seq: top } }).catch(() => { reportedRead.current = 0; });
  }, [msgs, circle.id, requestOpen]);
  useEffect(() => {
    const on = () => { if (!document.hidden) { reportedRead.current = 0; setMsgs(m => [...m]); } };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  // New messages keep the view at the bottom. An older page added at the top must NOT: the person stays exactly where they were reading.
  useLayoutEffect(() => {
    const el = wall.current;
    // Set the position outright (where it was + how much taller the list became): some browsers already shift it by themselves and some do not.
    if (anchor.current && el) { el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height); anchor.current = null; return; }
    // Someone reading older messages is left where they are; only a person already at the bottom follows the conversation down.
    if (nearBottom.current) toBottom(false);
  }, [msgs.length, waiting.length, uploads.length]);
  /** Scrolling up: fetch the 50 messages before the oldest one this screen has loaded. */
  const loadOlder = useCallback(async () => {
    if (olderRef.current !== 'idle') return;
    const before = oldestLoaded.current;
    if (before <= 1) { setOlder('end'); return; }
    setOlder('loading');
    try {
      const rows = await api<Message[]>(`/circles/${circle.id}/messages?before_seq=${before}&limit=${PAGE}`);
      const page = await dec(rows);
      if (oldestLoaded.current !== before) return;   // the list was reloaded meanwhile: this page belongs to the old one
      const whole = rows.length < PAGE;
      oldestLoaded.current = whole ? 0 : Math.min(...rows.map(m => m.seq ?? Infinity));
      if (page.length) { const el = wall.current; anchor.current = el ? { top: el.scrollTop, height: el.scrollHeight } : null; merge(page); }
      setOlder(whole ? 'end' : 'idle');
    } catch { setOlder('idle'); }   // offline: tried again on the next scroll
  }, [circle.id, merge, setOlder, dec]);
  const onWallScroll = (el: HTMLDivElement) => {
    nearBottom.current = Date.now() < followUntil.current || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    setAtBottom(nearBottom.current);
    if (el.scrollTop < 120) loadOlder();
  };
  // A photo that finishes decoding, or a bubble that rewraps, grows the thread after the
  // scroll has already run. Watching the content keeps the latest message in view instead
  // of leaving it hidden behind the composer.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (nearBottom.current && !anchor.current) toBottom(false); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const encDraft = useRef<{ body: string; reply: number | null; cid: string } | null>(null);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    // Your own message always brings you back down, even if you had scrolled up.
    follow(); setAtBottom(true);
    const body = text.trim(); if (!body) return;
    setError('');
    if (editing) {   // saving an edit: the text goes back to the same message
      const target = editing;
      setText(''); setEditing(null);
      try { if (enc && e2ee) { await e2ee.edit(circle.id, target.id, body); await refresh(); } else await api(`/messages/${target.id}`, { method: 'PATCH', body: { body } }); }
      catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
      return;
    }
    const quote = replyTo;
    setText(''); setReplyTo(null);
    if (enc && e2ee) {   // an encrypted chat: encrypted here, sent now (no readable copy waits in the outbox)
      setEncBusy(true);
      // The same words sent again after a failure keep the same id, so a message the server already holds is never made twice (the device keeps the very same ciphertext for it).
      const draft = encDraft.current && encDraft.current.body === body && encDraft.current.reply === (quote?.id ?? null) ? encDraft.current : { body, reply: quote?.id ?? null, cid: crypto.randomUUID() };
      encDraft.current = draft;
      let sent = false;
      try {
        const f = linkPreview.found && body.includes(linkPreview.found.asked) ? linkPreview.found : null;
        await e2ee.sendText(circle.id, body, {
          cid: draft.cid,
          replyTo: quote?.id ?? null, mentions: circle.kind === 'direct' ? [] : mentionedIds(body, circle.members.filter(x => x.id !== me.id)),
          ...(f ? { card: { type: 'link' as const, url: f.url, title: f.title, description: f.description, site: f.site, image: null } } : {}),   // made on this device; no picture (it would be fetched from a third party)
        });
        sent = true; encDraft.current = null;
        follow();
      } catch (err) { setText(body); setError(encFail(err)); }
      finally { setEncBusy(false); }
      // Sent is sent: if showing it fails, the live frame or the next poll shows it. The words must not come back into the box to be sent a second time.
      if (sent) await refresh().catch(() => {});
      return;
    }
    // Into the outbox (saved on this device) and on screen at once; the app's sender takes it from there, now or when the connection returns.
    box.add({
      cid: crypto.randomUUID(), circle: circle.id, body, replyTo: quote?.id ?? null, at: Date.now(),
      mentions: circle.kind === 'direct' ? [] : mentionedIds(body, circle.members.filter(x => x.id !== me.id)),
      preview: linkPreview.found && body.includes(linkPreview.found.asked) ? linkPreview.found.asked : undefined,
      quote: quote ? { id: quote.id, author: quote.author, kind: quote.kind, text: (quote.kind === 'voice' ? quote.transcript : quote.body)?.slice(0, 120) ?? '' } : undefined,
    });
    follow();   // you just wrote: follow your own message
    turnBox(n => n + 1);
    sender.kick();
  }

  // Photos, videos and files: chosen, shown in the sheet (caption, quality, remove), then handed to the media outbox, which uploads
  // them in pieces with progress and makes the message only when everything has arrived.
  function pick(files: FileList | File[] | null) {
    const list = files ? [...files] : [];
    if (fileInput.current) fileInput.current.value = '';
    if (list.length) { setError(''); setAttachMenu(false); setPicked(list); }
  }
  async function sendFilesEncrypted(files: UploadFile[], caption: string, viewOnce: boolean, quote: Message | null) {
    setEncBusy(true);
    try {
      const plain = await Promise.all(files.map(async f => ({ bytes: new Uint8Array(await f.blob.arrayBuffer()), name: f.name, mime: f.type || 'application/octet-stream', w: f.w, h: f.h, thumb: await thumbUrl(f.thumb) })));
      await e2ee!.sendMedia(circle.id, plain, viewOnce ? '' : caption, { replyTo: quote?.id ?? null, viewOnce });
      follow(); await refresh();
    } catch (err) { setError(encFail(err)); } finally { setEncBusy(false); }
  }
  function sendFiles(files: UploadFile[], caption: string, viewOnce = false) {
    const quote = replyTo;
    setPicked(null); setText(''); setReplyTo(null);
    follow();
    if (enc && e2ee) { sendFilesEncrypted(files, caption, viewOnce, quote); return; }
    uploader.add({ cid: crypto.randomUUID(), circle: circle.id, at: Date.now(), kind: 'files', caption, replyTo: quote?.id ?? null, files, ...(viewOnce ? { viewOnce: true } : {}) });
  }
  // A finished recording goes to the same outbox: it is on the device until the server has it, whatever the network does.
  function sendVoice(r: Recorded) {
    const quote = replyTo; setReplyTo(null);
    follow();
    if (enc && e2ee) {
      setEncBusy(true);
      r.blob.arrayBuffer().then(b => e2ee.sendVoice(circle.id, { bytes: new Uint8Array(b), mime: r.blob.type || 'audio/webm' }, r.ms, r.waveform, { replyTo: quote?.id ?? null, viewOnce: onceVoice }))
        .then(() => refresh()).catch(err => setError(encFail(err))).finally(() => { setEncBusy(false); setOnceVoice(false); });
      return;
    }
    uploader.add({
      cid: crypto.randomUUID(), circle: circle.id, at: Date.now(), kind: 'voice', caption: '', replyTo: quote?.id ?? null,
      files: [{ name: 'voice', type: r.blob.type || 'audio/webm', size: r.blob.size, blob: r.blob, thumb: null, w: null, h: null }],
      voice: { durationMs: r.ms, waveform: r.waveform, transcript: r.transcript }, ...(onceVoice ? { viewOnce: true } : {}),
    });
    setOnceVoice(false);
  }
  // A contact, a location, a sticker or a GIF: one request, with an id so that a retry is never a second message.
  async function sendCard(card: Record<string, unknown>) {
    const quote = replyTo;
    setSharing(null); setError(''); setReplyTo(null);
    if (enc && e2ee) {
      if (card.type === 'gif') { setError(t.e2ee.noGif); return; }
      setEncBusy(true);
      try { await e2ee.sendText(circle.id, '', { replyTo: quote?.id ?? null, card: card as any }); follow(); await refresh(); }
      catch (err) { setError(encFail(err)); } finally { setEncBusy(false); }
      return;
    }
    try { await api(`/circles/${circle.id}/cards`, { body: { ...card, client_msg_id: crypto.randomUUID(), reply_to: quote?.id ?? null } }); follow(); await refresh(); }
    catch (err) { fail(err instanceof ApiError ? err.code : 'generic'); }
  }

  /**
   * Live location. Not in an encrypted chat: the server holds the one card and overwrites it as the person moves, and
   * it cannot do that to something it cannot read. The button is simply not offered there.
   */
  async function sendLive(fix: { lat: number; lng: number; accuracy: number }, minutes: number) {
    setSharing(null); setError('');
    try {
      const r = await api<{ id: number }>(`/circles/${circle.id}/cards`, { body: { type: 'live', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, minutes, client_msg_id: crypto.randomUUID() } });
      beginShare(r.id, circle.id, Date.now() + minutes * 60_000);
      follow(); await refresh();
    } catch (err) { fail(err instanceof ApiError ? err.code : 'generic'); }
  }

  // "Typing…" to the others: at most one frame every 2.5 s while keys are pressed.
  function typed(value: string, at = value.length) {
    setText(value); setCaret(at);
    if (value && Date.now() - lastTypingSent.current > 2500) { lastTypingSent.current = Date.now(); live.send({ t: 'typing', circle: circle.id, on: true, kind: 'text' }); }
  }

  async function react(m: Message, emoji: string) {
    setDel(null);
    try {
      if (enc && e2ee) {   // a control message: the emoji is inside the ciphertext. The same emoji again takes it back.
        const mineNow = m.reactions?.find(r => r.u === me.id)?.e;
        await e2ee.react(circle.id, m.id, mineNow === emoji ? null : emoji); await refresh();
      } else await api(`/messages/${m.id}/react`, { body: { emoji } });
    }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  // "@": while a name is being typed, the members that match it (never in a one-to-one chat, never while editing).
  const asking = circle.kind !== 'direct' && !editing ? mentionQuery(text, caret) : null;
  const picker = asking ? circle.members.filter(x => x.id !== me.id && x.name.toLowerCase().includes(asking.query.toLowerCase())).slice(0, 8) : [];
  function choose(name: string) {
    if (!asking) return;
    const next = pickMention(text, caret, asking.start, name);
    typed(next.text, next.caret);
    requestAnimationFrame(() => { box2.current?.focus(); box2.current?.setSelectionRange(next.caret, next.caret); });
  }
  // *bold*, _italic_, ~strike~, `code`: the bar (or Ctrl/Cmd+B / I) wraps the selected words in the marker, and takes it off again.
  function format(style: Style) {
    const el = box2.current; if (!el) return;
    const r = toggleMark(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, style);
    if (r.text === text && r.start === r.end) return;
    typed(r.text, r.end); setCaret(r.start); setSelEnd(r.end);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end); });
  }
  // The box grows with what is written, up to about six lines, then scrolls.
  useLayoutEffect(() => {
    const el = box2.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);
  // Enter sends and Shift+Enter starts a new line on a keyboard; on a phone's keyboard Enter is a new line (the send button sends).
  function composerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); format('b'); return; }
    if (mod && !e.shiftKey && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); format('i'); return; }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      if (picker.length && asking) { choose(picker[0].name); return; }   // a name is being picked: Enter takes the first match
      e.currentTarget.form?.requestSubmit();
    }
  }
  const selecting = selEnd > caret && !!text.slice(caret, selEnd).trim();

  const canEdit = (m: Message) => m.userId === me.id && m.kind === 'text' && !m.deleted && !m.poll && (!m.card || m.card.type === 'link') && Date.now() - toDate(m.createdAt).getTime() < 15 * 60_000;

  // Ticks, from the members' marks: sent < delivered to everyone else < read by everyone else (only counts reads that are shared).
  const others = marks.filter(x => x.id !== me.id);
  const tick = (m: Message) => tickOf(m, others);
  const typing = typingLabel(typersOf(circle.id), t, circle.kind !== 'direct');
  // A link being written gets a preview card (asked from the server after a pause in typing), unless previews are off or an edit is open.
  const previewsOn = prefOn('previews');
  const linkPreview = useLinkPreview(editing || enc ? null : firstLink(text), previewsOn);
  /** One line that stands for a message where its full bubble is not drawn (a quoted reply, the pinned bar). */
  const lineOf = (m: Pick<Message, 'kind' | 'body' | 'transcript'> & { card?: { type: string } | string | null; attachments?: Attachment[] }) => {
    const type = typeof m.card === 'string' ? m.card : m.card?.type;
    if (type && type !== 'link') return cardWord(type, t);
    if (m.kind === 'voice') return m.transcript || <span className="inline-flex items-center gap-1"><Icon name="mic" className="w-3.5 h-3.5" />{t.voiceWord}</span>;
    return (m.body && plainText(m.body)) || (m.attachments?.length ? <span className="inline-flex items-center gap-1"><Icon name="attach" className="w-3.5 h-3.5" />{m.attachments[0].name ?? ''}</span> : '');
  };
  /** Text with its links as links (opened in a new tab, telling the site nothing about where the click came from). */
  const linked = (text: string, key = 0) => splitLinks(text).map((part, i) => part.href
    ? <a key={`${key}-${i}`} href={part.href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2 break-all">{part.text}</a> : part.text);
  // Jumping to a message scrolls it to the middle and flashes a ring round it, so after
  // the gallery or a search result closes you can see where you landed.
  // Opened from a reminder, a notification or a search result: show that message once it is on screen. A result can be
  // far older than the page that loads with the chat, so older pages are fetched, one at a time, until it is there —
  // up to HUNT_PAGES of them, after which the jump is dropped rather than dragging in years of history.
  const hunted = useRef(0);
  useEffect(() => { hunted.current = 0; }, [circle.id]);
  useEffect(() => {
    let want = 0; try { want = Number(sessionStorage.getItem(JUMP_KEY)) || 0; } catch { /* no jump */ }
    if (!want) return;
    const drop = () => { try { sessionStorage.removeItem(JUMP_KEY); } catch { /* fine */ } };
    if (msgs.some(m => m.id === want)) { drop(); hunted.current = 0; requestAnimationFrame(() => jumpTo(want)); return; }
    if (!loaded || olderRef.current === 'loading') return;
    if (olderRef.current === 'end' || hunted.current >= HUNT_PAGES) { drop(); return; }   // the chat begins above it, or it is too far back
    hunted.current++;
    loadOlder();
  }, [msgs, loaded, loadOlder, circle.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const jumpTo = (id: number) => {
    const el = document.getElementById(`m${id}`);
    if (!el) return;
    // Reading something older: stop following the newest message, or the next arrival (or the next render) pulls the
    // view straight back down and the jump looks as if it never happened.
    nearBottom.current = false; followUntil.current = 0; setAtBottom(false);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  };

  // Every photo of the chat loaded so far, oldest first: the viewer moves through them like an album (MED-03 gallery swipe).
  // View-once, deleted and expired messages stay out; so does anything still uploading.
  const { photos, photoMessage } = useMemo(() => {
    const items: ViewerItem[] = [], owner = new Map<number, number>();
    for (const m of msgs) {
      if (m.deleted || m.viewOnce || m.expired || m.pending || !m.attachments?.length) continue;
      const when = toDate(m.createdAt).toLocaleString(intlLocale(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      for (const x of m.attachments) {
        if (x.kind !== 'image') continue;
        items.push({ key: x.id, kind: 'image', att: x, alt: x.name ?? '', name: x.name ?? 'photo.jpg', caption: `${m.userId === me.id ? t.youLabel : m.author ?? ''} · ${when}` });
        owner.set(x.id, m.id);
      }
    }
    return { photos: items, photoMessage: owner };
  }, [msgs, lang, me.id, t]);
  const closeLight = useCallback(() => setLight(null), []);

  // As in WhatsApp: the sender can delete for everyone for a limited time, a manager at any time.
  // Two days for a sender, a week for the circle's owner and admins (same rule as the server).
  const canDeleteForEveryone = (m: Message) => { if (m.sealedOn) return m.userId === me.id; const age = Date.now() - toDate(m.createdAt).getTime(); return manager ? age < 7 * 24 * 3600_000 : m.userId === me.id && age < 48 * 3600_000; };

  async function deleteForEveryone(m: Message) {
    setDel(null);
    try { if (enc && e2ee) await e2ee.remove(circle.id, m.id); else await api(`/messages/${m.id}`, { method: 'DELETE' }); await refresh(true); loadPins(); }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  async function deleteForMe(m: Message) {
    setDel(null);
    try { await api(`/messages/${m.id}/hide`, { method: 'POST', body: {} }); setMsgs(prev => prev.filter(x => x.id !== m.id)); }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  async function archiveManually(m: Message) {
    try { await api(`/messages/${m.id}/archive`, { method: 'POST' }); await refresh(true); }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  const badge = (m: Message) => {
    const map: Record<string, [string, string]> = {
      archived: [t.archivedBadge, 'bg-green-soft text-green'],
      // «not archived» and «rejected» are the agent's private bookkeeping: shown on every bubble they made the chat noisy
      // (owner's calm rule). The reason stays reachable from the message menu.
      pending_transcript: [t.pendingBadge, 'bg-gold/15 text-gold-dark'],
    };
    return map[m.archiveStatus];
  };

  // What is drawn: the messages, then those still in the outbox, without the ones whose time ran out, with the device's notices slotted in.
  const thread = withNotices([...msgs, ...waiting].filter(m => !m.expired && !(m.expiresAt && toDate(m.expiresAt).getTime() <= clock)), notices);
  const chosenMsgs = chosen ? thread.filter(m => chosen.has(m.id)) : [];

  // Where the "unread messages" line goes, and how many sit below it. Only other people's messages count: your own,
  // and the chat's own notices, are not news to you.
  const { id: unreadId, count: unreadCount } = requestOpen ? { id: 0, count: 0 } : unreadMark(thread, unreadFrom, me.id);
  // Opening a chat with unread messages lands on the line, not at the newest message: the person reads on from where
  // they stopped. Once per chat; scrolling or a new message takes over from there.
  useEffect(() => {
    if (!unreadId || jumpedUnread.current === circle.id) return;
    jumpedUnread.current = circle.id;
    requestAnimationFrame(() => {
      const line = wall.current?.querySelector('[data-unread-line]');
      if (!line) return;
      nearBottom.current = false; followUntil.current = 0; setAtBottom(false);
      line.scrollIntoView({ block: 'center' });
    });
  }, [unreadId, circle.id]);

  return (
    <div className="chat-root flex flex-col h-full">
      {/* The search / starred / media tools now live in the header, beside the name. */}
      {pins.length > 0 && (() => { const p = pins[Math.min(pinIdx, pins.length - 1)]; return (
        <button type="button" className="flex items-center gap-2 w-full text-start rounded-lg bg-gold/15 text-ink px-3 py-1.5 mb-2 text-sm"
          onClick={() => { jumpTo(p.id); setPinIdx(i => (i + 1) % pins.length); }}>
          <Icon name="pin" className="w-4 h-4 shrink-0" />
          <span className="min-w-0 flex-1"><b className="text-xs text-gold-dark">{t.pinnedLabel}{pins.length > 1 ? ` ${Math.min(pinIdx, pins.length - 1) + 1}/${pins.length}` : ''}</b>
            <span className="block truncate">{lineOf(p)}</span></span>
        </button>
      ); })()}
      {/* Media is a gallery, not a strip wedged above the conversation. Picking a photo
          closes the gallery and scrolls the chat to the message it came from. */}
      {panel === 'media' && (
        <Dialog onClose={() => setPanel(null)} label={t.media}>
          <h2 className="text-lg font-bold mb-3">{t.media}</h2>
          {gallery.length === 0
            ? <p className="text-sm text-muted py-6 text-center">{t.noResults}</p>
            : (
              <ul className="grid grid-cols-3 gap-1.5 max-h-[60vh] overflow-y-auto">
                {gallery.map(g => (
                  <li key={g.id}>
                    {g.kind === 'file'
                      ? <a className="flex flex-col justify-center h-full p-2 rounded-lg border border-line text-xs break-words hover:bg-green-soft" href={`/api/media/${g.id}`} download={g.name ?? 'file'}>
                          <span className="flex items-center gap-1"><Icon name="file" className="w-3.5 h-3.5 shrink-0" />{g.name}</span>
                          <span className="block text-muted">{fmtSize(g.size)}</span>
                        </a>
                      : <button type="button" title={g.name ?? ''} className="block w-full aspect-square overflow-hidden rounded-lg bg-line hover:opacity-90 transition-opacity duration-[var(--dur-instant)]"
                          onClick={() => { setPanel(null); setTimeout(() => jumpTo(g.messageId), 120); }}>
                          <img alt={g.name ?? ''} loading="lazy" decoding="async" className="w-full h-full object-cover" {...sharpSrc(g, '(min-width: 1024px) 12vw, 33vw')} />
                        </button>}
                  </li>
                ))}
              </ul>
            )}
          <button className="btn btn-ghost w-full mt-3" onClick={() => setPanel(null)}>{t.closePanel}</button>
        </Dialog>
      )}

      {panel && panel !== 'media' && (
        <div className="card p-3 mb-2 max-h-72 overflow-y-auto">
          {panel === 'search' && <input autoFocus className="field mb-2" value={query} placeholder={t.searchPlaceholder} onChange={e => setQuery(e.target.value)} />}
          {results.length === 0 ? <p className="text-sm text-muted">{panel === 'search' && query.trim().length < 2 ? '' : t.noResults}</p> : (
            <ul className="divide-y divide-line">
              {results.map(r => (
                <li key={r.id}>
                  <button className="row-interactive w-full text-start py-2 px-1 rounded-lg" onClick={() => { setPanel(null); setTimeout(() => jumpTo(r.id), 120); }}>
                    <span className="text-xs text-muted">{r.author} · {toDate(r.createdAt).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    <span className="block whitespace-pre-wrap break-words">{r.kind === 'voice' ? r.transcript : plainText(r.body ?? '')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {inPick && (
        <div className="flex flex-wrap items-center gap-2 mb-2 p-2 rounded-2xl bg-card border border-line elevated-1 animate-slide-up">
          <b className="text-sm">{chosen!.size ? t.pick.count.replace('{n}', String(chosen!.size)) : t.pick.none}</b>
          <span className="flex-1" />
          <button type="button" className="btn btn-ghost !py-1 text-sm" disabled={!chosenMsgs.some(canForward)}
            onClick={() => { setFwd(chosenMsgs.find(canForward) ?? null); setFwdPick([]); api<Array<{ id: number; name: string; locked?: boolean; encrypted?: boolean }>>('/circles').then(l => setFwdTargets(l.filter(c => !c.locked && (enc ? !!c.encrypted : !c.encrypted)))).catch(() => setFwdTargets([])); }}>
            <Icon name="forward" className="w-4 h-4" />{t.pick.forward}
          </button>
          <button type="button" className="btn btn-ghost !py-1 text-sm" disabled={!chosen!.size} onClick={() => starPicked(!chosenMsgs.every(m => starredIds.has(m.id)))}>
            <Icon name="star" className="w-4 h-4" />{chosenMsgs.length && chosenMsgs.every(m => starredIds.has(m.id)) ? t.pick.unstar : t.pick.star}
          </button>
          <button type="button" className="btn btn-ghost !py-1 text-sm" disabled={!chosen!.size} onClick={() => deletePicked(false)}>
            <Icon name="trash" className="w-4 h-4" />{t.pick.delMe}
          </button>
          {chosenMsgs.some(canDeleteForEveryone) && (
            <button type="button" className="btn btn-ghost !py-1 text-sm !text-danger" onClick={() => { if (confirm(t.deleteForEveryone)) deletePicked(true); }}>
              <Icon name="trash" className="w-4 h-4" />{t.pick.delAll}
            </button>
          )}
          <button type="button" className="btn btn-ghost !py-1 text-sm" onClick={() => setChosen(null)}>{t.pick.cancel}</button>
        </div>
      )}
      <div ref={wall} data-chat-wall {...wallProps(circle.wallpaper)} className="chat-wall flex-1 overflow-y-auto pb-3" onScroll={e => onWallScroll(e.currentTarget)}
        onWheel={() => { followUntil.current = 0; }} onTouchMove={() => { followUntil.current = 0; }} onKeyDown={() => { followUntil.current = 0; }}>
        {/* Messages start at the top of the thread. (Bottom-anchoring was tried and
            reverted: on a tall desktop window it left a large void above a short chat.) */}
        <div ref={content} className="flex flex-col min-h-full">
        {older === 'loading' && (
          <p role="status" className="text-center text-xs text-muted py-2 flex items-center justify-center gap-2"><Spinner className="w-3.5 h-3.5" />{t.loadingOlder}</p>
        )}
        {/* An empty conversation was a large patterned void. Say what the space is for. */}
        {!loaded && thread.length === 0 && <MessagesSkeleton />}
        {loaded && thread.length === 0 && uploads.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 px-6 animate-fade-in">
            <span className="w-14 h-14 rounded-full bg-green-soft text-green flex items-center justify-center">
              <Icon name={enc ? 'lock' : 'chats'} className="w-7 h-7" />
            </span>
            <b className="text-green">{t.chatEmptyTitle}</b>
            <p className="text-sm text-muted max-w-xs">{t.chatEmptyBody}</p>
            {circle.kind === 'circle' && (
              <p className="text-caption text-muted max-w-xs flex items-center gap-1.5 mt-1">
                <Icon name="memory" className="w-3.5 h-3.5 shrink-0" />{t.chatEmptyCircle}
              </p>
            )}
          </div>
        )}
        {thread.map((m, i) => {
          // A notice this device wrote (a key change...). Pending outbox bubbles also have very low ids, so they are told apart by `pending`.
          if (m.id <= -1e9 && !m.pending) return <NoticeLine key={m.id} n={notices[-1e9 - m.id]} names={names} me={me.id} circle={circle.id} onCompare={() => setSafety(true)} />;
          if (m.undecryptable) return (
            <div key={m.id} id={`m${m.id}`} className={`flex mt-2 ${m.userId === me.id ? 'justify-end' : 'justify-start'}`}>
              <p className="rounded-2xl px-3 py-2 border border-dashed border-line text-muted text-sm max-w-[85%] flex items-center gap-1.5" title={m.waiting ? t.e2ee.waitingMsgWhy : t.e2ee.cantReadWhy}>
                <Icon name={m.waiting ? 'clock' : 'lock'} className="w-3.5 h-3.5 shrink-0" />{m.waiting ? t.e2ee.waitingMsg : t.e2ee.cantRead}
              </p>
            </div>
          );
          if (m.kind === 'system') return <p key={m.id} className="agent-note select-none text-center text-xs text-muted py-1.5 px-3 mx-auto w-fit max-w-full my-2 flex items-center gap-1.5"><Icon name="sparkle" className="w-3.5 h-3.5 shrink-0 text-gold-dark" />{systemText(m.body, t)}</p>;
          // (the day divider below needs `prev`, so it is computed after the system case)
          const mine = m.userId === me.id;
          // Consecutive messages from the same person within five minutes are one block:
          // the name is written once and the bubbles sit close, the way a conversation reads.
          const prev = thread[i - 1];
          const grouped = !!prev && prev.kind !== 'system' && prev.userId === m.userId && !prev.deleted && !m.deleted
            && toDate(m.createdAt).getTime() - toDate(prev.createdAt).getTime() < 5 * 60_000;
          const next = thread[i + 1];
          const lastOfGroup = !(next && next.kind !== 'system' && next.userId === m.userId && !next.deleted && !m.deleted
            && toDate(next.createdAt).getTime() - toDate(m.createdAt).getTime() < 5 * 60_000);
          const gap = grouped ? 'mt-0.5' : 'mt-3';
          // In a group or family circle, other people's messages carry their face: once, at the top of each block of
          // their messages (as in every group messenger); later bubbles of the block keep the same indent so they line up.
          const faces = circle.kind !== 'direct' && !mine;
          const who = faces ? memberById.get(m.userId ?? 0) : undefined;
          const face = faces && (grouped
            ? <span aria-hidden className="w-8 shrink-0" />
            : <button type="button" onClick={() => m.userId && openPerson(m.userId)} title={m.author ?? ''} aria-label={m.author ?? ''}
                className="self-start shrink-0 rounded-full transition-transform duration-[var(--dur-fast)] hover:scale-105">
                <PersonAvatar id={m.userId ?? 0} name={m.author ?? '?'} avatarAt={who?.avatarAt} className="w-8 h-8 text-sm" />
              </button>);
          // A new calendar day gets a divider, so scrolling back has landmarks.
          const newDay = !prev || toDate(prev.createdAt).toDateString() !== toDate(m.createdAt).toDateString();
          const unreadHere = m.id === unreadId;
          const withDay = (node: React.ReactNode) => newDay || unreadHere
            ? <Fragment key={`d${m.id}`}>{newDay && <DayDivider iso={m.createdAt} lang={lang} t={t} />}{unreadHere && <UnreadLine count={unreadCount} t={t} />}{node}</Fragment>
            : node;
          // The square corner is the tail: only the last bubble of a block has one, on the
          // side the bubble is anchored to. Logical corners, so it mirrors in Arabic.
          const tail = lastOfGroup ? (mine ? 'rounded-ee-md' : 'rounded-es-md') : '';
          if (!mine && m.userId && blockedIds.has(m.userId) && !shownBlocked.has(m.id)) {
            return withDay(
              <p key={m.id} id={`m${m.id}`} className="mx-auto my-1 w-fit max-w-full flex items-center gap-2 text-xs text-muted rounded-full border border-dashed border-line px-3 py-1">
                <Icon name="ban" className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{t.blockedMsg}</span>
                <button type="button" className="underline underline-offset-2 shrink-0"
                  onClick={() => setShownBlocked(p => new Set(p).add(m.id))}>{t.blockedShow}</button>
              </p>,
            );
          }
          if (m.deleted) {
            return withDay(
              <div key={m.id} id={`m${m.id}`} className={`flex gap-2 ${gap} ${mine ? 'justify-end' : 'justify-start'}`}>
                {face}
                <p className="rounded-2xl px-3 py-2 border border-dashed border-line text-muted italic text-sm flex items-center gap-1.5 select-none">
                  <Icon name="ban" className="w-3.5 h-3.5 shrink-0" />
                  {m.deletedBy === m.userId ? t.deletedMsg : t.deletedByManager}
                </p>
              </div>,
            );
          }
          const b = badge(m);
          // A voice note's machine transcript is a tool, not part of the message: shown only when asked for.
          const voiceCard = !m.viewOnce && m.kind === 'voice' && !!m.hasAudio;   // a voice note draws its own card, with its text inside it
          const whole = m.viewOnce ? '' : m.kind === 'voice' ? (voiceCard ? '' : transcribed.has(m.id) ? m.transcript : '') : m.body;
          const folded = (m.forwardCount ?? 0) >= MANY_TIMES && !openChains.has(m.id) && (whole?.length ?? 0) > CHAIN_CHARS;
          const shown = folded ? `${whole!.slice(0, CHAIN_CHARS).trimEnd()}…` : whole;
          // The controls live beside the bubble, never on top of it: floating them inside
          // covered the author's name and the start of the text.
          const actions = !m.pending && (
            <span className="self-center flex items-center gap-0.5 shrink-0 px-1 text-muted opacity-0
              group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity duration-[var(--dur-instant)]">
              <button onClick={() => setReacting(m)} aria-label={t.react} title={t.react}
                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-green-soft hover:text-green">
                <Icon name="smile" className="w-4 h-4" />
              </button>
              <button onClick={() => setDel(m)} aria-label={t.messageMenu} title={t.messageMenu}
                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-green-soft hover:text-green">
                <Icon name="chevron" className="w-4 h-4" />
              </button>
            </span>
          );
          const media = !m.viewOnce && !!m.attachments?.some(x => x.kind === 'image' || x.kind === 'video');
          // A sticker stands on its own, without a bubble round it (a bubble made it look like a pasted image).
          const bare = m.card?.type === 'sticker' && !m.replyTo && !m.forwardCount && !shown && !m.sealedOn;
          const pickable = inPick && !m.pending && m.id > 0 && !m.deleted;
          return withDay(
            <div key={m.id} id={`m${m.id}`} onClick={pickable ? () => togglePick(m.id) : undefined}
              className={`group/row flex gap-2 ${gap} animate-slide-up ${mine ? 'justify-end' : 'justify-start'} ${pickable ? 'cursor-pointer' : ''} ${chosen?.has(m.id) ? 'bg-green-soft/60 rounded-2xl' : ''}`}>
              {pickable && (
                <input type="checkbox" className="check self-center shrink-0" checked={chosen!.has(m.id)} aria-label={t.pick.one}
                  onChange={() => togglePick(m.id)} onClick={e => e.stopPropagation()} />
              )}
              {face}
              {mine && !inPick && actions}
              {/* A photo or video message has a fixed width, as in WhatsApp Web: across a wide desktop pane, 85% made a
                  single photo the size of the screen. Text keeps the flexible 85%. */}
              <div className={`group/msg relative ${media ? 'w-[min(80%,22rem)]' : voiceCard ? 'w-[min(88%,21.5rem)]' : 'max-w-[min(80%,36rem)]'} rounded-2xl ${tail} ${bare ? 'bubble-bare w-fit' : `${voiceCard ? 'px-3.5 pt-3 pb-2.5 !rounded-[1.25rem]' : 'px-3 py-2'} ${mine ? 'bubble-mine' : 'bubble-other'}`} ${m.pending ? 'opacity-60' : ''}
                transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)]`}>
                {!mine && !grouped && !bare && circle.kind !== 'direct' && <div className="text-[0.8rem] font-bold mb-0.5 leading-tight select-none" style={{ color: nameColour(m.userId ?? 0) }}>{m.author}</div>}
                {m.sealedOn && <div className={`text-[11px] mb-0.5 flex items-center gap-1 ${mine ? 'opacity-80' : 'text-gold-dark'}`}><Icon name="lock" className="w-3 h-3" />{t.sealedOnLabel} {m.sealedOn}</div>}
                {!!m.forwardCount && <div className={`text-[11px] italic mb-0.5 flex items-center gap-1 ${mine ? 'opacity-80' : 'text-muted'}`}><Icon name="forward" className="w-3 h-3" />{m.forwardCount >= 5 ? t.forwardedMany : t.forwarded}</div>}
                {m.replyTo && (
                  <button type="button" onClick={() => jumpTo(m.replyTo!.id)}
                    className={`block w-full text-start mb-1 rounded-lg border-s-4 px-2 py-1 text-xs ${mine ? 'bg-current/15 border-current/60' : 'bg-green-soft border-green'}`}>
                    <b className="block">{m.replyTo.author ?? ''}</b>
                    <span className="line-clamp-2">{m.replyTo.deleted
                      ? <span className="inline-flex items-center gap-1 italic"><Icon name="ban" className="w-3 h-3" />{t.quotedDeleted}</span>
                      : m.replyTo.text || cardWord(m.replyTo.card, t) || (m.replyTo.kind === 'voice' ? <span className="inline-flex items-center gap-1"><Icon name="mic" className="w-3 h-3" />{t.voiceWord}</span> : '')}</span>
                  </button>
                )}
                {m.viewOnce && <ViewOnceBubble m={m} mine={mine} meId={me.id} />}
                {!m.viewOnce && !!m.attachments?.length && (() => {
                  // A photo should reach the edge of its bubble; padding around it reads as a
                  // document attachment rather than an image someone sent.
                  const flush = (mine || grouped) && !m.replyTo && !m.sealedOn && !m.forwardCount
                    && m.attachments!.every(x => x.kind !== 'file');
                  return (
                  <div className={`${flush ? '-mx-3 -mt-2 mb-1.5 overflow-hidden rounded-t-2xl' : 'mb-1'} grid gap-1 ${m.attachments!.filter(x => x.kind !== 'file').length > 1 ? 'grid-cols-2' : ''}`}>
                    {m.attachments.map(x => x.kind === 'image' ? (
                      <button key={x.id} type="button" onClick={() => setLight(x.id)} className="relative block overflow-hidden rounded-lg bg-black/10"
                        style={x.w && x.h ? { aspectRatio: `${x.w} / ${x.h}`, maxHeight: '22rem' } : undefined}>
                        {enc ? <MediaImg att={x} thumb alt={x.name ?? ''} className="w-full h-full object-cover" />
                          : <img alt={x.name ?? ''} loading="lazy" decoding="async" className="w-full h-full object-cover" {...sharpSrc(x, '(min-width: 1024px) 22rem, 80vw')} />}
                        {m.card?.type === 'gif' && <span className="absolute bottom-1 start-1 rounded bg-black/60 text-white text-[10px] font-bold px-1" dir="ltr">GIF</span>}
                      </button>
                    ) : x.kind === 'video' ? (
                      <MediaVideo key={x.id} att={x} saver={prefOn('saver')} className="w-full rounded-lg max-h-96 bg-black" />
                    ) : (
                      <MediaFile key={x.id} att={x} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${mine ? 'bg-current/15' : 'bg-green-soft'}`}>
                        <Icon name="file" className="w-4 h-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{x.name}</span><span className="text-xs opacity-80">{fmtSize(x.size)}</span>
                      </MediaFile>
                    ))}
                  </div>
                  ); })()}
                {m.card?.type === 'link' && previewsOn && <LinkCard url={m.card.url} title={m.card.title} description={m.card.description} site={m.card.site} image={m.card.image && !m.encrypted ? `/api/media/${m.card.image}` : null} mine={mine} />}
                {m.card?.type === 'sticker' && <StickerView pack={m.card.pack} id={m.card.id} />}
                {m.card?.type === 'contact' && <ContactCard card={m.card} mine={mine} />}
                {m.card?.type === 'location' && <LocationCard card={m.card} mine={mine} />}
                {m.card?.type === 'live' && <LiveCard card={m.card} mine={mine} mid={m.id} onChanged={refresh} />}
                {(() => {
                  const starred = starredIds.has(m.id);
                  // The words: @mentions as buttons that open a private chat, links as links.
                  const words = (s: string) => m.mentions?.length
                    ? splitMentions(s, m.mentions).map((part, k) => part.id === undefined ? linked(part.text, k)
                      : <button key={k} type="button" className="font-bold underline underline-offset-2" onClick={() => openPerson(part.id!)}>{part.text}</button>)
                    : linked(s);
                  const meta = (
                    <span className={`inline-flex items-center gap-1 text-[11px] align-bottom select-none ${mine ? 'opacity-70' : 'text-muted'}`}>
                      {/* A star belongs beside the time, not floated into the text, where it
                          pushed the words around and forced the meta onto its own line. */}
                      {starred && <Icon name="star" className="w-3 h-3 shrink-0" aria-label={t.starred} />}
                      {remindedHere.has(m.id) && <Icon name="bell" className="w-3 h-3 shrink-0" aria-label={t.rem.has} />}
                      <span className="tabular-nums">{toDate(m.createdAt).toLocaleTimeString(intlLocale(lang), { hour: '2-digit', minute: '2-digit' })}</span>
                      {m.editedAt && <span>{t.edited}</span>}
                      {mine && !m.failed && <Ticks kind={tick(m)} t={t} />}
                    </span>
                  );
                  const failed = m.failed && (
                    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span role="status" className="text-danger font-bold inline-flex items-center gap-1"><Icon name="alert" className="w-3.5 h-3.5" />{t.sendFailed}</span>
                      <button onClick={() => { if (m.cid) { setError(''); sender.retry(m.cid); } }} className="text-danger underline">{t.retrySend}</button>
                      <button onClick={() => m.cid && sender.discard(m.cid)} className="underline opacity-80">{t.discardUnsent}</button>
                    </span>
                  );
                  // A plain text message carries its time and ticks on the last line, the way a
                  // chat app does it: an invisible spacer reserves the room, and the meta is
                  // placed in it. Anything richer (media, voice, a card, a poll, an edit, an agent
                  // badge) keeps the meta on its own row, where it does not have to fight for space.
                  if (voiceCard) return (
                    <VoiceMessage m={m} mine={mine} meId={me.id} others={others.length} meta={meta} canTranscribe={!m.encrypted}
                      open={transcribed.has(m.id)} onOpen={on => setTranscribed(p => { const n = new Set(p); if (on) n.add(m.id); else n.delete(m.id); return n; })}
                      after={failed && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{failed}</div>} />
                  );
                  const inline = !!shown && !folded && m.kind !== 'voice' && !m.attachments?.length && !m.editedAt && !b && !m.poll && !m.card && !m.failed && !m.viewOnce;
                  if (inline) return (
                    <p dir="auto" className="relative whitespace-pre-wrap break-words">
                      <Formatted text={shown} leaf={words} />
                      {/* The gap the meta sits in. It has to cover everything the meta can
                          contain — a star adds width, and too small a reservation means the
                          time lands on top of the text. */}
                      <span aria-hidden className="inline-block" style={{ width: `${(mine ? 4.6 : 3.2) + (starred ? 1 : 0) + (remindedHere.has(m.id) ? 1 : 0)}rem` }} />
                      <span className="absolute bottom-0 end-0 leading-none pb-[0.1rem]">{meta}</span>
                    </p>
                  );
                  // A sticker: its time and ticks on a small line just under it, at its edge (never on top of the picture).
                  if (bare) return <div className="mt-1 flex justify-end leading-none">{meta}</div>;
                  return (
                    <>
                      {shown && (
                        <p dir="auto" className={`whitespace-pre-wrap break-words ${m.kind === 'voice' ? 'text-sm opacity-75 mt-1.5 pt-1.5 border-t border-current/15' : ''} ${m.poll ? 'font-bold flex items-start gap-1.5' : ''}`}>
                          {m.poll && <Icon name="chart" className="w-4 h-4 mt-0.5 shrink-0" />}
                          <span><Formatted text={shown} leaf={words} /></span>
                        </p>
                      )}
                      {folded && (
                        <button type="button" className="text-xs underline underline-offset-2 opacity-80"
                          onClick={() => setOpenChains(p => new Set(p).add(m.id))}>{t.chainShow}</button>
                      )}
                      {m.poll && !m.deleted && <PollBubble m={m} meId={me.id} names={names} onError={fail} {...(enc && e2ee ? { onVote: (opts: number[]) => e2ee.vote(circle.id, m.id, opts).then(() => refresh()) } : {})} />}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {failed}
                        {meta}
                        {b && <button onClick={() => setOpen(open === m.id ? null : m.id)} className={`text-[11px] px-1.5 rounded-full ${b[1]}`}>{b[0]}</button>}
                      </div>
                    </>
                  );
                })()}

                {m.archiveStatus === 'archived' && circle.kind === 'circle' && (
                  <div className="agent-card mt-2 p-2 flex items-center gap-2">
                    <span className="agent-orb !w-8 !h-8 text-gold-dark" aria-hidden><Icon name="sparkle" className="w-4 h-4" /></span>
                    <span className="flex-1 text-sm text-ink"><b className="text-gold-dark">{t.agentCardTitle}</b> <span>{t.archivedBadge}</span></span>
                    <button type="button" className="btn !py-1 !px-2 text-xs" onClick={onOpenArchive}>{t.viewInArchive}</button>
                  </div>
                )}
                {!!m.reactions?.length && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(m.reactions.reduce<Record<string, number[]>>((acc, r) => ((acc[r.e] ??= []).push(r.u), acc), {})).map(([e, users]) => (
                      <button key={e} type="button" onClick={() => react(m, e)} aria-label={`${e} ${users.length}`}
                        className={`px-1.5 rounded-full text-xs border ${users.includes(me.id) ? 'bg-green-soft border-green text-green' : 'bg-card border-line text-ink'}`}>{e} {users.length > 1 ? users.length : ''}</button>
                    ))}
                  </div>
                )}
                {open === m.id && m.reason && (
                  <p className="mt-1 text-xs rounded-lg bg-black/5 text-ink p-2">
                    {t.score}: {m.score} · {m.category ? t.cat[m.category] : '—'}<br />{agentReason(m.reason)}
                  </p>
                )}
              </div>
              {!mine && !inPick && actions}
            </div>,
          );
        })}
        {uploads.map(job => <PendingUpload key={job.cid} job={job} uploader={uploader} error={code => t.errors[code] ?? t.errors.generic} />)}
        </div>
        <div ref={bottom} />
        {/* Scrolled up: a way back to the newest message, rather than silently missing it.
            Sticky inside the scroller so it floats above the conversation. */}
        {!atBottom && (
          <button type="button" onClick={() => toBottom()} aria-label={t.jumpToLatest} title={t.jumpToLatest}
            className="sticky bottom-2 float-end me-2 z-10 w-10 h-10 rounded-full bg-card border border-line elevated-2 text-green
              flex items-center justify-center animate-scale-in hover:bg-green-soft
              transition-colors duration-[var(--dur-instant)]">
            <Icon name="down" className="w-5 h-5" />
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-danger py-1">{error}</p>}
      {enc && encState !== 'ok' && <p role="status" className="text-xs rounded-lg bg-gold/15 text-ink p-2 mb-1">{encState === 'waiting' ? t.e2ee.waiting : encState === 'not_member' ? t.e2ee.notMember : encWhy === 'restored_behind' ? t.e2ee.behind : t.e2ee.stuck}{encState === 'stuck' && encWhy === 'restored_behind' && e2ee && <button type="button" className="btn !py-1 text-xs ms-2" onClick={() => { if (confirm(t.e2ee.startFreshConfirm)) e2ee.startFresh().catch(() => { alert(t.e2ee.startFreshFailed); }); }}>{t.e2ee.startFresh}</button>}</p>}
      {enc && circle.kind === 'direct' && notices.some(n => n.kind === 'gone') && <p role="status" className="text-xs rounded-lg bg-gold/15 text-ink p-2 mb-1">{t.e2ee.goneNote}</p>}
      {safety && <ChatSecuritySheet circle={circle} me={me} onClose={() => setSafety(false)} />}
      {encBusy && <p role="status" className="text-xs text-muted py-0.5">{t.e2ee.sending}</p>}
      {pinning && (
        <Dialog onClose={() => setPinning(null)} label={t.pinMessage}>
          <h2 className="text-lg font-bold">{t.pinMessage}</h2>
          <div className="mt-3 flex flex-col gap-2">
            {([[24, t.pin24], [168, t.pin7], [720, t.pin30]] as Array<[number, string]>).map(([h, label]) => (
              <button key={h} className="btn btn-ghost" onClick={async () => { const m = pinning; setPinning(null); try { await api(`/messages/${m.id}/pin`, { body: { hours: h } }); } catch { /* shown by the next refresh */ } loadPins(); }}>{label}</button>
            ))}
            <button className="btn btn-ghost" onClick={() => setPinning(null)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
      {reporting && (
        <Dialog onClose={() => setReporting(null)} label={t.reportTitle}>
          <h2 className="text-lg font-bold">{t.reportTitle}</h2>
          {reported ? <p role="status" className="mt-3">{t.reportSent}</p> : (
            <>
              <p className="text-sm text-muted mt-2">{t.reportNote}</p>
              <div className="mt-3 flex flex-col gap-2">
                {Object.entries(t.reportReasons).map(([k, label]) => (
                  <button key={k} className="btn btn-ghost" onClick={async () => {
                    try { await api(`/messages/${reporting.id}/report`, { body: { reason: k, ...(enc ? { snapshot: (reporting.body || '').slice(0, 1000) } : {}) } }); setReported(true); }
                    catch (err) { setReporting(null); setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
                  }}>{label}</button>
                ))}
              </div>
            </>
          )}
          <button className="btn btn-ghost w-full mt-3" onClick={() => setReporting(null)}>{reported ? t.closePanel : t.cancel}</button>
        </Dialog>
      )}
      {light !== null && (() => {
        const start = photos.findIndex(p => p.key === light);
        return start < 0 ? null : (
          <PhotoViewer items={photos} start={start} onClose={closeLight}
            actions={(item, close) => {
              const mid = photoMessage.get(Number(item.key));
              return mid ? <button type="button" className="h-11 px-4 rounded-full bg-white/10 text-white text-sm font-bold hover:bg-white/20 inline-flex items-center gap-2"
                onClick={() => { close(); setTimeout(() => jumpTo(mid), 60); }}><Icon name="chats" className="w-4 h-4" />{t.viewer.showInChat}</button> : null;
            }} />
        );
      })()}
      {fwd && (
        <Dialog onClose={() => setFwd(null)} label={t.forward}>
          <h2 className="text-lg font-bold">{t.forwardTo}</h2>
          {/* A chain message goes one chat at a time (the server holds the same line), so the picker allows one. */}
          {(fwd.forwardCount ?? 0) >= MANY_TIMES && <p className="mt-1 text-xs text-gold-dark bg-gold/15 rounded-lg p-2">{t.chainOne}</p>}
          <ul className="mt-3 space-y-1 max-h-64 overflow-y-auto">
            {fwdTargets.map(c => {
              const most = (fwd.forwardCount ?? 0) >= MANY_TIMES ? 1 : 5;
              return (
              <li key={c.id}>
                <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-green-soft">
                  <input type="checkbox" className="check" checked={fwdPick.includes(c.id)} disabled={!fwdPick.includes(c.id) && fwdPick.length >= most}
                    onChange={e => setFwdPick(p => e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id))} />
                  {c.name}
                </label>
              </li>
              );
            })}
          </ul>
          <div className="mt-4 flex gap-2">
            <button className="btn flex-1" disabled={!fwdPick.length} onClick={() => (inPick ? forwardPicked(fwdPick) : doForward())}>{t.forward}</button>
            <button className="btn btn-ghost flex-1" onClick={() => setFwd(null)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
      {typing && (
        <p aria-live="polite" className="text-xs text-muted py-0.5 flex items-center gap-1.5 animate-fade-in">
          <TypingDots />{typing}
        </p>
      )}
      {(replyTo || editing) && (
        <div className="flex items-center gap-2 rounded-lg bg-green-soft border-s-4 border-green px-3 py-1.5 text-xs mt-1">
          <span className="min-w-0 flex-1">
            <b className="block">{editing ? t.editingMsg : `${t.replyingTo} ${replyTo!.author ?? ''}`}</b>
            <span className="block truncate">{lineOf((editing ?? replyTo)!)}</span>
          </span>
          <button type="button" aria-label={t.cancel} className="px-2 text-base" onClick={() => { setReplyTo(null); setEditing(null); if (editing) setText(''); }}><Icon name="x" className="w-4 h-4" /></button>
        </div>
      )}
      {requestOpen ? (
        <RequestBar circle={circle} me={me} lastText={[...msgs].reverse().find(m => m.userId !== me.id && !m.deleted)?.body ?? ''}
          onAccepted={() => { setRequestOpen(false); window.dispatchEvent(new Event('thikra:chats')); }}
          onGone={() => { window.dispatchEvent(new Event('thikra:chats')); onLeave(); }} />
      ) : circle.sendPolicy === 'admins' && !manager ? (
        <p role="status" className="mt-2 text-center text-sm text-muted rounded-2xl bg-card border border-line py-3 px-4 flex items-center justify-center gap-2">
          <Icon name="lock" className="w-4 h-4 shrink-0" />{t.onlyAdminsSend}
        </p>
      ) : (
        <>
          {linkPreview.found && <LinkCard url={linkPreview.found.url} title={linkPreview.found.title} description={linkPreview.found.description} site={linkPreview.found.site}
            image={linkPreview.found.image ? `/api/link-preview/image/${linkPreview.found.image}` : null} onRemove={linkPreview.dismiss} />}
          {/* What opens above the message box floats over the conversation instead of pushing it up:
              the @mention list, the attach menu, and the stickers panel. */}
          <div ref={composerRef} className="relative pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="absolute bottom-full inset-x-0 mb-2 z-30 flex flex-col gap-2 pointer-events-none">
          {/* @mentions: the people of this group whose name matches what follows the @. */}
          {picker.length > 0 && (
            <ul role="listbox" aria-label="@" className="pointer-events-auto self-start w-[min(20rem,100%)] card elevated-3 p-1 max-h-56 overflow-y-auto animate-scale-in origin-bottom">
              {picker.map(x => (
                <li key={x.id}>
                  <button type="button" role="option" aria-selected={false} className="row-interactive w-full text-start px-2.5 py-2 rounded-xl flex items-center gap-2.5" onMouseDown={e => e.preventDefault()} onClick={() => choose(x.name)}>
                    <span className="w-8 h-8 rounded-full text-white text-sm font-bold flex items-center justify-center shrink-0" style={{ background: nameColour(x.id) }} aria-hidden>{[...x.name][0]}</span>
                    <span className="truncate font-medium">{x.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachMenu && (
            <ul role="menu" aria-label={t.attach} className="pointer-events-auto self-start card p-1.5 w-fit min-w-56 elevated-3 animate-scale-in origin-bottom-left rtl:origin-bottom-right">
              {([
                ['image', t.photosAndFiles, () => fileInput.current?.click()],
                ['you', t.shareContact, () => setSharing('contact')],
                ['location', t.shareLocation, () => setSharing('location')],
                ...(circle.kind !== 'direct' ? [['chart', t.newPoll, () => setPolling(true)] as const] : []),
              ] as const).map(([ic, label, go]) => (
                <li key={label}>
                  <button type="button" role="menuitem" className="row-interactive w-full text-start px-2.5 py-2 rounded-xl flex items-center gap-3"
                    onClick={() => { setAttachMenu(false); go(); }}>
                    <span className="w-9 h-9 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name={ic} className="w-[18px] h-[18px]" /></span>
                    <span className="font-medium">{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {sharing === 'panel' && <div className="pointer-events-auto self-end"><SharePanel onClose={() => setSharing(null)} onSticker={(pack, id) => sendCard({ type: 'sticker', pack, id })} onGif={id => (enc ? setError(t.e2ee.noGif) : sendCard({ type: 'gif', id }))} /></div>}
          </div>
          {/* One pill holding attach, the text, stickers and view-once, with the send or record
              button separate and round: the shape people already know from every chat app. */}
          <form onSubmit={send} className="relative flex items-end gap-2 pt-2">
            {/* The formatting bar: shown while words in the box are selected. */}
            {selecting && (
              <div data-fmt-bar role="toolbar" aria-label={t.fmtBar} className="absolute bottom-full mb-1 start-12 z-10 flex items-center gap-0.5 p-1 rounded-xl bg-card border border-line elevated-2 animate-fade-in">
                {([['b', t.fmtBold, 'font-bold', 'B'], ['i', t.fmtItalic, 'italic font-serif', 'I'], ['s', t.fmtStrike, 'line-through', 'S'], ['m', t.fmtCode, 'font-mono text-xs', '{ }']] as const).map(([k, label, cls, glyph]) => (
                  <button key={k} type="button" aria-label={label} title={label} onMouseDown={e => e.preventDefault()} onClick={() => format(k)}
                    className={`w-9 h-9 rounded-lg text-ink hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)] ${cls}`}>{glyph}</button>
                ))}
              </div>
            )}
            {text.length > MAX_TEXT - 500 && (
              <span role="status" className={`absolute -top-4 end-14 text-[11px] tabular-nums ${text.length >= MAX_TEXT ? 'text-danger font-bold' : 'text-muted'}`} dir="ltr">{text.length.toLocaleString()} / {MAX_TEXT.toLocaleString()}</span>
            )}
            <input ref={fileInput} type="file" multiple hidden accept="image/*,video/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx" onChange={e => pick(e.target.files)} />
            <div className="field-group !rounded-[1.375rem] flex-1 min-w-0 !items-end">
              <button type="button" className={`field-prefix !border-0 !px-3 h-11 self-end transition-colors duration-[var(--dur-instant)] ${attachMenu ? 'text-green' : 'text-muted hover:text-green'}`}
                aria-label={t.attach} title={t.attach} aria-expanded={attachMenu} onClick={() => { setSharing(null); setAttachMenu(v => !v); }}>
                <Icon name="attach" className="w-5 h-5" />
              </button>
              <textarea ref={box2} rows={1} dir="auto" className="!px-1 !py-2.5 min-w-0 resize-none leading-snug max-h-[168px] overflow-y-auto" value={text} maxLength={MAX_TEXT} placeholder={t.typeMessage}
                aria-label={t.typeMessage} title={t.fmtHint}
                onChange={e => { typed(e.target.value, e.target.selectionStart ?? e.target.value.length); setSelEnd(e.target.selectionEnd ?? e.target.value.length); }}
                onKeyDown={composerKey}
                onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); pick(files); } }}
                onSelect={e => { setCaret(e.currentTarget.selectionStart ?? 0); setSelEnd(e.currentTarget.selectionEnd ?? 0); }}
                onBlur={() => setTimeout(() => { if (document.activeElement !== box2.current && !document.activeElement?.closest('[data-fmt-bar]')) setSelEnd(0); }, 0)} />
              {!editing && (
                <button type="button" className={`px-2 self-end h-11 transition-colors duration-[var(--dur-instant)] ${sharing === 'panel' ? 'text-green' : 'text-muted hover:text-green'}`}
                  aria-label={t.stickersAndGifs} title={t.stickersAndGifs} aria-expanded={sharing === 'panel'}
                  onClick={() => { setAttachMenu(false); setSharing(v => (v === 'panel' ? null : 'panel')); }}>
                  <Icon name="sticker" className="w-5 h-5" />
                </button>
              )}
              {!text.trim() && !editing && !recording && (
                <button type="button" aria-pressed={onceVoice} aria-label={t.priv.viewOnceFor} title={`${t.priv.viewOnceFor}: ${t.priv.viewOnceVoice}`}
                  className={`pe-3 ps-1 self-end h-11 transition-colors duration-[var(--dur-instant)] ${onceVoice ? 'text-green' : 'text-muted hover:text-green'}`}
                  onClick={() => setOnceVoice(v => !v)}>
                  <Icon name="once" className="w-5 h-5" />
                </button>
              )}
            </div>
            {!text.trim() && !editing
              ? <VoiceRecorder circleId={circle.id} drafts={media.drafts} rtl={LANG_INFO[lang as Lang]?.rtl ?? false} lang={lang} onSend={sendVoice} onActive={setRecording} onError={setError} />
              : <button className="fab-accent w-11 h-11 rounded-full shrink-0 flex items-center justify-center animate-pop-in disabled:opacity-50" disabled={!text.trim()} aria-label={editing ? t.save : t.send} title={editing ? t.save : t.send}>
                  <Icon name={editing ? 'check' : 'send'} className="w-5 h-5 rtl:-scale-x-100" />
                </button>}
          </form>
          </div>
        </>
      )}
      {reminding && (
        <RemindSheet current={remindedHere.get(reminding.id)} onClose={() => setReminding(null)}
          onClear={() => { forgetReminder(me.id, `${circle.id}:${reminding.id}`); setReminding(null); }}
          onPick={at => { remind(me.id, { circleId: circle.id, messageId: reminding.id, chat: circle.name, at }); setReminding(null); }} />
      )}
      {reacting && <ReactionPicker t={t} onClose={() => setReacting(null)} onPick={e => { const m = reacting; setReacting(null); react(m, e); }} />}
      {picked && <SendSheet picked={picked} caption0={text.trim()} onClose={() => setPicked(null)} onSend={sendFiles} />}
      {sharing === 'contact' && <ContactSheet onClose={() => setSharing(null)} onSend={(name, phones) => sendCard({ type: 'contact', name, phones })} />}
      {sharing === 'location' && <LocationSheet onClose={() => setSharing(null)} onSend={(fix, label) => sendCard({ type: 'location', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, label })}
        {...(enc ? {} : { onSendLive: (fix, minutes) => sendLive(fix, minutes) })} />}
      {polling && <PollComposer circleId={circle.id} onClose={() => setPolling(false)} onError={fail} {...(enc && e2ee ? { onCreate: (q: string, o: string[], multiple: boolean) => e2ee.sendPoll(circle.id, q, o, multiple).then(() => refresh()) } : {})} />}
      {info && (
        <Dialog onClose={() => setInfo(null)} label={t.msgInfo}>
          <h2 className="text-lg font-bold mb-3">{t.msgInfo}</h2>
          {([[t.infoReadBy, info.readBy, 'check-double', true], [t.infoDeliveredTo, info.deliveredTo, 'check-double', false], [t.infoPending, info.pending, 'clock', false]] as const).map(([title, people, ic, read]) => people.length > 0 && (
            <section key={title} className="mb-3">
              <h3 className={`text-sm font-bold mb-1 flex items-center gap-1.5 ${read ? 'text-green' : 'text-muted'}`}><Icon name={ic} className="w-4 h-4" />{title}</h3>
              <ul className="space-y-0.5">
                {people.map(p => (
                  <li key={p.id} className="py-1.5 px-1 flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full text-white text-sm font-bold flex items-center justify-center shrink-0" style={{ background: nameColour(p.id) }} aria-hidden>{[...p.name][0]}</span>
                    <span className="flex-1 truncate">{p.name}</span>
                    {'at' in p && p.at && <time className="text-xs text-muted shrink-0 tabular-nums" dir="auto">{infoTime(p.at, lang)}</time>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <button className="btn btn-ghost w-full" onClick={() => setInfo(null)}>{t.close}</button>
        </Dialog>
      )}
      {del && (() => {
        // One row per action, each with its icon: scannable at a glance, the same shape as every other menu in the app.
        const row = (icon: Parameters<typeof Icon>[0]['name'], label: string, go: () => void, tone = '') => (
          <button key={label} className={`row-interactive w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-start ${tone}`} onClick={go}>
            <Icon name={icon} className="w-5 h-5 shrink-0" /><span className="flex-1 font-medium">{label}</span>
          </button>
        );
        const isPinned = pins.some(p => p.id === del.id);
        return (
        <Dialog onClose={() => setDel(null)} label={t.messageMenu}>
          <h2 className="text-lg font-bold">{t.messageMenu}</h2>
          {/* What is being acted on, so a long-press on the wrong bubble is noticed before anything happens. */}
          {!del.deleted && <p className="mt-2 text-sm text-muted line-clamp-2 rounded-xl bg-paper border border-line px-3 py-2">{lineOf(del)}</p>}
          <div className="mt-3 flex flex-col">
            {row('chats', t.reply, () => { setReplyTo(del); setEditing(null); setDel(null); requestAnimationFrame(() => box2.current?.focus()); })}
            {canEdit(del) && !del.sealedOn && row('pen', t.edit, () => { setEditing(del); setReplyTo(null); setText(del.body); setDel(null); requestAnimationFrame(() => box2.current?.focus()); })}
            {del.kind === 'voice' && !!del.transcript && row('file', transcribed.has(del.id) ? t.hideTranscript : t.showTranscript, () => { const id = del.id; setTranscribed(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setDel(null); })}
            {canForward(del) && row('forward', t.forward, () => openForward(del))}
            {!del.deleted && del.id > 0 && !del.pending && row('check-double', t.pick.start, () => { const m = del; setDel(null); setChosen(new Set([m.id])); })}
            {!del.deleted && row(starredIds.has(del.id) ? 'star-fill' : 'star', starredIds.has(del.id) ? t.unstar : t.star, () => toggleStar(del))}
            {!del.deleted && (isPinned
              ? row('pin', t.unpinMessage, async () => { const m = del; setDel(null); await api(`/messages/${m.id}/pin`, { method: 'DELETE' }).catch(() => {}); loadPins(); })
              : row('pin', t.pinMessage, () => { setPinning(del); setDel(null); }))}
            {!del.deleted && del.kind !== 'system' && !del.pending && del.id > 0 && row('bell', remindedHere.has(del.id) ? t.rem.at.replace('{when}', '\u2068' + new Date(remindedHere.get(del.id)!.at).toLocaleString(intlLocale(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '\u2069') : t.rem.title, () => { setReminding(del); setDel(null); })}
            {!del.deleted && del.userId === me.id && del.kind !== 'system' && !del.pending && row('check-double', t.msgInfo, () => { const m = del; setDel(null); openInfo(m); })}
            {!!circle.agentActive && !del.deleted && !!del.body && del.archiveStatus !== 'archived' && del.archiveStatus !== 'rejected' && row('memory', t.archiveThis, () => { const m = del; setDel(null); archiveManually(m); })}
            {del.userId !== me.id && del.kind !== 'system' && !del.deleted && row('alert', t.report, () => { setReporting(del); setReported(false); setDel(null); })}
          </div>
          {!del.deleted && del.reason && (del.archiveStatus === 'skipped' || del.archiveStatus === 'rejected') && (
            <p className="mt-2 text-xs rounded-xl bg-gold/15 text-ink p-2.5">{del.archiveStatus === 'rejected' ? t.rejectedBadge : t.skippedBadge} · {t.score}: {del.score}{del.category ? ` · ${t.cat[del.category]}` : ''}<br />{agentReason(del.reason)}</p>
          )}
          <div className="mt-3 pt-3 border-t border-line">
            <h3 className="text-sm font-bold text-muted px-1">{t.deleteMessage}</h3>
            {del.sealedOn && <p className="text-xs text-gold-dark mt-1 px-1">{t.sealedProtectedNote}</p>}
            {canDeleteForEveryone(del) && <p className="text-xs text-muted mt-1 px-1">{t.deleteNote}</p>}
            <div className="mt-1 flex flex-col">
              {canDeleteForEveryone(del) && row('trash', t.deleteForEveryone, () => deleteForEveryone(del), '!text-danger')}
              {row('trash', t.deleteForMe, () => deleteForMe(del))}
            </div>
          </div>
          <button className="btn btn-ghost w-full mt-3" onClick={() => setDel(null)}>{t.cancel}</button>
        </Dialog>
        );
      })()}
    </div>
  );
}

// ---- archive -----------------------------------------------------------------

function Archive({ circle }: { circle: CircleDetail }) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ArchiveEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [bookYear, setBookYear] = useState(new Date().getFullYear());
  const load = useCallback(() => api<ArchiveEntry[]>(`/circles/${circle.id}/archive?q=${encodeURIComponent(q)}`).then(setRows), [circle.id, q]);
  useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [load]);

  async function remove(id: number) { await api(`/archive/${id}`, { method: 'DELETE' }); load(); }
  async function act(id: number, what: 'decline' | 'resolve') { await api(`/archive/${id}/${what}`, { method: 'POST', body: {} }); load(); }
  const label = (e: ArchiveEntry) => e.kind === 'event' ? t.cat[e.category ?? 'other']
    : e.kind === 'conflict' ? (e.status === 'resolved' ? t.kinds.conflictResolved : e.status === 'faded' ? t.kinds.conflictFaded : t.kinds.conflict)
    : t.kinds[e.kind];

  const groups = rows.reduce<Record<string, ArchiveEntry[]>>((acc, r) => { (acc[r.eventDate.slice(0, 7)] ??= []).push(r); return acc; }, {});
  const month = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(intlLocale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const manager = circle.role === 'owner' || circle.role === 'admin';
  const years = Array.from({ length: 12 }, (_, i) => new Date().getFullYear() - i);
  const chip = 'text-caption px-2 py-0.5 rounded-full';
  const small = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-bold transition-colors duration-[var(--dur-instant)]';
  return (
    <div className="tab-scroll h-full overflow-y-auto space-y-6 pb-6 pt-1">
      {/* Toolbar: the same search box as the chat list, with the import beside it. */}
      <div className="flex flex-col sm:flex-row gap-2">
        <label className="w-full sm:flex-1 shrink-0 flex items-center gap-2.5 h-11 px-4 rounded-xl bg-card border border-line elevated-1
          transition-[border-color,box-shadow] duration-[var(--dur-fast)]
          focus-within:border-green focus-within:shadow-[inset_0_0_0_1px_var(--color-green)]">
          <Icon name="search" className="w-[18px] h-[18px] text-muted shrink-0" />
          <input className="bare-input flex-1 min-w-0 bg-transparent text-ink placeholder:text-muted" type="search"
            placeholder={t.searchArchive} aria-label={t.searchArchive} value={q} onChange={e => setQ(e.target.value)} />
        </label>
        {manager && (
          <button aria-pressed={importing} onClick={() => setImporting(v => !v)}
            className={`h-11 px-4 rounded-xl border inline-flex items-center justify-center gap-2 font-bold whitespace-nowrap elevated-1
              transition-colors duration-[var(--dur-instant)]
              ${importing ? 'bg-green-soft border-green text-green' : 'bg-card border-line text-green hover:border-green/40 hover:bg-green-soft/50'}`}>
            <Icon name="upload" className="w-[18px] h-[18px]" />{t.importButton}
          </button>
        )}
      </div>

      {importing && <div className="animate-slide-up"><Suspense fallback={null}><ImportPanel circle={circle} onDone={load} /></Suspense></div>}

      {/* The family story: the year picker and the reader belong together, so they share a card. */}
      <section className="rounded-2xl bg-card border border-line elevated-1 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3.5 flex-1 min-w-0">
          <span className="w-12 h-12 rounded-2xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="book" className="w-6 h-6" /></span>
          <span className="flex-1 min-w-0">
            <b className="block text-ink">{circle.storyTitle || t.storyHead}</b>
            <span className="block text-sm text-muted mt-0.5">{t.archStoryBody}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Picker label={t.bookYear} icon="calendar" value={bookYear} onChange={setBookYear} columns={3} align="end" className="flex-1 sm:flex-none sm:w-32"
            options={years.map(y => ({ value: y, label: String(y) }))} />
          <a className="btn h-11 !rounded-xl !px-5 flex-1 sm:flex-none" target="_blank" rel="noopener" href={`/api/circles/${circle.id}/book?year=${bookYear}&lang=${lang}`}>
            {t.archRead}<Icon name="arrow-out" className="w-4 h-4 rtl:-scale-x-100" />
          </a>
        </div>
      </section>

      <AlbumsSection circle={circle} />

      {rows.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-line bg-paper/50 px-6 py-12 flex flex-col items-center text-center gap-4 animate-fade-in">
          <div aria-hidden className="relative w-24 h-24 animate-scale-in">
            <span className="absolute inset-0 rounded-[1.75rem] rotate-6 bg-line/70 border border-line" />
            <span className="absolute inset-2 rounded-[1.4rem] bg-brand text-white flex items-center justify-center elevated-3"><Icon name="archive" className="w-9 h-9" /></span>
            <span className="absolute -top-2 -start-2 text-gold-dark animate-pulse-soft"><Icon name="sparkle" className="w-5 h-5" /></span>
          </div>
          <h3 className="text-lg font-bold text-ink">{q.trim() ? t.chatNoMatch : t.archEmptyTitle}</h3>
          {!q.trim() && <p className="text-sm text-muted leading-relaxed max-w-xl">{t.emptyArchive}</p>}
          {!q.trim() && manager && !importing && (
            <button className="btn btn-ghost h-11 !rounded-xl" onClick={() => setImporting(true)}><Icon name="upload" className="w-[18px] h-[18px]" />{t.importButton}</button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <h3 className="text-caption font-bold uppercase tracking-[0.12em] text-muted">{t.archEntries}</h3>
          {Object.entries(groups).map(([ym, list]) => (
            <section key={ym} className="space-y-3">
              <h4><span className="timeline-month">{month(ym)}</span></h4>
              <ol className="timeline space-y-3">
                {list.map(e => (
                  <li key={e.id} className="timeline-item animate-slide-up">
                    <article className="rounded-2xl bg-card border border-line elevated-1 p-4">
                      <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
                        <span className={`${chip} bg-green-soft text-green font-bold`}>{label(e)}</span>
                        {e.pending && <span className={`${chip} bg-gold/20 text-gold-dark font-bold`}>{t.pendingBadge2}</span>}
                        <span className="inline-flex items-center gap-1 tabular-nums" dir="ltr"><Icon name="calendar" className="w-3.5 h-3.5" />{e.eventDate}</span>
                        <span>· {e.source === 'manual' ? t.manual : t.auto}</span>
                      </div>
                      <p className="mt-2 text-ink leading-relaxed whitespace-pre-wrap break-words">{e.summary}</p>
                      {!!e.media?.length && (
                        <div className="mt-3 space-y-2">
                          <div className="flex gap-2 overflow-x-auto">{e.media.filter(m => m.kind !== 'voice').map(m => <a key={m.id} href={`/api/album-items/${m.id}/file`} target="_blank" rel="noopener" className="shrink-0"><img alt="" loading="lazy" className="w-20 h-20 object-cover rounded-xl bg-line" src={`/api/album-items/${m.id}/file?thumb=1`} /></a>)}</div>
                          {e.media.filter(m => m.kind === 'voice').map(m => <audio key={m.id} controls preload="none" className="w-full h-9" src={`/api/album-items/${m.id}/file`} />)}
                          <p className="text-caption text-muted">{t.albumEventNote}</p>
                        </div>
                      )}
                      {e.pending && <p className="mt-2 text-xs text-muted">{t.pendingNote}</p>}
                      {(e.canAct || (manager && !e.protected)) && (
                        <div className="mt-3 pt-3 border-t border-line flex flex-wrap gap-2">
                          {e.canAct && e.status === 'open' && <button onClick={() => act(e.id, 'resolve')} className={`${small} bg-green-soft text-green hover:bg-green-soft/70`}><Icon name="check" className="w-3.5 h-3.5" />{t.markResolved}</button>}
                          {e.canAct && e.pending && <button onClick={() => act(e.id, 'decline')} className={`${small} text-danger hover:bg-danger-soft`}><Icon name="ban" className="w-3.5 h-3.5" />{t.decline}</button>}
                          {manager && !e.protected && <button onClick={() => remove(e.id)} className={`${small} text-danger hover:bg-danger-soft ms-auto`}><Icon name="trash" className="w-3.5 h-3.5" />{t.deleteEntry}</button>}
                        </div>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** A thumbnail is 320px wide: fine in a small tile, visibly soft when a tile or bubble is
 *  larger than that (or on a retina screen). srcSet lets the browser take the full photo
 *  only when the slot needs it. Videos keep the poster frame. */
function sharpSrc(x: { id: number; kind: string; thumb: number | null }, sizes: string) {
  if (x.kind === 'image' && x.thumb) return { src: `/api/media/${x.thumb}`, srcSet: `/api/media/${x.thumb} 320w, /api/media/${x.id} 1600w`, sizes };
  return { src: `/api/media/${x.thumb ?? x.id}` };
}

/** Message bubbles while the first page loads: alternating sides and widths, so the
 *  screen already has the shape of a conversation instead of a false empty state. */
function MessagesSkeleton() {
  const { t } = useI18n();
  const rows: Array<[boolean, string, string]> = [[false, 'w-48', 'h-10'], [true, 'w-40', 'h-10'], [false, 'w-64', 'h-16'], [true, 'w-56', 'h-24'], [false, 'w-36', 'h-10'], [true, 'w-44', 'h-10']];
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3 py-4">
      <span className="sr-only">{t.loading}</span>
      {rows.map(([mine, w, h], i) => (
        <div key={i} aria-hidden className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
          <Skeleton className={`${w} ${h} max-w-[75%] !rounded-2xl ${mine ? '!rounded-br-md' : '!rounded-bl-md'}`} />
        </div>
      ))}
    </div>
  );
}

/** The whole chat screen before the chat itself has loaded: header, tabs, bubbles, composer. */
/**
 * The bar that stands in for the message box while a message request waits: who this is, and the four answers.
 * Accepting turns the chat into an ordinary one; declining, blocking and reporting take it out of the list.
 */
function RequestBar({ circle, me, lastText, onAccepted, onGone }: { circle: CircleDetail; me: Me; lastText: string; onAccepted: () => void; onGone: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'' | 'accept' | 'decline' | 'block' | 'report'>('');
  const [error, setError] = useState('');
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reporting, setReporting] = useState(false);
  const name = circle.members.find(x => x.id !== me.id)?.name ?? circle.name;
  async function answer(kind: 'accept' | 'decline' | 'block' | 'report', reason?: string) {
    setBusy(kind); setError('');
    try {
      if (kind === 'accept') { await api(`/requests/${circle.id}/accept`, { method: 'POST', body: {} }); onAccepted(); }
      else if (kind === 'report') { await api(`/requests/${circle.id}/report`, { body: { reason, ...(circle.encrypted ? { snapshot: lastText.slice(0, 1000) } : {}) } }); onGone(); }
      else { await api(`/requests/${circle.id}/decline`, { body: { block: kind === 'block' } }); onGone(); }
    } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); setBusy(''); }
  }
  return (
    <section aria-label={t.req.title} className="mt-2 rounded-2xl bg-card border border-line elevated-1 p-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <span aria-hidden className="w-10 h-10 rounded-xl bg-gold/15 text-gold-dark flex items-center justify-center shrink-0"><Icon name="envelope" className="w-5 h-5" /></span>
        <div className="min-w-0">
          <p className="font-bold text-ink">{fill(t.req.banner, { name })}</p>
          <p className="text-sm text-muted mt-0.5">{t.req.bannerHelp}</p>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <button className="btn btn-primary inline-flex items-center justify-center gap-2" disabled={!!busy} onClick={() => answer('accept')}>{busy === 'accept' ? <Spinner /> : <Icon name="check" className="w-4 h-4" />}{t.req.accept}</button>
        <button className="btn btn-ghost inline-flex items-center justify-center gap-2" disabled={!!busy} onClick={() => answer('decline')}>{busy === 'decline' ? <Spinner /> : <Icon name="x" className="w-4 h-4" />}{t.req.decline}</button>
        <button className="btn btn-ghost text-danger inline-flex items-center justify-center gap-2" disabled={!!busy} onClick={() => setConfirmBlock(true)}><Icon name="ban" className="w-4 h-4" />{t.req.block}</button>
        <button className="btn btn-ghost text-danger inline-flex items-center justify-center gap-2" disabled={!!busy} onClick={() => setReporting(true)}><Icon name="alert" className="w-4 h-4" />{t.req.report}</button>
      </div>
      {confirmBlock && (
        <Dialog onClose={() => setConfirmBlock(false)} label={t.req.block}>
          <h2 className="text-lg font-bold">{fill(t.req.blockConfirm, { name })}</h2>
          <div className="mt-4 flex gap-2">
            <button className="btn btn-danger flex-1 inline-flex items-center justify-center gap-2" disabled={!!busy} onClick={() => answer('block')}>{busy === 'block' && <Spinner />}{t.req.block}</button>
            <button className="btn btn-ghost" onClick={() => setConfirmBlock(false)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
      {reporting && (
        <Dialog onClose={() => setReporting(false)} label={t.req.report}>
          <h2 className="text-lg font-bold">{fill(t.req.reportTitle, { name })}</h2>
          <p className="text-sm text-muted mt-2">{t.req.reportHelp}</p>
          <div className="mt-3 flex flex-col gap-2">
            {Object.entries(t.reportReasons).map(([k, label]) => (
              <button key={k} className="btn btn-ghost" disabled={!!busy} onClick={() => answer('report', k)}>{label}</button>
            ))}
          </div>
          <button className="btn btn-ghost w-full mt-3" onClick={() => setReporting(false)}>{t.cancel}</button>
        </Dialog>
      )}
    </section>
  );
}

function ChatSkeleton({ docked }: { docked?: boolean }) {
  return (
    <div className={docked ? 'chat-docked flex flex-col h-full' : 'flex flex-col h-[100dvh] py-2'}>
      <div className="chat-head flex items-center gap-3 mb-3" aria-hidden>
        <Skeleton className="w-10 h-10 !rounded-xl" />
        <Skeleton className="w-10 h-10 !rounded-xl" />
        <span className="flex-1 space-y-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-24" /></span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="chat-root flex flex-col h-full">
          <div className="chat-wall flex-1 overflow-hidden"><MessagesSkeleton /></div>
          <div className="pt-2" aria-hidden><Skeleton className="h-12 !rounded-full" /></div>
        </div>
      </div>
    </div>
  );
}

// ---- settings ---------------------------------------------------------------

// Sizes a person reads, not a machine's. A plan of 2048 GB is two terabytes, and "5.0 GB" of free space reads like a
// measurement when it should read like an offer: whole numbers lose the pointless ".0".
const fmtBytes = (n: number) => {
  const unit = (v: number, u: string) => `${v % 1 === 0 ? v : v.toFixed(1)} ${u}`;
  if (n >= 1024 ** 4) return unit(n / 1024 ** 4, 'TB');
  if (n >= 1024 ** 3) { const gb = n / 1024 ** 3; return gb >= 1024 ? unit(gb / 1024, 'TB') : unit(gb, 'GB'); }
  if (n >= 1024 ** 2) return unit(n / 1024 ** 2, 'MB');
  return `${Math.ceil(n / 1024)} KB`;
};
/** Storage only means something once it is a number of photos. About 4 MB each, the size a modern phone makes. */
const roughPhotos = (bytes: number) => {
  const n = Math.round(bytes / (4 * 1024 ** 2));
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)},000`;
  return String(n);
};

type PickedContact = { name: string; tel: string };
/** Invite people from the phone's contacts (where the browser has the Contact Picker: Chrome on Android) or by sharing the invite link. The contacts stay on the phone: nothing is uploaded, the chosen ones only open a message with the link. */
function ContactInvite({ circle }: { circle: CircleDetail }) {
  const { t } = useI18n();
  const link = `${location.origin}/#/join/${circle.inviteCode}`;
  const text = t.inviteLinkText.replace('{name}', circle.name).replace('{link}', link);
  const [picked, setPicked] = useState<PickedContact[]>([]);
  const [note, setNote] = useState('');
  const canPick = typeof navigator !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window;
  async function pick() {
    try {
      const res: Array<{ name?: string[]; tel?: string[] }> = await (navigator as any).contacts.select(['name', 'tel'], { multiple: true });
      setPicked(res.filter(c => c.tel?.length).map(c => ({ name: c.name?.[0] ?? c.tel![0], tel: c.tel![0] })));
    } catch { /* cancelled */ }
  }
  async function share() {
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); setNote(t.copied); setTimeout(() => setNote(''), 1500); }
    } catch { /* cancelled or blocked */ }
  }
  const digits = (tel: string) => tel.replace(/[^\d+]/g, '');
  const intl = (tel: string) => { const d = digits(tel); return d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : null; };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost !rounded-xl" onClick={share}><Icon name="link" className="w-4 h-4" />{t.inviteShare}</button>
        {canPick && <button className="btn !rounded-xl" onClick={pick}><Icon name="group" className="w-4 h-4" />{t.inviteContacts}</button>}
      </div>
      {!canPick && <p className="text-xs text-muted">{t.inviteNoPicker}</p>}
      {picked.length > 0 && (
        <ul className="divide-y divide-line border border-line rounded-xl">
          {picked.map(c => { const w = intl(c.tel); return (
            <li key={c.tel} className="p-2 flex items-center gap-2 text-sm">
              <span className="flex-1 min-w-0"><b className="block truncate">{c.name}</b><span className="text-xs text-muted" dir="ltr">{c.tel}</span></span>
              <a className="btn btn-ghost !py-1" href={`sms:${digits(c.tel)}?&body=${encodeURIComponent(text)}`}>{t.inviteSms}</a>
              {w && <a className="btn btn-ghost !py-1" target="_blank" rel="noopener" href={`https://wa.me/${w}?text=${encodeURIComponent(text)}`}>{t.inviteWhatsapp}</a>}
            </li>
          ); })}
        </ul>
      )}
      <p className="text-xs text-muted">{t.invitePrivacy}</p>
      {note && <p role="status" className="text-xs text-green">{note}</p>}
    </div>
  );
}

function StoryEditor({ circle, onClose }: { circle: CircleDetail; onClose: () => void }) {
  const { t, lang } = useI18n();
  const year = new Date().getFullYear();
  const [chapters, setChapters] = useState<Array<{ idx: number; title: string; text: string; source: string }> | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<{ chapters: NonNullable<typeof chapters> }>(`/circles/${circle.id}/story?year=${year}&lang=${lang}`).then(r => setChapters(r.chapters)).catch(() => setChapters([])); }, [circle.id, year, lang]);
  async function save(ch: { idx: number; title: string; text: string }) {
    setError('');
    try { await api(`/circles/${circle.id}/story/${year}/${ch.idx}`, { method: 'PUT', body: { title: ch.title, text: ch.text, lang } }); setSaved(ch.idx); setChapters(l => l?.map(x => (x.idx === ch.idx ? { ...x, source: 'edited' } : x)) ?? l); }
    catch (e) { setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  const set = (idx: number, patch: object) => setChapters(l => l?.map(x => (x.idx === idx ? { ...x, ...patch } : x)) ?? l);
  return (
    <Dialog onClose={onClose} label={t.storyEdit}>
      <h2 className="text-lg font-bold">{t.storyEdit} · {year}</h2>
      <p className="text-xs text-muted mt-1">{t.storyEditNote}</p>
      {chapters === null ? <div className="mt-3 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3" /><Skeleton className="h-3 w-2/3" /></div>
        : chapters.length === 0 ? <p className="text-sm text-muted mt-3">{t.storyNoChapters}</p> : (
        <ul className="mt-3 space-y-4 max-h-[60vh] overflow-y-auto">
          {chapters.map(ch => (
            <li key={ch.idx} className="space-y-1">
              <div className="flex items-center gap-2"><input className="field !py-1 flex-1" value={ch.title} maxLength={120} onChange={e => set(ch.idx, { title: e.target.value })} />
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-line text-muted shrink-0">{t.storySource[ch.source] ?? ch.source}</span></div>
              <textarea className="field min-h-40" value={ch.text} onChange={e => set(ch.idx, { text: e.target.value })} />
              <div className="flex items-center gap-2"><button className="btn btn-ghost !py-1" onClick={() => save(ch)}>{t.save}</button>{saved === ch.idx && <span role="status" className="text-xs text-green inline-flex items-center gap-1"><Icon name="check" className="w-3.5 h-3.5" /> {t.saved}</span>}</div>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
      <button className="btn w-full mt-3" onClick={onClose}>{t.close}</button>
    </Dialog>
  );
}

function StoryCard({ circle, reload }: { circle: CircleDetail; reload: () => void }) {
  const { t, lang } = useI18n();
  const [title, setTitle] = useState(circle.storyTitle ?? '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  async function save() {
    if (title.trim() === (circle.storyTitle ?? '')) return;
    try { await api(`/circles/${circle.id}`, { method: 'PATCH', body: { storyTitle: title } }); await reload(); setMsg(t.saved); } catch { setMsg(t.errors.generic); }
  }
  async function write() {
    setBusy(true); setMsg('');
    try {
      const r = await api<{ written: number; model: boolean }>(`/circles/${circle.id}/story`, { body: { year: new Date().getFullYear(), lang } });
      setMsg(!r.model ? t.storyNoModel : !circle.agentActive ? t.storyNeedAgent : r.written > 0 ? t.storyWritten.replace('{n}', String(r.written)) : t.storyNothing);
    } catch (e) { setMsg(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); } finally { setBusy(false); }
  }
  return (
    <section className="rounded-2xl bg-card border border-line elevated-1 p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="book" className="w-5 h-5" /></span>
        <h3 className="font-bold text-ink">{t.storyHead}</h3>
      </div>
      <label className="block text-sm font-medium">{t.storyName}
        <input className="field mt-1" value={title} maxLength={80} placeholder={t.storyNamePh} onChange={e => setTitle(e.target.value)} onBlur={save} />
      </label>
      <p className="text-xs text-muted">{t.storyNote}</p>
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-ghost !rounded-xl" target="_blank" rel="noopener" href={`/api/circles/${circle.id}/book?year=${new Date().getFullYear()}&lang=${lang}`}><Icon name="book" className="w-4 h-4" />{t.bookButton}</a>
        <button className="btn !rounded-xl" disabled={busy} onClick={write}><Icon name="sparkle" className="w-4 h-4" />{t.storyWrite}</button>
        <button className="btn btn-ghost !rounded-xl" onClick={() => setEditing(true)}><Icon name="pen" className="w-4 h-4" />{t.storyEdit}</button>
      </div>
      {editing && <StoryEditor circle={circle} onClose={() => setEditing(false)} />}
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

function StorageCard({ circle, bill, manager, onChanged }: { circle: CircleDetail; bill: Billing; manager: boolean; onChanged: () => void }) {
  // Choosing a plan is a page of its own now (web/src/Plans.tsx); this card reports the family's space and
  // links to it. What is left here is the usage picture and managing an existing subscription.
  const { t } = useI18n();
  const [paidMsg, setPaidMsg] = useState(false);
  const [err, setErr] = useState('');
  // back from Stripe's page: the plan is switched on by Stripe's message to the server a moment later, so look again shortly
  useEffect(() => {
    if (!new URLSearchParams(location.search).get('paid')) return;
    setPaidMsg(true); history.replaceState(null, '', location.pathname + location.hash);
    const timers = [2500, 6000, 12000].map(ms => setTimeout(onChanged, ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  async function manage() {
    setErr('');
    try { const r = await api<{ url: string }>(`/circles/${circle.id}/billing-portal`, { body: {} }); window.location.href = r.url; }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  const pct = Math.min(100, (bill.archivedBytes / bill.quotaBytes) * 100);
  const full = bill.archivedBytes >= bill.quotaBytes, almost = !full && pct >= 80;
  return (
    <section className="rounded-2xl bg-card border border-line elevated-1 p-4 sm:p-5 space-y-2">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="storage" className="w-5 h-5" /></span>
        <h3 className="font-bold text-ink">{t.storage}</h3>
      </div>
      <div className="h-2 rounded-full bg-line overflow-hidden" role="progressbar" aria-valuenow={bill.archivedBytes} aria-valuemax={bill.quotaBytes}>
        <div className={`h-full ${full ? 'bg-danger' : almost ? 'bg-gold' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm">{fill(t.storUsedOf, { used: fmtBytes(bill.archivedBytes), total: fmtBytes(bill.quotaBytes) })}</p>
      {(full || almost) && <p role="status" className={`text-sm rounded-lg p-2 ${full ? 'text-danger bg-danger/10' : 'text-gold-dark bg-gold/15'}`}>{full ? t.storFullMsg : t.storAlmost}</p>}
      <p className="text-sm text-muted">{t.chatUsed}: <bdi dir="ltr">{fmtBytes(bill.chatBytes)}</bdi></p>
      <p className="text-sm text-muted">{t.plan}: {t.plans[bill.plan]} · {t.sponsor}: {bill.sponsor ?? t.noSponsor}</p>
      <p className="text-xs text-muted">{t.storageNote}</p>
      {bill.status === 'readonly' && <p role="status" className="text-sm text-gold-dark bg-gold/15 rounded-lg p-2">{t.readonlyNote}</p>}
      {bill.request?.status === 'open' && <p role="status" className="text-sm text-green">{t.storRequestSent}</p>}
      {bill.request?.status === 'granted' && <p className="text-xs text-green inline-flex items-center gap-1"><Icon name="check" className="w-3.5 h-3.5" />{t.storGranted}</p>}
      {bill.request?.status === 'declined' && <p className="text-xs text-muted">{t.storDeclined}</p>}
      {paidMsg && <p role="status" className="text-sm text-green bg-green-soft rounded-lg p-2">{t.payPaidThanks}</p>}
      {bill.periodEnd && bill.plan !== 'free' && <p className="text-xs text-muted">{t.payRenews}: <bdi dir="ltr">{bill.periodEnd.slice(0, 10)}</bdi></p>}
      {manager && bill.stripe && <button className="btn btn-ghost w-full" onClick={manage}>{t.payManage}</button>}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      {manager
        ? <a className="btn w-full" href={`#/plans/${circle.id}`}>{t.storGetMore}</a>
        : <p className="text-xs text-muted">{t.storManagersOnly}</p>}

    </section>
  );
}

function Settings({ circle, me, reload, onLeft, openArchive }: { circle: CircleDetail; me: Me; reload: () => void; onLeft: () => void; openArchive: () => void }) {
  const { t } = useI18n();
  const owner = circle.role === 'owner';
  const manager = owner || circle.role === 'admin';
  const [note, setNote] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const [delError, setDelError] = useState('');
  const [bill, setBill] = useState<Billing | null>(null);
  useEffect(() => { api<Billing>(`/circles/${circle.id}/billing`).then(setBill).catch(() => {}); }, [circle.id]);
  const presence = usePresence(circle.kind === 'direct' ? [] : circle.members.filter(m => m.id !== me.id).map(m => m.id));

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 1500); };
  async function patch(body: object) { await api(`/circles/${circle.id}`, { method: 'PATCH', body }); await reload(); flash(t.saved); }
  async function removeMember(uid: number) {
    await api(`/circles/${circle.id}/members/${uid}`, { method: 'DELETE' });
    if (uid === me.id) onLeft(); else reload();
  }
  async function setRole(uid: number, role: 'admin' | 'member') {
    await api(`/circles/${circle.id}/members/${uid}`, { method: 'PATCH', body: { role } }); reload();
  }
  async function transfer(uid: number) {
    if (!confirm(t.confirmTransfer)) return;
    await api(`/circles/${circle.id}/transfer`, { method: 'POST', body: { userId: uid } }); reload();
  }
  async function deleteCircle() {
    setDelError('');
    try { await api(`/circles/${circle.id}`, { method: 'DELETE', body: { confirm: typed } }); onLeft(); }
    catch (err) { setDelError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }
  async function regenerate() { await api(`/circles/${circle.id}/invite/regenerate`, { method: 'POST', body: {} }); await reload(); flash(t.saved); }
  async function copy() {
    try { await navigator.clipboard.writeText(circle.inviteCode ?? ''); flash(t.copied); } catch { /* clipboard blocked */ }
  }

  const [receipts, setReceipts] = useState(me.read_receipts === 1);
  async function setReceiptsOn(on: boolean) {
    setReceipts(on);
    try { await api('/me', { method: 'PATCH', body: { read_receipts: on } }); flash(t.saved); } catch { setReceipts(!on); }
  }

  const [sub, setSub] = useState<'members' | 'media' | 'settings'>('members');
  const inviteRef = useRef<HTMLElement>(null);
  // Asked for the invite (from the chat list): show Members and bring the invite card into view.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== circle.id) return;
      setSub('members');
      setTimeout(() => {
        const el = inviteRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.remove('flash-ring'); void el.offsetWidth; el.classList.add('flash-ring');
      }, 60);
    };
    window.addEventListener('thikra:invite', on);
    // Mounted by that same request (the chat was not open yet): run it once now.
    if (location.hash.endsWith('/settings')) on(new CustomEvent('thikra:invite', { detail: circle.id }));
    return () => window.removeEventListener('thikra:invite', on);
  }, [circle.id]);
  const [muteOpen, setMuteOpen] = useState(false);
  const [photos, setPhotos] = useState<GalleryItem[] | null>(null);
  useEffect(() => { if (sub === 'media' && photos === null) api<GalleryItem[]>(`/circles/${circle.id}/media`).then(setPhotos).catch(() => setPhotos([])); }, [sub, photos, circle.id]);
  async function setPref(body: object) { await api(`/circles/${circle.id}/prefs`, { method: 'PATCH', body }); await reload(); setMuteOpen(false); }
  const { lang } = useI18n();
  const when = (v: string) => toDate(v).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' });
  const muteLabel = circle.muted ? (circle.mutedUntil ? `${t.infoMutedUntil} ${when(circle.mutedUntil)}` : t.infoMutedAlways) : t.infoNotMuted;
  const sections = circle.kind === 'direct' ? (['settings'] as const) : (['members', 'media', 'settings'] as const);
  const show = (k: string, extra = 'space-y-4') => (sub === k ? extra : 'hidden');

  return (
    <div className="tab-scroll h-full overflow-y-auto flex flex-col gap-4 pb-4">
      <section className="text-center pt-2 flex flex-col items-center">
        {(() => {
          const title = (
            <>
              <h3 className="mt-4 text-2xl font-bold !text-ink tracking-tight break-words">{circle.name}</h3>
              <p className="mt-1 text-sm text-muted">{circle.kind === 'circle' ? t.infoKindCircle : circle.kind === 'group' ? t.infoKindGroup : ''}{circle.kind !== 'direct' && ' · '}{circle.members.length === 1 ? t.oneMember : t.infoMembersCount.replace('{n}', String(circle.members.length))}</p>
            </>
          );
          return circle.kind === 'direct'
            ? <><Avatar name={circle.name} kind={circle.kind} photo={circle.photo} person={(() => { const o = circle.members.find(x => x.id !== me.id); return o ? { id: o.id, avatarAt: o.avatarAt } : null; })()} className="w-20 h-20 text-3xl" />{title}</>
            : <GroupFace circle={circle} canEdit={manager || circle.editPolicy === 'all'} reload={reload} onError={code => flash(t.errors[code] ?? t.errors.generic)} title={title} />;
        })()}
        {manager && !!circle.joinRequests && (
          <button className="mt-3 inline-flex items-center gap-2 h-9 px-4 rounded-full bg-gold/15 text-gold-dark text-sm font-bold hover:bg-gold/25 transition-colors duration-[var(--dur-instant)]" onClick={() => setSub('settings')}>
            <Icon name="group" className="w-4 h-4" />{t.pendingRequests} ({circle.joinRequests})
          </button>
        )}
        <div className={`mt-5 w-full max-w-md grid gap-2 ${circle.kind !== 'direct' ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {([
            [circle.muted ? 'mute' : 'bell', circle.muted ? t.infoMuted : t.infoMute, !!circle.muted, () => circle.muted ? setPref({ muted: false }) : setMuteOpen(true)],
            [circle.favourite ? 'star-fill' : 'star', t.infoFavourite, !!circle.favourite, () => setPref({ favourite: !circle.favourite })],
            ...(circle.kind !== 'direct' ? [['plus', t.infoInvite, false, () => setSub('members')] as const] : []),
          ] as const).map(([ic, label, on, fn]) => (
            <button key={label} aria-pressed={on} onClick={fn}
              className={`group/qa flex flex-col items-center gap-1.5 py-3 rounded-2xl border text-sm transition-[background-color,border-color,box-shadow] duration-[var(--dur-fast)]
                ${on ? 'bg-green-soft border-green/40 text-green font-bold' : 'bg-card border-line text-ink hover:border-green/40 hover:shadow-[var(--shadow-e2)]'} elevated-1`}>
              <span className={`w-9 h-9 rounded-xl flex items-center justify-center ${on ? 'bg-brand text-white' : 'bg-green-soft text-green'}`}><Icon name={ic} className="w-[18px] h-[18px]" /></span>
              {label}
            </button>
          ))}
        </div>
      </section>
      {bill && circle.kind === 'circle' && bill.archivedBytes / bill.quotaBytes >= 0.8 && (
        <button className="text-sm rounded-xl p-3 bg-gold/15 text-gold-dark text-start flex items-center gap-2" onClick={() => setSub('media')}><Icon name="alert" className="w-4 h-4 shrink-0" />{bill.archivedBytes >= bill.quotaBytes ? t.storFullMsg : t.storAlmost}</button>
      )}
      {sections.length > 1 && (
        <div role="tablist" className="self-center inline-flex p-1 gap-1 rounded-2xl bg-paper border border-line">
          {sections.map(k => (
            <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}
              className={`px-5 h-9 rounded-xl text-sm transition-[background-color,color,box-shadow] duration-[var(--dur-fast)]
                ${sub === k ? 'bg-card text-green font-bold elevated-1' : 'text-muted hover:text-ink'}`}>
              {k === 'members' ? t.infoMembers : k === 'media' ? t.infoMedia : t.infoSettings}
            </button>
          ))}
        </div>
      )}
      <section className={show('settings', 'rounded-2xl bg-card border border-line elevated-1 overflow-hidden')}>
        <button className="row-interactive w-full flex items-center gap-3 p-4 text-start" onClick={() => setMuteOpen(true)}>
          <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name={circle.muted ? 'mute' : 'bell'} className="w-5 h-5" /></span>
          <span className="flex-1 min-w-0"><b className="block text-ink">{t.infoNotifications}</b><span className="block text-xs text-muted">{t.infoNotifNote}</span></span>
          <span className="text-sm text-muted shrink-0">{muteLabel}</span>
          <Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90 shrink-0" />
        </button>
      </section>
      {circle.kind === 'circle' && manager && <div className={show('settings')}><StoryCard circle={circle} reload={reload} /></div>}
      {circle.kind === 'circle' && (
        <section className={show('settings', 'rounded-2xl bg-card border border-line elevated-1 overflow-hidden')}>
          <h3 className="px-4 pt-4 pb-1 text-caption font-bold uppercase tracking-[0.12em] text-muted">{t.thekraHead}</h3>
          <ul className="divide-y divide-line">
            {([
              ['archive', t.thekraArchive, circle.agentActive ? t.agentOn : t.agentOff, openArchive, null],
              ['album', t.thekraAlbums, '', openArchive, null],
              ['book', t.bookButton, '', null, `/api/circles/${circle.id}/book?year=${new Date().getFullYear()}&lang=${lang}`],
              ['envelope', t.thekraSealed, '', null, '#/sealed'],
            ] as const).map(([ic, label, note, fn, href]) => {
              const inner = <>
                <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name={ic} className="w-5 h-5" /></span>
                <span className="flex-1 min-w-0 text-ink">{label}</span>
                {note && <span className="text-sm text-muted shrink-0">{note}</span>}
                <Icon name={href && href.startsWith('/api') ? 'arrow-out' : 'chevron'} className={`w-4 h-4 text-muted shrink-0 ${href && href.startsWith('/api') ? 'rtl:-scale-x-100' : '-rotate-90 rtl:rotate-90'}`} />
              </>;
              return <li key={label}>{href
                ? <a className="row-interactive flex items-center gap-3 px-4 py-3" href={href} {...(href.startsWith('/api') ? { target: '_blank', rel: 'noopener' } : {})}>{inner}</a>
                : <button className="row-interactive w-full flex items-center gap-3 px-4 py-3 text-start" onClick={fn!}>{inner}</button>}</li>;
            })}
          </ul>
          <p className="px-4 py-3 text-xs text-muted border-t border-line">{t.thekraNote}</p>
        </section>
      )}
      <div className={show('settings')}>
      {manager && circle.kind !== 'direct' && <GroupRules circle={circle} patch={patch} reload={reload} />}
      {/* An encrypted group can never become a family circle (the server cannot read it, and a chat's type is fixed at creation), so it is not offered. */}
      {circle.kind === 'group' && owner && !circle.encrypted && (
        <section className="rounded-2xl bg-card border border-line elevated-1 p-4 space-y-2">
          <button className="btn w-full flex items-center justify-center gap-2" onClick={async () => {
            try { await api(`/circles/${circle.id}/convert`, { method: 'POST', body: {} }); await reload(); flash(t.saved); }
            catch (err) { flash(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
          }}><Icon name="heart" className="w-4 h-4" />{t.convertToCircle}</button>
          <p className="text-sm text-muted">{t.convertNote}</p>
        </section>
      )}
      {circle.kind === 'group' && owner && circle.encrypted && (
        <section className="rounded-2xl bg-card border border-line elevated-1 p-4 flex items-start gap-3">
          <Icon name="lock" className="w-5 h-5 text-green shrink-0 mt-0.5" />
          <p className="text-sm text-muted">{t.e2ee.noConvert}</p>
        </section>
      )}
      <section className="rounded-2xl bg-card border border-line elevated-1 px-4 py-2">
        <Toggle checked={receipts} onChange={setReceiptsOn} label={t.readReceipts} note={<span className="text-sm">{t.readReceiptsNote}</span>} />
      </section>
      {circle.kind === 'circle' && (
        <section className="rounded-2xl bg-card border border-line elevated-1 p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="shield" className="w-5 h-5" /></span>
            <h3 className="font-bold text-ink">{t.agentInfoTitle}</h3>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl bg-green-soft/50 border border-line p-3.5 space-y-2">
              <p className="text-sm font-bold text-green flex items-center gap-1.5"><Icon name="sparkle" className="w-4 h-4" />{t.agentReadsTitle}</p>
              <ul className="text-sm space-y-1.5">{t.agentReads.map(x => <li key={x} className="flex items-start gap-2"><Icon name="check" className="w-4 h-4 text-green shrink-0 mt-0.5" /><span>{x}</span></li>)}</ul>
            </div>
            <div className="rounded-xl bg-danger-soft/60 border border-line p-3.5 space-y-2">
              <p className="text-sm font-bold text-danger flex items-center gap-1.5"><Icon name="lock" className="w-4 h-4" />{t.agentNeverTitle}</p>
              <ul className="text-sm space-y-1.5">{t.agentNever.map(x => <li key={x} className="flex items-start gap-2"><Icon name="x" className="w-4 h-4 text-danger shrink-0 mt-0.5" /><span>{x}</span></li>)}</ul>
            </div>
          </div>
        </section>
      )}
      {manager && (
        <section className="rounded-2xl bg-card border border-line elevated-1 p-4 sm:p-5 space-y-4">
          {circle.kind === 'circle' && <Toggle checked={!!circle.agentActive} onChange={v => patch({ agentActive: v })} label={t.agentMode} note={<span className="text-sm">{t.agentModeHelp}</span>} />}
          <div className="grid gap-4 md:grid-cols-2">
            {circle.kind === 'circle' && <div>
              <span className="block text-sm font-medium mb-1.5">{t.sensitivity}</span>
              <Picker label={t.sensitivity} value={circle.sensitivity} onChange={v => patch({ sensitivity: v })}
                options={(['strict', 'medium', 'lenient'] as const).map(v => ({ value: v, label: t.sens[v] }))} />
            </div>}
            <div>
              <span className="block text-sm font-medium mb-1.5">{t.invitePolicy}</span>
              <Picker label={t.invitePolicy} value={circle.invitePolicy} onChange={v => patch({ invitePolicy: v })}
                options={(['admins', 'members'] as const).map(v => ({ value: v, label: t.invitePolicies[v] }))} />
            </div>
          </div>
          <Toggle checked={circle.inviteEnabled} onChange={v => patch({ inviteEnabled: v })} label={t.inviteEnabled} />
          {/* GRP-02: how long a link lives, and what a newcomer may read. A family circle's past is never hidden. */}
          {circle.inviteEnabled && (
            <div>
              <span className="block text-sm font-medium mb-1.5">{t.priv.inviteLife}</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t.priv.inviteLife}>
                {([null, 1, 7, 30] as Array<number | null>).map(d => {
                  const on = d === null ? !circle.inviteExpiresAt : false;
                  return <button key={String(d)} type="button" role="radio" aria-checked={on}
                    className={`btn btn-ghost !py-1 ${on ? '!border-green !text-green font-bold' : ''}`}
                    onClick={() => api(`/circles/${circle.id}/invite/expiry`, { method: 'PUT', body: { days: d } }).then(reload).catch(() => {})}>
                    {d === null ? t.priv.inviteForever : d === 1 ? t.priv.inviteDay1 : t.priv.inviteDays.replace('{n}', String(d))}
                  </button>;
                })}
              </div>
              {circle.inviteExpiresAt && <p className="mt-1 text-xs text-muted">{t.priv.inviteEndsOn.replace('{date}', toDate(circle.inviteExpiresAt).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' }))}</p>}
            </div>
          )}
          {circle.kind !== 'circle' && (
            <div>
              <span className="block text-sm font-medium mb-1.5">{t.priv.historyHead}</span>
              <Picker label={t.priv.historyHead} value={circle.historyPolicy ?? 'all'} onChange={v => patch({ historyPolicy: v })}
                options={[{ value: 'all', label: t.priv.historyAll }, { value: 'since_join', label: t.priv.historySince }]} />
              <p className="mt-1 text-xs text-muted">{t.priv.historyNote}</p>
            </div>
          )}
        </section>
      )}

      </div>
      <div className={show('members')}>
      {circle.inviteCode ? (
        <section ref={inviteRef} className="scroll-mt-4 rounded-2xl bg-card border border-line elevated-1 p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="plus" className="w-5 h-5" /></span>
            <span className="min-w-0"><b className="block text-ink">{t.invite}</b><span className="block text-sm text-muted">{t.shareCode}</span></span>
          </div>
          <div className="flex gap-2">
            <code className="flex-1 h-12 rounded-xl bg-paper border border-dashed border-line flex items-center justify-center text-lg tracking-[0.2em] font-bold text-ink select-all" dir="ltr">{circle.inviteCode}</code>
            <button className="btn btn-ghost h-12 !rounded-xl" onClick={copy}><Icon name="copy" className="w-4 h-4" />{t.copy}</button>
          </div>
          <ContactInvite circle={circle} />
          {manager && <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-bold text-green hover:bg-green-soft transition-colors duration-[var(--dur-instant)]" onClick={regenerate}><Icon name="refresh" className="w-3.5 h-3.5" />{t.regenerate}</button>}
        </section>
      ) : !circle.inviteEnabled && <p className="text-sm text-muted text-center">{t.inviteOff}</p>}

      </div>
      <div className={show('media')}>
        {photos === null ? <GridSkeleton tiles={6} className="grid-cols-3 gap-1" />
          : photos.length === 0 ? <p className="text-sm text-muted text-center">{t.infoMediaNone}</p> : (
          <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1.5">
            {photos.map(g => (
              <li key={g.id}>{g.kind === 'file'
                ? <a className="h-full min-h-24 flex flex-col items-center justify-center gap-1.5 p-2 rounded-xl border border-line bg-card text-xs text-center break-all hover:bg-green-soft transition-colors duration-[var(--dur-instant)]" href={`/api/media/${g.id}`} download={g.name ?? 'file'}><Icon name="file" className="w-6 h-6 text-green" /><span className="line-clamp-2">{g.name}</span></a>
                : <a className="group/m relative block aspect-square overflow-hidden rounded-xl bg-line" href={`/api/media/${g.id}`} target="_blank" rel="noopener">
                    <img alt={g.name ?? ''} loading="lazy" decoding="async" className="w-full h-full object-cover transition-transform duration-[var(--dur-slow)] ease-[var(--ease-standard)] group-hover/m:scale-105" {...sharpSrc(g, '(min-width: 1280px) 14vw, (min-width: 1024px) 18vw, (min-width: 640px) 25vw, 33vw')} />
                    {g.kind === 'video' && <span className="absolute bottom-1.5 start-1.5 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center"><Icon name="play" className="w-3 h-3" /></span>}
                  </a>}</li>
            ))}
          </ul>
        )}
      {bill && circle.kind === 'circle' && <StorageCard circle={circle} bill={bill} manager={manager} onChanged={() => api<Billing>(`/circles/${circle.id}/billing`).then(setBill).catch(() => {})} />}

      </div>
      <div className={show('members')}>
      <section className="card p-4">
        <h3 className="font-bold mb-2">{t.membersTitle} ({circle.members.length})</h3>
        <ul className="divide-y divide-line">
          {circle.members.map(m => {
            const self = m.id === me.id;
            const canRemove = m.role !== 'owner' && (self || owner || (manager && m.role === 'member'));
            return (
              <li key={m.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex-1 min-w-[6rem]">
                  {m.name}
                  {!self && presence.get(m.id)?.online && <span role="img" aria-label={t.online} title={t.online} className="ms-2 inline-block w-2 h-2 rounded-full bg-green align-middle" />}
                  {m.role === 'owner' && <span className="ms-2 text-xs text-gold-dark">{t.owner}</span>}
                  {m.role === 'admin' && <span className="ms-2 text-xs text-green">{t.roleAdmin}</span>}
                  {m.about && <span className="block text-xs text-muted truncate" dir="auto" title={m.about} data-about>{m.about}</span>}
                </span>
                {!self && <button className="text-xs text-green underline" onClick={() => api<{ id: number }>('/direct', { body: { userId: m.id } }).then(r => { location.hash = `/circle/${r.id}`; }).catch(() => {})}>{t.messagePrivately}</button>}
                {owner && !self && m.role !== 'owner' && (
                  <>
                    <button className="text-xs text-green underline" onClick={() => setRole(m.id, m.role === 'admin' ? 'member' : 'admin')}>
                      {m.role === 'admin' ? t.demote : t.promote}
                    </button>
                    <button className="text-xs text-green underline" onClick={() => transfer(m.id)}>{t.transferOwner}</button>
                  </>
                )}
                {canRemove && <button className="text-xs text-danger underline" onClick={() => removeMember(m.id)}>{self ? t.leave : t.remove}</button>}
              </li>
            );
          })}
        </ul>
      </section>
      {circle.kind === 'circle' && <PeoplePanel circle={circle} manager={manager} />}
      </div>
<div className={show('settings')}>
      {owner && (
        <section className="card p-4 space-y-2 !border-danger/40">
          <h3 className="font-bold text-danger">{t.dangerZone}</h3>
          <button className="btn !bg-red-700" onClick={() => { setDeleting(true); setTyped(''); setDelError(''); }}>{t.deleteCircle}</button>
        </section>
      )}
      {deleting && (
        <Dialog onClose={() => setDeleting(false)} label={t.deleteCircle}>
          <h2 className="text-lg font-bold text-danger">{t.deleteCircle}</h2>
          <p className="text-sm text-muted mt-2">{t.deleteCircleWarn}</p>
          <p className="font-bold my-2">{circle.name}</p>
          <input className="field" autoFocus value={typed} onChange={e => setTyped(e.target.value)} aria-label={circle.name} />
          {delError && <p role="alert" className="text-sm text-danger mt-2">{delError}</p>}
          <div className="mt-4 flex gap-2">
            <button className="btn btn-ghost flex-1" onClick={() => setDeleting(false)}>{t.cancel}</button>
            <button className="btn !bg-red-700 flex-1" disabled={typed.trim() !== circle.name} onClick={deleteCircle}>{t.deleteForever}</button>
          </div>
        </Dialog>
      )}

      {circle.kind !== 'direct' && circle.role !== 'owner' && (
        <section className="card p-4 space-y-2">
          <button className="text-danger font-bold" onClick={() => { if (confirm(t.infoExitNote)) removeMember(me.id); }}>{t.infoExit}</button>
        </section>
      )}
      {circle.createdAt && <p className="text-xs text-muted text-center">{t.infoCreated} {toDate(circle.createdAt).toLocaleDateString(intlLocale(lang), { dateStyle: 'long' })}</p>}
      </div>
      {muteOpen && (
        <Dialog onClose={() => setMuteOpen(false)} label={t.infoNotifications}>
          <h2 className="text-lg font-bold">{t.infoNotifications}</h2>
          <div className="mt-3 flex flex-col gap-2">
            {circle.muted && <button className="btn btn-ghost" onClick={() => setPref({ muted: false })}>{t.unmute}</button>}
            <button className="btn btn-ghost" onClick={() => setPref({ muted: true, muteHours: 8 })}>{t.mute8h}</button>
            <button className="btn btn-ghost" onClick={() => setPref({ muted: true, muteHours: 168 })}>{t.mute1w}</button>
            <button className="btn btn-ghost" onClick={() => setPref({ muted: true })}>{t.muteAlways}</button>
            <button className="btn btn-ghost" onClick={() => setMuteOpen(false)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
      {note && <p role="status" className="text-center text-sm text-green">{note}</p>}
    </div>
  );
}
