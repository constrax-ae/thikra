import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { useI18n } from './i18n';
import { useTextSize, type TextSize } from './textsize';
import { useTheme, type Theme } from './theme';
import { useUploadQuality } from './quality';
import { usePref } from './prefs';
import { useInstall } from './install';
import { LangPicker, MachineNote } from './LangPicker';
import { useChatTheme, WALLPAPERS, BUBBLES } from './chattheme';
import { Icon, type IconName } from './icons';
import { Toggle } from './States';

type Row = 'install' | 'starred' | 'account' | 'privacy' | 'chats' | 'appearance' | 'notifications' | 'storage' | 'rights' | 'help' | null;


interface SupportCase { id: number; subject: string; status: 'open' | 'answered' | 'closed'; createdAt: string; messages: Array<{ fromStaff: number; body: string; createdAt: string }> }
/** Write to the team and read their answers. Only what you write here is sent: never your chats. */
interface DataReq { id: number; kind: 'export' | 'delete'; status: string; dueAt: string; response: string | null }
function DataRights() {
  const { t } = useI18n();
  const [list, setList] = useState<DataReq[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => api<DataReq[]>('/me/data-requests').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  async function ask(kind: 'export' | 'delete') {
    setMsg('');
    try { await api('/me/data-requests', { body: { kind } }); setMsg(t.rightsSent); load(); } catch (e) { setMsg(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  return (
    <div className="space-y-3">
      <p className="text-muted">{t.rightsNote}</p>
      <div className="flex flex-col gap-2"><button className="btn btn-ghost" onClick={() => ask('export')}>{t.rightsExport}</button><button className="btn btn-ghost text-danger" onClick={() => ask('delete')}>{t.rightsDelete}</button></div>
      {msg && <p role="status" className="text-muted">{msg}</p>}
      <ul className="space-y-1">{list.map(r => <li key={r.id} className="text-sm"><b>{t.rightsKind[r.kind]}</b> · {t.rightsStatus[r.status]} {r.status === 'open' && <span className="text-xs text-muted">· {t.rightsDue} <bdi dir="ltr">{r.dueAt.slice(0, 10)}</bdi></span>}{r.response && <span className="block text-xs text-muted">{r.response}</span>}</li>)}</ul>
    </div>
  );
}

function SupportBox() {
  const { t } = useI18n();
  const [cases, setCases] = useState<SupportCase[] | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState('');
  const load = () => api<SupportCase[]>('/support').then(setCases).catch(() => setCases([]));
  useEffect(() => { load(); }, []);
  const fail = (e: unknown) => setMsg(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  async function send(e: React.FormEvent) {
    e.preventDefault(); setMsg('');
    try { await api('/support', { body: { subject, body } }); setSubject(''); setBody(''); setMsg(t.supportSent); load(); } catch (err) { fail(err); }
  }
  async function answer(id: number) {
    const text = (reply[id] ?? '').trim(); if (!text) return;
    try { await api(`/support/${id}/reply`, { body: { body: text } }); setReply(r => ({ ...r, [id]: '' })); load(); } catch (err) { fail(err); }
  }
  return (
    <div className="space-y-3">
      <p className="text-muted">{t.helpAbout}</p>
      <form onSubmit={send} className="space-y-2">
        <b>{t.supportWrite}</b>
        <input className="field" value={subject} maxLength={80} placeholder={t.supportSubject} onChange={e => setSubject(e.target.value)} />
        <textarea className="field min-h-24" value={body} maxLength={2000} placeholder={t.supportBody} onChange={e => setBody(e.target.value)} />
        <button className="btn w-full" disabled={!subject.trim() || !body.trim()}>{t.supportSend}</button>
        <p className="text-xs text-muted">{t.supportPrivacy}</p>
      </form>
      {msg && <p role="status" className="text-sm text-green">{msg}</p>}
      {cases && cases.length > 0 && (
        <ul className="space-y-2">
          {cases.map(k => (
            <li key={k.id} className="border border-line rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2"><b className="flex-1 truncate">{k.subject}</b><span className="text-[11px] px-2 py-0.5 rounded-full bg-line text-muted">{t.supportStatus[k.status]}</span></div>
              <ul className="space-y-1">{k.messages.map((m, i) => <li key={i} className={`text-sm rounded-lg p-2 ${m.fromStaff ? 'bg-green-soft' : 'bg-card'}`}><span className="text-xs text-muted block">{m.fromStaff ? t.supportTeam : t.supportYou}</span><span className="whitespace-pre-wrap break-words">{m.body}</span></li>)}</ul>
              {k.status !== 'closed' && <div className="flex gap-2"><input className="field !py-1" value={reply[k.id] ?? ''} placeholder={t.supportReply} onChange={e => setReply(r => ({ ...r, [k.id]: e.target.value }))} /><button className="btn btn-ghost !py-1" onClick={() => answer(k.id)}>{t.supportSend}</button></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


function InstallHelp() {
  const { t } = useI18n();
  const i = useInstall();
  if (i.installed) return <p className="text-muted">{t.installDone}</p>;
  return (
    <div className="space-y-2">
      <p className="text-muted">{t.installWhy}</p>
      {i.canPrompt && <button className="btn w-full" onClick={() => i.install()}>{t.installButton}</button>}
      {!i.canPrompt && <ol className="text-sm space-y-1 list-decimal ms-5">{(i.ios ? t.installStepsIos : t.installStepsOther).map(x => <li key={x}>{x}</li>)}</ol>}
    </div>
  );
}

/** "You": the settings page, grouped the way WhatsApp users expect, with Thekra's own additions where they belong. */
/** Two-step verification: a 6-digit PIN asked after the SMS code, so a stolen SIM or a leaked code alone is not enough. */
function TwoStep({ has, onDone }: { has: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<null | 'set' | 'change' | 'remove'>(null);
  const [pin, setPin] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError(''); setMsg('');
    try {
      if (open === 'remove') await api('/me/pin/remove', { body: { pin: current } });
      else await api('/me/pin', { body: { pin, ...(open === 'change' ? { current } : {}) } });
      setMsg(open === 'remove' ? t.pinRemoved : t.pinSaved); setOpen(null); setPin(''); setCurrent(''); onDone();
    } catch (err) { fail(err); }
  }
  return (
    <div className="space-y-2">
      <b>{t.twoStep}</b>
      <p className="text-sm text-muted">{has ? t.twoStepOn : t.twoStepOff}</p>
      {msg && <p role="status" className="text-sm text-green">{msg}</p>}
      {!open && (has
        ? <div className="flex gap-2"><button className="btn btn-ghost flex-1" onClick={() => setOpen('change')}>{t.pinChange}</button><button className="btn btn-ghost flex-1" onClick={() => setOpen('remove')}>{t.pinTurnOff}</button></div>
        : <button className="btn btn-ghost w-full" onClick={() => setOpen('set')}>{t.pinTurnOn}</button>)}
      {open && (
        <form onSubmit={save} className="space-y-2">
          {(open === 'change' || open === 'remove') && <input className="field text-center tracking-[0.4em]" dir="ltr" type="password" inputMode="numeric" required maxLength={6} placeholder={t.pinCurrent} aria-label={t.pinCurrent} value={current} onChange={e => setCurrent(digits(e.target.value))} />}
          {open !== 'remove' && <input className="field text-center tracking-[0.4em]" dir="ltr" type="password" inputMode="numeric" required minLength={6} maxLength={6} placeholder={t.pinNew} aria-label={t.pinNew} value={pin} onChange={e => setPin(digits(e.target.value))} />}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2"><button className="btn flex-1">{t.save}</button><button type="button" className="btn btn-ghost" onClick={() => { setOpen(null); setError(''); setPin(''); setCurrent(''); }}>{t.cancel}</button></div>
        </form>
      )}
    </div>
  );
}


/** Change the number: a code goes to the NEW number; the account, circles and history stay. */
function ChangeNumber({ onDone }: { onDone: () => void }) {
  const { t, lang } = useI18n();
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [dev, setDev] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);
  async function request(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try { const r = await api<{ devCode?: string }>('/me/phone/request', { body: { phone: phone.trim(), lang } }); setDev(r.devCode ?? ''); setStep('code'); } catch (err) { fail(err); }
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try { await api('/me/phone/confirm', { body: { phone: phone.trim(), code: code.trim() } }); setDone(true); setStep('idle'); setPhone(''); setCode(''); onDone(); } catch (err) { fail(err); }
  }
  return (
    <div className="space-y-2">
      <b>{t.changeMyNumber}</b>
      {done && <p role="status" className="text-sm text-green">{t.numberChanged}</p>}
      {step === 'idle' ? (
        <form onSubmit={request} className="flex gap-2">
          <input className="field" dir="ltr" inputMode="tel" required placeholder="+971 50 000 0000" aria-label={t.newNumber} value={phone} onChange={e => setPhone(e.target.value)} />
          <button className="btn shrink-0">{t.sendNewCode}</button>
        </form>
      ) : (
        <form onSubmit={confirm} className="space-y-2">
          <p className="text-sm text-muted">{t.codeSentTo} <span dir="ltr">{phone}</span></p>
          <input className="field" dir="ltr" inputMode="numeric" autoFocus required maxLength={6} placeholder="••••••" aria-label={t.verificationCode} value={code} onChange={e => setCode(e.target.value)} />
          {dev && <p className="text-xs text-muted">{t.devCodeHint}: <span dir="ltr">{dev}</span></p>}
          <div className="flex gap-2"><button className="btn flex-1">{t.confirmNumber}</button><button type="button" className="btn btn-ghost" onClick={() => { setStep('idle'); setCode(''); setError(''); }}>{t.back}</button></div>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-xs text-muted">{t.changeNumberNote}</p>
    </div>
  );
}


/** A tiny chat that shows what a wallpaper or a bubble colour looks like, like WhatsApp's theme thumbnails. */
function MiniChat({ wall, bubble, selected }: { wall: string; bubble: string; selected: boolean }) {
  const colour = BUBBLES.find(([k]) => k === bubble)?.[1];
  return (
    <span aria-hidden className={`wall-${wall} flex flex-col justify-center gap-2 w-16 h-24 p-2 rounded-xl overflow-hidden bg-paper border-2 ${selected ? 'border-green' : 'border-line'}`}>
      <span className="block h-5 w-9 rounded-lg self-end" style={{ background: '#fff', border: '1px solid #e6e1d6' }} />
      <span className="block h-5 w-9 rounded-lg self-start" style={colour ? { background: colour } : { background: '#d9f2d6', border: '1px solid #bfe3bb' }} />
      <span className="block h-5 w-7 rounded-lg self-end" style={{ background: '#fff', border: '1px solid #e6e1d6' }} />
    </span>
  );
}

export function You({ me, onLogout, onDeleteAccount, onAdmin, onSealed, onChanged }: {
  me: Me; onLogout: () => void; onDeleteAccount: () => void; onAdmin: () => void; onSealed: () => void; onChanged: () => void;
}) {
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState<Row>(null);
  const [size, setSize] = useTextSize();
  const [theme, setTheme] = useTheme();
  const chat = useChatTheme();
  const [quality, setQuality] = useUploadQuality();
  const [sound, setSound] = usePref('sound');
  const [motion, setMotion] = usePref('motion');
  const [saver, setSaver] = usePref('saver');
  const themes: Array<[Theme, string]> = [['system', t.themeSystem], ['light', t.themeLight], ['dark', t.themeDark]];
  const [receipts, setReceipts] = useState(me.read_receipts === 1);
  const [copied, setCopied] = useState(false);
  const [push, setPush] = useState<'unsupported' | 'denied' | 'off' | 'on'>('off');
  const [pushMsg, setPushMsg] = useState('');
  const [preview, setPreview] = useState(me.push_preview === 1);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setPush('unsupported');
    if (Notification.permission === 'denied') return setPush('denied');
    navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).then(sub => setPush(sub ? 'on' : 'off')).catch(() => {});
  }, []);
  const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
  async function enablePush() {
    setPushMsg('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') return setPush('denied');
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api<{ key: string }>('/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await api('/push/subscribe', { body: sub.toJSON() });
      setPush('on');
    } catch { setPushMsg(t.pushFailed); }
  }
  async function disablePush() {
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
      setPush('off');
    } catch { setPushMsg(t.pushFailed); }
  }
  async function setPreviewOn(on: boolean) {
    setPreview(on);
    try { await api('/me', { method: 'PATCH', body: { push_preview: on } }); onChanged(); } catch { setPreview(!on); }
  }
  const [deleted, setDeleted] = useState<Array<{ id: number; name: string; daysLeft: number }>>([]);
  const loadDeleted = () => api<Array<{ id: number; name: string; daysLeft: number }>>('/me/deleted-circles').then(setDeleted).catch(() => {});
  useEffect(() => { loadDeleted(); }, []);

  async function setReceiptsOn(on: boolean) {
    setReceipts(on);
    try { await api('/me', { method: 'PATCH', body: { read_receipts: on } }); onChanged(); } catch { setReceipts(!on); }
  }
  const saveLang = (next: string) => { api('/me', { method: 'PATCH', body: { lang: next } }).catch(() => {}); };
  async function invite() {
    const text = `${t.inviteText}${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    } catch { /* cancelled or blocked */ }
  }

  const row = (k: Exclude<Row, null>, icon: IconName, label: string, body: React.ReactNode) => (
    <li key={k}>
      <button className="row-interactive w-full p-3 flex items-center gap-3 text-start" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
        <span className="w-8 flex justify-center text-green"><Icon name={icon} /></span>
        <span className="flex-1">{label}</span>
        {/* One chevron that turns, rather than two different glyphs swapping. */}
        <Icon name="down" className={`w-4 h-4 text-muted transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)] ${open === k ? 'rotate-180' : '-rotate-90 rtl:rotate-90'}`} />
      </button>
      {open === k && <div className="px-4 pb-4 space-y-2 text-sm animate-slide-up">{body}</div>}
    </li>
  );
  const sizes: Array<[TextSize, string]> = [['normal', 'A'], ['large', 'A+'], ['xlarge', 'A++']];

  return (
    <div className="space-y-4">
      <section className="flex items-center gap-4 p-2">
        <span className="w-16 h-16 rounded-full bg-brand text-white flex items-center justify-center text-2xl font-bold">{me.name.slice(0, 1)}</span>
        <div className="min-w-0"><div className="text-xl font-bold truncate">{me.name}</div><div className="text-muted text-sm" dir="ltr">{me.phone}</div></div>
      </section>
      <MachineNote />

      <ul className="card divide-y divide-line overflow-hidden">
        {row('starred', 'star', t.rowStarred, <p className="text-muted inline-flex items-center gap-1.5">{t.starred}: <Icon name="star-fill" className="w-4 h-4 text-gold-dark" /> {t.search}…</p>)}
        {row('account', 'key', t.rowAccount, (
          <>
            <TwoStep has={!!me.has_pin} onDone={onChanged} />
            <ChangeNumber onDone={onChanged} />
            <a className="btn btn-ghost block text-center" href="/api/me/export" download>{t.exportData}</a>
            <p className="text-muted">{t.exportNote}</p>
            {/* Set apart by a rule: nothing destructive should sit flush against the
                ordinary actions where it can be hit by accident. */}
            <div className="pt-3 mt-1 border-t border-line">
              <button className="btn btn-danger w-full" onClick={onDeleteAccount}>{t.deleteAccount}</button>
            </div>
          </>
        ))}
        {row('privacy', 'lock', t.rowPrivacy, (
          <Toggle checked={receipts} onChange={setReceiptsOn} label={t.readReceipts} note={t.readReceiptsNote} />
        ))}
        {row('chats', 'chats', t.rowChats, <p className="text-muted">{t.chatsNote}</p>)}
        {row('appearance', 'palette', t.rowAppearance, (
          <>
            {/* t.language holds the OTHER language's name ("العربية" when you are in English).
                That read as a prompt beside the old dropdown; beside a picker that already shows
                the current language it just looked wrong, so the row is labelled plainly. */}
            <div className="flex items-center gap-2"><span className="flex-1">{t.languageTitle}</span><LangPicker onPick={saveLang} /></div>
            <MachineNote />
            <div role="group" aria-label={t.themeLabel} className="flex items-center gap-2 flex-wrap">
              <span className="flex-1">{t.themeLabel}</span>
              {themes.map(([k, label]) => <button key={k} aria-pressed={theme === k} className={`btn btn-ghost !py-1 ${theme === k ? '!border-green !text-green font-bold' : ''}`} onClick={() => setTheme(k)}>{label}</button>)}
            </div>
            <div role="group" aria-label={t.chatWallpaper} className="space-y-1">
              <span>{t.chatWallpaper}</span>
              <div className="flex gap-3 flex-wrap">
                {WALLPAPERS.map(w => (
                  <button key={w} type="button" aria-pressed={chat.wall === w} onClick={() => chat.setWall(w)} className="flex flex-col items-center gap-1">
                    <MiniChat wall={w} bubble={chat.bubble} selected={chat.wall === w} />
                    <span className={`text-xs ${chat.wall === w ? 'text-green font-bold' : 'text-muted'}`}>{t.wallpapers[w]}</span>
                  </button>
                ))}
              </div>
            </div>
            <div role="group" aria-label={t.chatBubble} className="space-y-1">
              <span>{t.chatBubble}</span>
              <div className="flex gap-3 flex-wrap">
                {BUBBLES.map(([k]) => (
                  <button key={k} type="button" aria-pressed={chat.bubble === k} onClick={() => chat.setBubble(k)} className="flex flex-col items-center gap-1">
                    <MiniChat wall={chat.wall} bubble={k} selected={chat.bubble === k} />
                    <span className={`text-xs ${chat.bubble === k ? 'text-green font-bold' : 'text-muted'}`}>{t.bubbleNames[k]}</span>
                  </button>
                ))}
              </div>
            </div>
            <Toggle checked={motion} onChange={setMotion} label={t.animations} note={t.animationsNote} />
            <Toggle checked={saver} onChange={setSaver} label={t.dataSaver} note={t.dataSaverNote} />
            <div role="group" aria-label={t.uploadQuality} className="space-y-1">
              <span>{t.uploadQuality}</span>
              <div className="flex gap-2 items-center flex-wrap">
                {(['standard', 'original'] as const).map(k => <button key={k} aria-pressed={quality === k} onClick={() => setQuality(k)}
                  className={`btn btn-ghost !py-1 ${quality === k ? '!border-green !text-green font-bold' : ''}`}>{t.qualityNames[k]}</button>)}
              </div>
              <p className="text-xs text-muted">{t.uploadQualityNote}</p>
            </div>
            <div role="group" aria-label={t.textSize} className="flex items-center gap-2">
              <span className="flex-1">{t.textSize}</span>
              {sizes.map(([k, label]) => <button key={k} aria-pressed={size === k} className={`btn btn-ghost !py-1 ${size === k ? '!border-green !text-green font-bold' : ''}`} onClick={() => setSize(k)}>{label}</button>)}
            </div>
          </>
        ))}
        {row('notifications', 'bell', t.rowNotifications, (
          <>
            <Toggle checked={sound} onChange={setSound} label={t.inAppSound} note={t.inAppSoundNote} />
            {push === 'unsupported' && <p className="text-muted">{t.pushUnsupported}</p>}
            {push === 'denied' && <p className="text-muted">{t.pushDenied}</p>}
            {push === 'off' && <button className="btn" onClick={enablePush}>{t.pushEnable}</button>}
            {push === 'on' && (<><p className="text-green inline-flex items-center gap-1.5"><Icon name="check" className="w-4 h-4" />{t.pushOn}</p><button className="btn btn-ghost" onClick={disablePush}>{t.pushDisable}</button></>)}
            {pushMsg && <p role="alert" className="text-danger">{pushMsg}</p>}
            <div className="pt-2"><Toggle checked={preview} onChange={setPreviewOn} label={t.pushPreview} note={t.pushPreviewNote} /></div>
            <p className="text-muted">{t.notificationsSoon}</p>
          </>
        ))}
        {row('storage', 'storage', t.rowStorage, <p className="text-muted">{t.storageRowNote}</p>)}
        {row('install', 'phone', t.rowInstall, <InstallHelp />)}
        {row('rights', 'storage', t.rowRights, <DataRights />)}
        {row('help', 'help', t.rowHelp, <SupportBox />)}
      </ul>

      {deleted.length > 0 && (
        <section className="card p-3 space-y-2">
          <h3 className="font-bold">{t.recentlyDeleted}</h3>
          <ul className="divide-y divide-line">
            {deleted.map(d => (
              <li key={d.id} className="py-2 flex items-center gap-3">
                <span className="flex-1 min-w-0"><b className="block truncate">{d.name}</b><span className="text-xs text-muted">{d.daysLeft} {t.daysLeftWord}</span></span>
                <button className="btn !py-1 text-sm" onClick={async () => { await api(`/circles/${d.id}/restore`, { method: 'POST', body: {} }); loadDeleted(); }}>{t.restore}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="card divide-y divide-line overflow-hidden">
        <li><button className="w-full p-3 flex items-center gap-3 text-start hover:bg-green-soft/50" onClick={invite}>
          <span className="w-8 flex justify-center text-green"><Icon name="heart" /></span><span className="flex-1">{t.rowInvite}</span>{copied && <span className="text-xs text-green">{t.inviteCopied}</span>}
        </button></li>
        <li><button className="w-full p-3 flex items-center gap-3 text-start hover:bg-green-soft/50" onClick={onSealed}><span className="w-8 flex justify-center text-green"><Icon name="lock" /></span><span className="flex-1">{t.rowSealed}</span><Icon name="chevron" className="w-4 h-4 text-muted -rotate-90 rtl:rotate-90" /></button></li>
        {me.is_admin ? <li><button className="w-full p-3 flex items-center gap-3 text-start hover:bg-green-soft/50" onClick={onAdmin}><span className="w-8 flex justify-center text-green"><Icon name="tools" /></span><span className="flex-1">{t.rowAdmin}</span></button></li> : null}
      </ul>

      <button className="btn btn-ghost w-full" onClick={onLogout}>{t.logout}</button>
    </div>
  );
}
