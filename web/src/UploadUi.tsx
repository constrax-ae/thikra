import { useEffect, useMemo, useState } from 'react';
import { useI18n } from './i18n';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { prepare } from './media';
import { BlurFrame, CropFrame, MarkupPad, applyStrokes, blurBox, crop, rotate } from './ImageEdit';
import type { Stroke } from './edit';
import { VideoTrim, canEditVideo } from './VideoEdit';
import { readQuality, type Quality } from './quality';
import { MAX_FILES, tooLarge, type UploadFile, type UploadJob, type Uploader } from './uploads';
import { clock } from './VoiceUi';

export const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/** A picture straight from a file on this device (its address is released when it leaves the screen). */
function BlobImg({ blob, className }: { blob: Blob; className?: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img alt="" className={className} src={url} />;
}
const compressible = (f: { type: string }) => f.type.startsWith('image/') && f.type !== 'image/gif';

/**
 * Before sending: what was picked, with a thumbnail each, a caption, Standard or HD for photos, and one remove button per file.
 * A file over the limit is shown with the reason and must be removed before anything is sent (a photo is judged after compression).
 */
export function SendSheet({ picked, caption0, onClose, onSend }: { picked: File[]; caption0: string; onClose: () => void; onSend: (files: UploadFile[], caption: string, viewOnce?: boolean) => void }) {
  const { t } = useI18n();
  const [files, setFiles] = useState(() => picked.slice(0, MAX_FILES));
  const [caption, setCaption] = useState(caption0);
  const [quality, setQuality] = useState<Quality>(readQuality);
  const [busy, setBusy] = useState(false);
  const [once, setOnce] = useState(false);   // view once: one photo or video, no caption
  const onceOk = files.length === 1 && (files[0].type.startsWith('image/') || files[0].type.startsWith('video/'));
  const [over, setOver] = useState<Map<File, number>>(new Map());   // files still too large after compression
  const limitOf = (f: File) => over.get(f) ?? (compressible(f) ? null : tooLarge(f));
  const blocked = files.some(f => limitOf(f) !== null);
  useEffect(() => { if (!files.length) onClose(); }, [files.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    if (busy || blocked || !files.length || tool !== 'none' || editing) return;
    setBusy(true);
    const ready = await Promise.all(files.map(f => prepare(f, quality)));
    const big = new Map<File, number>();
    ready.forEach((p, i) => { const max = tooLarge(p.file); if (max !== null) big.set(files[i], max); });
    if (big.size) { setOver(big); setBusy(false); return; }
    onSend(ready.map(p => ({ name: p.file.name, type: p.file.type, size: p.file.size, blob: p.file, thumb: once && onceOk ? null : p.thumb, w: p.w, h: p.h })), once && onceOk ? '' : caption.trim(), once && onceOk);
  }
  const [active, setActive] = useState(0);
  const cur = files[Math.min(active, files.length - 1)];
  const curMax = cur ? limitOf(cur) : null;
  // Editing the photo being looked at: turn it, crop it, hide part of it, draw on it. The edited picture takes its place in the list.
  const [tool, setTool] = useState<'none' | 'crop' | 'hide' | 'draw' | 'trim'>('none');
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState('');
  const editable = !!cur && cur.type.startsWith('image/') && cur.type !== 'image/gif' && !busy;
  // A video can be cut and silenced only where the browser can re-make it; elsewhere the button is simply not there.
  const trimmable = !!cur && cur.type.startsWith('video/') && !busy && canEditVideo();
  async function edit(make: () => Promise<File>) {
    if (!cur) return;
    const was = cur;
    setEditing(true); setEditError('');
    try { const next = await make(); setFiles(list => list.map(f => (f === was ? next : f))); setOver(new Map()); }
    catch { setEditError(t.photoEdit.failed); }
    finally { setEditing(false); setTool('none'); }
  }
  // The order they are sent in: drag a thumbnail onto another, or move the one being looked at.
  const [dragging, setDragging] = useState<number | null>(null);
  function moveTo(from: number, to: number) {
    if (from === to || to < 0 || to >= files.length) return;
    setFiles(list => { const next = [...list]; const [f] = next.splice(from, 1); next.splice(to, 0, f); return next; });
    setActive(to);
  }
  const at = cur ? files.indexOf(cur) : -1;
  return (
    <Dialog wide onClose={() => { if (!busy) onClose(); }} label={t.photosAndFiles}>
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-bold flex-1">{t.photosAndFiles}</h2>
        <button type="button" disabled={busy} onClick={onClose} aria-label={t.cancel} title={t.cancel}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-muted hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]"><Icon name="x" className="w-5 h-5" /></button>
      </div>
      {picked.length > MAX_FILES && <p role="status" className="text-xs text-gold-dark mt-1">{t.tooManyFiles}</p>}

      {/* The one being looked at, large; the others as a strip underneath to switch between and remove. */}
      {cur && tool === 'crop' && <CropFrame src={cur} onCancel={() => setTool('none')} onDone={box => edit(() => crop(cur, box))} />}
      {cur && tool === 'hide' && <BlurFrame src={cur} onCancel={() => setTool('none')} onDone={box => edit(() => blurBox(cur, box))} />}
      {cur && tool === 'draw' && <MarkupPad src={cur} onCancel={() => setTool('none')} onDone={(strokes: Stroke[]) => edit(() => applyStrokes(cur, strokes))} />}
      {cur && tool === 'trim' && <VideoTrim src={cur} onCancel={() => setTool('none')} onDone={next => edit(async () => next)} />}
      {cur && tool === 'none' && (
        <div className={`mt-3 relative rounded-2xl overflow-hidden bg-paper border ${curMax !== null ? 'border-danger' : 'border-line'} h-[min(20rem,45vh)] flex items-center justify-center animate-fade-in`}>
          {cur.type.startsWith('image/') ? <BlobImg blob={cur} className="max-w-full max-h-full object-contain" />
            : (
              <span className="flex flex-col items-center gap-3 p-6 text-center">
                <span className="w-16 h-16 rounded-2xl bg-green-soft text-green flex items-center justify-center"><Icon name={cur.type.startsWith('video/') ? 'video' : 'file'} className="w-8 h-8" /></span>
                <span className="text-sm font-medium break-all text-ink">{cur.name}</span>
              </span>
            )}
          <span className="absolute bottom-2 start-2 rounded-full bg-black/55 text-white text-[11px] px-2 py-0.5" dir="ltr">{sizeText(cur.size)}</span>
          {editing && <span className="absolute inset-0 bg-card/60 flex items-center justify-center"><Icon name="refresh" className="w-6 h-6 text-green animate-spin" /></span>}
        </div>
      )}
      {cur && tool === 'none' && (editable || trimmable || files.length > 1) && (
        <div role="toolbar" aria-label={t.photosAndFiles} className="mt-2 flex items-center gap-1 flex-wrap">
          {editable && <>
            <button type="button" disabled={editing} onClick={() => edit(() => rotate(cur))} className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-sm text-ink hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)] disabled:opacity-50"><Icon name="rotate" className="w-4 h-4" />{t.photoEdit.rotate}</button>
            <button type="button" disabled={editing} onClick={() => setTool('crop')} className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-sm text-ink hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)] disabled:opacity-50"><Icon name="crop" className="w-4 h-4" />{t.photoEdit.crop}</button>
            <button type="button" disabled={editing} onClick={() => setTool('hide')} className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-sm text-ink hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)] disabled:opacity-50"><Icon name="mosaic" className="w-4 h-4" />{t.photoEdit.hide}</button>
            <button type="button" disabled={editing} onClick={() => setTool('draw')} className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-sm text-ink hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)] disabled:opacity-50"><Icon name="pen" className="w-4 h-4" />{t.photoEdit.draw}</button>
          </>}
          {trimmable && <button type="button" disabled={editing} onClick={() => setTool('trim')} className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-sm text-ink hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)] disabled:opacity-50"><Icon name="scissors" className="w-4 h-4" />{t.videoEdit.trim}</button>}
          {files.length > 1 && <>
            <span className="flex-1" />
            <button type="button" disabled={busy || at <= 0} onClick={() => moveTo(at, at - 1)} aria-label={t.photoEdit.moveEarlier} title={t.photoEdit.moveEarlier} className="w-9 h-9 rounded-xl inline-flex items-center justify-center text-ink hover:bg-green-soft hover:text-green disabled:opacity-40 disabled:hover:bg-transparent"><Icon name="arrow-start" className="w-4 h-4 rtl:-scale-x-100" /></button>
            <span className="text-xs text-muted tabular-nums" dir="ltr">{at + 1} / {files.length}</span>
            <button type="button" disabled={busy || at >= files.length - 1} onClick={() => moveTo(at, at + 1)} aria-label={t.photoEdit.moveLater} title={t.photoEdit.moveLater} className="w-9 h-9 rounded-xl inline-flex items-center justify-center text-ink hover:bg-green-soft hover:text-green disabled:opacity-40 disabled:hover:bg-transparent"><Icon name="arrow-end" className="w-4 h-4 rtl:-scale-x-100" /></button>
          </>}
        </div>
      )}
      {editError && <p role="alert" className="text-sm text-danger mt-1">{editError}</p>}
      {files.length > 1 && (
        <ul className="mt-1 flex gap-2 overflow-x-auto pt-2 pb-1 pe-2">
          {files.map((f, i) => {
            const max = limitOf(f);
            const on = f === cur;
            return (
              <li key={`${f.name}-${f.size}-${i}`} className={`relative shrink-0 transition-opacity ${dragging === i ? 'opacity-40' : ''}`}
                draggable={!busy} onDragStart={e => { setDragging(i); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragging(null)}
                onDragOver={e => { if (dragging !== null) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragging !== null) moveTo(dragging, i); setDragging(null); }}>
                <button type="button" onClick={() => setActive(i)} aria-label={f.name} aria-pressed={on}
                  className={`block w-14 h-14 rounded-xl overflow-hidden bg-paper border-2 transition-colors duration-[var(--dur-instant)] ${max !== null ? 'border-danger' : on ? 'border-green' : 'border-transparent'}`}>
                  {f.type.startsWith('image/') ? <BlobImg blob={f} className="w-full h-full object-cover" />
                    : <span className="w-full h-full flex items-center justify-center text-green"><Icon name={f.type.startsWith('video/') ? 'video' : 'file'} className="w-5 h-5" /></span>}
                </button>
                <button type="button" disabled={busy} aria-label={`${t.removeFile} ${f.name}`} onClick={() => { setFiles(list => list.filter(x => x !== f)); setActive(0); }}
                  className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-ink text-paper flex items-center justify-center border-2 border-card"><Icon name="x" className="w-3 h-3" /></button>
              </li>
            );
          })}
        </ul>
      )}
      {files.length === 1 && cur && (
        <button type="button" disabled={busy} onClick={() => setFiles([])} className="mt-2 text-xs text-danger inline-flex items-center gap-1 hover:underline"><Icon name="trash" className="w-3.5 h-3.5" />{t.removeFile}</button>
      )}
      {files.filter(f => limitOf(f) !== null).map(f => (
        <p key={f.name + f.size} role="alert" className="text-sm text-danger mt-2">{fill(t.fileTooLarge, { name: f.name, size: sizeText(f.size), max: sizeText(limitOf(f)!) })}</p>
      ))}

      {/* Options on one line: quality as a two-way switch, view once as a toggle chip. */}
      {(files.some(compressible) || onceOk) && (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          {files.some(compressible) && (
            <div role="group" aria-label={t.uploadQuality} className="inline-flex p-0.5 rounded-xl bg-paper border border-line">
              {(['standard', 'original'] as const).map(k => (
                <button key={k} type="button" aria-pressed={quality === k} disabled={busy} onClick={() => { setQuality(k); setOver(new Map()); }}
                  className={`h-8 px-3.5 rounded-[0.6rem] text-sm transition-[background-color,color,box-shadow] duration-[var(--dur-fast)] ${quality === k ? 'bg-card text-green font-bold elevated-1' : 'text-muted hover:text-ink'}`}>{t.qualityNames[k]}</button>
              ))}
            </div>
          )}
          {onceOk && (
            <button type="button" aria-pressed={once} disabled={busy} onClick={() => setOnce(v => !v)}
              className={`h-9 px-3.5 rounded-full border text-sm inline-flex items-center gap-1.5 transition-colors duration-[var(--dur-instant)] ${once ? 'bg-green-soft border-green text-green font-bold' : 'border-line text-muted hover:text-ink'}`}>
              <Icon name="once" className="w-4 h-4" />{t.priv.viewOnce}
            </button>
          )}
        </div>
      )}
      {once && <p className="text-xs text-muted mt-2">{t.priv.viewOnceNote}</p>}
      {files.some(f => f.type.startsWith('video/')) && <p className="text-xs text-muted mt-2">{t.videoNotCompressed}</p>}

      {/* The caption and the send button, shaped like the message box. */}
      <div className="mt-4 flex items-center gap-2">
        {!once ? (
          <div className="field-group !rounded-full flex-1 min-w-0 items-center">
            <input className="!px-4 min-w-0" value={caption} maxLength={4000} placeholder={t.captionHint} disabled={busy} onChange={e => setCaption(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
          </div>
        ) : <span className="flex-1" />}
        <button type="button" className="btn btn-primary !rounded-full h-11 px-5 shrink-0 inline-flex items-center gap-2" disabled={busy || blocked || tool !== 'none' || editing} onClick={send}>
          {busy ? t.preparing : <><Icon name="send" className="w-4 h-4 rtl:-scale-x-100" />{fill(t.sendCount, { n: files.length })}</>}
        </button>
      </div>
    </Dialog>
  );
}

