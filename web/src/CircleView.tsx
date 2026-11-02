import { prepare } from './media';
import { AlbumsSection } from './Album';
import { chime, prefOn } from './prefs';
import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, toDate, type Attachment, type GalleryItem, type ArchiveEntry, type Billing, type CircleDetail, type Me, type Message } from './api';
import { useI18n, intlLocale, speechLocale, systemText } from './i18n';
import { Dialog } from './Dialog';
import { live } from './live';
import { ImportPanel } from './Import';
import { Icon } from './icons';

type Tab = 'chat' | 'archive' | 'settings';

export function CircleView({ id, me, initialTab, onBack, onLeft }: { id: number; me: Me; initialTab?: Tab; onBack: () => void; onLeft: () => void }) {
  const { t } = useI18n();
  const [circle, setCircle] = useState<CircleDetail | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'chat');
  const [blocked, setBlocked] = useState(false);
  const [sealedTotal, setSealedTotal] = useState(0);

  const loadCircle = useCallback(() => api<CircleDetail>(`/circles/${id}`).then(setCircle).catch(onBack), [id, onBack]);
  useEffect(() => { loadCircle(); }, [loadCircle]);
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
  if (!circle) return null;

  // A circle has everything; a plain group has no archive; a one-to-one chat is just the chat.
  const tabs: Tab[] = circle.kind === 'direct' ? ['chat'] : circle.kind === 'group' ? ['chat', 'settings'] : ['chat', 'archive', 'settings'];
  return (
    <div className="flex flex-col h-[100dvh] py-2">
      <div className="flex items-center gap-2 mb-3">
        <button className="btn btn-ghost !px-3" onClick={onBack} aria-label={t.back}>←</button>
        <h2 className="text-lg font-bold truncate flex-1">{circle.name}</h2>
        {other && <button className="btn btn-ghost !py-1 text-sm" onClick={toggleBlock}>{blocked ? t.unblock : t.block}</button>}
        {circle.kind === 'circle' && sealedTotal > 0 && <span className="text-[11px] px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark" title={t.sealedCount.replace('{n}', String(sealedTotal))}>✉️ {sealedTotal}</span>}
        {circle.kind === 'circle' && !!circle.agentActive && <span className="text-[11px] px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark" title={t.agentModeHelp}>🕯️ {t.agentOn}</span>}
      </div>
      {blocked && <p role="status" className="text-xs text-gold-dark bg-gold/15 rounded-lg p-2 mb-2">{t.blockedNote}</p>}
      {tabs.length > 1 && <div className="flex gap-1 mb-3 border-b border-line">
        {tabs.map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 -mb-px border-b-2 ${tab === k ? 'border-green text-green font-bold' : 'border-transparent text-muted'}`}>
            {t[k]}
          </button>
        ))}
      </div>}
      {tab === 'chat' && circle.kind === 'circle' && <TodayBanner circleId={circle.id} onOpen={() => setTab('archive')} />}
      <div className="flex-1 min-h-0">
        {tab === 'chat' && <Chat circle={circle} me={me} onOpenArchive={() => setTab('archive')} />}
        {tab === 'archive' && <Archive circle={circle} />}
        {tab === 'settings' && <Settings circle={circle} me={me} reload={loadCircle} onLeft={onLeft} openArchive={() => setTab('archive')} />}
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
      <span aria-hidden>{it.type === 'birthday' ? '🎂' : '🕯️'}</span>
      <button className="flex-1 min-w-0 text-start" onClick={it.type === 'memory' ? onOpen : undefined}><span className="line-clamp-2">{text}{more > 0 ? ` (+${more})` : ''}</span></button>
      <button aria-label={t.close} className="text-muted px-1" onClick={() => { setHidden(true); try { localStorage.setItem(`today:${circleId}`, data.day); } catch { /* ignore */ } }}>×</button>
    </div>
  );
}

const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A voice message player like WhatsApp's: play/pause, a seek bar, elapsed/length, and 1x/1.5x/2x speed. */
function VoicePlayer({ id, ms, mine }: { id: number; ms: number | null; mine: boolean }) {
  const { t } = useI18n();
  const el = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(ms ?? 0);
  const [speed, setSpeed] = useState(1);
  // A stable pseudo-waveform from the message id (the real audio is not analysed): the same message always draws the same shape.
  const bars = useMemo(() => Array.from({ length: 32 }, (_, i) => 22 + Math.round(((Math.sin(id * 12.9898 + i * 78.233) * 43758.5453) % 1 + 1) % 1 * 70)), [id]);
  const progress = len > 0 ? Math.min(1, pos / len) : 0;
  const toggle = () => { const a = el.current; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause(); };
  const cycle = () => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (el.current) el.current.playbackRate = next; };
  return (
    <div className="flex items-center gap-2 min-w-[14rem]">
      <audio ref={el} preload={prefOn('saver') ? 'none' : 'metadata'} src={`/api/messages/${id}/audio`}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={e => { const d = e.currentTarget.duration; if (!ms && Number.isFinite(d)) setLen(d * 1000); }} />
      <button type="button" onClick={toggle} aria-label={playing ? t.pauseVoice : t.playVoice}
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-gold text-[#2b3832]`}>{playing ? '❚❚' : '▶'}</button>
      <div className="flex-1 relative h-9 flex items-center gap-[2px]" dir="ltr" aria-hidden
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * Math.max(len, 1); setPos(v); if (el.current) el.current.currentTime = v / 1000; }}>
        {bars.map((h, i) => <span key={i} className="w-[3px] rounded-full shrink-0" style={{ height: `${h}%`, background: i / bars.length <= progress ? 'var(--color-gold)' : 'currentColor', opacity: i / bars.length <= progress ? 1 : 0.3 }} />)}
      </div>
      <input type="range" min={0} max={Math.max(len, pos, 1)} value={pos} aria-label={t.playVoice} className="sr-only"
        onChange={e => { const v = Number(e.target.value); setPos(v); if (el.current) el.current.currentTime = v / 1000; }} />
      <span className="text-[11px] tabular-nums shrink-0" dir="ltr">{clock(playing || pos > 0 ? pos : len)}</span>
      <button type="button" onClick={cycle} aria-label={t.playbackSpeed} className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${mine ? 'bg-current/20' : 'bg-green-soft text-green'}`}>{speed}x</button>
    </div>
  );
}

// Each member has their own colour for their NAME only (messages stay white), like WhatsApp. All reach 4.5:1 on white.
export const MEMBER_COLOURS = ['#b0235a', '#00796b', '#5b3fc4', '#c2410c', '#1565c0', '#7b4a2a', '#2e7d32', '#8e24aa', '#9a6700', '#c0392b'];
const nameColour = (userId: number) => MEMBER_COLOURS[Math.abs(userId) % MEMBER_COLOURS.length];

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
      {manager && editing === null && <button className="btn btn-ghost w-full" onClick={() => open('new')}>＋ {t.addPerson}</button>}
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

function Chat({ circle, me, onOpenArchive }: { circle: CircleDetail; me: Me; onOpenArchive: () => void }) {
  const { t, lang } = useI18n();
  const [msgs, setMsgs] = useState<Message[]>([]);
  // Drafts (M-13): what you were typing survives leaving the chat and closing the app. Per circle, on this device.
  const draftKey = `thikra_draft_${circle.id}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [del, setDel] = useState<Message | null>(null);
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
  const [panel, setPanel] = useState<null | 'search' | 'starred' | 'media'>(null);
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
    refresh(true).catch(() => {});
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
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
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

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setError(''); setUploading(n => n + 1);
    try {
      const list = [...files].slice(0, 10);
      const prepared = await Promise.all(list.map(prepare));
      const fd = new FormData();
      prepared.forEach(p => { fd.append('file', p.file); fd.append('thumb', p.thumb ?? new Blob([]), 't.jpg'); if (p.w) fd.append('w', String(p.w)); if (p.h) fd.append('h', String(p.h)); });
      const caption = text.trim(); const quote = replyTo;
      if (caption) fd.append('caption', caption);
      if (quote) fd.append('reply_to', String(quote.id));
      fd.append('client_msg_id', crypto.randomUUID());
      await api(`/circles/${circle.id}/attachments`, { form: fd });
      setText(''); setReplyTo(null);
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
  const jumpTo = (id: number) => document.getElementById(`m${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });

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
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 pb-2">
        <button className={`btn btn-ghost !py-1 text-sm ${panel === 'search' ? '!border-green' : ''}`} onClick={() => { setQuery(''); setPanel(p => p === 'search' ? null : 'search'); }}><Icon name="search" className="w-4 h-4 inline-block align-[-2px] me-1" />{t.search}</button>
        <button className={`btn btn-ghost !py-1 text-sm ${panel === 'starred' ? '!border-green' : ''}`} onClick={() => setPanel(p => p === 'starred' ? null : 'starred')}><Icon name="star" className="w-4 h-4 inline-block align-[-2px] me-1" />{t.starred}</button>
        <button className={`btn btn-ghost !py-1 text-sm ${panel === 'media' ? '!border-green' : ''}`} onClick={() => setPanel(p => p === 'media' ? null : 'media')}><Icon name="image" className="w-4 h-4 inline-block align-[-2px] me-1" />{t.media}</button>
      </div>
      {pins.length > 0 && (() => { const p = pins[Math.min(pinIdx, pins.length - 1)]; return (
        <button type="button" className="flex items-center gap-2 w-full text-start rounded-lg bg-gold/15 text-ink px-3 py-1.5 mb-2 text-sm"
          onClick={() => { jumpTo(p.id); setPinIdx(i => (i + 1) % pins.length); }}>
          <span aria-hidden>📌</span>
          <span className="min-w-0 flex-1"><b className="text-xs text-gold-dark">{t.pinnedLabel}{pins.length > 1 ? ` ${Math.min(pinIdx, pins.length - 1) + 1}/${pins.length}` : ''}</b>
            <span className="block truncate">{p.kind === 'voice' ? `🎙 ${t.voiceWord}` : p.attachments?.length && !p.body ? `📎 ${p.attachments[0].name ?? ''}` : p.body}</span></span>
        </button>
      ); })()}
      {panel && (
        <div className="card p-3 mb-2 max-h-72 overflow-y-auto">
          {panel === 'media' && (gallery.length === 0 ? <p className="text-sm text-muted">{t.noResults}</p> : (
            <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {gallery.map(g => (
                <li key={g.id}>
                  {g.kind === 'file'
                    ? <a className="block p-2 rounded-lg border border-line text-xs break-words hover:bg-green-soft" href={`/api/media/${g.id}`} download={g.name ?? 'file'}>📄 {g.name}<span className="block text-muted">{fmtSize(g.size)}</span></a>
                    : <button type="button" className="block w-full aspect-square overflow-hidden rounded-lg bg-line" onClick={() => { setPanel(null); setTimeout(() => jumpTo(g.messageId), 50); }}>
                        <img alt={g.name ?? ''} loading="lazy" className="w-full h-full object-cover" src={`/api/media/${g.thumb ?? g.id}`} />
                      </button>}
                </li>
              ))}
            </ul>
          ))}
          {panel === 'search' && <input autoFocus className="field mb-2" value={query} placeholder={t.searchPlaceholder} onChange={e => setQuery(e.target.value)} />}
          {panel !== 'media' && (results.length === 0 ? <p className="text-sm text-muted">{panel === 'search' && query.trim().length < 2 ? '' : t.noResults}</p> : (
            <ul className="divide-y divide-line">
              {results.map(r => (
                <li key={r.id}>
                  <button className="w-full text-start py-2" onClick={() => { setPanel(null); setTimeout(() => jumpTo(r.id), 50); }}>
                    <span className="text-xs text-muted">{r.author} · {toDate(r.createdAt).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    <span className="block whitespace-pre-wrap break-words">{r.kind === 'voice' ? r.transcript : r.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
      <div className="chat-wall flex-1 overflow-y-auto space-y-2 pb-2">
        {msgs.map(m => {
          if (m.kind === 'system') return <p key={m.id} className="agent-note text-center text-xs text-muted py-1.5 px-3 mx-auto w-fit max-w-full">✦ {systemText(m.body, t)}</p>;
          const mine = m.userId === me.id;
          if (m.deleted) {
            return (
              <div key={m.id} id={`m${m.id}`} className={`flex ${mine ? 'justify-start' : 'justify-end'}`}>
                <p className="rounded-2xl px-3 py-2 border border-dashed border-line text-muted italic text-sm">
                  🚫 {m.deletedBy === m.userId ? t.deletedMsg : t.deletedByManager}
                </p>
              </div>
            );
          }
          const b = badge(m);
          const shown = m.kind === 'voice' ? m.transcript : m.body;
          return (
            <div key={m.id} id={`m${m.id}`} className={`flex ${mine ? 'justify-start' : 'justify-end'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${mine ? 'bubble-mine' : 'bubble-other'} ${m.pending ? 'opacity-60' : ''}`}>
                {!mine && <div className="text-xs font-bold mb-0.5" style={{ color: nameColour(m.userId ?? 0) }}>{m.author}</div>}
                {m.sealedOn && <div className={`text-[11px] mb-0.5 ${mine ? 'opacity-80' : 'text-gold-dark'}`}>🔒 {t.sealedOnLabel} {m.sealedOn}</div>}
                {!!m.forwardCount && <div className={`text-[11px] italic mb-0.5 ${mine ? 'opacity-80' : 'text-muted'}`}>↪ {m.forwardCount >= 5 ? t.forwardedMany : t.forwarded}</div>}
                {starredIds.has(m.id) && <span aria-label={t.starred} className={`float-end text-xs ${mine ? 'opacity-80' : 'text-gold-dark'}`}>★</span>}
                {m.replyTo && (
                  <button type="button" onClick={() => jumpTo(m.replyTo!.id)}
                    className={`block w-full text-start mb-1 rounded-lg border-s-4 px-2 py-1 text-xs ${mine ? 'bg-current/15 border-current/60' : 'bg-green-soft border-green'}`}>
                    <b className="block">{m.replyTo.author ?? ''}</b>
                    <span className="line-clamp-2">{m.replyTo.deleted ? `🚫 ${t.quotedDeleted}` : m.replyTo.text}</span>
                  </button>
                )}
                {!!m.attachments?.length && (
                  <div className={`mb-1 grid gap-1 ${m.attachments.filter(x => x.kind !== 'file').length > 1 ? 'grid-cols-2' : ''}`}>
                    {m.attachments.map(x => x.kind === 'image' ? (
                      <button key={x.id} type="button" onClick={() => setLight(x)} className="block overflow-hidden rounded-lg bg-black/10"
                        style={x.w && x.h ? { aspectRatio: `${x.w} / ${x.h}`, maxHeight: '22rem' } : undefined}>
                        <img alt={x.name ?? ''} loading="lazy" className="w-full h-full object-cover" src={`/api/media/${x.thumb ?? x.id}`} />
                      </button>
                    ) : x.kind === 'video' ? (
                      <video key={x.id} controls preload={prefOn('saver') ? 'none' : 'metadata'} playsInline className="w-full rounded-lg max-h-96 bg-black" poster={x.thumb ? `/api/media/${x.thumb}` : undefined} src={`/api/media/${x.id}`} />
                    ) : (
                      <a key={x.id} href={`/api/media/${x.id}`} download={x.name ?? 'file'} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${mine ? 'bg-current/15' : 'bg-green-soft'}`}>
                        <span aria-hidden>📄</span><span className="min-w-0 flex-1 truncate">{x.name}</span><span className="text-xs opacity-80">{fmtSize(x.size)}</span>
                      </a>
                    ))}
                  </div>
                )}
                {m.kind === 'voice' && m.hasAudio ? <VoicePlayer id={m.id} ms={m.audioMs ?? null} mine={mine} /> : null}
                {shown && <p className="whitespace-pre-wrap break-words">{shown}</p>}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className={mine ? 'opacity-70' : 'text-muted'}>
                    {toDate(m.createdAt).toLocaleTimeString(intlLocale(lang), { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {m.editedAt && <span className={mine ? 'opacity-70' : 'text-muted'}>{t.edited}</span>}
                  {mine && (() => { const k = tick(m); return (
                    <span role="img" aria-label={{ pending: t.tickPending, sent: t.tickSent, delivered: t.tickDelivered, read: t.tickRead }[k]}
                      className={k === 'read' ? 'text-[var(--bubble-tick)] font-bold' : 'opacity-80'}>{k === 'pending' ? '🕓' : k === 'sent' ? '✓' : '✓✓'}</span>
                  ); })()}
                  {b && <button onClick={() => setOpen(open === m.id ? null : m.id)} className={`px-1.5 rounded-full ${b[1]}`}>{b[0]}</button>}
                  {!m.pending && <button onClick={() => setDel(m)} aria-label={t.messageMenu} className={`ms-auto px-1 text-base leading-none ${mine ? 'opacity-70' : 'text-muted'}`}>⋯</button>}
                </div>
                {m.archiveStatus === 'archived' && circle.kind === 'circle' && (
                  <div className="agent-card mt-2 p-2 flex items-center gap-2">
                    <span className="agent-orb !w-8 !h-8 !text-base" aria-hidden>🕯️</span>
                    <span className="flex-1 text-sm text-ink"><b className="text-gold-dark">{t.agentCardTitle} ✦</b> <span>{t.archivedBadge}</span></span>
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
                    {t.score}: {m.score} · {m.category ? t.cat[m.category] : '—'}<br />{m.reason}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
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
                  <input type="checkbox" checked={fwdPick.includes(c.id)} disabled={!fwdPick.includes(c.id) && fwdPick.length >= 5}
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
      {typing.length > 0 && <p aria-live="polite" className="text-xs text-muted py-0.5">{typing.length === 1 ? `${typing[0]}${t.typingOne}` : t.typingMany}</p>}
      {(replyTo || editing) && (
        <div className="flex items-center gap-2 rounded-lg bg-green-soft border-s-4 border-green px-3 py-1.5 text-xs mt-1">
          <span className="min-w-0 flex-1">
            <b className="block">{editing ? t.editingMsg : `${t.replyingTo} ${replyTo!.author ?? ''}`}</b>
            <span className="block truncate">{(editing ?? replyTo)!.kind === 'voice' ? (editing ?? replyTo)!.transcript : (editing ?? replyTo)!.body}</span>
          </span>
          <button type="button" aria-label={t.cancel} className="px-2 text-base" onClick={() => { setReplyTo(null); setEditing(null); if (editing) setText(''); }}>✕</button>
        </div>
      )}
      {uploading > 0 && <p role="status" className="text-xs text-muted py-0.5">{t.uploading}</p>}
      <form onSubmit={send} className="flex gap-2 pt-2">
        <input ref={fileInput} type="file" multiple hidden accept="image/*,video/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx" onChange={e => attach(e.target.files)} />
        <button type="button" className="btn btn-ghost" aria-label={t.attach} title={t.attach} onClick={() => fileInput.current?.click()}>📎</button>
        <input className="field" value={text} maxLength={4000} placeholder={t.typeMessage} onChange={e => typed(e.target.value)} />
        <button type="button" className={`btn ${recording ? '!bg-red-700' : 'btn-ghost'}`} onClick={recording ? stopRec : startRec}
          aria-label={recording ? t.stop : t.record}>{recording ? '■' : '🎙'}</button>
        {recording && <span role="status" aria-label={t.recordingNow} className="self-center text-sm text-danger tabular-nums" dir="ltr">● {clock(recMs)}</span>}
        <button className="btn" disabled={!text.trim()}>{editing ? t.save : t.send}</button>
      </form>
      {del && (
        <Dialog onClose={() => setDel(null)} label={t.messageMenu}>
          <h2 className="text-lg font-bold">{t.messageMenu}</h2>
          {!del.deleted && (
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t.react}>
              {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(e => <button key={e} type="button" className="text-2xl px-2 py-1 rounded-xl hover:bg-green-soft" aria-label={e} onClick={() => react(del, e)}>{e}</button>)}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2">
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
              <p className="text-xs rounded-lg bg-black/5 text-ink p-2">{del.archiveStatus === 'rejected' ? t.rejectedBadge : t.skippedBadge} · {t.score}: {del.score}{del.category ? ` · ${t.cat[del.category]}` : ''}<br />{del.reason}</p>
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

  return (
    <div className="h-full overflow-y-auto space-y-4 pb-4">
      <div className="flex gap-2">
        <input className="field" type="search" placeholder={t.searchArchive} value={q} onChange={e => setQ(e.target.value)} />
        {(circle.role === 'owner' || circle.role === 'admin') && (
          <button className="btn btn-ghost whitespace-nowrap" onClick={() => setImporting(v => !v)}>{t.importButton}</button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <select aria-label={t.bookYear} className="field !w-auto" value={bookYear} onChange={e => setBookYear(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => new Date().getFullYear() - i).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <a className="btn btn-ghost" target="_blank" rel="noopener" href={`/api/circles/${circle.id}/book?year=${bookYear}&lang=${lang}`}>📖 {t.bookButton}</a>
      </div>
      {importing && <ImportPanel circle={circle} onDone={load} />}
      <AlbumsSection circle={circle} />
      {rows.length === 0 && <p className="text-muted text-center py-8">{t.emptyArchive}</p>}
      {Object.entries(groups).map(([ym, list]) => (
        <section key={ym}>
          <h3 className="text-sm font-bold text-green mb-2">{month(ym)}</h3>
          <ol className="border-s-2 border-gold/50 ps-4 space-y-3">
            {list.map(e => (
              <li key={e.id} className="card p-3">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="px-2 py-0.5 rounded-full bg-green-soft text-green">{label(e)}</span>
                  {e.pending && <span className="px-2 py-0.5 rounded-full bg-gold/20 text-gold-dark">{t.pendingBadge2}</span>}
                  <span>{e.eventDate}</span>
                  <span>· {e.source === 'manual' ? t.manual : t.auto}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words">{e.summary}</p>
                {!!e.media?.length && (
                  <div className="mt-2 space-y-1">
                    <div className="flex gap-1 overflow-x-auto">{e.media.filter(m => m.kind !== 'voice').map(m => <a key={m.id} href={`/api/album-items/${m.id}/file`} target="_blank" rel="noopener" className="shrink-0"><img alt="" loading="lazy" className="w-16 h-16 object-cover rounded-lg bg-line" src={`/api/album-items/${m.id}/file?thumb=1`} /></a>)}</div>
                    {e.media.filter(m => m.kind === 'voice').map(m => <audio key={m.id} controls preload="none" className="w-full h-8" src={`/api/album-items/${m.id}/file`} />)}
                    <p className="text-[11px] text-muted">{t.albumEventNote}</p>
                  </div>
                )}
                {e.pending && <p className="mt-1 text-xs text-muted">{t.pendingNote}</p>}
                {e.canAct && (
                  <div className="mt-1 flex gap-3 text-xs">
                    {e.pending && <button onClick={() => act(e.id, 'decline')} className="text-danger underline">{t.decline}</button>}
                    {e.status === 'open' && <button onClick={() => act(e.id, 'resolve')} className="text-green underline">{t.markResolved}</button>}
                  </div>
                )}
                {(circle.role === 'owner' || circle.role === 'admin') && !e.protected && <button onClick={() => remove(e.id)} className="mt-1 text-xs text-danger underline">{t.deleteEntry}</button>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

// ---- settings ---------------------------------------------------------------

const fmtBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

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
        <button className="btn btn-ghost" onClick={share}>🔗 {t.inviteShare}</button>
        {canPick && <button className="btn" onClick={pick}>👥 {t.inviteContacts}</button>}
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
      {chapters === null ? null : chapters.length === 0 ? <p className="text-sm text-muted mt-3">{t.storyNoChapters}</p> : (
        <ul className="mt-3 space-y-4 max-h-[60vh] overflow-y-auto">
          {chapters.map(ch => (
            <li key={ch.idx} className="space-y-1">
              <div className="flex items-center gap-2"><input className="field !py-1 flex-1" value={ch.title} maxLength={120} onChange={e => set(ch.idx, { title: e.target.value })} />
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-line text-muted shrink-0">{t.storySource[ch.source] ?? ch.source}</span></div>
              <textarea className="field min-h-40" value={ch.text} onChange={e => set(ch.idx, { text: e.target.value })} />
              <div className="flex items-center gap-2"><button className="btn btn-ghost !py-1" onClick={() => save(ch)}>{t.save}</button>{saved === ch.idx && <span role="status" className="text-xs text-green">✓ {t.saved}</span>}</div>
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
    <section className="card p-4 space-y-2">
      <h3 className="font-bold text-green">{t.storyHead}</h3>
      <label className="block text-sm font-medium">{t.storyName}
        <input className="field mt-1" value={title} maxLength={80} placeholder={t.storyNamePh} onChange={e => setTitle(e.target.value)} onBlur={save} />
      </label>
      <p className="text-xs text-muted">{t.storyNote}</p>
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-ghost" target="_blank" rel="noopener" href={`/api/circles/${circle.id}/book?year=${new Date().getFullYear()}&lang=${lang}`}>📖 {t.bookButton}</a>
        <button className="btn" disabled={busy} onClick={write}>✍️ {t.storyWrite}</button>
        <button className="btn btn-ghost" onClick={() => setEditing(true)}>✏️ {t.storyEdit}</button>
      </div>
      {editing && <StoryEditor circle={circle} onClose={() => setEditing(false)} />}
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

function StorageCard({ circle, bill, manager, onChanged }: { circle: CircleDetail; bill: Billing; manager: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<Array<{ id: string; quotaBytes: number; priceMonthly: number; priceYearly: number; currency: string }>>([]);
  const [live, setLive] = useState<'test' | 'live' | null>(null);
  const [interval, setIntervalKind] = useState<'month' | 'year'>('month');
  const [paidMsg, setPaidMsg] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) api<{ plans: typeof plans; paymentsLive: boolean; paymentsMode: 'test' | 'live' | null }>('/plans').then(r => { setPlans(r.plans); setLive(r.paymentsLive ? r.paymentsMode : null); }).catch(() => {}); }, [open]);
  // back from Stripe's page: the plan is switched on by Stripe's message to the server a moment later, so look again shortly
  useEffect(() => {
    if (!new URLSearchParams(location.search).get('paid')) return;
    setPaidMsg(true); history.replaceState(null, '', location.pathname + location.hash);
    const timers = [2500, 6000, 12000].map(ms => setTimeout(onChanged, ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  async function pay(plan: string) {
    setErr('');
    try { const r = await api<{ url: string }>(`/circles/${circle.id}/checkout`, { body: { plan, interval } }); window.location.href = r.url; }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  async function manage() {
    setErr('');
    try { const r = await api<{ url: string }>(`/circles/${circle.id}/billing-portal`, { body: {} }); window.location.href = r.url; }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  const pct = Math.min(100, (bill.archivedBytes / bill.quotaBytes) * 100);
  const full = bill.archivedBytes >= bill.quotaBytes, almost = !full && pct >= 80;
  async function ask(plan: string) {
    setErr('');
    try { await api(`/circles/${circle.id}/storage-request`, { body: { plan } }); onChanged(); setOpen(false); }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  const price = (p: { priceMonthly: number; priceYearly: number; currency: string }) => p.priceMonthly === 0 ? t.storFreeLine : `${p.priceMonthly} ${p.currency} ${t.storPerMonth} · ${p.priceYearly} ${p.currency} ${t.storPerYear}`;
  return (
    <section className="card p-4 space-y-2">
      <h3 className="font-bold">{t.storage}</h3>
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
      {bill.request?.status === 'granted' && <p className="text-xs text-green">✓ {t.storGranted}</p>}
      {bill.request?.status === 'declined' && <p className="text-xs text-muted">{t.storDeclined}</p>}
      {paidMsg && <p role="status" className="text-sm text-green bg-green-soft rounded-lg p-2">{t.payPaidThanks}</p>}
      {bill.periodEnd && bill.plan !== 'free' && <p className="text-xs text-muted">{t.payRenews}: <bdi dir="ltr">{bill.periodEnd.slice(0, 10)}</bdi></p>}
      {manager && bill.stripe && <button className="btn btn-ghost w-full" onClick={manage}>{t.payManage}</button>}
      {err && !open && <p role="alert" className="text-sm text-danger">{err}</p>}
      {manager ? <button className="btn w-full" onClick={() => setOpen(true)}>{t.storGetMore}</button> : <p className="text-xs text-muted">{t.storManagersOnly}</p>}
      {open && (
        <Dialog onClose={() => setOpen(false)} label={t.storGetMore}>
          <h2 className="text-lg font-bold">{t.storPlansTitle}</h2>
          <ul className="mt-3 space-y-2">
            {plans.map(p => (
              <li key={p.id} className={`border rounded-xl p-3 ${p.id === bill.plan ? 'border-green bg-green-soft' : 'border-line'}`}>
                <div className="flex items-center gap-2"><b className="flex-1">{t.plans[p.id]} · <bdi dir="ltr">{fmtBytes(p.quotaBytes)}</bdi></b>{p.id === bill.plan && <span className="text-xs text-green">{t.storCurrent}</span>}</div>
                <p className="text-sm text-muted">{price(p)}</p>
                {live && p.id !== 'free' && p.id !== bill.plan && p.quotaBytes > bill.quotaBytes && <button className="btn w-full mt-2" onClick={() => pay(p.id)}>{t.payPay} · {interval === 'year' ? `${p.priceYearly} ${p.currency}` : `${p.priceMonthly} ${p.currency}`}</button>}
                {!live && p.id !== 'free' && p.id !== bill.plan && p.quotaBytes > bill.quotaBytes && bill.request?.status !== 'open' && <button className="btn btn-ghost w-full mt-2" onClick={() => ask(p.id)}>{t.storRequest}</button>}
              </li>
            ))}
          </ul>
          {live && <div className="flex gap-2 mt-3" role="group">{(['month', 'year'] as const).map(k => <button key={k} aria-pressed={interval === k} onClick={() => setIntervalKind(k)} className={`flex-1 rounded-full border px-3 py-1 text-sm ${interval === k ? 'bg-green text-white border-green' : 'border-line text-muted'}`}>{k === 'month' ? t.payMonthly : t.payYearly}</button>)}</div>}
          {live === 'test' && <p className="text-xs text-gold-dark bg-gold/15 rounded-lg p-2 mt-2">{t.payTest}</p>}
          {!live && <p className="text-xs text-muted mt-3">{t.storNoPayments}</p>}
          {err && <p role="alert" className="text-sm text-danger mt-2">{err}</p>}
          <button className="btn btn-ghost w-full mt-3" onClick={() => setOpen(false)}>{t.cancel}</button>
        </Dialog>
      )}
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
    <div className="h-full overflow-y-auto flex flex-col gap-4 pb-4">
      <section className="text-center space-y-2 pt-1">
        <div className="mx-auto w-20 h-20 rounded-full bg-green-soft text-green flex items-center justify-center text-3xl font-bold" aria-hidden>{[...circle.name][0]}</div>
        <h3 className="text-xl font-bold break-words">{circle.name}</h3>
        <p className="text-sm text-muted">{circle.kind === 'circle' ? t.infoKindCircle : circle.kind === 'group' ? t.infoKindGroup : ''}{circle.kind !== 'direct' && ' · '}{circle.members.length === 1 ? t.oneMember : t.infoMembersCount.replace('{n}', String(circle.members.length))}</p>
        <div className="grid grid-cols-3 gap-2 pt-1">
          <button className="card p-2 text-sm min-w-0" aria-pressed={!!circle.muted} onClick={() => circle.muted ? setPref({ muted: false }) : setMuteOpen(true)}>{circle.muted ? '🔕' : '🔔'}<span className="block">{circle.muted ? t.infoMuted : t.infoMute}</span></button>
          <button className="card p-2 text-sm min-w-0" aria-pressed={!!circle.favourite} onClick={() => setPref({ favourite: !circle.favourite })}>{circle.favourite ? '★' : '☆'}<span className="block">{t.infoFavourite}</span></button>
          {circle.kind !== 'direct' && <button className="card p-2 text-sm min-w-0" onClick={() => setSub('members')}>＋<span className="block">{t.infoInvite}</span></button>}
        </div>
      </section>
      {bill && circle.kind === 'circle' && bill.archivedBytes / bill.quotaBytes >= 0.8 && (
        <button className="text-sm rounded-lg p-2 bg-gold/15 text-gold-dark text-start" onClick={() => setSub('media')}>{bill.archivedBytes >= bill.quotaBytes ? t.storFullMsg : t.storAlmost}</button>
      )}
      <div role="tablist" className="flex justify-center gap-1">
        {sections.map(k => (
          <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}
            className={`px-4 py-1.5 rounded-full border text-sm ${sub === k ? 'bg-card border-green text-green font-bold' : 'border-transparent text-muted'}`}>
            {k === 'members' ? t.infoMembers : k === 'media' ? t.infoMedia : t.infoSettings}
          </button>
        ))}
      </div>
      <section className={show('settings', 'card p-0 divide-y divide-line')}>
        <button className="w-full flex items-center gap-3 p-4 text-start" onClick={() => setMuteOpen(true)}>
          <span aria-hidden>{circle.muted ? '🔕' : '🔔'}</span><span className="flex-1">{t.infoNotifications}</span><span className="text-sm text-muted">{muteLabel}</span>
        </button>
        <p className="px-4 py-2 text-xs text-muted">{t.infoNotifNote}</p>
      </section>
      {circle.kind === 'circle' && manager && <div className={show('settings')}><StoryCard circle={circle} reload={reload} /></div>}
      {circle.kind === 'circle' && (
        <section className={show('settings', 'card p-0 divide-y divide-line')}>
          <h3 className="px-4 pt-3 font-bold text-green">{t.thekraHead}</h3>
          <button className="w-full flex items-center gap-3 p-4 text-start" onClick={openArchive}><span aria-hidden>🗂</span><span className="flex-1">{t.thekraArchive}</span><span className="text-sm text-muted">{circle.agentActive ? t.agentOn : t.agentOff}</span></button>
          <button className="w-full flex items-center gap-3 p-4 text-start" onClick={openArchive}><span aria-hidden>📔</span><span className="flex-1">{t.thekraAlbums}</span></button>
          <a className="flex items-center gap-3 p-4" target="_blank" rel="noopener" href={`/api/circles/${circle.id}/book?year=${new Date().getFullYear()}&lang=${lang}`}><span aria-hidden>📖</span><span className="flex-1">{t.bookButton}</span></a>
          <a className="flex items-center gap-3 p-4" href="#/sealed"><span aria-hidden>✉️</span><span className="flex-1">{t.thekraSealed}</span></a>
          <p className="px-4 py-2 text-xs text-muted">{t.thekraNote}</p>
        </section>
      )}
      <div className={show('settings')}>
      {circle.kind === 'group' && owner && (
        <section className="card p-4 space-y-2">
          <button className="btn w-full" onClick={async () => { await api(`/circles/${circle.id}/convert`, { method: 'POST', body: {} }); await reload(); flash(t.saved); }}>{t.convertToCircle}</button>
          <p className="text-sm text-muted">{t.convertNote}</p>
        </section>
      )}
      <section className="card p-4">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={receipts} onChange={e => setReceiptsOn(e.target.checked)} />
          <span><b>{t.readReceipts}</b><span className="block text-sm text-muted">{t.readReceiptsNote}</span></span>
        </label>
      </section>
      {circle.kind === 'circle' && (
        <section className="card p-4 space-y-2">
          <h3 className="font-bold">{t.agentInfoTitle}</h3>
          <p className="text-sm font-bold">✦ {t.agentReadsTitle}</p>
          <ul className="text-sm space-y-1">{t.agentReads.map(x => <li key={x}>✓ {x}</li>)}</ul>
          <p className="text-sm font-bold pt-1">🔒 {t.agentNeverTitle}</p>
          <ul className="text-sm space-y-1">{t.agentNever.map(x => <li key={x}>✕ {x}</li>)}</ul>
        </section>
      )}
      {manager && (
        <section className="card p-4 space-y-3">
          {circle.kind === 'circle' && <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1.5 w-5 h-5 accent-[var(--color-gold)]" checked={!!circle.agentActive}
              onChange={e => patch({ agentActive: e.target.checked })} />
            <span><b>{t.agentMode}</b><span className="block text-sm text-muted">{t.agentModeHelp}</span></span>
          </label>}
          {circle.kind === 'circle' && <div>
            <label className="block text-sm font-medium mb-1">{t.sensitivity}</label>
            <select className="field" value={circle.sensitivity} onChange={e => patch({ sensitivity: e.target.value })}>
              {(['strict', 'medium', 'lenient'] as const).map(s => <option key={s} value={s}>{t.sens[s]}</option>)}
            </select>
          </div>}
          <div>
            <label className="block text-sm font-medium mb-1">{t.invitePolicy}</label>
            <select className="field" value={circle.invitePolicy} onChange={e => patch({ invitePolicy: e.target.value })}>
              {(['admins', 'members'] as const).map(p => <option key={p} value={p}>{t.invitePolicies[p]}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-3">
            <input type="checkbox" className="w-5 h-5 accent-[var(--color-gold)]" checked={circle.inviteEnabled}
              onChange={e => patch({ inviteEnabled: e.target.checked })} />
            <span>{t.inviteEnabled}</span>
          </label>
        </section>
      )}

      </div>
      <div className={show('members')}>
      {circle.inviteCode ? (
        <section className="card p-4 space-y-2">
          <h3 className="font-bold">{t.invite}</h3>
          <p className="text-sm text-muted">{t.shareCode}</p>
          <div className="flex gap-2">
            <code className="field !bg-paper text-center select-all" dir="ltr">{circle.inviteCode}</code>
            <button className="btn btn-ghost" onClick={copy}>{t.copy}</button>
          </div>
          <ContactInvite circle={circle} />
          {manager && <button className="text-xs text-green underline" onClick={regenerate}>{t.regenerate}</button>}
        </section>
      ) : !circle.inviteEnabled && <p className="text-sm text-muted text-center">{t.inviteOff}</p>}

      </div>
      <div className={show('media')}>
        {photos === null ? null : photos.length === 0 ? <p className="text-sm text-muted text-center">{t.infoMediaNone}</p> : (
          <ul className="grid grid-cols-3 sm:grid-cols-4 gap-1">
            {photos.map(g => (
              <li key={g.id}>{g.kind === 'file'
                ? <a className="block p-2 rounded-lg border border-line text-xs break-words" href={`/api/media/${g.id}`} download={g.name ?? 'file'}>📄 {g.name}</a>
                : <a className="block aspect-square overflow-hidden rounded-lg bg-line" href={`/api/media/${g.id}`} target="_blank" rel="noopener"><img alt={g.name ?? ''} loading="lazy" className="w-full h-full object-cover" src={`/api/media/${g.thumb ?? g.id}`} /></a>}</li>
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
