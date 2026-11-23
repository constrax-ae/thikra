import { useMediaUrl } from './E2eeUi';
import { Icon } from './icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Message } from './api';
import { useI18n, speechLocale } from './i18n';
import { prefOn } from './prefs';
import { bars as toBars, gesture, nextSpeed, MAX_MS, MIN_MS, TAP_MS } from './voice';
import type { DraftStore, RecDraft } from './mediastore';

export const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const SPEED_KEY = 'thikra_voice_speed';
const savedSpeed = () => { try { const v = Number(localStorage.getItem(SPEED_KEY)); return v === 1.5 || v === 2 ? v : 1; } catch { return 1; } };

/** The bars of a waveform with the played part filled; click or drag anywhere on it to move through the recording. */
function Wave({ bars, progress, onSeek, label }: { bars: number[]; progress: number; onSeek?: (fraction: number) => void; label?: string }) {
  const dragging = useRef(false);
  const at = (e: React.PointerEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  return (
    <div className={`flex-1 min-w-0 relative h-7 flex items-center gap-[2px] touch-none select-none ${onSeek ? 'cursor-pointer' : ''}`} dir="ltr"
      role={onSeek ? 'slider' : undefined} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} tabIndex={onSeek ? 0 : undefined}
      onKeyDown={e => { if (!onSeek) return; if (e.key === 'ArrowRight') onSeek(Math.min(1, progress + 0.05)); if (e.key === 'ArrowLeft') onSeek(Math.max(0, progress - 0.05)); }}
      onPointerDown={e => { if (!onSeek) return; dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still seeks where it was pressed */ } onSeek(at(e)); }}
      onPointerMove={e => { if (onSeek && dragging.current) onSeek(at(e)); }}
      onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
      {bars.map((h, i) => <span key={i} className="flex-1 max-w-[4px] min-w-[2px] rounded-full" style={{ height: `${Math.max(8, h)}%`, background: 'currentColor', opacity: (i + 0.5) / bars.length <= progress ? 0.95 : 0.28 }} />)}
      {onSeek && <span aria-hidden className="absolute top-1/2 w-3 h-3 rounded-full bg-current elevated-1 pointer-events-none" style={{ insetInlineStart: `${progress * 100}%`, transform: 'translate(-50%, -50%)' }} />}
    </div>
  );
}

/**
 * A voice note in the chat: play/pause, the real waveform (drag to seek), elapsed/length, 1x / 1.5x / 2x (remembered), and a mark
 * that says whether it has been played. A listener's first play is reported to the server once.
 */
