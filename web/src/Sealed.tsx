import { useEffect, useRef, useState } from 'react';
import { Picker } from './Picker';
import { Toggle } from './States';
import { MachineNote } from './LangPicker';
import { api, ApiError, toDate, type CircleDetail, type CircleSummary } from './api';
import { useI18n, intlLocale } from './i18n';
import { Icon } from './icons';

type Trigger = 'date' | 'event' | 'death';
interface Sealed { id: number; circleId: number; circleName: string; trigger: Trigger; occasion: string | null; kind: 'text' | 'voice' | 'video' | 'image'; body: string; fileName: string | null; unlockAt: string | null; yearly: boolean; status: 'sealed' | 'waiting' | 'stopped'; releaseAt: string | null; note: string | null; recipient: string | null }
interface Evidence { messages: number; members: number; needMessages: number; needMembers: number }
interface Envelopes {
  total: number;
  events: Array<{ id: number; author: string; waiting: boolean; releaseAt: string | null; evidence: Evidence; canStop: boolean }>;
  deathEnabled?: boolean;
  deaths: Array<{ authorId: number; author: string; count: number; waiting: boolean; releaseAt: string | null; evidence: Evidence; canStop: boolean }>;
  waitHours: number;
  agentActive: boolean;
}

const clock = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Sealed messages: letters to the family's future, as text, voice or video. The disclosure comes first, because the first version keeps the content on our servers. */
export function SealedPage({ meId, onBack }: { meId: number; onBack: () => void }) {
  const { t, lang } = useI18n();
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [mine, setMine] = useState<Sealed[]>([]);
  const [circle, setCircle] = useState<number | ''>('');
  const [members, setMembers] = useState<CircleDetail['members']>([]);
  const [env, setEnv] = useState<Envelopes | null>(null);
  const [trigger, setTrigger] = useState<Trigger>('date');
  const [to, setTo] = useState<number | ''>('');
  const [dates, setDates] = useState<string[]>(['']);
  const [occasion, setOccasion] = useState('');
  const [yearly, setYearly] = useState(false);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<{ blob: Blob; name: string; kind: 'voice' | 'video' | 'image'; ms: number | null } | null>(null);
  const [recording, setRecording] = useState<null | 'voice' | 'video'>(null);
  const [recMs, setRecMs] = useState(0);
  const [preview, setPreview] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; start: number; kind: 'voice' | 'video' } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = () => api<Sealed[]>('/me/sealed').then(setMine).catch(() => {});
  const loadEnv = (c: number | '') => c === '' ? setEnv(null) : api<Envelopes>(`/circles/${c}/sealed-envelopes`).then(setEnv).catch(() => setEnv(null));
  useEffect(() => {
    api<CircleSummary[]>('/circles').then(l => { const c = l.filter(x => x.kind !== 'direct'); setCircles(c); if (c[0]) setCircle(c[0].id); }).catch(() => {});
    load();
  }, []);
  useEffect(() => {
    if (circle === '') return;
    api<CircleDetail>(`/circles/${circle}`).then(d => setMembers(d.members.filter(m => m.id !== meId))).catch(() => setMembers([]));
    setTo(''); loadEnv(circle);
  }, [circle, meId]);
  useEffect(() => { if (!recording) return; const i = setInterval(() => setRecMs(Date.now() - rec.current!.start), 250); return () => clearInterval(i); }, [recording]);
  useEffect(() => { if (!file) { setPreview(''); return; } const u = URL.createObjectURL(file.blob); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);

  async function startRec(kind: 'voice' | 'video') {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: true } : { audio: true });
      const mr = new MediaRecorder(stream);
      const state = { mr, stream, chunks: [] as Blob[], start: Date.now(), kind };
      mr.ondataavailable = e => e.data.size && state.chunks.push(e.data);
      mr.start(); rec.current = state; setRecMs(0); setRecording(kind);
    } catch { setError(t.micDenied); }
  }
  function stopRec() {
    const r = rec.current; if (!r) return;
    r.mr.onstop = () => {
      r.stream.getTracks().forEach(x => x.stop());
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || (r.kind === 'video' ? 'video/webm' : 'audio/webm') });
      setFile({ blob, name: r.kind === 'video' ? 'video.webm' : 'voice.webm', kind: r.kind, ms: Date.now() - r.start });
    };
    r.mr.stop(); rec.current = null; setRecording(null);
  }
  function chooseFile(f: File | undefined) {
    if (!f) return;
    const kind = f.type.startsWith('audio/') ? 'voice' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
    if (!kind) { setError(t.errors.invalid_attachment); return; }
    setError(''); setFile({ blob: f, name: f.name, kind, ms: null });
  }

  async function seal(e: React.FormEvent) {
    e.preventDefault(); setError(''); setMsg('');
    try {
      const fd = new FormData();
      if (file) { fd.append('file', new File([file.blob], file.name, { type: file.blob.type })); if (file.ms) fd.append('duration', String(file.ms)); }
      fd.append('body', body); fd.append('trigger', trigger); if (occasion) fd.append('occasion', occasion);
      if (trigger === 'date') { fd.append('dates', JSON.stringify(dates.map(d => new Date(d).toISOString()))); if (yearly && dates.length === 1) fd.append('yearly', 'true'); if (to !== '') fd.append('recipientId', String(to)); }
      await api(`/circles/${circle}/sealed`, { form: fd });
      setBody(''); setDates(['']); setOccasion(''); setYearly(false); setFile(null); setMsg(t.sealedDone); load(); loadEnv(circle);
    } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
  }
  const act = async (path: string, opts: { method?: string } = {}) => {
    try { await api(path, { method: opts.method ?? 'POST', body: opts.method === 'DELETE' ? undefined : {} }); } catch (err) { setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); }
    load(); loadEnv(circle);
  };
  const minWhen = new Date(Date.now() + 10 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const hasContent = !!file || !!body.trim();
  const canSeal = hasContent && circle !== '' && (trigger !== 'date' || dates.every(Boolean)) && (trigger !== 'event' || !!occasion.trim());
  const dt = (iso: string) => toDate(iso).toLocaleString(intlLocale(lang), { dateStyle: 'long', timeStyle: 'short' });
  const icon = (k: string) => <Icon name={({ voice: 'mic', video: 'video', image: 'image' } as const)[k as 'voice' | 'video' | 'image'] ?? 'file'} className="w-3.5 h-3.5 inline-block align-[-2px]" />;
  const trigLabel = (s: Sealed) => s.trigger === 'date' ? (s.unlockAt ? dt(s.unlockAt) : '') : s.trigger === 'event' ? `${t.trigEvent}: ${s.occasion ?? ''}` : t.trigDeath;

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center gap-2">
        <button className="w-10 h-10 rounded-xl text-muted flex items-center justify-center hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]" onClick={onBack} aria-label={t.back} title={t.back}><Icon name="arrow-back" className="w-5 h-5 rtl:-scale-x-100" /></button>
        <span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center"><Icon name="lock" className="w-5 h-5" /></span>
        <h2 className="text-2xl font-bold !text-ink tracking-tight">{t.sealedTitle}</h2>
      </div>
      <p className="text-sm text-muted">{t.sealedIntro}</p>
      <p role="note" className="text-sm rounded-lg bg-gold/15 text-ink p-3 border border-gold/50">{t.sealedDisclosure}</p>
      <MachineNote />

      {/* The family's side: envelopes waiting for an event or for sad news. Never any content. The agent decides; here is how far it has got. */}
      {env && env.total > 0 && <p className="text-sm text-gold-dark inline-flex items-center gap-1.5"><Icon name="envelope" className="w-4 h-4" />{t.sealedCount.replace('{n}', String(env.total))}</p>}
      {env && (env.events.length > 0 || env.deaths.length > 0) && (
        <section className="card p-4 space-y-3">
          <h3 className="font-bold text-green">{t.envelopesTitle}</h3>
          {!env.agentActive && <p className="text-sm text-danger">{t.agentOffWarning}</p>}
          {env.events.map(ev => (
            <div key={ev.id} className="text-sm space-y-1">
              <div className="flex items-center gap-1.5"><Icon name="envelope" className="w-4 h-4 text-gold-dark" /><b>{ev.author}</b> — {t.trigEvent}</div>
              <p className="text-muted">{ev.waiting ? `${t.countdownEvent.replace('{h}', String(env.waitHours / 24))} ${ev.releaseAt ? dt(ev.releaseAt) : ''}` : `${t.evidenceSoFar}: ${ev.evidence.messages}/${ev.evidence.needMessages} ${t.evMessages} · ${ev.evidence.members}/${ev.evidence.needMembers} ${t.evMembers}`}</p>
              {ev.canStop && <button className="btn !py-1 text-sm" onClick={() => act(`/sealed/${ev.id}/stop`)}>{t.stopCountdown}</button>}
            </div>
          ))}
          {env.deaths.map(d => (
            <div key={d.authorId} className="text-sm space-y-1 border-t border-line pt-2">
              <div className="flex items-center gap-1.5"><Icon name="envelope" className="w-4 h-4 text-gold-dark" /><b>{d.author}</b> — {d.count} {t.afterDeathLetters}</div>
              <p className={d.waiting ? 'text-danger' : 'text-muted'}>{d.waiting ? `${t.deathCountdown.replace('{h}', String(env.waitHours / 24))} ${d.releaseAt ? dt(d.releaseAt) : ''}` : `${t.evidenceSoFar}: ${d.evidence.messages}/${d.evidence.needMessages} ${t.evMessages} · ${d.evidence.members}/${d.evidence.needMembers} ${t.evMembers}`}</p>
              {d.canStop && <button className="btn !py-1 text-sm" onClick={() => act(`/circles/${circle}/sealed/death/${d.authorId}/stop`)}>{d.authorId === meId ? t.imAlive : t.stopCountdown}</button>}
            </div>
          ))}
        </section>
      )}

      <form onSubmit={seal} className="card p-4 space-y-3">
        <div className="block text-sm font-medium">{t.sealedCircle}
          <Picker className="mt-1" label={t.sealedCircle} value={circle} onChange={setCircle}
            options={circles.map(c => ({ value: c.id, label: c.name }))} />
        </div>
        <div role="group" aria-label={t.sealedTrigger} className="flex flex-wrap gap-2">
          {([['date', t.trigDate], ['event', t.trigEvent], ...(env?.deathEnabled ? [['death', t.trigDeath]] : [])] as Array<[Trigger, string]>).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={trigger === k} onClick={() => setTrigger(k)} className={`btn btn-ghost !py-1 text-sm ${trigger === k ? '!border-green !text-green font-bold' : ''}`}>{label}</button>
          ))}
        </div>
        <p className="text-xs text-muted">{trigger === 'date' ? t.trigDateHelp : trigger === 'event' ? t.trigEventHelp : t.trigDeathHelp}</p>
        <label className="block text-sm font-medium">{t.occasionLabel}{trigger === 'event' ? ' *' : ''}
          <input className="field mt-1" maxLength={80} value={occasion} placeholder={t.occasionHint} onChange={e => setOccasion(e.target.value)} />
        </label>
        {trigger === 'date' && (
          <>
            <div className="space-y-2">
              <span className="block text-sm font-medium">{dates.length > 1 ? t.sealedWhenMany : t.sealedWhen}</span>
              {dates.map((d, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input className="field" type="datetime-local" required min={minWhen} value={d} onChange={e => setDates(p => p.map((x, j) => (j === i ? e.target.value : x)))} dir="ltr" aria-label={`${t.sealedWhen} ${i + 1}`} />
                  {dates.length > 1 && <button type="button" className="btn btn-ghost !px-3" aria-label={t.sealedRemoveDate} onClick={() => setDates(p => p.filter((_, j) => j !== i))}>×</button>}
                </div>
              ))}
              {dates.length < 12 && <button type="button" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-bold text-green hover:bg-green-soft transition-colors duration-[var(--dur-instant)]" onClick={() => setDates(p => [...p, ''])}><Icon name="plus" className="w-4 h-4" />{t.sealedAddDate}</button>}
            </div>
            {dates.length === 1 && <Toggle checked={yearly} onChange={setYearly} label={t.sealedYearly} />}
            <div className="block text-sm font-medium">{t.sealedTo}
              {/* 0 stands for "the whole circle": Picker needs a real value, and the empty
                  string the native select used is not one. */}
              <Picker className="mt-1" label={t.sealedTo} value={to === '' ? 0 : to} onChange={v => setTo(v === 0 ? '' : v)}
                options={[{ value: 0, label: t.sealedWhole }, ...members.map(m => ({ value: m.id, label: m.name }))]} />
            </div>
          </>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">{t.letterContent}</div>
          <div className="flex flex-wrap gap-2">
            {recording
              ? <button type="button" className="btn !bg-red-700" onClick={stopRec}><Icon name="stop" className="w-4 h-4" />{t.stop} <span dir="ltr" className="tabular-nums">{clock(recMs)}</span></button>
              : <>
                  <button type="button" className="btn btn-ghost" onClick={() => startRec('voice')}><Icon name="mic" className="w-4 h-4" />{t.recordVoice}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => startRec('video')}><Icon name="video" className="w-4 h-4" />{t.recordVideo}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => picker.current?.click()}><Icon name="attach" className="w-4 h-4" />{t.chooseFile}</button>
                </>}
            <input ref={picker} type="file" hidden accept="audio/*,video/*,image/*" onChange={e => chooseFile(e.target.files?.[0])} />
          </div>
          {file && (
            <div className="rounded-lg border border-line p-2 space-y-1">
              {file.kind === 'voice' && <audio controls src={preview} className="w-full" />}
              {file.kind === 'video' && <video controls playsInline src={preview} className="w-full max-h-64 rounded" />}
              {file.kind === 'image' && <img alt="" src={preview} className="max-h-64 rounded" />}
              <button type="button" className="text-sm text-danger underline" onClick={() => setFile(null)}>{t.removeFile}</button>
            </div>
          )}
          <textarea className="field" rows={file ? 2 : 5} maxLength={4000} value={body} placeholder={file ? t.captionHint : t.sealedText} onChange={e => setBody(e.target.value)} />
        </div>

        <p className="text-xs text-muted">{t.openedForever}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {msg && <p role="status" className="text-sm text-green">{msg}</p>}
        <button className="btn w-full" disabled={!canSeal || !!recording}><Icon name="lock" className="w-4 h-4" />{t.sealedSeal}</button>
      </form>

      <section className="space-y-2">
        <h3 className="font-bold text-green">{t.sealedMine}</h3>
        {mine.length === 0 ? <p className="card p-4 text-muted">{t.sealedNone}</p> : (
          <ul className="space-y-3">
            {mine.map(s => (
              <li key={s.id} className={`card envelope p-3 flex gap-3 ${s.status === 'stopped' ? 'envelope-open' : ''}`}>
                {/* The seal carries the state: gold and unbroken while it waits, red while
                    the family's waiting period runs, flat and spent once it is stopped. */}
                <span aria-hidden className={`wax-seal ${s.status === 'waiting' ? 'wax-seal-waiting' : s.status === 'stopped' ? 'wax-seal-open' : ''}`}>
                  <Icon name={s.status === 'stopped' ? 'ban' : 'lock'} className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-caption text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{icon(s.kind)} {s.circleName}</span><span>→ {s.recipient ?? t.sealedWhole}</span><span>{trigLabel(s)}</span>
                    {s.yearly && <span className="px-1.5 rounded-full bg-green-soft text-green">{t.sealedYearlyTag}</span>}
                    {s.status === 'waiting' && <span className="px-1.5 rounded-full bg-danger-soft text-danger font-bold">{t.deathWaiting}</span>}
                    {s.status === 'stopped' && <span className="px-1.5 rounded-full bg-danger-soft text-danger">{t.sealedStopped}</span>}
                  </div>
                  {s.occasion && s.trigger !== 'event' && <b className="block">{s.occasion}</b>}
                  {/* How long this letter still has to wait, in plain words. */}
                  {s.status === 'sealed' && <Countdown at={s.unlockAt} />}
                  {s.status === 'waiting' && s.releaseAt && <Countdown at={s.releaseAt} urgent />}
                  {s.kind !== 'text' && <p className="text-sm">{s.fileName}</p>}
                  {s.body && <p className="whitespace-pre-wrap break-words">{s.body}</p>}
                  <div className="flex gap-3 text-sm pt-0.5">
                    {s.trigger !== 'death' && s.status === 'sealed' && <button className="text-green underline" onClick={() => act(`/sealed/${s.id}/open`)}>{t.openNow}</button>}
                    {s.status !== 'waiting' && <button className="text-danger underline" onClick={() => act(`/sealed/${s.id}`, { method: 'DELETE' })}>{t.sealedCancel}</button>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** How long a letter still has to wait, in the reader's own language.
 *  Intl.RelativeTimeFormat handles the plural rules and the wording for every language
 *  we ship, so this needs no translated strings of its own beyond the verb. */
function Countdown({ at, urgent }: { at: string | null; urgent?: boolean }) {
  const { t, lang } = useI18n();
  if (!at) return null;
  const ms = toDate(at).getTime() - Date.now();
  if (ms <= 0) return null;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: 'auto' });
  const days = Math.round(ms / 86_400_000);
  const hours = Math.round(ms / 3_600_000);
  const when = days >= 1 ? rtf.format(days, 'day') : rtf.format(hours, 'hour');
  return (
    <p className={`text-caption ${urgent ? 'text-danger font-bold' : 'text-gold-dark'}`}>
      {t.opensLabel} {when}
    </p>
  );
}
