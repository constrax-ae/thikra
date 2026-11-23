import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError, type CircleDetail, type Message } from './api';
import { useI18n } from './i18n';
import { Dialog } from './Dialog';
import { deviceLock } from './lock';
import { Icon } from './icons';

// ---- chat lock: the device's PIN ---------------------------------------------------------------

/** Re-renders when the PIN is set or cleared and when the locked chats are opened or locked again. */
export function useLock() {
  const snap = () => `${deviceLock.hasPin() ? 1 : 0}${deviceLock.isUnlocked() ? 1 : 0}`;
  const s = useSyncExternalStore(deviceLock.onChange, snap);
  return { hasPin: s[0] === '1', unlocked: s[1] === '1' };
}

/** Choose a PIN (first time on this device) or enter it. Calls onDone when the locked chats are open. */
export function PinGate({ onDone, onClose, otherDevice }: { onDone: () => void; onClose: () => void; otherDevice?: boolean }) {
  const { t } = useI18n();
  const { hasPin, unlocked } = useLock();
  const [pin, setPin] = useState(''), [again, setAgain] = useState(''), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (unlocked) onDone(); }, [unlocked]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true);
    try {
      if (!hasPin) {
        if (!/^\d{4,10}$/.test(pin)) return setMsg(t.priv.pinShort);
        if (pin !== again) return setMsg(t.priv.pinMismatch);
        await deviceLock.setPin(pin);
      } else {
        const r = await deviceLock.unlock(pin);
        if (!r.ok) { setPin(''); setMsg(r.waitS ? t.priv.pinWait.replace('{s}', String(r.waitS)) : t.priv.pinWrong); }
      }
    } finally { setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} label={hasPin ? t.priv.pinEnter : t.priv.pinCreate}>
      <form onSubmit={submit} className="space-y-3 text-center">
        <span aria-hidden className="mx-auto w-14 h-14 rounded-2xl bg-green-soft text-green flex items-center justify-center"><Icon name="lock" className="w-7 h-7" /></span>
        <h2 className="text-lg font-bold">{hasPin ? t.priv.pinEnter : t.priv.pinCreate}</h2>
        {!hasPin && <p className="text-sm text-muted">{t.priv.pinCreateNote}</p>}
        {!hasPin && otherDevice && <p className="text-sm text-muted">{t.priv.pinOtherDevice}</p>}
        <input className="field text-center tracking-widest" type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={10} dir="ltr"
          aria-label={hasPin ? t.priv.pinEnter : t.priv.pinCreate} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} />
        {!hasPin && <input className="field text-center tracking-widest" type="password" inputMode="numeric" autoComplete="off" maxLength={10} dir="ltr"
          aria-label={t.priv.pinRepeat} placeholder={t.priv.pinRepeat} value={again} onChange={e => setAgain(e.target.value.replace(/\D/g, ''))} />}
        {msg && <p role="alert" className="text-sm text-danger">{msg}</p>}
        <div className="flex gap-2">
          <button className="btn flex-1" disabled={busy || pin.length < 4}>{hasPin ? t.priv.pinOpen : t.priv.pinSave}</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t.cancel}</button>
        </div>
        {hasPin && <p className="text-xs text-muted">{t.priv.pinForgot}</p>}
      </form>
    </Dialog>
  );
}

// ---- chat options: disappearing messages, wallpaper, lock ---------------------------------------

