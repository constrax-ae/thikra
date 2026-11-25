import { useMediaUrl } from './E2eeUi';
import { Icon } from './icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Message } from './api';
import { useI18n, speechLocale, LANG_INFO } from './i18n';
import { prefOn } from './prefs';
import { useTranscribe } from './Privacy';
import { bars as toBars, gesture, nextSpeed, nextVoiceNote, smoothTime, MAX_MS, MIN_MS, TAP_MS, type Clock } from './voice';
import type { DraftStore, RecDraft } from './mediastore';

export const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const SPEED_KEY = 'thikra_voice_speed';
const savedSpeed = () => { try { const v = Number(localStorage.getItem(SPEED_KEY)); return v === 1.5 || v === 2 ? v : 1; } catch { return 1; } };

/** How many of the newest loudness readings (one every 0.1 s) the live meter keeps: more than fit, the oldest scroll off. */
const LIVE_BARS = 900;
/** One bar and its gap, in pixels: how many bars a line of a given width holds. */
const BAR_PX = 5;

/** How many bars fit the element's width right now, kept up to date as it resizes (a phone turning, a window narrowing). */
function useBarsThatFit(ref: React.RefObject<HTMLElement | null>, fallback = 48) {
  const [n, setN] = useState(fallback);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setN(Math.max(12, Math.floor(el.clientWidth / BAR_PX)));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return n;
}

/** Loudness (0-100, from the meter) to a bar height. A square-root curve, so ordinary speaking voice shows as a real waveform. */
const liveHeight = (p: number) => Math.max(0.12, Math.min(1, Math.sqrt(p / 55)));

/**
 * The meter while recording, as WhatsApp draws it: thin bars packed together, the newest at the end (next to pause), growing
 * back towards the timer; as many as the line holds (it is measured), so a long recording fills the whole line and then scrolls.
 */
function LiveWave({ peaks }: { peaks: number[] }) {
  const { lang } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const fit = useBarsThatFit(box, 60);
  const shown = peaks.slice(-fit);
  const rtl = LANG_INFO[lang as keyof typeof LANG_INFO]?.rtl ?? false;
  return (
    <div ref={box} className="flex-1 min-w-0 h-8 overflow-hidden flex items-center justify-end gap-[2px]" dir={rtl ? 'rtl' : 'ltr'} aria-hidden data-live-wave>
      {shown.map((p, i) => (
        <span key={peaks.length - shown.length + i} className="shrink-0 w-[3px] h-full rounded-full bg-current origin-center"
          style={{ transform: `scaleY(${liveHeight(p)})` }} />
      ))}
    </div>
  );
}

/**
 * Listening to a paused or kept recording before sending it, laid out as WhatsApp does: play/pause, the time, then the whole
 * recording's waveform across the rest of the line with the dot that slides as it plays (drag it to move).
 */
function DraftPreview({ src, peaks, ms }: { src: string | null; peaks: number[]; ms: number }) {
  const { t } = useI18n();
  const el = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const fit = useBarsThatFit(box);
  const bars = useMemo(() => toBars(peaks, fit), [peaks, peaks.length, fit]);   // the same array grows when a paused recording is resumed and paused again
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const total = ms || 1;
  return (
    <>
      {src && <audio ref={el} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={e => { setPos(e.currentTarget.currentTime * 1000); setPlaying(false); }}
        onEnded={() => { setPlaying(false); setPos(0); }} onTimeUpdate={e => setPos(e.currentTarget.currentTime * 1000)} />}
      <button type="button" disabled={!src} onClick={() => { const a = el.current; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause(); }}
        aria-label={playing ? t.pauseVoice : t.listenRec} className={`w-9 h-9 -ms-1.5 rounded-full shrink-0 flex items-center justify-center text-muted hover:text-ink disabled:opacity-40 transition-colors duration-[var(--dur-instant)] ${playing ? 'bg-green-soft !text-ink' : 'hover:bg-green-soft'}`}>
        <Icon name={playing ? 'pause' : 'play'} className="w-5 h-5" />
      </button>
      <span className="rec-time shrink-0 min-w-[2.5rem]" dir="ltr">{clock(playing || pos > 0 ? pos : total)}</span>
      <span ref={box} className="flex-1 min-w-0 flex text-green ps-1.5 pe-1">
        <Wave bars={bars} progress={Math.min(1, pos / total)} audio={el} playing={playing} lenMs={total}
          onSeek={src ? f => { setPos(f * total); if (el.current && Number.isFinite(el.current.duration)) el.current.currentTime = f * el.current.duration; } : undefined} label={t.listenRec} />
      </span>
    </>
  );
}