/** Something on its way to the server: what it is, how far it has got, and a way to stop it (or to try again after a refusal). */
export function PendingUpload({ job, uploader, error }: { job: UploadJob; uploader: Uploader; error: (code: string) => string }) {
  const { t } = useI18n();
  const pct = Math.round(uploader.progress(job.cid) * 100);
  const waiting = uploader.isWaiting(job.cid);
  const pics = job.files.filter(f => f.type.startsWith('image/'));
  const rest = job.files.filter(f => !f.type.startsWith('image/'));
  return (
    <div className="flex justify-start" data-upload={job.cid}>
      <div className="max-w-[85%] rounded-2xl px-3 py-2 bubble-mine animate-fade-in">
        {job.kind === 'voice' ? <p className="text-sm flex items-center gap-1.5"><Icon name="mic" className="w-4 h-4" />{t.voiceWord} <span dir="ltr" className="tabular-nums opacity-80">{clock(job.voice?.durationMs ?? 0)}</span></p> : (
          <>
            {pics.length > 0 && (
              <div className={`mb-1 grid gap-1 ${pics.length > 1 ? 'grid-cols-2' : ''}`}>
                {pics.map((f, i) => <BlobImg key={i} blob={f.thumb ?? f.blob} className="w-full max-h-48 object-cover rounded-lg opacity-70" />)}
              </div>
            )}
            {rest.map((f, i) => <p key={i} className="text-sm flex items-center gap-2"><span aria-hidden className="shrink-0"><Icon name={f.type.startsWith('video/') ? 'video' : 'file'} className="w-4 h-4" /></span><span className="min-w-0 flex-1 truncate">{f.name}</span><span className="text-xs opacity-80" dir="ltr">{sizeText(f.size)}</span></p>)}
            {job.caption && <p className="whitespace-pre-wrap break-words mt-1">{job.caption}</p>}
          </>
        )}
        {!job.failed && job.kind === 'files' && (
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t.uploading} className="mt-2 h-1.5 rounded-full bg-black/15 overflow-hidden" dir="ltr">
            <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
          {job.failed ? (
            <>
              <span role="status" className="text-danger font-bold">{t.uploadFailed}: {error(job.failed)}{job.max ? ` (${fill(t.uploadLimitReason, { max: sizeText(job.max) })})` : ''}</span>
              <button type="button" className="text-danger underline" onClick={() => uploader.retry(job.cid)}>{t.retrySend}</button>
              <button type="button" className="underline opacity-80" onClick={() => uploader.cancel(job.cid)}>{t.discardUnsent}</button>
            </>
          ) : (
            <>
              <span role="status" className="opacity-80">{waiting ? t.waitingNetwork : job.kind === 'voice' ? t.sendingVoice : fill(t.uploadingPct, { pct })}</span>
              <button type="button" className="ms-auto underline" aria-label={t.cancelUpload} onClick={() => uploader.cancel(job.cid)}><span className="inline-flex items-center gap-1"><Icon name="x" className="w-3 h-3" />{t.cancel}</span></button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
