import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { clampRange, clipName, isWholeClip, MIN_CLIP, pickMime, secs } from './edit';

/**
 * Cutting a video down to the part that matters, and dropping its sound.
 *
 * A browser cannot re-wrap an MP4 without re-encoding it, so the only honest way to do this on the device is to play
 * the chosen piece and record it as it goes: it takes as long as the piece lasts, and the picture is encoded again.
 * That is why nothing happens unless the person asks for it — an untouched video is still sent exactly as it was.
 * The sound is taken from the element through WebAudio and NOT connected to the speakers, so the room stays quiet
 * while it records. Muting simply leaves the sound out of the recording, so what is sent has no audio track at all.
 */

type Capture = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
const streamOf = (v: HTMLVideoElement) => { const c = v as Capture; return (c.captureStream ?? c.mozCaptureStream)?.call(c) ?? null; };

/** Whether this browser can do it at all. Where it cannot, the buttons are not offered rather than failing late. */
export function canEditVideo(): boolean {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return false;
  const v = document.createElement('video') as Capture;
  if (!v.captureStream && !v.mozCaptureStream) return false;
  return !!pickMime(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
}

export interface Trim { start: number; end: number; mute: boolean }

/** The chosen piece of the clip, as a new file. `onProgress` gets 0..1; `cancel()` stops it and throws. */
export async function trimVideo(file: File, { start, end, mute }: Trim, onProgress: (p: number) => void, signal?: { stopped: boolean }): Promise<File> {
  const mime = pickMime(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('unsupported');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url; video.playsInline = true; video.muted = mute; video.preload = 'auto';
  let audio: { ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null = null;
  try {
    await new Promise<void>((res, rej) => { video.onloadeddata = () => res(); video.onerror = () => rej(new Error('decode')); });
    await new Promise<void>(res => { video.currentTime = start; video.onseeked = () => res(); });

    const picture = streamOf(video);
    if (!picture) throw new Error('unsupported');
    const tracks = [...picture.getVideoTracks()];
    if (!mute) {
      const Ctx: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaElementSource(video).connect(dest);   // to the recording only, never to the speakers
      audio = { ctx, dest };
      tracks.push(...dest.stream.getAudioTracks());
    }
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime });
    const parts: Blob[] = [];
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    const done = new Promise<Blob>(res => { rec.onstop = () => res(new Blob(parts, { type: mime })); });

    rec.start(250);
    await video.play();
    await new Promise<void>(res => {
      const tick = () => {
        if (signal?.stopped || video.currentTime >= end || video.ended) return res();
        onProgress(Math.min(1, (video.currentTime - start) / Math.max(MIN_CLIP, end - start)));
        requestAnimationFrame(tick);
      };
      tick();
    });
    video.pause();
    rec.stop();
    const blob = await done;
    if (signal?.stopped) throw new Error('cancelled');
    onProgress(1);
    return new File([blob], clipName(file.name, mime), { type: mime });
  } finally {
    video.pause(); video.removeAttribute('src'); video.load();
    audio?.ctx.close().catch(() => {});
    URL.revokeObjectURL(url);
  }
}

/** Choose the piece to keep and whether it keeps its sound, then make it. */
export function VideoTrim({ src, onDone, onCancel }: { src: File; onDone: (file: File) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [mute, setMute] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef<{ stopped: boolean }>({ stopped: false });
  useEffect(() => { const u = URL.createObjectURL(src); setUrl(u); return () => URL.revokeObjectURL(u); }, [src]);
  useEffect(() => () => { stop.current.stopped = true; }, []);

  const set = (which: 'start' | 'end') => (value: number) => {
    const next = clampRange(which === 'start' ? value : range.start, which === 'end' ? value : range.end, duration, which);
    setRange(next);
    if (video.current) video.current.currentTime = which === 'start' ? next.start : next.end;
  };
  const whole = isWholeClip(range.start, range.end, duration);
  const length = Math.max(0, range.end - range.start);

  async function apply() {
    if (busy) return;
    if (whole && !mute) { onCancel(); return; }   // nothing was asked for
    setBusy(true); setError(''); setProgress(0);
    stop.current = { stopped: false };
    try { onDone(await trimVideo(src, { start: range.start, end: range.end, mute }, setProgress, stop.current)); }
    catch { if (!stop.current.stopped) setError(t.videoEdit.failed); setBusy(false); }
  }

  return (
    <div className="mt-3">
      <div className="relative rounded-2xl overflow-hidden bg-paper border border-line h-[min(20rem,45vh)] flex items-center justify-center">
        {url && <video ref={video} src={url} playsInline muted preload="metadata" className="max-w-full max-h-full"
          onLoadedMetadata={e => { const d = e.currentTarget.duration || 0; setDuration(d); setRange({ start: 0, end: d }); }} />}
      </div>
      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 text-muted">{t.videoEdit.start}</span>
          <input type="range" min={0} max={Math.max(0, duration)} step={0.1} value={range.start} disabled={busy} onChange={e => set('start')(Number(e.target.value))} className="flex-1" aria-label={t.videoEdit.start} />
          <span className="tabular-nums w-12 text-end" dir="ltr">{secs(range.start)}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 text-muted">{t.videoEdit.end}</span>
          <input type="range" min={0} max={Math.max(0, duration)} step={0.1} value={range.end} disabled={busy} onChange={e => set('end')(Number(e.target.value))} className="flex-1" aria-label={t.videoEdit.end} />
          <span className="tabular-nums w-12 text-end" dir="ltr">{secs(range.end)}</span>
        </label>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted">{t.videoEdit.length}: <span className="tabular-nums" dir="ltr">{secs(length)}</span></span>
          <button type="button" aria-pressed={mute} disabled={busy} onClick={() => setMute(v => !v)}
            className={`h-9 px-3.5 rounded-full border text-sm inline-flex items-center gap-1.5 transition-colors duration-[var(--dur-instant)] ${mute ? 'bg-green-soft border-green text-green font-bold' : 'border-line text-muted hover:text-ink'}`}>
            <Icon name={mute ? 'mic-off' : 'mic'} className="w-4 h-4" />{t.videoEdit.mute}
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{t.videoEdit.note}</p>
      {error && <p role="alert" className="text-sm text-danger mt-1">{error}</p>}
      {busy && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t.videoEdit.working} className="mt-2 h-1.5 rounded-full bg-line overflow-hidden" dir="ltr">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={busy || duration <= 0} className="btn btn-primary flex-1 inline-flex items-center justify-center gap-2" onClick={apply}>
          <Icon name="scissors" className="w-4 h-4" />{busy ? t.videoEdit.working : t.videoEdit.apply}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => { stop.current.stopped = true; onCancel(); }}>{t.cancel}</button>
      </div>
    </div>
  );
}
