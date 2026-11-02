import { useMemo, useRef, useState } from 'react';
import { api, ApiError, type CircleDetail } from './api';
import { useI18n } from './i18n';
import { parseWhatsApp, type ParsedChat } from '../../core/whatsapp';
import { buildDraft } from '../../core/importer';
import { defaultAlbumTitle, planAlbum, zipResolver, type AlbumKind } from '../../core/album';
import { openZip, type Zip } from './zip';
import { prepare } from './media';

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const mb = (n: number) => `${Math.max(1, Math.round(n / 1048576))} MB`;

/** Reads a WhatsApp export on this device (a zip can be gigabytes: only the chat text and the files you choose are ever read). */
export function ImportPanel({ circle, onDone }: { circle: CircleDetail; onDone: () => void }) {
  const { t, lang } = useI18n();
  const [parsed, setParsed] = useState<ParsedChat | null>(null);
  const [zip, setZip] = useState<Zip | null>(null);
  const [sensitivity, setSensitivity] = useState(circle.sensitivity);
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const [years, setYears] = useState<Set<number>>(new Set());
  const [kinds, setKinds] = useState<Record<AlbumKind, boolean>>({ image: true, voice: true, video: false });
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ n: number; m: number } | null>(null);
  const cancel = useRef(false);
  const albumId = useRef<number | null>(null);

  const plan = useMemo(() => (parsed ? planAlbum(parsed.messages, zip ? zipResolver(zip.entries.keys()) : () => undefined) : null), [parsed, zip]);
  const draft = useMemo(() => (parsed ? buildDraft(parsed.messages.filter(m => years.has(Number(m.date.slice(0, 4)))), sensitivity) : null), [parsed, sensitivity, years]);
  const wanted = useMemo(() => (plan ? plan.items.filter(i => years.has(i.year) && kinds[i.kind]) : []), [plan, years, kinds]);
  const bytes = useMemo(() => wanted.reduce((n, i) => n + (zip?.entries.get(i.entry)?.usize ?? 0), 0), [wanted, zip]);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(''); setResult(''); setUnticked(new Set()); setParsed(null); setZip(null); albumId.current = null;
    try {
      let text: string, z: Zip | null = null;
      if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
        z = await openZip(file);
        const txt = [...z.entries.values()].filter(x => /\.txt$/i.test(x.name) && x.usize < 50_000_000).sort((a, b) => b.usize - a.usize)[0];
        if (!txt) throw new Error('no chat');
        text = await z.text(txt.name);
      } else text = await file.text();
      const chat = parseWhatsApp(text);
      if (chat.messages.length === 0) { setError(t.importUnrecognized); return; }
      setParsed(chat); setZip(z);
      setYears(new Set(chat.messages.map(m => Number(m.date.slice(0, 4)))));
      setTitle(defaultAlbumTitle(chat.range ?? null, lang));
    } catch {
      setError(t.importUnrecognized);
    }
  }

  const toggleYear = (y: number) => { setYears(p => { const n = new Set(p); if (n.has(y)) n.delete(y); else n.add(y); return n; }); setUnticked(new Set()); };
  const chosen = draft ? draft.events.filter((_, i) => !unticked.has(i)) : [];
  const fail = (err: unknown) => setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic);

  async function upload() {
    if (!zip || wanted.length === 0) return;
    setBusy(true); setError(''); cancel.current = false;
    try {
      if (!albumId.current) {
        const r = await api<{ id: number }>(`/circles/${circle.id}/albums`, { body: { title: title.trim() || defaultAlbumTitle(plan!.range, lang), source: 'whatsapp', from: plan!.range?.from, to: plan!.range?.to } });
        albumId.current = r.id;
      }
      let n = 0, stop = false;
      setProgress({ n, m: wanted.length });
      const queue = [...wanted];
      const worker = async () => {
        for (let it = queue.shift(); it && !stop && !cancel.current; it = queue.shift()) {
          try {
            const ext = it.entry.split('.').pop()!.toLowerCase();
            const blob = await zip.read(it.entry);
            const raw = new File([blob], it.file, { type: MIME[ext] ?? 'application/octet-stream' });
            const p = it.kind === 'voice' ? { file: raw, thumb: null, w: null, h: null } : await prepare(raw);
            const form = new FormData();
            form.append('file', p.file); if (p.thumb) form.append('thumb', p.thumb, 'thumb.jpg');
            form.append('takenAt', it.takenAt); form.append('sender', it.sender);
            if (p.w) form.append('w', String(p.w)); if (p.h) form.append('h', String(p.h));
            await api(`/albums/${albumId.current}/items`, { form });
          } catch (err) {
            if (err instanceof ApiError && (err.code === 'storage_full' || err.code === 'archive_readonly' || err.code === 'forbidden')) { stop = true; fail(err); if (err.code === 'storage_full') setError(t.impFull); }
            // any other single file that fails is skipped; the rest carry on
          }
          setProgress({ n: ++n, m: wanted.length });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (stop) return;
      if (cancel.current) { setError(t.impPartial.replace('{n}', String(n)).replace('{m}', String(wanted.length))); return; }
      setResult(t.impAlbumDone.replace('{n}', String(n)));
      if (chosen.length > 0) await sendEvents();
      else { setParsed(null); setZip(null); }
      onDone();
    } catch (err) { fail(err); } finally { setBusy(false); setProgress(null); }
  }

  async function sendEvents() {
    const r = await api<{ added: number; skipped: number }>(`/circles/${circle.id}/import`, {
      body: { entries: chosen.map(({ date, title, summary, category }) => ({ date, title, summary, category })) },
    });
    setResult(r2 => `${r2 ? r2 + ' · ' : ''}${t.importDone.replace('{a}', String(r.added)).replace('{s}', String(r.skipped))}`);
    setParsed(null); setZip(null);
  }
  async function eventsOnly() {
    setBusy(true); setError('');
    try { setResult(''); await sendEvents(); onDone(); } catch (err) { fail(err); } finally { setBusy(false); }
  }

  const hasMedia = !!plan && (plan.items.length > 0);
  return (
    <section className="card p-4 space-y-3">
      <h3 className="font-bold">{t.importWhatsapp}</h3>
      <p className="text-sm text-muted">{t.importPrivacy}</p>
      <p className="text-xs text-muted">{t.importHow}</p>
      <input type="file" accept=".txt,.zip,text/plain,application/zip" onChange={pick} className="block w-full text-sm" aria-label={t.importPick} disabled={busy} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {result && <p role="status" className="text-sm text-green">{result}</p>}

      {parsed && draft && plan && (
        <>
          <p className="text-sm">
            <bdi dir="ltr">{parsed.range?.from} → {parsed.range?.to}</bdi> · {parsed.messages.length} {t.importMessages}
          </p>
          <p className="text-xs text-muted">{t.importParticipants}: {parsed.senders.slice(0, 6).map(s => s.name).join('، ')}</p>

          <fieldset className="space-y-1" disabled={busy}>
            <legend className="text-sm font-medium">{t.impYearsLbl}</legend>
            <div className="flex flex-wrap gap-2">
              {plan.years.map(y => (
                <label key={y.year} className={`px-3 py-1 rounded-full border text-sm cursor-pointer ${years.has(y.year) ? 'bg-green-soft border-green text-green font-bold' : 'border-line text-muted'}`}>
                  <input type="checkbox" className="sr-only" checked={years.has(y.year)} onChange={() => toggleYear(y.year)} />
                  {y.year} <span className="text-xs">({y.image + y.voice}{y.video ? `+${y.video}` : ''})</span>
                </label>
              ))}
            </div>
          </fieldset>

          <h4 className="font-bold text-green">{t.impAlbumHead}</h4>
          {!hasMedia ? <p className="text-sm text-muted">{t.impNoMedia}</p> : (
            <div className="space-y-2">
              <label className="block text-sm font-medium">{t.impAlbumName}
                <input className="field mt-1" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} disabled={busy} />
              </label>
              <div className="flex flex-col gap-1 text-sm">
                {([['image', t.impPhotos], ['voice', t.impVoices], ['video', t.impVideos]] as const).map(([k, label]) => {
                  const total = plan.items.filter(i => years.has(i.year) && i.kind === k).length;
                  if (!plan.items.some(i => i.kind === k)) return null;
                  return <label key={k} className="flex items-center gap-2"><input type="checkbox" className="w-5 h-5 accent-[#1f4d3f]" checked={kinds[k]} disabled={busy} onChange={() => setKinds(p => ({ ...p, [k]: !p[k] }))} />{label} ({total})</label>;
                })}
              </div>
              <p className="text-xs text-muted">{wanted.length} · {t.impSize}: {mb(bytes)}
                {plan.missing > 0 && <> · {plan.missing} {t.impMissing}</>}{plan.notKept > 0 && <> · {plan.notKept} {t.impNotKept}</>}</p>
              {progress && <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.m} aria-valuenow={progress.n} className="h-2 rounded-full bg-line overflow-hidden"><div className="h-full bg-green" style={{ width: `${(progress.n / progress.m) * 100}%` }} /></div>}
              {progress && <p className="text-xs text-muted" role="status">{t.impUploading.replace('{n}', String(progress.n)).replace('{m}', String(progress.m))}</p>}
              <div className="flex gap-2">
                <button className="btn flex-1" disabled={busy || wanted.length === 0 || years.size === 0} onClick={upload}>{t.impMake} ({wanted.length})</button>
                {busy && <button className="btn btn-ghost" onClick={() => { cancel.current = true; }}>{t.impCancel}</button>}
              </div>
            </div>
          )}

          <h4 className="font-bold text-green">{t.impEventsHead}</h4>
          <div>
            <label className="block text-sm font-medium mb-1">{t.sensitivity}</label>
            <select className="field" value={sensitivity} disabled={busy} onChange={e => { setSensitivity(e.target.value as typeof sensitivity); setUnticked(new Set()); }}>
              {(['strict', 'medium', 'lenient'] as const).map(s => <option key={s} value={s}>{t.sens[s]}</option>)}
            </select>
          </div>
          {draft.events.length === 0 ? <p className="text-sm text-muted">{t.importNone}</p> : (
            <ol className="space-y-2 max-h-96 overflow-y-auto">
              {draft.events.map((ev, i) => (
                <li key={`${ev.date}-${i}`} className="border border-line rounded-xl p-2">
                  <label className="flex items-start gap-3">
                    <input type="checkbox" className="mt-1 w-5 h-5 accent-[#1f4d3f]" checked={!unticked.has(i)} disabled={busy}
                      onChange={() => setUnticked(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <span className="px-2 py-0.5 rounded-full bg-green-soft text-green">{t.cat[ev.category ?? 'other']}</span>
                        <bdi dir="ltr">{ev.date}</bdi>
                        {ev.reactions > 0 && <span>+{ev.reactions}</span>}
                      </span>
                      <span className="block whitespace-pre-wrap break-words">{ev.summary}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ol>
          )}
          <button className="btn btn-ghost w-full" disabled={busy || chosen.length === 0} onClick={eventsOnly}>{t.importAdd} ({chosen.length})</button>
        </>
      )}
    </section>
  );
}