export function VoicePlayer({ m, mine, meId, others }: { m: Message; mine: boolean; meId: number; others: number }) {
  const { t } = useI18n();
  const el = useRef<HTMLAudioElement>(null);
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
  const toggle = () => { const a = el.current; if (!a) return; a.playbackRate = speed; if (a.paused) a.play().catch(() => {}); else a.pause(); };
  const cycle = () => { const next = nextSpeed(speed); setSpeed(next); if (el.current) el.current.playbackRate = next; try { localStorage.setItem(SPEED_KEY, String(next)); } catch { /* not remembered */ } };
  const seek = (f: number) => { const v = f * Math.max(len, 1); setPos(v); if (el.current) el.current.currentTime = v / 1000; };
  const started = () => {
    setPlaying(true);
    if (!mine && !played && !told.current) { told.current = true; api(`/messages/${m.id}/played`, { method: 'POST', body: {} }).catch(() => { told.current = false; }); }
  };
  return (
    <div className="flex items-center gap-2.5 min-w-[15rem] py-0.5">
      <audio ref={el} preload={prefOn('saver') ? 'none' : 'metadata'} src={m.encrypted ? encSrc ?? undefined : `/api/messages/${m.id}/audio`}
        onPlay={started} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={e => { const d = e.currentTarget.duration; if (!m.audioMs && Number.isFinite(d)) setLen(d * 1000); }} />
      <button type="button" onClick={cycle} aria-label={`${t.playbackSpeed} ${speed}x`} title={t.playbackSpeed}
        className={`w-9 h-9 rounded-full shrink-0 text-xs font-bold flex items-center justify-center transition-colors duration-[var(--dur-instant)] ${mine ? 'bg-current/15' : 'bg-green-soft text-green'}`}>{speed}x</button>
      <button type="button" onClick={toggle} aria-label={playing ? t.pauseVoice : t.playVoice}
        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-fast)] active:scale-90 hover:bg-current/10">
        <Icon name={playing ? 'pause' : 'play'} className="w-5 h-5" />
      </button>
      <div className="flex-1 min-w-0">
        <Wave bars={shape} progress={progress} onSeek={seek} label={t.playVoice} />
        <div className="flex items-center justify-between gap-2 -mt-1">
          <span className="text-[11px] tabular-nums opacity-70" dir="ltr">{clock(playing || pos > 0 ? pos : len)}</span>
          <span role="img" aria-label={played ? t.voicePlayed : t.voiceNotPlayed} title={played ? t.voicePlayed : t.voiceNotPlayed} data-played={played ? '1' : '0'}
            className={`shrink-0 flex items-center ${played ? (mine ? 'text-[var(--bubble-tick)]' : 'text-green') : mine ? 'opacity-40' : 'text-gold-dark'}`}>
            {played || mine ? <Icon name="mic" className="w-3.5 h-3.5" /> : <span className="w-2 h-2 rounded-full bg-current" />}
          </span>
        </div>
      </div>
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
    let mr: MediaRecorder;   // a voice bitrate keeps 15 minutes under the server's 5 MB
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
        setLive(cur.peaks.slice(-40));
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
      // The server takes 15 minutes at most: stop there (paused, ready to send) rather than record what cannot be sent.
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
  function onDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || phaseRef.current !== 'idle') return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable: release is still seen on the button */ }
    down.current = { x: e.clientX, y: e.clientY, at: Date.now() };
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
    down.current = null;
    const tap = Date.now() - d.at < TAP_MS;
    if (phaseRef.current === 'starting') { if (s.current) s.current.released = true; else pendingRelease.current = true; return; }
    if (phaseRef.current !== 'holding') return;
    if (tap) setPhase('locked'); else finish();
  }
  // The finger went up before the microphone was granted: `begin` reads this when it gets there.
  const pendingRelease = useRef(false);
  useEffect(() => { if (phase === 'holding' && pendingRelease.current) { pendingRelease.current = false; setPhase('locked'); } if (phase === 'idle') pendingRelease.current = false; }, [phase]);

  const active = phase !== 'idle';
  const shown = live.length ? live : Array.from({ length: 40 }, () => 4);
  return (
    <>
      {phase !== 'locked' && phase !== 'paused' && phase !== 'restored' && (
        <button type="button" className={`btn !rounded-full !w-11 !h-11 !px-0 shrink-0 touch-none select-none transition-transform duration-[var(--dur-fast)] ${phase === 'holding' || phase === 'starting' ? '!bg-danger scale-125 relative z-20' : 'btn-primary'}`}
          aria-label={t.record} title={t.holdToRecord} style={{ WebkitTouchCallout: 'none' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { if (down.current && phaseRef.current === 'holding') { down.current = null; setPhase('locked'); } }}
          onContextMenu={e => e.preventDefault()}
          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && phaseRef.current === 'idle') { e.preventDefault(); begin(true); } }}><Icon name="mic" className="w-5 h-5" /></button>
      )}
      {(phase === 'holding' || phase === 'starting') && (
        <div className="absolute inset-0 z-10 flex items-center gap-3 rounded-full bg-card border border-line elevated-1 animate-fade-in ps-4 pe-14" role="status" aria-label={t.recordingNow}>
          <span className="text-danger tabular-nums text-sm shrink-0 flex items-center gap-1.5" dir="ltr"><span className="w-2 h-2 rounded-full bg-danger animate-pulse-soft" />{clock(ms)}</span>
          <Wave bars={shown} progress={0} />
          <span className={`text-xs shrink-0 flex items-center gap-1 transition-colors duration-[var(--dur-instant)] ${hint === 'cancel' ? 'text-danger font-bold' : 'text-muted'}`}><Icon name="chevron" className={`w-3.5 h-3.5 ${rtl ? '' : 'rotate-180'}`} />{t.slideToCancel}</span>
          <span className={`text-xs shrink-0 hidden sm:flex items-center gap-1 transition-colors duration-[var(--dur-instant)] ${hint === 'lock' ? 'text-green font-bold' : 'text-muted'}`}><Icon name="lock" className="w-3.5 h-3.5" />{t.slideUpToLock}</span>
        </div>
      )}
      {(phase === 'locked' || phase === 'paused' || phase === 'restored') && (
        <div className="absolute inset-0 z-10 flex items-center gap-2 rounded-full bg-card border border-line elevated-1 animate-fade-in ps-1.5 pe-1.5" role="group" aria-label={phase === 'restored' ? t.unsentVoice : t.recordingNow}>
          <button type="button" className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-danger hover:bg-danger/10 transition-colors duration-[var(--dur-instant)]" aria-label={t.deleteRec} title={t.deleteRec} onClick={cancel}><Icon name="trash" className="w-5 h-5" /></button>
          <span className={`tabular-nums text-sm shrink-0 flex items-center gap-1.5 ${phase === 'locked' ? 'text-danger' : 'text-muted'}`} dir="ltr" role="status">{phase === 'locked' && <span className="w-2 h-2 rounded-full bg-danger animate-pulse-soft" />}{clock(ms)}</span>
          {preview && phase !== 'locked'
            ? <audio controls src={preview} className="flex-1 min-w-0 h-9" aria-label={t.listenRec} />
            : <Wave bars={shown} progress={0} />}
          {phase === 'restored' && <span className="text-xs text-muted shrink-0 hidden sm:inline">{t.unsentVoice}</span>}
          {phase === 'locked' && <button type="button" className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-muted hover:text-green transition-colors duration-[var(--dur-instant)]" aria-label={t.pauseRec} title={t.pauseRec} onClick={pause}><Icon name="pause" className="w-5 h-5" /></button>}
          {phase === 'paused' && <button type="button" className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-danger hover:bg-danger/10 transition-colors duration-[var(--dur-instant)]" aria-label={t.resumeRec} title={t.resumeRec} onClick={resume}><Icon name="mic" className="w-5 h-5" /></button>}
          <button type="button" className="btn btn-primary !rounded-full !h-9 !px-4 shrink-0" aria-label={t.sendVoice} onClick={finish}>{t.send}</button>
        </div>
      )}
      {active && <span className="sr-only" aria-live="polite">{phase === 'paused' ? t.recPaused : phase === 'restored' ? t.unsentVoice : t.recordingNow}</span>}
    </>
  );
}