export const WALL_NAMES = ['none', 'dots', 'dusk', 'dunes', 'forest', 'rose'];
export const WALL_COLOURS = ['#f6efe4', '#e3efe8', '#e4ebf5', '#f4e6ee', '#ece6f5', '#fbf1c7', '#d9e3dc', '#e9e9e9'];
/** What the chat's own wallpaper does to the message area: a pattern name or a colour; nothing when the person has not chosen one for this chat. */
export function wallProps(w: string | null | undefined): { 'data-chatwall'?: string; style?: React.CSSProperties } {
  if (!w) return {};
  if (/^#[0-9a-f]{6}$/i.test(w)) return { style: { backgroundColor: w, backgroundImage: 'none' } };
  return { 'data-chatwall': w };
}
const TIMERS: Array<[number | null, 'off' | 'd1' | 'd7' | 'd90']> = [[null, 'off'], [86400, 'd1'], [604800, 'd7'], [7776000, 'd90']];
export const timerWord = (secs: number, t: { priv: Record<string, string> }) => t.priv[secs === 86400 ? 'd1' : secs === 604800 ? 'd7' : 'd90'];

export function ChatOptions({ circle, onClose, reload }: { circle: CircleDetail; onClose: () => void; reload: () => void }) {
  const { t } = useI18n();
  const { unlocked } = useLock();
  const [error, setError] = useState('');
  const [pinFor, setPinFor] = useState<null | 'lock'>(null);
  const manager = circle.role === 'owner' || circle.role === 'admin';
  const canTimer = circle.kind === 'direct' || manager;
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  async function timer(seconds: number | null) { setError(''); try { await api(`/circles/${circle.id}/disappearing`, { method: 'PUT', body: { seconds } }); reload(); } catch (e) { fail(e); } }
  async function prefs(body: object) { setError(''); try { await api(`/circles/${circle.id}/prefs`, { method: 'PATCH', body }); reload(); } catch (e) { fail(e); } }
  const wall = circle.wallpaper ?? null;
  return (
    <Dialog onClose={onClose} label={t.priv.chatOptions}>
      <h2 className="text-lg font-bold">{t.priv.chatOptions}</h2>
      <div className="mt-3 space-y-4 max-h-[70vh] overflow-y-auto">
        <section>
          <h3 className="font-bold text-sm flex items-center gap-2"><span aria-hidden className="w-8 h-8 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="clock" className="w-4 h-4" /></span>{t.priv.disappearing}</h3>
          {circle.kind === 'circle' ? <p className="text-xs text-muted mt-1">{t.priv.disappearingFamily}</p> : (
            <>
              <p className="text-xs text-muted mt-1">{t.priv.disappearingNote}</p>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={t.priv.disappearing}>
                {TIMERS.map(([secs, key]) => {
                  const on = (circle.disappearSeconds ?? null) === secs;
                  return <button key={key} type="button" role="radio" aria-checked={on} disabled={!canTimer} onClick={() => timer(secs)}
                    className={`btn btn-ghost !py-1 transition-colors duration-[var(--dur-instant)] ${on ? '!border-green !text-green font-bold' : ''} ${canTimer ? '' : 'opacity-50'}`}>{t.priv[key]}</button>;
                })}
              </div>
              {!canTimer && <p className="text-xs text-muted mt-1">{t.priv.disappearingAdmins}</p>}
            </>
          )}
        </section>
        <section>
          <h3 className="font-bold text-sm flex items-center gap-2"><span aria-hidden className="w-8 h-8 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="image" className="w-4 h-4" /></span>{t.priv.wallpaper}</h3>
          <p className="text-xs text-muted mt-1">{t.priv.wallpaperNote}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" aria-pressed={wall === null} onClick={() => prefs({ wallpaper: null })} className={`px-2 h-12 rounded-xl border-2 text-xs text-ink bg-card transition-colors duration-[var(--dur-instant)] ${wall === null ? 'border-green text-green font-bold' : 'border-line'}`}>{t.priv.wallpaperDefault}</button>
            {WALL_NAMES.map(w => (
              <button key={w} type="button" aria-pressed={wall === w} aria-label={t.wallpapers[w]} title={t.wallpapers[w]} onClick={() => prefs({ wallpaper: w })}
                className={`wall-${w} w-12 h-12 rounded-xl bg-paper border-2 text-[10px] ${wall === w ? 'border-green' : 'border-line'}`}>{w === 'none' ? t.wallpapers.none : ''}</button>
            ))}
          </div>
          <p className="text-xs text-muted mt-2">{t.priv.colours}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {WALL_COLOURS.map(c => <button key={c} type="button" aria-pressed={wall?.toLowerCase() === c} aria-label={c} onClick={() => prefs({ wallpaper: c })}
              className={`w-9 h-9 rounded-full border-2 ${wall?.toLowerCase() === c ? 'border-green' : 'border-line'}`} style={{ background: c }} />)}
          </div>
        </section>
        <section>
          <h3 className="font-bold text-sm flex items-center gap-2"><span aria-hidden className="w-8 h-8 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="lock" className="w-4 h-4" /></span>{t.priv.lockChat}</h3>
          <p className="text-xs text-muted mt-1">{t.priv.lockNote}</p>
          <button type="button" className="btn btn-ghost mt-2" onClick={() => (circle.locked ? prefs({ locked: false }) : unlocked ? prefs({ locked: true }) : setPinFor('lock'))}>
            {circle.locked ? t.priv.unlockChat : t.priv.lockChat}
          </button>
        </section>
      </div>
      {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
      <button className="btn w-full mt-4" onClick={onClose}>{t.priv.done}</button>
      {pinFor && <PinGate onClose={() => setPinFor(null)} onDone={() => { setPinFor(null); prefs({ locked: true }); }} />}
    </Dialog>
  );
}

// ---- view once ---------------------------------------------------------------------------------

/** A view-once photo, video or voice note. The sender sees who opened it; a recipient can open it one time (the server enforces that). */
export function ViewOnceBubble({ m, mine, meId }: { m: Message; mine: boolean; meId: number }) {
  const { t } = useI18n();
  const [step, setStep] = useState<'idle' | 'confirm' | 'viewing'>('idle');
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);
  const file = m.attachments?.[0];
  const isVoice = m.kind === 'voice';
  const what = isVoice ? t.priv.viewOnceVoice : file?.kind === 'video' ? t.priv.viewOnceVideo : t.priv.viewOncePhoto;
  const whatIcon = isVoice ? 'mic' : file?.kind === 'video' ? 'video' : 'image';
  const opened = m.viewOnce?.openedBy ?? [];
  const mineOpened = opened.includes(meId);
  const gone = !isVoice ? !file : !m.hasAudio;
  async function open() {
    setMsg('');
    try { await api(`/messages/${m.id}/open`, { method: 'POST', body: {} }); setFailed(false); setStep('viewing'); }
    catch (e) { setStep('idle'); setMsg(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  const src = isVoice ? `/api/messages/${m.id}/audio` : `/api/media/${file?.id}`;
  return (
    <div className="my-1 select-none">
      <div className="flex items-center gap-2 rounded-2xl border border-dashed border-current/40 px-3 py-2">
        <span aria-hidden className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="once" className="w-5 h-5" /></span>
        <span className="min-w-0 flex-1">
          <b className="block"><Icon name={whatIcon} className="w-4 h-4 inline-block align-text-bottom me-1" />{what}</b>
          <span className="block text-xs opacity-80">
            {mine ? (opened.length ? t.priv.viewOnceBy.replace('{n}', String(opened.length)) : t.priv.viewOnceNotYet)
              : mineOpened ? t.priv.viewOnceOpened : gone ? t.priv.viewOnceExpired : t.priv.viewOnceTap}
          </span>
        </span>
        {!mine && !mineOpened && !gone && <button type="button" className="btn !py-1 !px-3 text-sm" onClick={() => setStep('confirm')}>{t.priv.viewOnceOpenNow}</button>}
      </div>
      {msg && <p role="alert" className="text-xs text-danger mt-1">{msg}</p>}
      {step === 'confirm' && (
        <Dialog onClose={() => setStep('idle')} label={t.priv.viewOnce}>
          <h2 className="text-lg font-bold flex items-center gap-2"><span aria-hidden className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="once" className="w-5 h-5" /></span>{t.priv.viewOnce}</h2>
          <p className="mt-2">{t.priv.viewOnceConfirm}</p>
          <p className="text-xs text-muted mt-2">{t.priv.viewOnceNote}</p>
          <div className="mt-4 flex gap-2"><button className="btn flex-1" onClick={open}>{t.priv.viewOnceOpenNow}</button><button className="btn btn-ghost" onClick={() => setStep('idle')}>{t.cancel}</button></div>
        </Dialog>
      )}
      {step === 'viewing' && (
        <Dialog onClose={() => setStep('idle')} label={t.priv.viewOnce}>
          {failed ? <p role="alert" className="text-danger">{t.priv.viewOnceFail}</p>
            : isVoice ? <audio autoPlay controls controlsList="nodownload" className="w-full" src={src} onError={() => setFailed(true)} />
            : file?.kind === 'video' ? <video autoPlay controls playsInline controlsList="nodownload" className="max-w-full max-h-[65vh] mx-auto rounded-lg bg-black" src={src} onError={() => setFailed(true)} onContextMenu={e => e.preventDefault()} />
            : <img alt="" className="max-w-full max-h-[65vh] mx-auto rounded-lg" src={src} onError={() => setFailed(true)} onContextMenu={e => e.preventDefault()} draggable={false} />}
          <p className="text-xs text-muted mt-3">{t.priv.viewOnceClosing} {t.priv.viewOnceNote}</p>
          <button className="btn w-full mt-3" onClick={() => setStep('idle')}>{t.priv.viewOnceClose}</button>
        </Dialog>
      )}
    </div>
  );
}

// ---- voice-to-text -----------------------------------------------------------------------------

let status: Promise<boolean> | null = null;
const isConfigured = () => (status ??= api<{ configured: boolean }>('/transcribe').then(r => r.configured).catch(() => { status = null; return false; }));
const store = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* not kept */ } return null; };

/** "Show as text" for ONE voice note, asked by this reader. The note is sent to the speech service only when this is pressed; the text is kept on this device and shown to this person only. */
export function Transcribe({ m }: { m: Message }) {
  const { t } = useI18n();
  const key = `tamtim_tx_${m.id}`;
  const [text, setText] = useState<string | null>(() => store(key));
  const [shown, setShown] = useState(true);
  const [state, setState] = useState<'idle' | 'ask' | 'busy'>('idle');
  const [msg, setMsg] = useState('');
  async function start() {
    setMsg('');
    if (!(await isConfigured())) return setMsg(t.priv.transcribeOff);
    if (store('tamtim_tx_ok') !== '1') return setState('ask');
    run();
  }
  async function run() {
    setState('busy'); setMsg('');
    try {
      const audio = await fetch(`/api/messages/${m.id}/audio`, { credentials: 'same-origin' });
      if (!audio.ok) throw new ApiError('generic', audio.status);
      const blob = await audio.blob();
      const fd = new FormData();
      fd.append('audio', new File([blob], 'voice', { type: (audio.headers.get('content-type') ?? blob.type ?? 'audio/webm').split(';')[0] }));
      const r = await api<{ text: string }>('/transcribe', { form: fd });
      store(key, r.text); setText(r.text); setShown(true);
      if (!r.text.trim()) setMsg(t.priv.transcribeFail);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setMsg(code === 'transcribe_off' ? t.priv.transcribeOff : code === 'too_many_requests' ? t.priv.transcribeLimit : t.priv.transcribeFail);
    } finally { setState('idle'); }
  }
  return (
    <div className="mt-1 text-sm">
      {text && shown && <p className="rounded-xl bg-green-soft text-ink px-2.5 py-1.5 whitespace-pre-wrap break-words" dir="auto"><span className="block text-[11px] opacity-70">{t.priv.transcribeLabel}</span>{text}</p>}
      {text
        ? <button type="button" className="text-xs underline opacity-80" onClick={() => setShown(s => !s)}>{shown ? t.priv.transcribeHide : t.priv.transcribe}</button>
        : <button type="button" className="text-xs underline opacity-80" disabled={state === 'busy'} onClick={start}>{state === 'busy' ? t.priv.transcribing : t.priv.transcribe}</button>}
      {msg && <p role="status" className="text-xs text-danger mt-0.5">{msg}</p>}
      {state === 'ask' && (
        <Dialog onClose={() => setState('idle')} label={t.priv.transcribe}>
          <h2 className="text-lg font-bold">{t.priv.transcribe}</h2>
          <p className="mt-2 text-sm">{t.priv.transcribeAsk}</p>
          <div className="mt-4 flex gap-2"><button className="btn flex-1" onClick={() => { store('tamtim_tx_ok', '1'); run(); }}>{t.priv.transcribeYes}</button><button className="btn btn-ghost" onClick={() => setState('idle')}>{t.cancel}</button></div>
        </Dialog>
      )}
    </div>
  );
}
