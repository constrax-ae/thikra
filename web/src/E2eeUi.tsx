// The screens of end-to-end encryption: encrypted pictures and files, the chat's type note, the safety number, the notices, and the devices and recovery panel.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Attachment, type CircleDetail, type Me } from './api';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { useI18n } from './i18n';
import { getE2ee, onChatChange, restoreDevice, forgetDevice, stopE2ee, useE2ee } from './e2ee';
import type { DeviceInfo, Notice } from './e2ee/engine';
import { QrImage, QrScanner } from './QrUi';
import { askConfirm } from './confirm';

// ---- encrypted files, shown ------------------------------------------------------------------------------------------------------------------

const urls = new Map<number, Promise<string>>();
/** The address to show for an attachment: the server's for a readable chat; for an encrypted one the file is downloaded, checked, decrypted here and shown from memory. */
export function useMediaUrl(att: Attachment | null | undefined, thumb = false): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const id = att?.id;
  useEffect(() => {
    if (!att) { setUrl(null); return; }
    if (!att.enc) { setUrl(`/api/media/${thumb && att.thumb ? att.thumb : att.id}`); return; }
    if (thumb && att.enc.thumb) { setUrl(att.enc.thumb); return; }
    const e2ee = getE2ee();
    if (!e2ee) { setUrl(null); return; }
    let live = true;
    let p = urls.get(att.id);
    if (!p) { p = e2ee.openAttachment(att).then(b => URL.createObjectURL(new Blob([b as BlobPart], { type: att.mime }))); urls.set(att.id, p); p.catch(() => urls.delete(att.id)); }
    p.then(u => { if (live) setUrl(u); }, () => { if (live) setUrl(null); });
    return () => { live = false; };
  }, [id, thumb, att?.enc?.k]);   // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}
export function MediaImg({ att, thumb, className, alt = '' }: { att: Attachment; thumb?: boolean; className?: string; alt?: string }) {
  const url = useMediaUrl(att, thumb);
  return url ? <img alt={alt} loading="lazy" className={className} src={url} /> : <div aria-hidden className={`${className ?? ''} bg-black/10 animate-pulse min-h-16`} />;
}
export function MediaVideo({ att, className, saver }: { att: Attachment; className?: string; saver?: boolean }) {
  const poster = useMediaUrl(att.enc?.thumb ? att : undefined, true);
  const [want, setWant] = useState(!att.enc || !saver);
  const url = useMediaUrl(want ? att : undefined);
  return <video controls preload={saver ? 'none' : 'metadata'} playsInline className={className} poster={poster ?? undefined} src={url ?? undefined} onPlay={() => setWant(true)} onClick={() => setWant(true)} />;
}
/** A file link: for an encrypted chat the click downloads, decrypts and saves. */
export function MediaFile({ att, className, children }: { att: Attachment; className?: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  if (!att.enc) return <a href={`/api/media/${att.id}`} download={att.name ?? 'file'} className={className}>{children}</a>;
  return (
    <button type="button" className={`${className ?? ''} w-full text-start`} disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const u = await (urls.get(att.id) ?? (() => { const p = getE2ee()!.openAttachment(att).then(b => URL.createObjectURL(new Blob([b as BlobPart], { type: 'application/octet-stream' }))); urls.set(att.id, p); return p; })());
        const a = document.createElement('a'); a.href = u; a.download = (att.name ?? 'file').replace(/[\\/:*?"<>|]/g, '_'); a.click();
      } catch { /* the file could not be fetched or did not match: nothing is saved */ } finally { setBusy(false); }
    }}>{children}</button>
  );
}

// ---- what kind of chat is this ---------------------------------------------------------------------------------------------------------------

export const isEncryptedChat = (c: { encrypted?: boolean } | null | undefined) => !!c?.encrypted;