/**
 * The bars of a waveform. In a voice note the part already played takes the accent colour (click or drag anywhere to move
 * through it); while recording (`live`) every bar is lit. Bars grow with a transform, not a height, so the live meter stays smooth.
 */
function Wave({ bars, progress, onSeek, label, live, audio, playing, lenMs }: {
  bars: number[]; progress: number; onSeek?: (fraction: number) => void; label?: string; live?: boolean;
  /** While a note plays, the filled part and the dot follow the audio on every frame. */
  audio?: React.RefObject<HTMLAudioElement | null>; playing?: boolean; lenMs?: number;
}) {
  const { lang } = useI18n();
  // As in WhatsApp: in Arabic the recording runs from the right, like the text, and fills right to left.
  const rtl = LANG_INFO[lang as keyof typeof LANG_INFO]?.rtl ?? false;
  const dragging = useRef(false);
  const fill = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const at = (e: React.PointerEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); const x = rtl ? r.right - e.clientX : e.clientX - r.left; return Math.max(0, Math.min(1, x / r.width)); };
  // Painted straight onto the elements (no React render per frame): the accent copy of the bars is clipped to the played part,
  // and the dot slides with a transform, which the browser moves on the compositor.
  const paint = (f: number) => {
    const p = Math.max(0, Math.min(1, f)) * 100;
    if (fill.current) fill.current.style.clipPath = rtl ? `inset(0 0 0 ${(100 - p).toFixed(3)}%)` : `inset(0 ${(100 - p).toFixed(3)}% 0 0)`;
    if (dot.current) dot.current.style.transform = `translate3d(${rtl ? 50 - p * (dot.current.parentElement!.clientWidth / dot.current.clientWidth) : -50 + p * (dot.current.parentElement!.clientWidth / dot.current.clientWidth)}%, -50%, 0)`;
  };
  const progressRef = useRef(progress); progressRef.current = progress;
  useEffect(() => { if (!playing) paint(progress); }, [progress, playing, rtl]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing || !audio?.current) return;
    let frame = 0, memo: Clock | null = null;
    const step = () => {
      const a = audio.current;
      const total = a && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (lenMs ?? 0) / 1000;
      if (a && total > 0) { const r = smoothTime(memo, a.currentTime, performance.now(), a.playbackRate || 1); memo = r.memo; paint(r.time / total); }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, lenMs, audio, rtl]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Many bars (a draft's whole recording) sit closer together, so they still fit a phone; a chat bubble keeps its 2px gaps.
  const gap = bars.length > 60 ? 'gap-px' : 'gap-[2px]';
  const row = (lit: boolean) => bars.map((h, i) => (
    <span key={i} className="flex-1 max-w-[3px] min-w-px h-full rounded-full origin-center"
      style={{ transform: `scaleY(${Math.max(14, Math.min(100, h)) / 100})`, background: lit ? 'var(--voice-accent, currentColor)' : 'currentColor', opacity: lit ? 1 : 0.34 }} />
  ));
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight', back = rtl ? 'ArrowRight' : 'ArrowLeft';
  return (
    <div className={`flex-1 min-w-0 relative h-9 touch-none select-none ${onSeek ? 'cursor-pointer' : ''}`} dir={rtl ? 'rtl' : 'ltr'}
      role={onSeek ? 'slider' : undefined} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} tabIndex={onSeek ? 0 : undefined}
      onKeyDown={e => { if (!onSeek) return; if (e.key === forward) onSeek(Math.min(1, progress + 0.05)); if (e.key === back) onSeek(Math.max(0, progress - 0.05)); }}
      onPointerDown={e => { if (!onSeek) return; dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still seeks where it was pressed */ } const f = at(e); paint(f); onSeek(f); }}
      onPointerMove={e => { if (onSeek && dragging.current) { const f = at(e); paint(f); onSeek(f); } }}
      onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
      <div className={`absolute inset-0 overflow-hidden flex items-center justify-between ${gap}`}>{row(!!live)}</div>
      {!live && <div ref={fill} aria-hidden data-wave-fill className={`absolute inset-0 overflow-hidden flex items-center justify-between ${gap} pointer-events-none`} style={{ clipPath: rtl ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)' }}>{row(true)}</div>}
      {!live && onSeek && (
        <span ref={dot} aria-hidden data-wave-dot className="absolute top-1/2 w-3 h-3 rounded-full pointer-events-none will-change-transform"
          style={{ [rtl ? 'right' : 'left']: 0, background: 'var(--voice-accent, currentColor)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--voice-accent, currentColor) 25%, transparent)', transform: `translate3d(${rtl ? 50 : -50}%, -50%, 0)` }} />
      )}
    </div>
  );
}

