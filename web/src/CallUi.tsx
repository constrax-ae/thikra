// Voice calls (trial), the browser side: signalling over the live socket, one RTCPeerConnection, the call sheet.
// The voice goes straight between the two browsers (WebRTC, encrypted by DTLS-SRTP); our server only relays the set-up messages.
// Design and limits: docs/superpowers/specs/2026-11-19-calls-design.md. Rings only while this page is open.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { live } from './live';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { PersonAvatar } from './Groups';
import { clock, endKey, gradeQuality, readQuality, safetyCode, type Quality, type StatsMark } from './calls';

type Phase = 'idle' | 'incoming' | 'calling' | 'connecting' | 'active';
interface Ui { phase: Phase; call: string; circle: number; name: string; answered: boolean; /** The other person, for their face. */ peer?: { id: number; avatarAt?: string | null } | null }
const IDLE: Ui = { phase: 'idle', call: '', circle: 0, name: '', answered: false };
interface Ctx { start(circle: number, name: string, peer?: { id: number; avatarAt?: string | null } | null): void; busy: boolean }
const CallCtx = createContext<Ctx>({ start: () => {}, busy: false });
export const useCalls = () => useContext(CallCtx);

const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/** A soft two-tone ring made with the browser's audio engine (no file to download). Returns the stop function. */
function ring(): () => void {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    ctx.resume?.().catch(() => {});
    const beep = () => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 440; g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 1);
    };
    beep(); const iv = setInterval(beep, 2200);
    return () => { clearInterval(iv); ctx.close().catch(() => {}); };
  } catch { return () => {}; }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [ui, setUi] = useState<Ui>(IDLE);
  const [muted, setMuted] = useState(false);
  const [secs, setSecs] = useState(0);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);   // why the last call ended, or why one could not start
  const uiRef = useRef(ui);
  const put = useCallback((u: Ui) => { uiRef.current = u; setUi(u); }, []);   // the ref moves at once, so a frame in the same tick sees the new state
  const pc = useRef<RTCPeerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<Array<RTCIceCandidateInit | null>>([]);
  const remoteSet = useRef(false);
  const offerSdp = useRef(''), answerSdp = useRef('');
  const stopRing = useRef<(() => void) | null>(null);
  const turn = useRef(false);
  const timers = useRef<{ tick?: ReturnType<typeof setInterval>; stats?: ReturnType<typeof setInterval>; guard?: ReturnType<typeof setTimeout>; note?: ReturnType<typeof setTimeout> }>({});

  const showNote = useCallback((text: string) => {
    setNote(text); clearTimeout(timers.current.note);
    timers.current.note = setTimeout(() => setNote(null), 8000);
  }, []);
  const noteFor = useCallback((reason: string, name: string) => {
    const k = endKey(reason);
    if (k === 'failed' && !turn.current) return t.calls.noTurn;
    return ((t.calls as Record<string, string>)[k] ?? t.calls.ended).replace('{name}', name);
  }, [t]);

  /** Close everything of the current call (media, timers, ring). Does not tell the server. */
  const cleanup = useCallback(() => {
    stopRing.current?.(); stopRing.current = null;
    clearInterval(timers.current.tick); clearInterval(timers.current.stats); clearTimeout(timers.current.guard);
    pc.current?.close(); pc.current = null;
    stream.current?.getTracks().forEach(x => x.stop()); stream.current = null;
    if (audio.current) audio.current.srcObject = null;
    pending.current = []; remoteSet.current = false; offerSdp.current = ''; answerSdp.current = '';
    put(IDLE); setMuted(false); setSecs(0); setQuality(null); setCode(null);
  }, []);

  const send = (f: Record<string, unknown> & { t: string }) => live.send(f);

  const finish = useCallback((reason: string) => {
    const name = uiRef.current.name;
    cleanup(); showNote(noteFor(reason, name));
  }, [cleanup, noteFor, showNote]);

  const hangUp = useCallback((reason?: string) => {
    const u = uiRef.current;
    if (u.phase === 'idle') return;
    send({ t: 'call_end', call: u.call, reason });
    const name = u.name;
    cleanup();
    if (reason === 'failed') showNote(noteFor('failed', name));
  }, [cleanup, noteFor, showNote]);

  async function mic(): Promise<MediaStream | null> {
    if (!navigator.mediaDevices?.getUserMedia) { showNote(t.calls.micUnavailable); return null; }
    try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e: any) { showNote(e?.name === 'NotFoundError' ? t.calls.micUnavailable : t.calls.micDenied); return null; }
  }

  async function connection(call: string): Promise<RTCPeerConnection | null> {
    const cfg = await api<{ iceServers: RTCIceServer[]; turn: boolean }>('/calls/ice').catch(() => null);
    if (!cfg) { showNote(t.errors.network); return null; }
    turn.current = cfg.turn;
    const p = new RTCPeerConnection({ iceServers: cfg.iceServers });
    p.onicecandidate = e => { send({ t: 'call_ice', call, candidate: e.candidate ? e.candidate.toJSON() : null }); };
    p.ontrack = e => { if (audio.current) { audio.current.srcObject = e.streams[0] ?? new MediaStream([e.track]); audio.current.play().catch(() => {}); } };
    p.onconnectionstatechange = () => {
      if (pc.current !== p) return;
      if (p.connectionState === 'connected') connected();
      else if (p.connectionState === 'failed') hangUp('failed');
    };
    pc.current = p;
    return p;
  }

  function connected() {
    clearTimeout(timers.current.guard);
    if (uiRef.current.phase === 'active') return;
    put({ ...uiRef.current, phase: 'active' });
    const t0 = Date.now();
    timers.current.tick = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    let mark: StatsMark | null = null;
    timers.current.stats = setInterval(async () => {
      try { const r = readQuality((await pc.current!.getStats()).values(), mark); mark = r.next; setQuality(gradeQuality(r)); } catch { /* the call may be closing */ }
    }, 3000);
  }
  /** A connection that has not come up 25 s after the answer is given up on, with the reason shown. */
  const guardConnect = () => { clearTimeout(timers.current.guard); timers.current.guard = setTimeout(() => { if (uiRef.current.phase !== 'active' && uiRef.current.phase !== 'idle') hangUp('failed'); }, 25_000); };

  const start = useCallback(async (circle: number, name: string, peer?: { id: number; avatarAt?: string | null } | null) => {
    if (uiRef.current.phase !== 'idle') return;
    setNote(null);
    if (!live.connected) return showNote(t.calls.notConnected);
    const call = newId();
    put({ phase: 'calling', call, circle, name, answered: false, peer: peer ?? null });
    const alive = () => uiRef.current.call === call;   // the person may cancel while a permission prompt or a request is still open
    const s = await mic();
    if (!s) return alive() ? put(IDLE) : undefined;
    if (!alive()) return s.getTracks().forEach(x => x.stop());
    stream.current = s;
    const p = await connection(call);
    if (!p || !alive()) { p?.close(); if (pc.current === p) pc.current = null; if (stream.current === s) stream.current = null; s.getTracks().forEach(x => x.stop()); return !p && alive() ? put(IDLE) : undefined; }
    s.getTracks().forEach(tr => p.addTrack(tr, s));
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    if (!alive()) return;
    offerSdp.current = offer.sdp ?? '';
    if (!send({ t: 'call_offer', call, circle, sdp: offerSdp.current })) { cleanup(); showNote(t.calls.notConnected); }
  }, [t, cleanup, showNote]);

  async function accept() {
    const u = uiRef.current;
    if (u.phase !== 'incoming') return;
    stopRing.current?.(); stopRing.current = null;
    put({ ...u, phase: 'connecting', answered: true });
    const alive = () => uiRef.current.call === u.call;   // the caller may give up while we wait for the microphone
    const s = await mic();
    if (!alive()) return s?.getTracks().forEach(x => x.stop());
    if (!s) { send({ t: 'call_end', call: u.call, reason: 'decline' }); return cleanup(); }
    stream.current = s;
    const p = await connection(u.call);
    if (!alive()) { p?.close(); if (pc.current === p) pc.current = null; return; }
    if (!p) { send({ t: 'call_end', call: u.call, reason: 'decline' }); return cleanup(); }
    s.getTracks().forEach(tr => p.addTrack(tr, s));
    await p.setRemoteDescription({ type: 'offer', sdp: offerSdp.current });
    remoteSet.current = true;
    const ans = await p.createAnswer();
    await p.setLocalDescription(ans);
    if (!alive()) return;
    answerSdp.current = ans.sdp ?? '';
    send({ t: 'call_answer', call: u.call, sdp: answerSdp.current });
    safetyCode(offerSdp.current, answerSdp.current).then(setCode);
    await flush(p);
    guardConnect();
  }
  async function flush(p: RTCPeerConnection) {
    for (const c of pending.current.splice(0)) if (c) await p.addIceCandidate(c).catch(() => {});
  }

  // Frames from the server. Kept in a ref-free effect: every handler reads the current call through uiRef.
  useEffect(() => live.on(f => {
    if (f.t === 'close') { if (uiRef.current.phase !== 'idle') finish('lost'); return; }
    if (f.t === 'call_incoming') {
      if (uiRef.current.phase !== 'idle') return;   // the server only rings a free person; this is another tab of ours that is already in a call
      offerSdp.current = f.sdp;
      stopRing.current = ring();
      setNote(null);
      put({ phase: 'incoming', call: f.call, circle: f.circle, name: f.from?.name ?? '', answered: false, peer: Number.isInteger(f.from?.id) ? { id: f.from.id, avatarAt: f.from.avatarAt ?? null } : null });
      return;
    }
    const u = uiRef.current;
    if (f.call !== u.call) return;
    if (f.t === 'call_taken') { if (u.phase === 'incoming' || (u.phase === 'connecting' && !answerSdp.current.length)) { if (u.phase === 'connecting') cleanup(); stopRing.current?.(); stopRing.current = null; put(IDLE); } return; }
    if (f.t === 'call_end') { if (u.phase !== 'idle') finish(f.reason); return; }
    if (f.t === 'call_answer' && u.phase === 'calling') {
      answerSdp.current = f.sdp;
      put({ ...u, phase: 'connecting', answered: true });
      const p = pc.current;
      p?.setRemoteDescription({ type: 'answer', sdp: f.sdp }).then(() => { remoteSet.current = true; return flush(p); }).catch(() => hangUp('failed'));
      safetyCode(offerSdp.current, f.sdp).then(setCode);
      guardConnect();
      return;
    }
    if (f.t === 'call_ice') {
      const p = pc.current;
      if (p && remoteSet.current) { if (f.candidate) p.addIceCandidate(f.candidate).catch(() => {}); } else pending.current.push(f.candidate);
    }
  }), [finish, hangUp]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the page: the socket drops and the server tells the other side; this just makes it faster.
  useEffect(() => {
    const bye = () => { const u = uiRef.current; if (u.phase !== 'idle') send({ t: 'call_end', call: u.call }); };
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);
  useEffect(() => () => { cleanup(); }, [cleanup]);

  const toggleMute = () => { const on = !muted; stream.current?.getAudioTracks().forEach(x => { x.enabled = !on; }); setMuted(on); };
  const ctx = useMemo(() => ({ start, busy: ui.phase !== 'idle' }), [start, ui.phase]);
  const c = t.calls;
  const q = quality ? { good: [c.qGood, 'text-green'], weak: [c.qWeak, 'text-gold-dark'], bad: [c.qBad, 'text-danger'] }[quality] : null;

  return (
    <CallCtx.Provider value={ctx}>
      {children}
      <audio ref={audio} autoPlay playsInline />
      {note && ui.phase === 'idle' && <div role="alert" className="fixed z-50 inset-x-4 bottom-24 mx-auto max-w-md rounded-xl bg-ink text-paper text-sm p-3 shadow-lg flex gap-3 items-start"><span className="flex-1">{note}</span><button className="underline" onClick={() => setNote(null)}>{c.close}</button></div>}
      {ui.phase !== 'idle' && (() => {
        const ringing = ui.phase === 'incoming' || ui.phase === 'calling';
        const status = ui.phase === 'incoming' ? c.incoming : ui.phase === 'calling' ? c.calling : ui.phase === 'connecting' ? c.connecting : clock(secs);
        // One round control with its word under it, as on a phone's call screen.
        const ctl = (label: string, icon: Parameters<typeof Icon>[0]['name'], tone: string, onClick: () => void, extra: Record<string, unknown> = {}) => (
          <div className="flex flex-col items-center gap-2 w-20">
            <button type="button" aria-label={label} title={label} onClick={onClick} {...extra}
              className={`w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-[transform,background-color] duration-[var(--dur-fast)] hover:scale-105 active:scale-95 ${tone}`}>
              <Icon name={icon} className={`w-7 h-7 ${icon === 'call' && tone.includes('danger') ? 'rotate-[135deg]' : ''}`} />
            </button>
            <span className="text-xs text-white/80 select-none">{label}</span>
          </div>
        );
        return (
          // The whole screen becomes the call (as in every messenger): a deep green backdrop, the person's face in the middle,
          // the state under their name, and the controls along the bottom. It stays above everything until the call ends.
          <div role="dialog" aria-modal="true" aria-label={c.title}
            className="fixed inset-0 z-[70] flex flex-col items-center text-white animate-fade-in select-none"
            style={{ background: 'radial-gradient(120% 90% at 50% 25%, #2f6b57 0%, #1f4d3f 45%, #12302a 100%)' }}>
            <div className="w-full flex items-center justify-center gap-2 pt-[max(1.5rem,env(safe-area-inset-top))] text-sm text-white/75">
              <Icon name="lock" className="w-3.5 h-3.5" />{c.title}
            </div>
            <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
              <div className="relative flex items-center justify-center">
                {ringing && <>
                  <span aria-hidden className="absolute w-40 h-40 rounded-full bg-white/10 animate-ping [animation-duration:2.2s]" />
                  <span aria-hidden className="absolute w-52 h-52 rounded-full border border-white/10" />
                </>}
                <span className="relative rounded-full ring-4 ring-white/15">
                  <PersonAvatar id={ui.peer?.id ?? 0} name={ui.name || '?'} avatarAt={ui.peer?.avatarAt} className="w-32 h-32 text-5xl" />
                </span>
              </div>
              <p className="mt-8 text-3xl font-bold tracking-tight truncate max-w-full">{ui.name}</p>
              <p role="status" className="mt-2 text-base text-white/80 tabular-nums" data-testid="call-status">{status}</p>
              {ui.phase === 'active' && q && <p className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-white/10" data-testid="call-quality"><span aria-hidden className={`w-1.5 h-1.5 rounded-full ${quality === 'good' ? 'bg-green-300' : quality === 'weak' ? 'bg-amber-300' : 'bg-red-300'}`} />{q[0]}</p>}
              {ui.phase === 'incoming' && <p className="mt-3 text-xs text-white/60 max-w-xs">{c.ringNote}</p>}
              {code && (
                <div className="mt-6 rounded-2xl bg-white/10 px-4 py-3 max-w-xs">
                  <p className="text-[11px] text-white/70">{c.safety}</p>
                  <p className="font-mono tracking-widest text-base mt-0.5" dir="ltr" data-testid="call-code">{code}</p>
                  <p className="text-[11px] text-white/60 mt-1">{c.safetyNote}</p>
                </div>
              )}
            </div>
            <div className="w-full flex justify-center gap-10 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-4">
              {ui.phase === 'incoming' ? (<>
                {ctl(c.decline, 'call', 'bg-danger text-white', () => hangUp('decline'))}
                {ctl(c.accept, 'call', 'bg-[#22a06b] text-white', accept, { 'data-testid': 'call-accept' })}
              </>) : (<>
                {ui.answered && ctl(muted ? c.unmute : c.mute, muted ? 'mic-off' : 'mic', muted ? 'bg-white text-[#1f4d3f]' : 'bg-white/15 text-white', toggleMute, { 'aria-pressed': muted, 'data-testid': 'call-mute' })}
                {ctl(ui.phase === 'calling' ? c.cancel : c.hangUp, 'call', 'bg-danger text-white', () => hangUp(), { 'data-testid': 'call-hangup' })}
              </>)}
            </div>
          </div>
        );
      })()}
    </CallCtx.Provider>
  );
}

/** The call button of a private chat's header. */
export function CallButton({ circle, name, peer }: { circle: number; name: string; peer?: { id: number; avatarAt?: string | null } | null }) {
  const { t } = useI18n();
  const { start, busy } = useCalls();
  return <button className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:bg-green-soft/60 hover:text-green disabled:opacity-50 transition-colors duration-[var(--dur-instant)]" disabled={busy} onClick={() => start(circle, name, peer)} aria-label={t.calls.call} title={t.calls.call} data-testid="call-button"><Icon name="call" className="w-5 h-5" /></button>;
}