/** The line under the chat's name: never an encrypted look on a readable chat, or the reverse. Only a family circle and an encrypted chat say anything. */
export function ChatTypeNote({ circle, onMore }: { circle: CircleDetail; onMore: () => void }) {
  const { t } = useI18n();
  if (circle.kind === 'direct' && !circle.encrypted) return null;
  const enc = !!circle.encrypted;
  const text = enc ? (circle.kind === 'direct' ? t.e2ee.headerDirect : t.e2ee.headerGroup) : circle.kind === 'circle' ? t.e2ee.headerCircle : null;
  if (!text) return null;
  return (
    <button type="button" onClick={onMore} title={t.e2ee.headerMore}
      className={`flex items-center gap-1 max-w-full text-start text-caption transition-colors duration-[var(--dur-instant)] ${enc ? 'text-green' : 'text-gold-dark'}`}><Icon name={enc ? 'lock' : 'heart'} className="w-3 h-3 shrink-0" /><span className="truncate">{text}</span></button>
  );
}
export function ChatTypeBadge({ encrypted, kind }: { encrypted?: boolean; kind: string }) {
  const { t } = useI18n();
  if (encrypted) return <span title={t.e2ee.private} aria-label={t.e2ee.private} role="img" className="inline-flex shrink-0 text-green"><Icon name="lock" className="w-3.5 h-3.5" /></span>;
  return kind === 'circle' ? <span title={t.e2ee.headerCircle} aria-label={t.e2ee.headerCircle} role="img" className="inline-flex shrink-0 text-gold-dark"><Icon name="heart" className="w-3.5 h-3.5" /></span> : null;
}