/** Each voice note on screen, by message id: how to start it. Used to play the next one when one ends. */
const players = new Map<number, () => void>();
/** The note after `endedId` in the chat on screen, if it is a voice note right after it (see nextVoiceNote). */
function playNextAfter(endedId: number, from: HTMLElement | null) {
  if (!prefOn('voiceNext')) return;
  const wall = from?.closest('[data-chat-wall]') ?? document;
  const order = [...wall.querySelectorAll<HTMLElement>('[id^="m"]')].filter(el => /^m\d+$/.test(el.id))
    .map(el => ({ id: Number(el.id.slice(1)), voice: !!el.querySelector('[data-voice-player]') }));
  const next = nextVoiceNote(order, endedId);
  const play = next === null ? undefined : players.get(next);
  if (!play) return;
  document.getElementById(`m${next}`)?.scrollIntoView({ block: 'nearest', behavior: prefOn('motion') ? 'smooth' : 'auto' });
  play();
}

/**
 * A voice note in the chat, laid out as one card:
 *   [ play ]  ▂▅▇▃▆▂▅▇▃  [ 1x ]
 *             🎙 0:12 · Show text            12:14 ✓✓
 *             ┌ the text, when it is shown ┐
 * Play/pause, the real waveform (drag to seek), the speed (1x / 1.5x / 2x, remembered), its length and whether it was played,
 * and the text: the sender's own transcript if it came with one, otherwise (in a chat the server can read) a transcription
 * asked for on this device. A listener's first play is reported to the server once.
 */
