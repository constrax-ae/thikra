import { prepare } from './media';
import { AlbumsSection } from './Album';
import { Picker } from './Picker';
import { chime, prefOn } from './prefs';
import { Fragment, useMemo, useCallback, useEffect, useRef, useState, Suspense, lazy } from 'react';
import { api, ApiError, toDate, type Attachment, type GalleryItem, type ArchiveEntry, type Billing, type CircleDetail, type Me, type Message } from './api';
import { useI18n, intlLocale, speechLocale, systemText } from './i18n';
import { Dialog } from './Dialog';
import { live } from './live';
import { Icon } from './icons';
import { QUICK_REACTIONS, ALL_REACTIONS } from '../../core/reactions';
import { Spinner, GridSkeleton, Skeleton, Toggle } from './States';

// The WhatsApp importer carries a chat parser and a draft builder that most families will never open, so it arrives
// only when someone actually taps Import.
const ImportPanel = lazy(() => import('./Import').then(m => ({ default: m.ImportPanel })));

type Tab = 'chat' | 'archive' | 'settings';
export type Panel = null | 'search' | 'starred' | 'media';

/** Delivery state, drawn the way a chat app draws it: one check sent, two delivered,
 *  two in the accent colour once everyone has read it. */
function Ticks({ kind, t }: { kind: 'pending' | 'sent' | 'delivered' | 'read'; t: { tickPending: string; tickSent: string; tickDelivered: string; tickRead: string } }) {
  const label = { pending: t.tickPending, sent: t.tickSent, delivered: t.tickDelivered, read: t.tickRead }[kind];
  if (kind === 'pending') return <Icon name="clock" className="w-3.5 h-3.5" aria-label={label} />;
  return (
    <span role="img" aria-label={label} className={kind === 'read' ? 'text-[var(--bubble-tick)]' : undefined}>
      <Icon name={kind === 'sent' ? 'check' : 'check-double'} className="w-4 h-4" />
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

function DayDivider({ iso, lang, t }: { iso: string; lang: string; t: { today: string; yesterday: string } }) {
  const d = toDate(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const label = diff <= 0 ? t.today : diff === 1 ? t.yesterday
    : d.toLocaleDateString(intlLocale(lang), { day: 'numeric', month: 'long', year: diff > 300 ? 'numeric' : undefined });
  return (
    <div className="flex justify-center my-3">
      <span className="text-caption text-muted bg-card/90 border border-line rounded-full px-3 py-1 backdrop-blur-sm">{label}</span>
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
  if (!held || Date.now() - held.at > 10_000) firstPage.set(id, { at: Date.now(), page: api<Message[]>(`/circles/${id}/messages?after=0`) });
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

  const loadCircle = useCallback(() => api<CircleDetail>(`/circles/${id}`).then(c => { circleCache.set(id, c); setCircle(c); }).catch(onBack), [id, onBack]);
  useEffect(() => { prefetchMessages(id).catch(() => {}); loadCircle(); }, [id, loadCircle]);
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
    try { await api(`/users/${other.id}/block`, { body: { on } }); } catch { setBlocked(!on); }
  }
  if (!circle) return <ChatSkeleton docked={docked} />;

  // A circle has everything; a plain group has no archive; a one-to-one chat is just the chat.
  const tabs: Tab[] = circle.kind === 'direct' ? ['chat'] : circle.kind === 'group' ? ['chat', 'settings'] : ['chat', 'archive', 'settings'];
  return (
    <div className={docked ? 'chat-docked flex flex-col h-full' : 'flex flex-col h-[100dvh] py-2'}>
      <div className="chat-head flex items-center gap-2 mb-3">
        <button className="w-10 h-10 shrink-0 rounded-xl text-muted flex items-center justify-center hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]"
          onClick={onBack} aria-label={t.back} title={t.back}><Icon name="arrow-back" className="w-5 h-5 rtl:-scale-x-100" /></button>
        <span className={`w-10 h-10 shrink-0 flex items-center justify-center font-bold ${circle.kind === 'direct' ? 'rounded-full' : 'rounded-xl'}
          ${circle.kind === 'circle' ? 'bg-brand text-white ring-2 ring-gold/50 ring-offset-2 ring-offset-card' : 'bg-green-soft text-green'}`} aria-hidden>
          {circle.kind === 'group' ? <Icon name="group" className="w-5 h-5" /> : circle.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <h2 className="text-lg font-bold !text-ink truncate leading-tight"><bdi>{circle.name}</bdi></h2>
          {circle.kind !== 'direct' && <span className="block text-caption text-muted truncate">{circle.members.length === 1 ? t.oneMember : `${circle.members.length} ${t.members}`}</span>}
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
        {other && <button className="btn btn-ghost !py-1 text-sm" onClick={toggleBlock}>{blocked ? t.unblock : t.block}</button>}
        {circle.kind === 'circle' && sealedTotal > 0 && <span className="hidden sm:inline-flex shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark" title={t.sealedCount.replace('{n}', String(sealedTotal))}><span className="inline-flex items-center gap-1"><Icon name="envelope" className="w-3.5 h-3.5" />{sealedTotal}</span></span>}
        {circle.kind === 'circle' && !!circle.agentActive && <span className="hidden sm:inline-flex shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark" title={t.agentModeHelp}><span className="inline-flex items-center gap-1"><Icon name="sparkle" className="w-3.5 h-3.5" />{t.agentOn}</span></span>}
      </div>
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
        {tab === 'chat' && <Chat circle={circle} me={me} panel={panel} setPanel={setPanel} onOpenArchive={() => goTab('archive')} />}
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

const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A voice message player like WhatsApp's: play/pause, a seek bar, elapsed/length, and 1x/1.5x/2x speed. */
export const MEMBER_COLOURS = ['#b0235a', '#00796b', '#5b3fc4', '#c2410c', '#1565c0', '#7b4a2a', '#2e7d32', '#8e24aa', '#9a6700', '#c0392b'];
interface Person { id: number; name: string; userId: number | null; relation: string | null; birthDate: string | null; deathDate: string | null }
const nameColour = (userId: number) => MEMBER_COLOURS[Math.abs(userId) % MEMBER_COLOURS.length];
const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function VoicePlayer({ id, ms, mine, author, userId, meta }: { id: number; ms: number | null; mine: boolean; author?: string | null; userId?: number | null; meta?: React.ReactNode }) {
  const { t } = useI18n();
  const el = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(ms ?? 0);
  const [speed, setSpeed] = useState(1);
  const bars = useMemo(() => Array.from({ length: 34 }, (_, i) => 30 + Math.round(((Math.sin(id * 12.9898 + i * 78.233) * 43758.5453) % 1 + 1) % 1 * 60)), [id]);
  const progress = len > 0 ? Math.min(1, pos / len) : 0;

  // `timeupdate` only fires about four times a second, which is why the bar moved in steps.
  // While it is playing we read the clock each frame instead, and stop as soon as it pauses.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => { const a = el.current; if (a) setPos(a.currentTime * 1000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => { const a = el.current; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause(); };
  const cycle = () => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (el.current) el.current.playbackRate = next; };
  const seekTo = (clientX: number) => {
    const box = wave.current?.getBoundingClientRect(); if (!box) return;
    const v = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * Math.max(len, 1);
    setPos(v); if (el.current) el.current.currentTime = v / 1000;
  };
  // Dragging the knob scrubs; the listeners live on the window so the pointer can leave the bar.
  const drag = (e: React.PointerEvent) => {
    e.preventDefault(); seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return (
    <div className="flex items-center gap-2.5 min-w-[14rem] py-0.5">
      <audio ref={el} preload={prefOn('saver') ? 'none' : 'metadata'} src={`/api/messages/${id}/audio`}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={e => { if (!playing) setPos(e.currentTarget.currentTime * 1000); }}
        onLoadedMetadata={e => { const d = e.currentTarget.duration; if (!ms && Number.isFinite(d)) setLen(d * 1000); }} />

      {/* Who recorded it — and, once it is playing, the speed control takes the same slot
          instead of floating in a grey disc of its own. */}
      {playing || speed !== 1 ? (
        <button type="button" onClick={cycle} aria-label={t.playbackSpeed} title={t.playbackSpeed}
          className={`w-9 h-9 rounded-full shrink-0 text-xs font-bold flex items-center justify-center
            transition-colors duration-[var(--dur-instant)] ${mine ? 'bg-current/15' : 'bg-green-soft text-green'}`}>
          {speed}x
        </button>
      ) : (
        <span className="relative shrink-0">
          <span className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-white text-sm"
            style={{ background: userId != null ? nameColour(userId) : 'var(--color-brand)' }} aria-hidden>
            {(author ?? '').trim().slice(0, 1) || '•'}
          </span>
          <span className="absolute -bottom-0.5 -end-0.5 w-4 h-4 rounded-full bg-card text-green flex items-center justify-center" aria-hidden>
            <Icon name="mic" className="w-2.5 h-2.5" />
          </span>
        </span>
      )}

      <button type="button" onClick={toggle} aria-label={playing ? t.pauseVoice : t.playVoice}
        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-fast)] active:scale-90 hover:bg-current/10">
        <Icon name={playing ? 'pause' : 'play'} className="w-5 h-5" />
      </button>

      <div className="flex-1 min-w-0">
        <div ref={wave} onPointerDown={drag}
          className="relative h-7 flex items-center gap-[2px] cursor-pointer touch-none" dir="ltr"
          role="slider" aria-label={t.playVoice} aria-valuemin={0} aria-valuemax={Math.round(len / 1000)} aria-valuenow={Math.round(pos / 1000)}
          tabIndex={0}
          onKeyDown={e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const next = Math.max(0, Math.min(len, pos + (e.key === 'ArrowRight' ? 5000 : -5000)));
            setPos(next); if (el.current) el.current.currentTime = next / 1000;
          }}>
          {bars.map((h, i) => (
            <span key={i} className="flex-1 min-w-[2px] max-w-[3px] rounded-full shrink-0"
              style={{ height: `${h}%`, background: 'currentColor', opacity: i / bars.length <= progress ? 0.95 : 0.28 }} />
          ))}
          {/* The knob rides the same value as the bars, moved with a transform so it animates
              per frame rather than relaying out the row. */}
          <span aria-hidden className="absolute top-1/2 w-3 h-3 rounded-full bg-current shadow-e1 pointer-events-none"
            style={{ insetInlineStart: `${progress * 100}%`, transform: 'translate(-50%, -50%)' }} />
        </div>
        {/* Duration on the left, the message's own time and ticks on the right: one line
            under the wave, the way a voice note reads in any chat app. */}
        <div className="flex items-center justify-between gap-2 -mt-1">
          <span className="text-[11px] tabular-nums opacity-70" dir="ltr">{clock(playing || pos > 0 ? pos : len)}</span>
          {meta}
        </div>
      </div>
    </div>
  );
}

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

// ---- chat ------------------------------------------------------------------

function Chat({ circle, me, panel, setPanel, onOpenArchive }: { circle: CircleDetail; me: Me; panel: Panel; setPanel: React.Dispatch<React.SetStateAction<Panel>>; onOpenArchive: () => void }) {
  const { t, lang } = useI18n();
  const agentReason = useAgentReason();
  const [msgs, setMsgs] = useState<Message[]>(() => pageCache.get(circle.id) ?? []);
  // False until the first page has arrived: an empty list before that means "loading",
  // not "this chat has no messages", and must not say so.
  const [loaded, setLoaded] = useState(() => pageCache.has(circle.id));
  useEffect(() => { pageCache.set(circle.id, msgs.filter(m => !m.pending)); }, [circle.id, msgs]);
  // Drafts (M-13): what you were typing survives leaving the chat and closing the app. Per circle, on this device.
  const draftKey = `thikra_draft_${circle.id}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [del, setDel] = useState<Message | null>(null);
  const [reacting, setReacting] = useState<Message | null>(null);
  // A machine transcript is a tool, not part of the message: shown only when asked for.
  const [transcribed, setTranscribed] = useState<Set<number>>(new Set());
  const [marks, setMarks] = useState(circle.members);                 // each member's delivered/read "up to here"
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  useEffect(() => {
    try { if (text && !editing) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch { /* storage unavailable: no draft, everything else works */ }
  }, [text, editing, draftKey]);
  const [typers, setTypers] = useState<Record<number, number>>({});   // user id -> when to stop showing "typing…"
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
  const loadPins = useCallback(() => api<Message[]>(`/circles/${circle.id}/pins`).then(p => { setPins(p); setPinIdx(0); }).catch(() => {}), [circle.id]);
  useEffect(() => { loadPins(); }, [loadPins]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [light, setLight] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(0);
  const [pending, setPending] = useState<File[]>([]);           // chosen, not sent yet
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = pending.map(f => (f.type.startsWith('image/') ? URL.createObjectURL(f) : ''));
    setPreviews(urls);
    return () => urls.forEach(u => u && URL.revokeObjectURL(u));
  }, [pending]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [recMs, setRecMs] = useState(0);
  const recStart = useRef(0);
  useEffect(() => {
    if (!recording) return;
    const i = setInterval(() => setRecMs(Date.now() - recStart.current), 250);
    return () => clearInterval(i);
  }, [recording]);
  const [fwdTargets, setFwdTargets] = useState<Array<{ id: number; name: string }>>([]);
  const [fwdPick, setFwdPick] = useState<number[]>([]);
  const lastTypingSent = useRef(0);
  const reportedRead = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  // Auto-scrolling on every new message yanks you away from what you were reading.
  // We only follow the conversation while you are already at the bottom; otherwise a
  // button appears and you decide when to jump.
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // `stick` is the live value the scroll handlers read; `atBottom` is the same thing for
  // rendering. A ref is needed because the ResizeObserver below fires outside React.
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stick.current = nearBottom;
    setAtBottom(nearBottom);
  };
  // Scroll the container itself rather than a sentinel element: scrollIntoView stops at the
  // sentinel's box, which left the newest message tucked under the composer.
  const toBottom = (smooth = true) => {
    const el = scroller.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  const lastSeq = useRef(0);
  const lastRev = useRef(0);
  const unsent = useRef(new Map<string, { body: string; replyTo: number | null }>()); // client_msg_id -> what to resend, until acknowledged
  const manager = circle.role === 'owner' || circle.role === 'admin';
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; speech?: any; transcript: string } | null>(null);

  // Merge messages into the screen by seq: a message we already show is replaced by its newer revision, new ones slot in
  // order, and ones still being sent (no seq yet) stay at the bottom.
  const merge = useCallback((incoming: Message[]) => {
    setMsgs(prev => {
      const byId = new Map(prev.map(m => [m.id, m]));
      for (const m of incoming) {
        const held = byId.get(m.id);
        if (!held || (m.rev ?? 0) >= (held.rev ?? 0)) byId.set(m.id, { ...held, ...m });
      }
      return [...byId.values()].sort((x, y) => (x.seq ?? Infinity) - (y.seq ?? Infinity) || x.id - y.id);
    });
  }, []);

  /**
   * Opening (`full`): the latest page. Catching up: everything new OR CHANGED since the last sync reply (rev), oldest first,
   * page by page. The watermark moves only on sync replies, never on pushes, so a lost push is repaired by the next sync.
   */
  const refresh = useCallback(async (full = false) => {
    if (full || lastRev.current === 0) {
      const page = await api<Message[]>(`/circles/${circle.id}/messages?after=0`);
      setMsgs(prev => full ? page : prev);
      if (!full) merge(page);
      lastSeq.current = Math.max(0, ...page.map(m => m.seq ?? 0));
      lastRev.current = Math.max(0, ...page.map(m => m.rev ?? 0));
      return;
    }
    for (let guard = 0; guard < 50; guard++) {
      const got = await api<Message[]>(`/circles/${circle.id}/messages?after_rev=${lastRev.current}`);
      if (got.length) {
        merge(got);
        lastRev.current = Math.max(lastRev.current, ...got.map(m => m.rev ?? 0));
        lastSeq.current = Math.max(lastSeq.current, ...got.map(m => m.seq ?? 0));
      }
      if (got.length < 200) break;
    }
  }, [circle.id, merge]);

  useEffect(() => {
    // The first page was already requested alongside the chat itself (prefetchMessages);
    // use that answer instead of asking again. Later full reloads always go to the server.
    const held = firstPage.get(circle.id);
    firstPage.delete(circle.id);
    const first = held && Date.now() - held.at < 10_000 ? held.page : null;   // an old, unused prefetch is not trusted
    (first
      ? first.then(page => {
          setMsgs(page);
          lastSeq.current = Math.max(0, ...page.map(m => m.seq ?? 0));
          lastRev.current = Math.max(0, ...page.map(m => m.rev ?? 0));
        })
      : refresh(true)
    ).catch(() => refresh(true)).catch(() => {}).finally(() => setLoaded(true));
    // Live: new messages arrive as pushed frames. Polling stays as the safety net: fast while the socket is down, rare while it is up.
    const off = live.on(f => {
      if (f.t === 'open') {
        refresh().catch(() => {}); // (re)connected: catch up on what was missed
        // ...and resend what was never acknowledged. Safe: the server de-duplicates by client_msg_id.
        for (const [cid, u] of unsent.current) live.send({ t: 'send', circle: circle.id, client_msg_id: cid, body: u.body, reply_to: u.replyTo });
      }
      else if (f.t === 'msg' && f.circle === circle.id) {
        const m = f.m as Message;
        if (m.userId && m.userId !== me.id && document.visibilityState === 'visible') chime();   // the in-app sound, if the person wants it
        if (m.userId) setTypers(prev => ({ ...prev, [m.userId!]: 0 })); // they sent it: no longer typing
        // A hole in the sequence means a push was lost: sync now instead of waiting for the safety poll.
        const hole = m.seq !== undefined && lastSeq.current > 0 && m.seq > lastSeq.current + 1;
        lastSeq.current = Math.max(lastSeq.current, m.seq ?? 0);
        if (hole) refresh().catch(() => {});
        merge([m]);
      } else if (f.t === 'pins' && f.circle === circle.id) {
        loadPins();
      } else if (f.t === 'update' && f.circle === circle.id) {
        merge([f.m as Message]);
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
      } else if (f.t === 'typing' && f.circle === circle.id) {
        setTypers(prev => ({ ...prev, [f.user]: f.on === false ? 0 : Date.now() + 4000 }));
      } else if (f.t === 'changed' && f.circle === circle.id) refresh().catch(() => {});
      else if (f.t === 'ack') { unsent.current.delete(f.client_msg_id); setMsgs(prev => prev.filter(x => x.cid !== f.client_msg_id)); }
      else if (f.t === 'err' && f.client_msg_id) {
        unsent.current.delete(f.client_msg_id);
        setMsgs(prev => prev.filter(x => x.cid !== f.client_msg_id));
        setError(t.errors[f.error] ?? t.errors.generic);
      }
    });
    let n = 0;
    const timer = setInterval(() => { if (!live.connected || ++n % 10 === 0) refresh().catch(() => {}); }, 3000);
    return () => { off(); clearInterval(timer); };
  }, [refresh, merge, loadPins, circle.id, t, me.read_receipts]);

  useEffect(() => { api<Message[]>(`/circles/${circle.id}/starred`).then(r => setStarredIds(new Set(r.map(m => m.id)))).catch(() => {}); }, [circle.id]);

  // Search as you type (debounced); the "starred" panel lists your stars instead.
  useEffect(() => {
    if (panel === 'media') { api<GalleryItem[]>(`/circles/${circle.id}/media`).then(setGallery).catch(() => setGallery([])); return; }
    if (panel === 'starred') { api<Message[]>(`/circles/${circle.id}/starred`).then(setResults).catch(() => setResults([])); return; }
    if (panel !== 'search' || query.trim().length < 2) { setResults([]); return; }
    const timer = setTimeout(() => api<Message[]>(`/circles/${circle.id}/search?q=${encodeURIComponent(query.trim())}`).then(setResults).catch(() => setResults([])), 250);
    return () => clearTimeout(timer);
  }, [panel, query, circle.id]);

  async function toggleStar(m: Message) {
    const on = !starredIds.has(m.id);
    setDel(null);
    setStarredIds(prev => { const n = new Set(prev); if (on) n.add(m.id); else n.delete(m.id); return n; });
    try { await api(`/messages/${m.id}/star`, { body: { on } }); } catch { setStarredIds(prev => { const n = new Set(prev); if (on) n.delete(m.id); else n.add(m.id); return n; }); }
  }

  async function openForward(m: Message) {
    setDel(null); setFwd(m); setFwdPick([]);
    api<Array<{ id: number; name: string }>>('/circles').then(setFwdTargets).catch(() => setFwdTargets([]));
  }
  async function doForward() {
    if (!fwd || !fwdPick.length) return;
    const m = fwd; setFwd(null);
    try { await api(`/messages/${m.id}/forward`, { body: { circles: fwdPick } }); setError(''); if (fwdPick.includes(circle.id)) refresh().catch(() => {}); }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  // "Typing…" fades by itself if the person stops (or the frame is lost).
  useEffect(() => { const i = setInterval(() => setTypers(p => Object.values(p).some(v => v > Date.now()) || Object.keys(p).length ? { ...p } : p), 1000); return () => clearInterval(i); }, []);

  // Tell the server how far we have read, whenever the chat is on screen and something newer arrived.
  useEffect(() => {
    const top = Math.max(0, ...msgs.map(m => m.seq ?? 0));
    if (top <= reportedRead.current || document.hidden) return;
    reportedRead.current = top;
    if (!live.send({ t: 'read', circle: circle.id, seq: top })) api(`/circles/${circle.id}/read`, { body: { seq: top } }).catch(() => { reportedRead.current = 0; });
  }, [msgs, circle.id]);
  useEffect(() => {
    const on = () => { if (!document.hidden) { reportedRead.current = 0; setMsgs(m => [...m]); } };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => { if (stick.current) toBottom(false); }, [msgs.length]);
  // A photo that finishes decoding, or a bubble that rewraps, grows the thread after the
  // scroll has already run. Watching the content keeps the latest message in view instead
  // of leaving it hidden behind the composer.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(false); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    // Your own message always brings you back down, even if you had scrolled up.
    stick.current = true; setAtBottom(true);
    if (pending.length) { const list = pending, cap = text; await upload(list, cap); return; }
    const body = text.trim(); if (!body) return;
    setError('');
    if (editing) {   // saving an edit: the text goes back to the same message
      const target = editing;
      setText(''); setEditing(null);
      try { await api(`/messages/${target.id}`, { method: 'PATCH', body: { body } }); }
      catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
      return;
    }
    const quote = replyTo;
    setText(''); setReplyTo(null);
    // Shown at once, marked pending until the server confirms. The client id makes a retry safe (the server de-duplicates).
    const cid = crypto.randomUUID();
    setMsgs(prev => [...prev, { id: -Date.now(), cid, pending: true, userId: me.id, author: me.name, kind: 'text', body, transcript: null,
      hasAudio: 0, archiveStatus: 'none', score: null, category: null, reason: null, createdAt: new Date().toISOString(), deleted: 0, deletedBy: null,
      replyTo: quote ? { id: quote.id, author: quote.author, kind: quote.kind, deleted: false, text: (quote.kind === 'voice' ? quote.transcript : quote.body)?.slice(0, 120) ?? '' } : null }]);
    unsent.current.set(cid, { body, replyTo: quote?.id ?? null });
    if (live.send({ t: 'send', circle: circle.id, client_msg_id: cid, body, reply_to: quote?.id ?? null })) return;
    // Socket down: send over HTTP now; if that works the entry is cleared, if the network is out it stays pending and the socket resends it on reconnect.
    try {
      await api(`/circles/${circle.id}/messages`, { body: { body, client_msg_id: cid, reply_to: quote?.id ?? null } });
      unsent.current.delete(cid);
      setMsgs(prev => prev.filter(x => x.cid !== cid));
      await refresh();
    } catch (err) {
      unsent.current.delete(cid); // the user gets the text back to resend by hand, so it must not also be resent here
      setMsgs(prev => prev.filter(x => x.cid !== cid));
      setText(body); setReplyTo(quote); setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic);
    }
  }

  // Picking files no longer sends them. They wait in a tray above the composer so the
  // message box can be used as a caption first, which is what people expect when they
  // attach a photo — the server has always accepted one, it was just unreachable.
  function attach(files: FileList | null) {
    if (!files?.length) return;
    setPending(p => [...p, ...files].slice(0, 10));
    if (fileInput.current) fileInput.current.value = '';
  }

  async function upload(list: File[], caption: string) {
    stick.current = true; setAtBottom(true);
    setError(''); setUploading(n => n + 1);
    try {
      const prepared = await Promise.all(list.map(prepare));
      const fd = new FormData();
      prepared.forEach(p => { fd.append('file', p.file); fd.append('thumb', p.thumb ?? new Blob([]), 't.jpg'); if (p.w) fd.append('w', String(p.w)); if (p.h) fd.append('h', String(p.h)); });
      const quote = replyTo;
      if (caption.trim()) fd.append('caption', caption.trim());
      if (quote) fd.append('reply_to', String(quote.id));
      fd.append('client_msg_id', crypto.randomUUID());
      await api(`/circles/${circle.id}/attachments`, { form: fd });
      setText(''); setReplyTo(null); setPending([]);
      await refresh();
    } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
    finally { setUploading(n => n - 1); if (fileInput.current) fileInput.current.value = ''; }
  }

  // "Typing…" to the others: at most one frame every 2.5 s while keys are pressed.
  function typed(value: string) {
    setText(value);
    if (value && Date.now() - lastTypingSent.current > 2500) { lastTypingSent.current = Date.now(); live.send({ t: 'typing', circle: circle.id, on: true }); }
  }

  async function react(m: Message, emoji: string) {
    setDel(null);
    try { await api(`/messages/${m.id}/react`, { body: { emoji } }); }
    catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }

  const canEdit = (m: Message) => m.userId === me.id && m.kind === 'text' && !m.deleted && Date.now() - toDate(m.createdAt).getTime() < 15 * 60_000;

  // Ticks, from the members' marks: sent < delivered to everyone else < read by everyone else (only counts reads that are shared).
  const others = marks.filter(x => x.id !== me.id);
  const tick = (m: Message): 'pending' | 'sent' | 'delivered' | 'read' => {
    if (m.pending || !m.seq) return 'pending';
    if (others.length && others.every(o => o.readSeq !== null && o.readSeq >= m.seq!)) return 'read';
    if (others.length && others.every(o => o.deliveredSeq >= m.seq!)) return 'delivered';
    return 'sent';
  };
  const typing = Object.entries(typers).filter(([id, until]) => until > Date.now() && Number(id) !== me.id).map(([id]) => marks.find(x => x.id === Number(id))?.name ?? '');
  // Jumping to a message scrolls it to the middle and flashes a ring round it, so after
  // the gallery or a search result closes you can see where you landed.
  const jumpTo = (id: number) => {
    const el = document.getElementById(`m${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  };

  async function startRec() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const state = { mr, chunks: [] as Blob[], stream, transcript: '', speech: undefined as any };
      mr.ondataavailable = ev => ev.data.size && state.chunks.push(ev.data);
      // Best-effort in-browser transcription so voice notes can be archived (no server-side STT yet).
      const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
      if (SR) {
        const sp = new SR(); sp.lang = speechLocale(lang); sp.continuous = true; sp.interimResults = false;
        sp.onresult = (ev: any) => { for (let i = ev.resultIndex; i < ev.results.length; i++) state.transcript += ev.results[i][0].transcript + ' '; };
        sp.onerror = () => {}; try { sp.start(); } catch { /* already started */ }
        state.speech = sp;
      }
      mr.start(); rec.current = state; recStart.current = Date.now(); setRecMs(0); setRecording(true);
    } catch { setError(t.micDenied); }
  }

  function stopRec() {
    const r = rec.current; if (!r) return;
    r.mr.onstop = async () => {
      r.stream.getTracks().forEach(tr => tr.stop());
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
      const form = new FormData();
      form.append('audio', new File([blob], 'voice', { type: blob.type }));
      form.append('transcript', r.transcript.trim());
      form.append('duration', String(Math.max(1, Date.now() - recStart.current)));
      try { await api(`/circles/${circle.id}/voice`, { form }); await refresh(true); }
      catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
    };
    try { r.speech?.stop(); } catch { /* ignore */ }
    r.mr.stop(); rec.current = null; setRecording(false);
  }

  // As in WhatsApp: the sender can delete for everyone for a limited time, a manager at any time.
  // Two days for a sender, a week for the circle's owner and admins (same rule as the server).
  const canDeleteForEveryone = (m: Message) => { if (m.sealedOn) return m.userId === me.id; const age = Date.now() - toDate(m.createdAt).getTime(); return manager ? age < 7 * 24 * 3600_000 : m.userId === me.id && age < 48 * 3600_000; };

  async function deleteForEveryone(m: Message) {
    setDel(null);
    try { await api(`/messages/${m.id}`, { method: 'DELETE' }); await refresh(true); }
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

  return (
    <div className="chat-root flex flex-col h-full">
      {/* The search / starred / media tools now live in the header, beside the name. */}
      {pins.length > 0 && (() => { const p = pins[Math.min(pinIdx, pins.length - 1)]; return (
        <button type="button" className="flex items-center gap-2 w-full text-start rounded-lg bg-gold/15 text-ink px-3 py-1.5 mb-2 text-sm"
          onClick={() => { jumpTo(p.id); setPinIdx(i => (i + 1) % pins.length); }}>
          <Icon name="pin" className="w-4 h-4 shrink-0" />
          <span className="min-w-0 flex-1"><b className="text-xs text-gold-dark">{t.pinnedLabel}{pins.length > 1 ? ` ${Math.min(pinIdx, pins.length - 1) + 1}/${pins.length}` : ''}</b>
            <span className="block truncate">{p.kind === 'voice' ? <span className="inline-flex items-center gap-1"><Icon name="mic" className="w-3.5 h-3.5" />{t.voiceWord}</span> : p.attachments?.length && !p.body ? <span className="inline-flex items-center gap-1"><Icon name="attach" className="w-3.5 h-3.5" />{p.attachments[0].name ?? ''}</span> : p.body}</span></span>
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
                    <span className="block whitespace-pre-wrap break-words">{r.kind === 'voice' ? r.transcript : r.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div ref={scroller} onScroll={onScroll} className="chat-wall flex-1 overflow-y-auto pb-3">
        {/* Messages start at the top of the thread. (Bottom-anchoring was tried and
            reverted: on a tall desktop window it left a large void above a short chat.) */}
        <div ref={content} className="flex flex-col min-h-full">
        {/* An empty conversation was a large patterned void. Say what the space is for. */}
        {!loaded && msgs.length === 0 && <MessagesSkeleton />}
        {loaded && msgs.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 px-6 animate-fade-in">
            <span className="w-14 h-14 rounded-full bg-green-soft text-green flex items-center justify-center">
              <Icon name="chats" className="w-7 h-7" />
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
        {msgs.map((m, i) => {
          if (m.kind === 'system') return <p key={m.id} className="agent-note text-center text-xs text-muted py-1.5 px-3 mx-auto w-fit max-w-full my-2 flex items-center gap-1.5"><Icon name="sparkle" className="w-3.5 h-3.5 shrink-0 text-gold-dark" />{systemText(m.body, t)}</p>;
          // (the day divider below needs `prev`, so it is computed after the system case)
          const mine = m.userId === me.id;
          // Consecutive messages from the same person within five minutes are one block:
          // the name is written once and the bubbles sit close, the way a conversation reads.
          const prev = msgs[i - 1];
          const grouped = !!prev && prev.kind !== 'system' && prev.userId === m.userId && !prev.deleted && !m.deleted
            && toDate(m.createdAt).getTime() - toDate(prev.createdAt).getTime() < 5 * 60_000;
          const next = msgs[i + 1];
          const lastOfGroup = !(next && next.kind !== 'system' && next.userId === m.userId && !next.deleted && !m.deleted
            && toDate(next.createdAt).getTime() - toDate(m.createdAt).getTime() < 5 * 60_000);
          const gap = grouped ? 'mt-0.5' : 'mt-2';
          // A new calendar day gets a divider, so scrolling back has landmarks.
          const newDay = !prev || toDate(prev.createdAt).toDateString() !== toDate(m.createdAt).toDateString();
          const withDay = (node: React.ReactNode) => newDay
            ? <Fragment key={`d${m.id}`}><DayDivider iso={m.createdAt} lang={lang} t={t} />{node}</Fragment>
            : node;
          // The square corner is the tail: only the last bubble of a block has one, on the
          // side the bubble is anchored to. Logical corners, so it mirrors in Arabic.
          const tail = lastOfGroup ? (mine ? 'rounded-ee-md' : 'rounded-es-md') : '';
          if (m.deleted) {
            return withDay(
              <div key={m.id} id={`m${m.id}`} className={`flex ${gap} ${mine ? 'justify-end' : 'justify-start'}`}>
                <p className="rounded-2xl px-3 py-2 border border-dashed border-line text-muted italic text-sm flex items-center gap-1.5">
                  <Icon name="ban" className="w-3.5 h-3.5 shrink-0" />
                  {m.deletedBy === m.userId ? t.deletedMsg : t.deletedByManager}
                </p>
              </div>,
            );
          }
          const b = badge(m);
          const shown = m.kind === 'voice' ? (transcribed.has(m.id) ? m.transcript : '') : m.body;
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
          return withDay(
            <div key={m.id} id={`m${m.id}`} className={`group/row flex ${gap} animate-slide-up ${mine ? 'justify-end' : 'justify-start'}`}>
              {mine && actions}
              {/* A photo or video message has a fixed width, as in WhatsApp Web: across a wide desktop pane, 85% made a
                  single photo the size of the screen. Text keeps the flexible 85%. */}
              <div className={`group/msg relative ${m.attachments?.some(x => x.kind === 'image' || x.kind === 'video') ? 'w-[min(85%,22rem)]' : 'max-w-[85%]'} rounded-2xl ${tail} px-3 py-2 ${mine ? 'bubble-mine' : 'bubble-other'} ${m.pending ? 'opacity-60' : ''}
                transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)]`}>
                {!mine && !grouped && <div className="text-xs font-bold mb-0.5" style={{ color: nameColour(m.userId ?? 0) }}>{m.author}</div>}
                {m.sealedOn && <div className={`text-[11px] mb-0.5 flex items-center gap-1 ${mine ? 'opacity-80' : 'text-gold-dark'}`}><Icon name="lock" className="w-3 h-3" />{t.sealedOnLabel} {m.sealedOn}</div>}
                {!!m.forwardCount && <div className={`text-[11px] italic mb-0.5 flex items-center gap-1 ${mine ? 'opacity-80' : 'text-muted'}`}><Icon name="forward" className="w-3 h-3" />{m.forwardCount >= 5 ? t.forwardedMany : t.forwarded}</div>}

                {m.replyTo && (
                  <button type="button" onClick={() => jumpTo(m.replyTo!.id)}
                    className={`block w-full text-start mb-1 rounded-lg border-s-4 px-2 py-1 text-xs ${mine ? 'bg-current/15 border-current/60' : 'bg-green-soft border-green'}`}>
                    <b className="block">{m.replyTo.author ?? ''}</b>
                    <span className="line-clamp-2">{m.replyTo.deleted ? <span className="inline-flex items-center gap-1 italic"><Icon name="ban" className="w-3 h-3" />{t.quotedDeleted}</span> : m.replyTo.text}</span>
                  </button>
                )}
                {!!m.attachments?.length && (() => {
                  // A photo should reach the edge of its bubble; padding around it reads as a
                  // document attachment rather than an image someone sent.
                  const flush = (mine || grouped) && !m.replyTo && !m.sealedOn && !m.forwardCount
                    && m.attachments!.every(x => x.kind !== 'file');
                  return (
                  <div className={`${flush ? '-mx-3 -mt-2 mb-1.5 overflow-hidden rounded-t-2xl' : 'mb-1'} grid gap-1 ${m.attachments!.filter(x => x.kind !== 'file').length > 1 ? 'grid-cols-2' : ''}`}>
                    {m.attachments.map(x => x.kind === 'image' ? (
                      <button key={x.id} type="button" onClick={() => setLight(x)} className="block overflow-hidden rounded-lg bg-black/10"
                        style={x.w && x.h ? { aspectRatio: `${x.w} / ${x.h}`, maxHeight: '22rem' } : undefined}>
                        <img alt={x.name ?? ''} loading="lazy" decoding="async" className="w-full h-full object-cover" {...sharpSrc(x, '(min-width: 1024px) 22rem, 80vw')} />
                      </button>
                    ) : x.kind === 'video' ? (
                      <video key={x.id} controls preload={prefOn('saver') ? 'none' : 'metadata'} playsInline className="w-full rounded-lg max-h-96 bg-black" poster={x.thumb ? `/api/media/${x.thumb}` : undefined} src={`/api/media/${x.id}`} />
                    ) : (
                      <a key={x.id} href={`/api/media/${x.id}`} download={x.name ?? 'file'} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${mine ? 'bg-current/15' : 'bg-green-soft'}`}>
                        <Icon name="file" className="w-4 h-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{x.name}</span><span className="text-xs opacity-80">{fmtSize(x.size)}</span>
                      </a>
                    ))}
                  </div>
                  ); })()}
                {m.kind === 'voice' && m.hasAudio ? (
                  <VoicePlayer id={m.id} ms={m.audioMs ?? null} mine={mine} author={m.author} userId={m.userId}
                    meta={
                      <span className={`inline-flex items-center gap-1 text-[11px] ${mine ? 'opacity-70' : 'text-muted'}`}>
                        {starredIds.has(m.id) && <Icon name="star" className="w-3 h-3 shrink-0" aria-label={t.starred} />}
                        <span className="tabular-nums">{toDate(m.createdAt).toLocaleTimeString(intlLocale(lang), { hour: '2-digit', minute: '2-digit' })}</span>
                        {mine && <Ticks kind={tick(m)} t={t} />}
                      </span>
                    } />
                ) : null}
                {(() => {
                  const starred = starredIds.has(m.id);
                  // Voice notes carry the meta inside the player, on the duration line.
                  if (m.kind === 'voice') return shown
                    ? <p dir="auto" className="whitespace-pre-wrap break-words text-sm opacity-75 mt-1.5 pt-1.5 border-t border-current/15">{shown}</p>
                    : null;
                  const meta = (
                    <span className={`inline-flex items-center gap-1 text-[11px] align-bottom ${mine ? 'opacity-70' : 'text-muted'}`}>
                      {/* A star belongs beside the time, not floated into the text, where it
                          pushed the words around and forced the meta onto its own line. */}
                      {starred && <Icon name="star" className="w-3 h-3 shrink-0" aria-label={t.starred} />}
                      <span className="tabular-nums">{toDate(m.createdAt).toLocaleTimeString(intlLocale(lang), { hour: '2-digit', minute: '2-digit' })}</span>
                      {m.editedAt && <span>{t.edited}</span>}
                      {mine && <Ticks kind={tick(m)} t={t} />}
                    </span>
                  );
                  // A plain text message carries its time and ticks on the last line, the way a
                  // chat app does it: an invisible spacer reserves the room, and the meta is
                  // placed in it. Anything richer (media, voice, an edit, an agent badge) keeps
                  // the meta on its own row, where it does not have to fight for space.
                  // (voice has already returned above, so it cannot reach here)
                  const inline = !!shown && !m.attachments?.length && !m.editedAt && !b;
                  if (inline) return (
                    <p dir="auto" className="relative whitespace-pre-wrap break-words">
                      {shown}
                      {/* The gap the meta sits in. It has to cover everything the meta can
                          contain — a star adds width, and too small a reservation means the
                          time lands on top of the text. */}
                      <span aria-hidden className="inline-block" style={{ width: `${(mine ? 4.6 : 3.2) + (starred ? 1 : 0)}rem` }} />
                      <span className="absolute bottom-0 end-0 leading-none pb-[0.1rem]">{meta}</span>
                    </p>
                  );
                  return (
                    <>
                      {shown && <p dir="auto" className="whitespace-pre-wrap break-words">{shown}</p>}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {meta}
                        {b && <button onClick={() => setOpen(open === m.id ? null : m.id)} className={`text-[11px] px-1.5 rounded-full ${b[1]}`}>{b[0]}</button>}
                      </div>
                    </>
                  );
                })()}
                {/* The message menu sits in the bubble's corner on hover, rather than taking
                    permanent space in the meta row. */}

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
              {!mine && actions}
            </div>,
          );
        })}
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
                    try { await api(`/messages/${reporting.id}/report`, { body: { reason: k } }); setReported(true); }
                    catch (err) { setReporting(null); setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
                  }}>{label}</button>
                ))}
              </div>
            </>
          )}
          <button className="btn btn-ghost w-full mt-3" onClick={() => setReporting(null)}>{reported ? t.closePanel : t.cancel}</button>
        </Dialog>
      )}
      {light && (
        <Dialog onClose={() => setLight(null)} label={light.name ?? t.media}>
          <img alt={light.name ?? ''} className="max-w-full max-h-[70vh] mx-auto rounded-lg" src={`/api/media/${light.id}`} />
          <div className="mt-3 flex gap-2">
            <a className="btn flex-1 text-center" href={`/api/media/${light.id}`} download={light.name ?? 'photo.jpg'}>{t.download}</a>
            <button className="btn btn-ghost flex-1" onClick={() => setLight(null)}>{t.closePanel}</button>
          </div>
        </Dialog>
      )}
      {fwd && (
        <Dialog onClose={() => setFwd(null)} label={t.forward}>
          <h2 className="text-lg font-bold">{t.forwardTo}</h2>
          <ul className="mt-3 space-y-1 max-h-64 overflow-y-auto">
            {fwdTargets.map(c => (
              <li key={c.id}>
                <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-green-soft">
                  <input type="checkbox" className="check" checked={fwdPick.includes(c.id)} disabled={!fwdPick.includes(c.id) && fwdPick.length >= 5}
                    onChange={e => setFwdPick(p => e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id))} />
                  {c.name}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <button className="btn flex-1" disabled={!fwdPick.length} onClick={doForward}>{t.forward}</button>
            <button className="btn btn-ghost flex-1" onClick={() => setFwd(null)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
      {typing.length > 0 && (
        <p aria-live="polite" className="text-xs text-muted py-0.5 flex items-center gap-1.5 animate-fade-in">
          <TypingDots />
          {typing.length === 1 ? `${typing[0]}${t.typingOne}` : t.typingMany}
        </p>
      )}
      {(replyTo || editing) && (
        <div className="flex items-center gap-2 rounded-lg bg-green-soft border-s-4 border-green px-3 py-1.5 text-xs mt-1">
          <span className="min-w-0 flex-1">
            <b className="block">{editing ? t.editingMsg : `${t.replyingTo} ${replyTo!.author ?? ''}`}</b>
            <span className="block truncate">{(editing ?? replyTo)!.kind === 'voice' ? (editing ?? replyTo)!.transcript : (editing ?? replyTo)!.body}</span>
          </span>
          <button type="button" aria-label={t.cancel} className="px-2 text-base" onClick={() => { setReplyTo(null); setEditing(null); if (editing) setText(''); }}><Icon name="x" className="w-4 h-4" /></button>
        </div>
      )}
      {uploading > 0 && (
        <p role="status" className="text-xs text-muted py-1 flex items-center gap-2 animate-fade-in">
          <Spinner className="w-3.5 h-3.5" />
          {t.uploading}{uploading > 1 ? ` (${uploading})` : ''}
        </p>
      )}
      {/* One pill holding attach, the text and the microphone, with the send button
          separate and round: the shape people already know from every chat app. */}
      {/* Files waiting to be sent, with the composer acting as the caption box. */}
      {pending.length > 0 && (
        <div className="card p-2 mt-1 flex items-center gap-2 overflow-x-auto animate-slide-up">
          {pending.map((f, i) => (
            <div key={`${f.name}-${i}`} className="relative shrink-0">
              {previews[i]
                ? <img src={previews[i]} alt="" className="w-16 h-16 object-cover rounded-lg border border-line" />
                : <div className="w-16 h-16 rounded-lg border border-line flex flex-col items-center justify-center gap-1 p-1 text-center">
                    <Icon name="file" className="w-5 h-5 text-muted" />
                    <span className="text-[10px] text-muted truncate w-full">{f.name}</span>
                  </div>}
              <button type="button" aria-label={t.cancel} title={t.cancel}
                onClick={() => setPending(p => p.filter((_, n) => n !== i))}
                className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-card border border-line text-muted
                  flex items-center justify-center text-xs leading-none hover:text-danger"><Icon name="x" className="w-3 h-3" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost !px-3 shrink-0" onClick={() => fileInput.current?.click()} aria-label={t.attach} title={t.attach}>
            <Icon name="attach" className="w-4 h-4" />
          </button>
        </div>
      )}
      <form onSubmit={send} className="flex items-end gap-2 pt-2">
        <input ref={fileInput} type="file" multiple hidden accept="image/*,video/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx" onChange={e => attach(e.target.files)} />
        <div className="field-group !rounded-full flex-1 items-center">
          <button type="button" className="field-prefix !border-0 !px-3 text-muted hover:text-green" aria-label={t.attach} title={t.attach} onClick={() => fileInput.current?.click()}>
            <Icon name="attach" className="w-5 h-5" />
          </button>
          <input className="!px-1" value={text} maxLength={4000}
            placeholder={pending.length ? t.addCaption : t.typeMessage}
            onChange={e => typed(e.target.value)} />
          {recording
            ? <span role="status" aria-label={t.recordingNow} className="flex items-center gap-1.5 pe-3 text-sm text-danger tabular-nums" dir="ltr">
                <span aria-hidden className="w-2 h-2 rounded-full bg-danger animate-pulse-soft" />{clock(recMs)}
              </span>
            : null}
          <button type="button" className={`px-3 self-center transition-colors duration-[var(--dur-instant)] ${recording ? 'text-danger' : 'text-muted hover:text-green'}`}
            onClick={recording ? stopRec : startRec} aria-label={recording ? t.stop : t.record} title={recording ? t.stop : t.record}>
            <Icon name={recording ? 'stop' : 'mic'} className="w-5 h-5" />
          </button>
        </div>
        <button className="btn !rounded-full !w-11 !px-0 shrink-0 flex items-center justify-center" disabled={!text.trim() && !pending.length} aria-label={editing ? t.save : t.send} title={editing ? t.save : t.send}>
          <Icon name="send" className="w-5 h-5" />
        </button>
      </form>
      {reacting && <ReactionPicker t={t} onClose={() => setReacting(null)} onPick={e => { const m = reacting; setReacting(null); react(m, e); }} />}
      {del && (
        <Dialog onClose={() => setDel(null)} label={t.messageMenu}>
          <h2 className="text-lg font-bold">{t.messageMenu}</h2>

          <div className="mt-3 flex flex-col gap-2">
            {del.kind === 'voice' && !!del.transcript && (
              <button className="btn btn-ghost" onClick={() => { const id = del.id; setTranscribed(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setDel(null); }}>
                {transcribed.has(del.id) ? t.hideTranscript : t.showTranscript}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => { setReplyTo(del); setEditing(null); setDel(null); }}>{t.reply}</button>
            {del.kind === 'text' && !del.deleted && <button className="btn btn-ghost" onClick={() => openForward(del)}>{t.forward}</button>}
            {del.userId !== me.id && del.kind !== 'system' && !del.deleted && <button className="btn btn-ghost" onClick={() => { setReporting(del); setReported(false); setDel(null); }}>{t.report}</button>}
            {!del.deleted && (pins.some(p => p.id === del.id)
              ? <button className="btn btn-ghost" onClick={async () => { const m = del; setDel(null); await api(`/messages/${m.id}/pin`, { method: 'DELETE' }).catch(() => {}); loadPins(); }}>{t.unpinMessage}</button>
              : <button className="btn btn-ghost" onClick={() => { setPinning(del); setDel(null); }}>{t.pinMessage}</button>)}
            {!!circle.agentActive && !del.deleted && !!del.body && del.archiveStatus !== 'archived' && del.archiveStatus !== 'rejected' && (
              <button className="btn btn-ghost" onClick={() => { const m = del; setDel(null); archiveManually(m); }}>{t.archiveThis}</button>
            )}
            {!del.deleted && del.reason && (del.archiveStatus === 'skipped' || del.archiveStatus === 'rejected') && (
              <p className="text-xs rounded-lg bg-black/5 text-ink p-2">{del.archiveStatus === 'rejected' ? t.rejectedBadge : t.skippedBadge} · {t.score}: {del.score}{del.category ? ` · ${t.cat[del.category]}` : ''}<br />{agentReason(del.reason)}</p>
            )}
            {!del.deleted && <button className="btn btn-ghost" onClick={() => toggleStar(del)}>{starredIds.has(del.id) ? t.unstar : t.star}</button>}
            {canEdit(del) && !del.sealedOn && <button className="btn btn-ghost" onClick={() => { setEditing(del); setReplyTo(null); setText(del.body); setDel(null); }}>{t.edit}</button>}
          </div>
          <h3 className="mt-4 font-bold">{t.deleteMessage}</h3>
          {del.sealedOn && <p className="text-xs text-gold-dark mt-2">{t.sealedProtectedNote}</p>}
          {canDeleteForEveryone(del) && <p className="text-xs text-muted mt-2">{t.deleteNote}</p>}
          <div className="mt-4 flex flex-col gap-2">
            {canDeleteForEveryone(del) && <button className="btn !bg-red-700" onClick={() => deleteForEveryone(del)}>{t.deleteForEveryone}</button>}
            <button className="btn btn-ghost" onClick={() => deleteForMe(del)}>{t.deleteForMe}</button>
            <button className="btn btn-ghost" onClick={() => setDel(null)}>{t.cancel}</button>
          </div>
        </Dialog>
      )}
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
          focus-within:border-green focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-focus)_16%,transparent)]">
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
      <p className="text-sm"><bdi dir="ltr">{t.storUsedOf.replace('{used}', fmtBytes(bill.archivedBytes)).replace('{total}', fmtBytes(bill.quotaBytes))}</bdi></p>
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
        <div aria-hidden className={`w-20 h-20 flex items-center justify-center text-3xl font-bold ${circle.kind === 'direct' ? 'rounded-full' : 'rounded-3xl'}
          ${circle.kind === 'circle' ? 'bg-brand text-white ring-2 ring-gold/50 ring-offset-4 ring-offset-card' : 'bg-green-soft text-green'}`}>
          {circle.kind === 'group' ? <Icon name="group" className="w-9 h-9" /> : [...circle.name][0]?.toUpperCase()}
        </div>
        <h3 className="mt-4 text-2xl font-bold !text-ink tracking-tight break-words">{circle.name}</h3>
        <p className="mt-1 text-sm text-muted">{circle.kind === 'circle' ? t.infoKindCircle : circle.kind === 'group' ? t.infoKindGroup : ''}{circle.kind !== 'direct' && ' · '}{circle.members.length === 1 ? t.oneMember : t.infoMembersCount.replace('{n}', String(circle.members.length))}</p>
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
      {circle.kind === 'group' && owner && (
        <section className="card p-4 space-y-2">
          <button className="btn w-full" onClick={async () => { await api(`/circles/${circle.id}/convert`, { method: 'POST', body: {} }); await reload(); flash(t.saved); }}>{t.convertToCircle}</button>
          <p className="text-sm text-muted">{t.convertNote}</p>
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
                  {m.role === 'owner' && <span className="ms-2 text-xs text-gold-dark">{t.owner}</span>}
                  {m.role === 'admin' && <span className="ms-2 text-xs text-green">{t.roleAdmin}</span>}
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