/** The details sheet of a chat: what the type means, and for an encrypted chat the safety number. */
export function ChatSecuritySheet({ circle, me, onClose }: { circle: CircleDetail; me: Me; onClose: () => void }) {
  const { t } = useI18n();
  const { e2ee } = useE2ee();
  const others = circle.members.filter(m => m.id !== me.id);
  const [pick, setPick] = useState<number | null>(circle.kind === 'direct' ? others[0]?.id ?? null : null);
  const [number, setNumber] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [state, setState] = useState<string>('');
  const [qr, setQr] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const name = others.find(m => m.id === pick)?.name ?? '';
  useEffect(() => {
    setNumber(null); setQr(null); setScan(false); setScanMsg('');
    if (!circle.encrypted || !e2ee || !pick) return;
    let live = true;
    e2ee.safetyNumber(circle.id, pick).then(n => { if (live) setNumber(n); }).catch(() => { if (live) setState('keysMismatch'); });
    e2ee.safetyQr(circle.id, pick).then(q => { if (live) setQr(q); }).catch(() => {});
    e2ee.isVerified(pick, circle.id).then(v => { if (live) setVerified(v); }).catch(() => {});
    return () => { live = false; };
  }, [circle.id, circle.encrypted, e2ee, pick]);
  return (
    <Dialog onClose={onClose} label={t.e2ee.what}>
      <h2 className="flex items-center gap-3 text-lg font-bold text-ink">
        <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${circle.encrypted ? 'bg-green-soft text-green' : 'bg-gold/15 text-gold-dark'}`}><Icon name={circle.encrypted ? 'lock' : 'heart'} className="w-5 h-5" /></span>
        <span className="min-w-0">{t.e2ee.what}</span>
      </h2>
      <p className="mt-3 text-sm text-ink">{circle.encrypted ? t.e2ee.whatPrivate : t.e2ee.whatCircle}</p>
      {circle.encrypted && <p className="mt-2 text-xs text-muted">{t.e2ee.lost}</p>}
      {circle.encrypted && <p className="mt-3 flex items-start gap-2 rounded-xl bg-gold/15 text-ink text-xs px-3 py-2"><Icon name="alert" className="w-4 h-4 shrink-0 text-gold-dark" /><span>{t.e2ee.notAudited}</span></p>}
      {circle.encrypted && circle.kind !== 'direct' && (
        <label className="block mt-3 text-sm">{t.e2ee.safetyPickGroup}
          <select className="field mt-1" value={pick ?? ''} onChange={e => setPick(e.target.value ? Number(e.target.value) : null)}>
            <option value="" />{others.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}
      {circle.encrypted && pick && (
        <section className="mt-3 rounded-2xl bg-card border border-line elevated-1 p-4 animate-fade-in">
          <h3 className="font-bold text-ink">{t.e2ee.safetyTitle}</h3>
          {state === 'keysMismatch' ? <p role="alert" className="text-danger text-sm mt-1">{t.e2ee.keysMismatch}</p> : (
            <>
              <p className="text-xs text-muted mt-1">{t.e2ee.safetyHelp.replace('{name}', name)}</p>
              <p dir="ltr" className="mt-3 rounded-xl bg-paper border border-line px-3 py-2 font-mono text-lg tracking-wider tabular-nums text-center leading-8 text-ink" aria-label={t.e2ee.safetyTitle}>
                {number ? number.split(' ').reduce<string[]>((rows, g, i) => { if (i % 3 === 0) rows.push(g); else rows[rows.length - 1] += ' ' + g; return rows; }, []).map((r, i) => <span key={i} className="block">{r}</span>) : '…'}
              </p>
              <p className={`text-sm mt-2 flex items-center justify-center gap-1.5 text-center ${verified ? 'text-green' : 'text-muted'}`}>{verified && <Icon name="check" className="w-4 h-4 shrink-0" />}<span>{verified ? t.e2ee.safetyVerified.replace('{name}', name) : t.e2ee.safetyNot}</span></p>
              {qr && number && <div className="mt-3"><QrImage text={qr} label={t.e2ee.safetyQr} /><p className="text-xs text-muted text-center mt-1">{t.e2ee.safetyQrHelp.replace('{name}', name)}</p></div>}
              {number && !scan && <button className="btn btn-ghost w-full mt-2" onClick={() => { setScanMsg(''); setScan(true); }}>{t.e2ee.safetyScan}</button>}
              {scan && <QrScanner onClose={() => setScan(false)} onText={async text => {
                setScan(false);
                try { const ok = await e2ee!.checkSafetyQr(circle.id, pick, text); if (ok) setVerified(true); setScanMsg(ok ? t.e2ee.safetyScanOk.replace('{name}', name) : t.e2ee.safetyScanBad); } catch { setScanMsg(t.e2ee.safetyScanBad); }
              }} />}
              {scanMsg && <p role="status" className="text-sm mt-2 text-center">{scanMsg}</p>}
              {!verified && number && <button className="btn w-full mt-2" onClick={async () => { await e2ee!.verify(pick, circle.id); setVerified(true); }}>{t.e2ee.safetyVerify}</button>}
            </>
          )}
        </section>
      )}
      <button className="btn btn-ghost w-full mt-3" onClick={onClose}>{t.close}</button>
    </Dialog>
  );
}

/** The notices the device itself wrote into this chat (keys changed, a device added), drawn like system lines. */
export function useNotices(circle: number, enabled: boolean): Notice[] {
  const { e2ee } = useE2ee();
  const [list, setList] = useState<Notice[]>([]);
  useEffect(() => {
    if (!enabled || !e2ee) return;
    let live = true;
    const load = () => e2ee.notices(circle).then(l => { if (live) setList(l); }).catch(() => {});
    load();
    const off = onChatChange(c => { if (c === circle || c === null) load(); });
    return () => { live = false; off(); };
  }, [circle, enabled, e2ee]);
  return list;
}
export function NoticeLine({ n, names, me, circle, onCompare }: { n: Notice; names: Map<number, string>; me: number; circle?: number; onCompare?: () => void }) {
  const { t } = useI18n();
  const { e2ee } = useE2ee();
  const [more, setMore] = useState(false);
  const [state, setState] = useState<'waiting' | 'dismissed' | 'added' | 'gone' | null>(null);   // what became of this new device
  const [unconf, setUnconf] = useState<boolean | null>(null);   // still unconfirmed in this chat?
  const still = state === 'waiting' || state === 'dismissed';
  useEffect(() => {
    if ((n.kind !== 'new_device_waiting' && n.kind !== 'new_device_unconfirmed') || !e2ee) return;
    let live = true;
    const look = () => (circle === undefined ? Promise.resolve() : n.kind === 'new_device_unconfirmed'
      ? e2ee.unconfirmedDevices().then(l => { if (live) setUnconf(l.some(x => x.circle === circle && x.userId === n.userId && x.deviceId === n.detail?.deviceId)); })
      : e2ee.deviceState(circle, n.userId, n.detail?.deviceId ?? 0).then(st => { if (live) setState(st); })).catch(() => {});
    look();
    const off = onChatChange(c => { if (c === circle || c === null) look(); });
    return () => { live = false; off(); };
  }, [n, e2ee, circle]);
  const name = names.get(n.userId) ?? '…';
  const cls = 'agent-note text-center text-xs text-gold-dark py-1.5 px-3 mx-auto w-fit max-w-full my-2 animate-fade-in';
  const row = 'flex items-center justify-center gap-1.5';
  // A warning is a small card, not a pill: the width is held to something readable, the words sit on the
  // start edge, and the buttons line up under them instead of floating in the middle of a wide bar.
  const warn = 'notice-card text-sm text-ink mx-auto w-fit max-w-[min(32rem,100%)] my-2 p-3 animate-fade-in';
  if (n.kind === 'gone') return <p role="status" className={`${cls} ${row}`}><Icon name="lock" className="w-3.5 h-3.5 shrink-0" />{t.e2ee.goneNote}</p>;
  if (n.kind === 'new_device_waiting' && state === 'gone') return null;
  if (n.kind === 'new_device_unconfirmed') return unconf === false ? null : (
    <div role="status" className={warn}>
      <p className="flex items-start gap-2 text-start"><Icon name="alert" className="w-4 h-4 mt-0.5 shrink-0 text-gold-dark" /><span>{t.e2ee.unconfirmedNote.replace('{name}', name)}</span></p>
      {n.detail?.code && <p dir="ltr" className="mt-1.5 ms-6 w-fit rounded-lg bg-card border border-line px-2 py-0.5 font-mono text-xs text-muted">{t.e2ee.deviceCode.replace('{code}', n.detail.code)}</p>}
      {unconf && circle !== undefined && e2ee && (
        <span className="flex flex-wrap gap-2 mt-2.5 ms-6">
          <button type="button" className="btn !py-1 text-xs" onClick={() => { e2ee.acceptDevice(circle, n.userId, n.detail!.deviceId!).catch(() => {}); }}>{t.e2ee.unconfirmedKeep}</button>
          {onCompare && <button type="button" className="btn btn-ghost !py-1 text-xs" onClick={onCompare}>{t.e2ee.newDeviceCompare}</button>}
          <button type="button" className="btn btn-ghost !py-1 text-xs" onClick={() => { e2ee.removeDevice(circle, n.userId, n.detail!.deviceId!).catch(() => {}); }}>{t.e2ee.unconfirmedRemove}</button>
        </span>
      )}
    </div>
  );
  if (n.kind === 'new_device_waiting') return (
    <div role="status" className={warn}>
      <p className="flex items-start gap-2 text-start"><Icon name="alert" className="w-4 h-4 mt-0.5 shrink-0 text-gold-dark" /><span>{(state === 'added' ? t.e2ee.newDeviceAdded : t.e2ee.newDeviceWaiting).replace('{name}', name)}</span></p>
      {n.detail?.code && <p dir="ltr" className="mt-1.5 ms-6 w-fit rounded-lg bg-card border border-line px-2 py-0.5 font-mono text-xs text-muted">{t.e2ee.deviceCode.replace('{code}', n.detail.code)}</p>}
      {still && circle !== undefined && e2ee && (
        <span className="flex flex-wrap gap-2 mt-2.5 ms-6">
          <button type="button" className="btn !py-1 text-xs" onClick={() => { e2ee.acceptDevice(circle, n.userId, n.detail!.deviceId!).catch(() => {}); }}>{t.e2ee.newDeviceAdd}</button>
          {onCompare && <button type="button" className="btn btn-ghost !py-1 text-xs" onClick={onCompare}>{t.e2ee.newDeviceCompare}</button>}
          {state === 'waiting' && <button type="button" className="btn btn-ghost !py-1 text-xs" onClick={() => { e2ee.dismissWaiting(circle, n.detail!.deviceId!).catch(() => {}); }}>{t.e2ee.newDeviceNotNow}</button>}
        </span>
      )}
    </div>
  );
  if (n.kind === 'own_device_added' || n.userId === me) return <p role="status" className={`${cls} ${row}`}><Icon name="key" className="w-3.5 h-3.5 shrink-0" />{t.e2ee.ownDeviceAdded}</p>;
  return (
    <>
      <p role="status" className={`${cls} ${row}`}><Icon name="key" className="w-3.5 h-3.5 shrink-0" /><span>{t.e2ee.keysChanged.replace('{name}', name)} <button type="button" className="underline hover:text-ink transition-colors duration-[var(--dur-instant)]" onClick={() => setMore(true)}>{t.e2ee.learnMore}</button></span></p>
      {more && (
        <Dialog onClose={() => setMore(false)} label={t.e2ee.keysWhyTitle}>
          <h3 className="font-bold">{t.e2ee.keysWhyTitle}</h3>
          <p className="mt-2 text-sm">{t.e2ee.keysWhy.split('{name}').join(name)}</p>
          <button className="btn w-full mt-3" onClick={() => setMore(false)}>{t.close ?? 'OK'}</button>
        </Dialog>
      )}
    </>
  );
}

// ---- devices and recovery (the "You" screen) ---------------------------------------------------------------------------------------------------

export function EncryptionPanel({ me }: { me: Me }) {
  const { t } = useI18n();
  const { on, e2ee } = useE2ee();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [mine, setMine] = useState('');
  const [bk, setBk] = useState<boolean | null>(null);
  const [shown, setShown] = useState('');
  const [msg, setMsg] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [mineLink, setMineLink] = useState<{ code: string; qr: string; expiresAt: number } | null>(null);   // the pairing this (new) device shows
  const mineCode = mineLink?.code ?? '';
  const [scanning, setScanning] = useState(false);
  const [left, setLeft] = useState(0);
  const [typed, setTyped] = useState('');                // the code typed on an older device
  const [found, setFound] = useState<DeviceInfo | null>(null);
  const [policy, setPolicy] = useState<'ask' | 'auto'>('ask');
  const reload = () => { if (!e2ee) return; e2ee.devices().then(setDevices).catch(() => {}); e2ee.myCode().then(setMine).catch(() => {}); e2ee.backup.enabled().then(setBk).catch(() => {}); };
  useEffect(reload, [e2ee]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!e2ee) return; e2ee.linkPending().then(c => { if (c) e2ee.linkRequest().then(setMineLink).catch(() => {}); }).catch(() => {}); e2ee.newDevicePolicy().then(setPolicy).catch(() => {}); }, [e2ee]);
  // The new device waits for the older one to confirm and hand the history over.
  useEffect(() => {
    if (!e2ee || !mineLink) return;
    let live = true;
    const tick = async () => {
      const r = await e2ee.receiveHistory().catch(e => { if (live && e?.code === 'bad_transfer') { setMineLink(null); setMsg(t.e2ee.linkBad); } return null; });
      if (r && live) { setMineLink(null); setMsg(t.e2ee.linkReceived); reload(); e2ee.syncAll().catch(() => {}); }
    };
    const id = setInterval(tick, 3000); tick();
    return () => { live = false; clearInterval(id); };
  }, [e2ee, mineLink]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // the pairing runs out after a few minutes: say so, and show a fresh one only when asked
    if (!mineLink) return;
    const id = setInterval(() => { const s = Math.round(mineLink.expiresAt - Date.now() / 1000); setLeft(s); if (s <= 0) { setMineLink(null); setMsg(t.e2ee.linkExpired); } }, 1000);
    setLeft(Math.round(mineLink.expiresAt - Date.now() / 1000));
    return () => clearInterval(id);
  }, [mineLink]);   // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e: any) => setMsg(e?.code === 'bad_recovery_code' ? t.e2ee.recoveryWrong : e?.code === 'no_backup' ? t.e2ee.recoveryNone : t.e2ee.setupFailed);
  if (!on || !e2ee) return null;
  const others = devices.filter(d => !d.mine);
  const myId = devices.find(d => d.mine)?.deviceId ?? 0;
  const needsMe = (d: DeviceInfo) => !d.mine && !d.approved && d.deviceId > myId;   // only a device made after this one waits for this one's yes
  const waiting = others.filter(needsMe);
  return (
    <section className="rounded-2xl bg-card border border-line elevated-1 p-4 mt-4 animate-fade-in">
      <h2 className="flex items-center gap-3 text-lg font-bold text-ink"><span className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="lock" className="w-5 h-5" /></span><span className="min-w-0">{t.e2ee.devicesTitle}</span></h2>
      <p className="text-sm text-muted mt-2">{t.e2ee.devicesHelp}</p>
      <p className="mt-2 flex items-start gap-2 rounded-xl bg-gold/15 text-ink text-xs px-3 py-2"><Icon name="alert" className="w-4 h-4 shrink-0 text-gold-dark" /><span>{t.e2ee.notAudited}</span></p>
      <ul className="mt-3 divide-y divide-line">
        {devices.map(d => (
          <li key={d.deviceId} className="py-2.5 text-sm text-ink">
            <b>{d.label ?? '—'}</b>{d.mine && <span className="ms-2 text-xs text-green">{t.e2ee.thisDevice}</span>}
            {d.code && <span dir="ltr" className="block text-xs text-muted">{t.e2ee.deviceCode.replace('{code}', d.code)}</span>}
            {needsMe(d) && <span className="block text-xs text-gold-dark">{t.e2ee.awaiting} — {t.e2ee.approveHelp}</span>}
            {!d.mine && <span className="flex gap-2 mt-1">
              {needsMe(d) && <button className="btn !py-1 text-xs" onClick={async () => { await e2ee.approveDevice(d.deviceId); reload(); }}>{t.e2ee.approve}</button>}
              <button className="btn btn-ghost !py-1 text-xs" onClick={async () => { if (await askConfirm(t.e2ee.revokeConfirm, { danger: true })) { await e2ee.revokeDevice(d.deviceId); reload(); } }}>{t.e2ee.revoke}</button>
            </span>}
          </li>
        ))}
      </ul>
      {others.length === 0 && mine && <p dir="ltr" className="text-xs text-muted mt-2">{t.e2ee.deviceCode.replace('{code}', mine)}</p>}
      {waiting.length > 0 && <p role="status" className="text-sm text-gold-dark mt-2">{t.e2ee.awaiting}: {waiting.length}</p>}

      <h3 className="font-bold mt-4">{t.e2ee.linkTitle}</h3>
      <p className="mt-2 flex items-start gap-2 rounded-xl bg-gold/15 text-ink text-xs px-3 py-2"><Icon name="alert" className="w-4 h-4 shrink-0 text-gold-dark" /><span>{t.e2ee.lostWarn}</span></p>
      <div className="rounded-2xl bg-paper border border-line p-3 mt-2">
        <p className="text-sm font-bold">{t.e2ee.linkNewTitle}</p>
        <p className="text-xs text-muted mt-1">{t.e2ee.linkNewHelp}</p>
        {mineCode ? (
          <>
            <div className="mt-2"><QrImage text={mineLink!.qr} label={t.e2ee.linkQr} /></div>
            <p className="text-xs text-muted mt-2 text-center">{t.e2ee.linkOrType}</p>
            <p dir="ltr" className="font-mono text-lg tracking-widest text-center select-all" aria-label={t.e2ee.linkCode}>{mineCode}</p>
            <p role="status" className="text-xs text-muted mt-1 text-center">{t.e2ee.linkWaiting} · {t.e2ee.linkExpiresIn.replace('{s}', String(Math.max(0, left)))}</p>
          </>
        ) : <button className="btn mt-2" disabled={busy} onClick={async () => { setBusy(true); setMsg(''); try { setMineLink(await e2ee.linkRequest()); } catch (e) { fail(e); } finally { setBusy(false); } }}>{t.e2ee.linkShow}</button>}
      </div>
      <div className="rounded-2xl bg-paper border border-line p-3 mt-2">
        <p className="text-sm font-bold">{t.e2ee.linkOldTitle}</p>
        <p className="text-xs text-muted mt-1">{t.e2ee.linkOldHelp}</p>
        {!found && scanning && <QrScanner onClose={() => setScanning(false)} onText={async text => {
          setScanning(false); setBusy(true); setMsg('');
          try { const d = await e2ee.findLink(text); if (d) { setTyped(text); setFound(d); } else setMsg(t.e2ee.linkNotFound); } catch { setMsg(t.e2ee.linkBad); } finally { setBusy(false); }
        }} />}
        {!found && !scanning && <button type="button" className="btn w-full mt-2" onClick={() => { setMsg(''); setScanning(true); }}>{t.e2ee.scanLink}</button>}
        {!found && !scanning ? (
          <form className="mt-2 flex gap-2" onSubmit={async e => {
            e.preventDefault(); setBusy(true); setMsg('');
            try { const d = await e2ee.findLink(typed); if (d) setFound(d); else setMsg(t.e2ee.linkNotFound); } catch { setMsg(t.e2ee.linkBad); } finally { setBusy(false); }
          }}>
            <input dir="ltr" className="field min-w-0 flex-1 font-mono" value={typed} placeholder={t.e2ee.linkPlaceholder} onChange={e => setTyped(e.target.value)} aria-label={t.e2ee.linkType} />
            <button className="btn" disabled={busy || typed.trim().length < 16}>{t.e2ee.linkFind}</button>
          </form>
        ) : found && (
          <div role="group" aria-label={t.e2ee.linkConfirmTitle} className="mt-2">
            <p className="font-bold text-sm">{t.e2ee.linkConfirmTitle}</p>
            <p className="text-sm mt-1">{t.e2ee.linkConfirmText.replace('{label}', found.label ?? '—').replace('{code}', found.code ?? '')}</p>
            <div className="flex gap-2 mt-2">
              <button className="btn" disabled={busy} onClick={async () => {
                setBusy(true); setMsg('');
                try { const r = await e2ee.confirmLink(found.deviceId, typed); setMsg(t.e2ee.linkDone.replace('{chats}', String(r.chats)).replace('{messages}', String(r.messages))); setFound(null); setTyped(''); reload(); } catch { setMsg(t.e2ee.linkBad); } finally { setBusy(false); }
              }}>{t.e2ee.linkConfirm}</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => { setFound(null); }}>{t.e2ee.linkNo}</button>
            </div>
          </div>
        )}
      </div>
      <label className="block mt-3 text-sm font-bold">{t.e2ee.policyTitle}
        <select className="field mt-1 font-normal" value={policy} onChange={async e => { const v = e.target.value === 'auto' ? 'auto' : 'ask'; setPolicy(v); await e2ee.setNewDevicePolicy(v); }}>
          <option value="ask">{t.e2ee.policyAsk}</option>
          <option value="auto">{t.e2ee.policyAuto}</option>
        </select>
      </label>
      <p className="text-xs text-muted mt-1">{t.e2ee.policyHelp}</p>

      <h3 className="font-bold mt-4">{t.e2ee.recoveryTitle}</h3>
      <p className="mt-2 flex items-start gap-2 rounded-xl bg-gold/15 text-ink text-xs px-3 py-2"><Icon name="alert" className="w-4 h-4 shrink-0 text-gold-dark" /><span>{t.e2ee.lostWarn}</span></p>
      <p className="text-xs text-muted mt-1">{t.e2ee.recoveryHelp}</p>
      <p className="text-xs text-muted mt-1">{t.e2ee.recoveryWarn}</p>
      {shown && <p dir="ltr" className="mt-2 font-mono text-lg text-center select-all rounded-xl bg-paper border border-line p-3 text-ink" aria-label={t.e2ee.recoveryShown}>{shown}</p>}
      {bk && !shown && <p className="text-sm text-green mt-2 flex items-center gap-1.5"><Icon name="check" className="w-4 h-4 shrink-0" />{t.e2ee.recoveryOn}</p>}
      <div className="flex flex-wrap gap-2 mt-2">
        {!bk && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { setShown(await e2ee.backup.enable()); setBk(true); } catch (e) { fail(e); } finally { setBusy(false); } }}>{t.e2ee.recoveryEnable}</button>}
        {bk && <button className="btn btn-ghost" onClick={async () => { await e2ee.backup.disable(); setBk(false); setShown(''); }}>{t.e2ee.recoveryDisable}</button>}
      </div>
      {bk === false && (
        <form className="mt-3 flex gap-2" onSubmit={async e => {
          e.preventDefault(); setBusy(true); setMsg('');
          try { await restoreDevice(me.id, code); setMsg(t.e2ee.recoveryDone); setCode(''); } catch (err) { fail(err); } finally { setBusy(false); }
        }}>
          <input dir="ltr" className="field min-w-0 flex-1 font-mono" value={code} placeholder={t.e2ee.recoveryPlaceholder} onChange={e => setCode(e.target.value)} aria-label={t.e2ee.recoveryRestore} />
          <button className="btn" disabled={busy || code.trim().length < 25}>{t.e2ee.recoveryRestore}</button>
        </form>
      )}
      {msg && <p role="status" className="text-sm mt-2">{msg}</p>}
      <button className="btn btn-ghost mt-4 text-sm" onClick={async () => { if (await askConfirm(t.e2ee.forgetConfirm, { danger: true })) { stopE2ee(); await forgetDevice(me.id); location.reload(); } }}>{t.e2ee.forget}</button>
    </section>
  );
}
export { api, useMemo };