export function VoiceMessage({ m, mine, meId, others, meta, after, open, onOpen, canTranscribe }: {
  m: Message; mine: boolean; meId: number; others: number;
  /** The time, ticks, star: the bubble's usual meta, placed at the end of the second row. */
  meta: React.ReactNode;
  /** Anything the bubble adds under it (a failed-send line, the archive badge). */
  after?: React.ReactNode;
  /** Whether the text is shown (kept by the chat, so the message menu can toggle it too). */
  open: boolean; onOpen: (open: boolean) => void;
  canTranscribe: boolean;
}) {
  const { t } = useI18n();
  const el = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(m.audioMs ?? 0);
  const [speed, setSpeed] = useState(savedSpeed);
  const told = useRef(false);
  const encSrc = useMediaUrl(m.encrypted ? m.attachments?.[0] : undefined);   // an encrypted voice note is fetched, checked and decrypted on this device
  // The real shape, measured by the sender's device. Older notes have none: a stable made-up shape from the message id.
  const shape = useMemo(() => (m.waveform?.length ? m.waveform : Array.from({ length: 40 }, (_, i) => 22 + Math.round(((Math.sin(m.id * 12.9898 + i * 78.233) * 43758.5453) % 1 + 1) % 1 * 70))), [m.id, m.waveform]);
  const progress = len > 0 ? Math.min(1, pos / len) : 0;
  const playedBy = m.playedBy ?? [];
  const played = mine ? others > 0 && playedBy.length >= others : playedBy.includes(meId);
  const own = m.transcript?.trim() || null;
  const server = useTranscribe(m, () => onOpen(true));
  const text = own ?? (canTranscribe ? server.text : null);
  const canText = !!own || canTranscribe;
  const shown = open && !!text;
  const toggleText = () => { if (open) onOpen(false); else if (text) onOpen(true); else server.start(); };
  const toggle = () => { const a = el.current; if (!a) return; a.playbackRate = speed; if (a.paused) a.play().catch(() => {}); else a.pause(); };
  // Registered so the note before this one can start it when it ends. The speed is read when it starts (it may have changed).
  useEffect(() => {
    const start = () => { const a = el.current; if (!a) return; a.currentTime = 0; a.playbackRate = savedSpeed(); a.play().catch(() => {}); };
    players.set(m.id, start);
    return () => { if (players.get(m.id) === start) players.delete(m.id); };
  }, [m.id]);
  // The page went away (another app, a call, the screen locked): stop rather than talk into an empty room.
  useEffect(() => {
    const onHide = () => { if (document.hidden && el.current && !el.current.paused) el.current.pause(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);
  const cycle = () => { const next = nextSpeed(speed); setSpeed(next); if (el.current) el.current.playbackRate = next; try { localStorage.setItem(SPEED_KEY, String(next)); } catch { /* not remembered */ } };
  const seek = (f: number) => { const v = f * Math.max(len, 1); setPos(v); if (el.current) el.current.currentTime = v / 1000; };
  const started = () => {
    // MED-02: one player at a time on this device. Starting this one stops whatever was playing, including a video,
    // rather than leaving two voices talking over each other.
    for (const other of document.querySelectorAll<HTMLMediaElement>('audio, video')) if (other !== el.current && !other.paused) other.pause();
    setPlaying(true);
    if (!mine && !played && !told.current) { told.current = true; api(`/messages/${m.id}/played`, { method: 'POST', body: {} }).catch(() => { told.current = false; }); }
  };
  const time = clock(playing || pos > 0 ? pos : len);
  return (
    <div ref={box} data-voice-player className="voice-note w-full">
      <audio ref={el} preload={prefOn('saver') ? 'none' : 'metadata'} src={m.encrypted ? encSrc ?? undefined : `/api/messages/${m.id}/audio`}
        onPlay={started} onPause={e => { setPos(e.currentTarget.currentTime * 1000); setPlaying(false); }} onEnded={() => { setPlaying(false); setPos(0); playNextAfter(m.id, box.current); }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={e => { const d = e.currentTarget.duration; if (!m.audioMs && Number.isFinite(d)) setLen(d * 1000); }} />
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} aria-label={playing ? t.pauseVoice : t.playVoice} data-playing={playing || undefined}
          className="voice-play shrink-0 w-11 h-11 rounded-full flex items-center justify-center">
          <Icon name={playing ? 'pause' : 'play'} className={`w-5 h-5 ${playing ? '' : 'translate-x-[1px]'}`} />
        </button>
        <Wave bars={shape} progress={progress} onSeek={seek} label={t.playVoice} audio={el} playing={playing} lenMs={len} />
        <button type="button" onClick={cycle} aria-label={t.vn.speed.replace('{speed}', `${speed}x`)} title={t.playbackSpeed}
          className="voice-chip shrink-0 h-7 min-w-[2.75rem] px-2 rounded-full text-xs tabular-nums transition-[background-color,transform] duration-[var(--dur-fast)] active:scale-95" dir="ltr">{speed}×</button>
      </div>
      <div className="mt-1 ps-14 flex flex-wrap items-center gap-x-3 gap-y-1 min-h-5 text-[11px] leading-none">
        <span className="inline-flex items-center gap-1 tabular-nums" dir="ltr">
          <span role="img" aria-label={played ? t.voicePlayed : t.voiceNotPlayed} title={played ? t.voicePlayed : t.voiceNotPlayed} data-played={played ? '1' : '0'}
            className={`inline-flex items-center ${played ? 'voice-played' : 'opacity-70'}`}>
            {!mine && !played && <span aria-hidden className="voice-dot w-1.5 h-1.5 rounded-full me-1" />}
            <Icon name="mic" className="w-3 h-3" />
          </span>
          <span className="opacity-80" aria-label={t.vn.length.replace('{time}', time)}>{time}</span>
        </span>
        {canText && (
          <button type="button" className="voice-link inline-flex items-center gap-1 py-1.5 -my-1.5 disabled:opacity-60" aria-expanded={shown} onClick={toggleText} disabled={server.busy}>
            <Icon name={shown ? 'down' : 'wave'} className={`w-3.5 h-3.5 transition-transform duration-[var(--dur-fast)] ${shown ? 'rotate-180' : ''}`} />
            {shown ? t.vn.hide : server.busy ? t.vn.working : t.vn.show}
          </button>
        )}
        <span className="ms-auto">{meta}</span>
      </div>
      {server.msg && <p role="status" className="ps-14 mt-1 text-xs text-danger">{server.msg}</p>}
      {/* The text opens in place: the row grows from 0fr to 1fr (no measured height to animate), and fades in. */}
      <div className="grid transition-[grid-template-rows,opacity] duration-[var(--dur-base)] ease-[var(--ease-standard)]"
        style={{ gridTemplateRows: shown ? '1fr' : '0fr', opacity: shown ? 1 : 0 }} aria-hidden={!shown}>
        <div className="min-h-0 overflow-hidden">
          <p dir="auto" className="voice-text mt-2 rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words" data-voice-text>
            {!own && <span className="block text-[11px] opacity-75 mb-0.5">{t.priv.transcribeLabel}</span>}{text}
          </p>
        </div>
      </div>
      {after}
      {server.consent}
    </div>
  );
}

// ---- recording ---------------------------------------------------------------------------------

export interface Recorded { blob: Blob; ms: number; waveform: number[]; transcript: string }
type Phase = 'idle' | 'starting' | 'holding' | 'locked' | 'paused' | 'restored';
interface Session { mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; peaks: number[]; transcript: string; speech?: any; audio?: AudioContext; meter?: ReturnType<typeof setInterval>; ticker?: ReturnType<typeof setInterval>; ms: number; since: number; mime: string; wantLock: boolean; released: boolean; cancelled: boolean }

/**
 * The mic button and everything that happens while a voice note is being made.
 *  - Hold: a timer and a live waveform; slide away to cancel, slide up to lock, release to send.
 *  - A short tap (or the keyboard) locks at once: record hands-free, pause, listen, delete or send.
 *  - Every second of the recording is written to the device (`drafts`). If the tab is closed, crashes or the screen is left, the
 *    recording is offered again the next time this chat is opened, to listen to and send or delete.
 * It must be placed inside a `relative` container: while recording it covers that container.
 */
export function VoiceRecorder({ circleId, drafts, rtl, lang, onSend, onActive, onError }: {
  circleId: number; drafts: DraftStore; rtl: boolean; lang: string;
  onSend: (r: Recorded) => void; onActive: (on: boolean) => void; onError: (text: string) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const [ms, setMs] = useState(0);
  const [live, setLive] = useState<number[]>([]);
  const [hint, setHint] = useState<'none' | 'cancel' | 'lock'>('none');
  const [preview, setPreview] = useState<string | null>(null);
  const [restored, setRestored] = useState<RecDraft | null>(null);
  const s = useRef<Session | null>(null);
  const down = useRef<{ x: number; y: number; at: number } | null>(null);
  const previewUrl = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => { onActive(phase === 'holding' || phase === 'locked' || phase === 'starting'); }, [phase]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A recording left behind by an interruption is offered again.
  useEffect(() => {
    let gone = false;
    drafts.get(circleId).then(d => { if (!gone && d && d.chunks.length && phaseRef.current === 'idle') { setRestored(d); setMs(d.ms); setLive(toBars(d.peaks, 40)); setPhase('restored'); showPreview(new Blob(d.chunks, { type: d.mime })); } }).catch(() => {});
    return () => { gone = true; };
  }, [circleId, drafts]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the screen while recording: the microphone is released; what was recorded so far is already on the device.
  useEffect(() => () => { const cur = s.current; if (cur) { cur.cancelled = false; stopTracks(cur, true); } if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);
  // The app goes to the background while the mic is held: lock instead of losing or sending by accident.
  useEffect(() => {
    const hidden = () => { if (document.hidden && phaseRef.current === 'holding') { down.current = null; setPhase('locked'); } };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);

  function showPreview(blob: Blob | null) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = blob ? URL.createObjectURL(blob) : null;
    setPreview(previewUrl.current);
  }
  const elapsed = (cur: Session) => cur.ms + (cur.since ? Date.now() - cur.since : 0);
  const saveDraft = (cur: Session) => drafts.put({ circle: circleId, mime: cur.mime, ms: elapsed(cur), chunks: [...cur.chunks], peaks: [...cur.peaks], transcript: cur.transcript, at: Date.now() }).catch(() => {});
  function stopTracks(cur: Session, keepDraft: boolean) {
    clearInterval(cur.meter); clearInterval(cur.ticker);
    try { cur.speech?.stop(); } catch { /* not running */ }
    try { if (cur.mr.state !== 'inactive') cur.mr.stop(); } catch { /* already stopped */ }
    cur.stream.getTracks().forEach(tr => tr.stop());
    cur.audio?.close().catch(() => {});
    if (!keepDraft) drafts.remove(circleId).catch(() => {});
    s.current = null;
  }

  async function begin(wantLock: boolean) {
    if (phaseRef.current !== 'idle') return;
    setPhase('starting'); setMs(0); setLive([]); setHint('none'); onError('');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { if (alive.current) { setPhase('idle'); onError(t.micDenied); } return; }
    // The person left the chat (or cancelled) while the browser was still asking for the microphone: let it go at once.
    if (!alive.current || (phaseRef.current as Phase) !== 'starting') { stream.getTracks().forEach(tr => tr.stop()); return; }
    let mr: MediaRecorder;   // 32 kbps: the 30 minutes of MED-01 come to about 7 MB, well under the server's 25 MB
    try { mr = new MediaRecorder(stream, { audioBitsPerSecond: 32_000 }); } catch { mr = new MediaRecorder(stream); }
    const cur: Session = { mr, stream, chunks: [], peaks: [], transcript: '', ms: 0, since: Date.now(), mime: mr.mimeType || 'audio/webm', wantLock, released: false, cancelled: false };
    s.current = cur;
    mr.ondataavailable = ev => { if (ev.data.size) { cur.chunks.push(ev.data); if (!cur.cancelled) saveDraft(cur); } };
    // The live waveform: how loud the microphone is, ten times a second.
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audio = new AC(), node = audio.createAnalyser(); node.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(node);
      const buf = new Uint8Array(node.fftSize);
      cur.audio = audio;
      cur.meter = setInterval(() => {
        if (mr.state !== 'recording') return;
        node.getByteTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        cur.peaks.push(Math.round((peak / 128) * 100));
        setLive(cur.peaks.slice(-LIVE_BARS));
      }, 100);
    } catch { /* no meter: the recording still works, with a flat line */ }
    // Best-effort words from the browser, so a voice note can be found and kept by the family archive (as before).
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (SR) {
      try {
        const sp = new SR(); sp.lang = speechLocale(lang); sp.continuous = true; sp.interimResults = false;
        sp.onresult = (ev: any) => { for (let i = ev.resultIndex; i < ev.results.length; i++) cur.transcript += ev.results[i][0].transcript + ' '; };
        sp.onerror = () => {}; sp.start(); cur.speech = sp;
      } catch { /* not available */ }
    }
    cur.ticker = setInterval(() => {
      setMs(elapsed(cur));
      // The server takes 30 minutes at most (MED-01): stop there (paused, ready to send) rather than record what cannot be sent.
      if (elapsed(cur) >= MAX_MS && cur.mr.state === 'recording') { down.current = null; pause(); }
    }, 200);
    mr.start(1000);   // a piece every second, each written to the device
    // The finger may already be up (a tap, or the permission question took a while): then this is a hands-free recording.
    setPhase(cur.wantLock || cur.released ? 'locked' : 'holding');
  }
  function cancel() {
    const cur = s.current;
    if (cur) { cur.cancelled = true; stopTracks(cur, false); }
    drafts.remove(circleId).catch(() => {});
    showPreview(null); setRestored(null); setHint('none'); down.current = null; setPhase('idle');
  }
  function finish() {
    if (phaseRef.current === 'restored' && restored) {
      onSend({ blob: new Blob(restored.chunks, { type: restored.mime }), ms: Math.max(1, restored.ms), waveform: toBars(restored.peaks), transcript: restored.transcript.trim() });
      drafts.remove(circleId).catch(() => {});
      showPreview(null); setRestored(null); setPhase('idle');
      return;
    }
    const cur = s.current; if (!cur) return;
    const total = elapsed(cur);
    if (total < MIN_MS) { cancel(); onError(t.tooShortVoice); return; }
    cur.mr.onstop = () => {
      onSend({ blob: new Blob(cur.chunks, { type: cur.mime }), ms: Math.max(1, total), waveform: toBars(cur.peaks), transcript: cur.transcript.trim() });
      drafts.remove(circleId).catch(() => {});
    };
    cur.cancelled = true;   // from here the outbox keeps it; the draft is no longer needed
    stopTracks(cur, true);
    showPreview(null); setHint('none'); down.current = null; setPhase('idle');
  }
  function pause() {
    const cur = s.current; if (!cur || cur.mr.state !== 'recording') return;
    cur.ms = elapsed(cur); cur.since = 0;
    cur.mr.pause();
    const once = () => { cur.mr.removeEventListener('dataavailable', once); showPreview(new Blob(cur.chunks, { type: cur.mime })); };
    cur.mr.addEventListener('dataavailable', once);
    try { cur.mr.requestData(); } catch { once(); }
    setMs(cur.ms); setPhase('paused');
  }
  function resume() {
    const cur = s.current; if (!cur || cur.mr.state !== 'paused' || elapsed(cur) >= MAX_MS) return;
    showPreview(null); cur.since = Date.now(); cur.mr.resume(); setPhase('locked');
  }

  // ---- the mic button: hold, slide, release ----
  // A click (or a quick tap) goes straight to the recording bar, as on WhatsApp's desktop app. The "slide to cancel" view of
  // press-and-hold is shown only once the press has lasted longer than a tap, so a click never flashes it first.
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { if (phase !== 'holding' && phase !== 'starting') { clearTimeout(holdTimer.current); setHeld(false); } }, [phase]);
  function onDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || phaseRef.current !== 'idle') return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable: release is still seen on the button */ }
    down.current = { x: e.clientX, y: e.clientY, at: Date.now() };
    clearTimeout(holdTimer.current); holdTimer.current = setTimeout(() => { if (down.current) setHeld(true); }, TAP_MS);
    begin(false);
  }
  function onMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!down.current || phaseRef.current !== 'holding') return;
    const g = gesture(e.clientX - down.current.x, e.clientY - down.current.y, rtl);
    if (g === 'cancel') return cancel();
    if (g === 'lock') { down.current = null; setHint('none'); return setPhase('locked'); }
    const dx = (rtl ? 1 : -1) * (e.clientX - down.current.x), dy = down.current.y - e.clientY;
    setHint(dx > 30 && dx >= dy ? 'cancel' : dy > 25 ? 'lock' : 'none');
  }
  function onUp() {
    const d = down.current; if (!d) return;
    down.current = null; clearTimeout(holdTimer.current);
    const tap = Date.now() - d.at < TAP_MS;
    if (phaseRef.current === 'starting') { if (s.current) s.current.released = true; else pendingRelease.current = true; return; }
    if (phaseRef.current !== 'holding') return;
    if (tap) setPhase('locked'); else finish();
  }
  // The finger went up before the microphone was granted: `begin` reads this when it gets there.
  const pendingRelease = useRef(false);
  useEffect(() => { if (phase === 'holding' && pendingRelease.current) { pendingRelease.current = false; setPhase('locked'); } if (phase === 'idle') pendingRelease.current = false; }, [phase]);

  const active = phase !== 'idle';
  return (
    <>
      {phase !== 'locked' && phase !== 'paused' && phase !== 'restored' && (
        <button type="button" className={`fab-accent w-11 h-11 rounded-full shrink-0 flex items-center justify-center touch-none select-none ${held ? 'fab-recording scale-125 relative z-20' : ''}`}
          aria-label={t.record} title={t.holdToRecord} style={{ WebkitTouchCallout: 'none' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { if (down.current && phaseRef.current === 'holding') { down.current = null; setPhase('locked'); } }}
          onContextMenu={e => e.preventDefault()}
          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && phaseRef.current === 'idle') { e.preventDefault(); begin(true); } }}><Icon name="mic" className="w-5 h-5" /></button>
      )}
      {held && (phase === 'holding' || phase === 'starting') && (
        <div className="rec-bar absolute inset-x-0 bottom-0 h-11 z-10 flex items-center gap-3 ps-4 pe-16 animate-rec-in" role="status" aria-label={t.recordingNow}>
          <span className="rec-time shrink-0" dir="ltr"><span className="rec-dot" aria-hidden />{clock(ms)}</span>
          <span className="flex-1 min-w-0 flex text-muted"><LiveWave peaks={live} /></span>
          <span className={`text-xs shrink-0 flex items-center gap-1 transition-colors duration-[var(--dur-instant)] ${hint === 'cancel' ? 'text-danger' : 'text-muted'}`}><Icon name="chevron" className={`w-3.5 h-3.5 ${rtl ? '' : 'rotate-180'}`} />{t.slideToCancel}</span>
          <span className={`text-xs shrink-0 hidden sm:flex items-center gap-1 transition-colors duration-[var(--dur-instant)] ${hint === 'lock' ? 'text-green' : 'text-muted'}`}><Icon name="lock" className="w-3.5 h-3.5" />{t.slideUpToLock}</span>
        </div>
      )}
      {(phase === 'locked' || phase === 'paused' || phase === 'restored') && (
        // WhatsApp's layout: delete at the start, OUTSIDE the pill; inside it only the recording (dot, time, waveform) or the
        // draft (play, time, waveform with its dot); then pause (while recording) or the mic (to carry on), and send.
        <div className="absolute inset-x-0 bottom-0 h-11 z-10 flex items-center gap-1.5 sm:gap-2 animate-fade-in" role="group" aria-label={phase === 'restored' ? t.unsentVoice : t.recordingNow}>
          <button type="button" className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-muted hover:text-danger hover:bg-danger/10 transition-colors duration-[var(--dur-instant)]" aria-label={t.deleteRec} title={t.deleteRec} onClick={cancel}><Icon name="trash" className="w-5 h-5" /></button>
          <div className="rec-bar flex-1 min-w-0 h-11 flex items-center gap-2 ps-3 pe-4">
            {phase === 'locked'
              ? <>
                  <span className="rec-time shrink-0" dir="ltr" role="status"><span className="rec-dot" aria-hidden />{clock(ms)}</span>
                  <span className="flex-1 min-w-0 flex text-muted"><LiveWave peaks={live} /></span>
                </>
              : <DraftPreview src={preview} peaks={(phase === 'restored' ? restored?.peaks : s.current?.peaks) ?? []} ms={ms} />}
          </div>
          {phase === 'locked' && <button type="button" className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-danger hover:bg-danger/10 transition-colors duration-[var(--dur-instant)]" aria-label={t.pauseRec} title={t.pauseRec} onClick={pause}><Icon name="pause" className="w-6 h-6" /></button>}
          {phase === 'paused' && <button type="button" className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-danger hover:bg-danger/10 transition-colors duration-[var(--dur-instant)]" aria-label={t.resumeRec} title={t.resumeRec} onClick={resume}><Icon name="mic" className="w-6 h-6" /></button>}
          <button type="button" className="fab-accent w-11 h-11 rounded-full shrink-0 flex items-center justify-center" aria-label={t.sendVoice} title={t.sendVoice} onClick={finish}><Icon name="send" className="w-5 h-5 rtl:-scale-x-100" /></button>
        </div>
      )}
      {active && <span className="sr-only" aria-live="polite">{phase === 'paused' ? t.recPaused : phase === 'restored' ? t.unsentVoice : t.recordingNow}</span>}
    </>
  );
}
