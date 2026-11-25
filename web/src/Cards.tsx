import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Card, type LinkPreview } from './api';
import { intlLocale, useI18n } from './i18n';
import { Dialog } from './Dialog';
import { STICKER_PACKS, findSticker } from '../../core/stickers';
import { mapLinks, vcard } from './links';
import { isSharing, onShareChange, stopSharing } from './livelocation';
import { Icon } from './icons';
import { Spinner } from './States';

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
const OUT = { target: '_blank', rel: 'noopener noreferrer nofollow' } as const;

/** What the chat list, a quoted reply and a pinned line call a message that is a card. */
export function cardWord(type: string | null | undefined, t: Record<string, any>): string {
  return ({ gif: `GIF`, sticker: `${t.stickerWord}`, contact: `${t.contactWord}`, location: `${t.locationWord}`, live: `${t.liveWord}` } as Record<string, string>)[type ?? ''] ?? '';
}

// ---- link preview ------------------------------------------------------------------------------

/** The card of a link, in a bubble (`image` is a media id of the message) or above the message box (`image` is the stored preview's hash). */
export function LinkCard({ url, title, description, site, image, mine, onRemove }: { url: string; title: string; description?: string; site: string; image: string | null; mine?: boolean; onRemove?: () => void }) {
  const { t } = useI18n();
  // The line under the title is the real address the link goes to, never the name the page gives itself (anyone can fake that).
  let host = site; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the page's name */ }
  return (
    <div className={`relative mt-1 flex overflow-hidden rounded-xl border-s-4 text-start ${mine ? 'bg-current/10 border-current/50' : 'bg-green-soft border-green'}`} data-card="link">
      <a href={url} {...OUT} className="flex min-w-0 flex-1 items-stretch">
        {image && <img alt="" loading="lazy" className="w-20 h-20 object-cover shrink-0" src={image} />}
        <span className="min-w-0 flex-1 px-3 py-2">
          <b className="block text-sm font-bold line-clamp-2" dir="auto">{title}</b>
          {description && <span className="block text-xs opacity-80 line-clamp-2" dir="auto">{description}</span>}
          <span className="block text-[11px] opacity-70 truncate" dir="ltr">{host}</span>
        </span>
      </a>
      {onRemove && <button type="button" aria-label={t.removePreview} title={t.removePreview} className="px-3 shrink-0 self-start py-2 opacity-70 hover:opacity-100 transition-colors duration-[var(--dur-instant)]" onClick={onRemove}><Icon name="x" className="w-4 h-4" /></button>}
    </div>
  );
}
/** While a link is being written: ask the server for its preview (after a pause in typing). Nothing is asked when previews are off. */
export function useLinkPreview(link: string | null, on: boolean) {
  const [found, setFound] = useState<(LinkPreview & { asked: string }) | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    if (!on || !link || link === dismissed) return;
    let gone = false;
    const timer = setTimeout(() => {
      api<{ preview: LinkPreview | null }>('/link-preview', { body: { url: link } }).then(r => { if (!gone && r.preview) setFound({ ...r.preview, asked: link }); }).catch(() => {});
    }, 600);
    return () => { gone = true; clearTimeout(timer); };
  }, [link, on, dismissed]);
  return { found: found && found.asked === link ? found : null, dismiss: () => setDismissed(link) };
}

// ---- stickers ----------------------------------------------------------------------------------

export function StickerView({ pack, id, small }: { pack: string; id: string; small?: boolean }) {
  const s = findSticker(pack, id);
  if (!s) return <span aria-hidden className="inline-flex text-muted"><Icon name="sticker" className="w-6 h-6" /></span>;
  if (!s.text) return <span role="img" aria-label={s.id} className={small ? 'text-[1.7rem] leading-none' : 'text-7xl leading-none block py-1'}>{s.emoji}</span>;
  return (
    <span role="img" aria-label={s.text} dir="rtl" data-sticker={`${pack}/${id}`}
      className={`inline-flex flex-col items-center justify-center text-center font-bold border-[var(--color-gold)] bg-[#fff8e6] text-[#1f4d3f] ${small ? 'w-[4.5rem] h-[4.5rem] rounded-2xl border text-[10px] gap-0.5 p-1' : 'w-36 h-36 rounded-[1.4rem] border-2 text-lg gap-1 p-2'}`}
>
      <span aria-hidden className={small ? 'text-[1.6rem] leading-none' : 'text-5xl leading-none'}>{s.emoji}</span>
      <span className="leading-tight">{s.text}</span>
    </span>
  );
}

interface GifItem { id: string; title: string; w: number; h: number }
const recent = <T,>(key: string): T[] => { try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const remember = <T,>(key: string, item: T, same: (a: T, b: T) => boolean) => { try { localStorage.setItem(key, JSON.stringify([item, ...recent<T>(key).filter(x => !same(x, item))].slice(0, 12))); } catch { /* not remembered */ } };

/** Stickers and GIFs, above the message box. GIF search goes through our own server; without a provider key it says so. */
export function SharePanel({ onSticker, onGif, onClose }: { onSticker: (pack: string, id: string) => void; onGif: (id: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'stickers' | 'gifs'>('stickers');
  const [q, setQ] = useState('');
  const [gifs, setGifs] = useState<{ configured: boolean; items: GifItem[] } | null>(null);
  const recentStickers = recent<{ pack: string; id: string }>('thikra_recent_stickers').filter(s => findSticker(s.pack, s.id));
  const recentGifs = recent<GifItem>('thikra_recent_gifs');
  useEffect(() => {
    if (tab !== 'gifs') return;
    let gone = false;
    const timer = setTimeout(() => api<{ configured: boolean; items: GifItem[] }>(`/gifs?q=${encodeURIComponent(q.trim())}`).then(r => { if (!gone) setGifs(r); }).catch(() => { if (!gone) setGifs({ configured: true, items: [] }); }), q ? 350 : 0);
    return () => { gone = true; clearTimeout(timer); };
  }, [tab, q]);
  const sticker = (pack: string, id: string) => { remember('thikra_recent_stickers', { pack, id }, (a, b) => a.pack === b.pack && a.id === b.id); onSticker(pack, id); };
  const gif = (g: GifItem) => { remember('thikra_recent_gifs', g, (a, b) => a.id === b.id); onGif(g.id); };
  const gifGrid = (list: GifItem[]) => (
    <ul className="grid grid-cols-3 gap-1">
      {list.map(g => <li key={g.id}><button type="button" aria-label={g.title || 'GIF'} className="block w-full aspect-square overflow-hidden rounded-xl bg-line transition-opacity duration-[var(--dur-instant)] hover:opacity-90" onClick={() => gif(g)}><img alt="" loading="lazy" className="w-full h-full object-cover" src={`/api/gifs/${g.id}/preview`} /></button></li>)}
    </ul>
  );
  // A sticker with words is a tile in a 4-across grid; an emoji-only sticker (the "faces" pack) is a small square in a tight grid.
  const grid = (pack: string, items: Array<{ id: string; text?: string }>) => {
    const words = items.some(x => x.text);
    return (
      <ul className={words ? 'grid grid-cols-4 gap-1.5' : 'grid grid-cols-8 gap-0.5'}>
        {items.map(x => (
          <li key={x.id} className="flex justify-center">
            <button type="button" onClick={() => sticker(pack, x.id)} aria-label={x.text || x.id}
              className={`flex items-center justify-center rounded-xl transition-[background-color,transform] duration-[var(--dur-fast)] hover:bg-green-soft active:scale-95 ${words ? 'p-1' : 'w-10 h-10'}`}>
              <StickerView pack={pack} id={x.id} small />
            </button>
          </li>
        ))}
      </ul>
    );
  };
  const head = (label: string) => <h3 className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm px-1 pt-2 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{label}</h3>;
  return (
    // A popover above the message box, not a block in the page: opening it never pushes the conversation up.
    <section aria-label={t.stickersAndGifs}
      className="w-[min(25rem,calc(100vw-2rem))] h-[min(24rem,60vh)] flex flex-col rounded-2xl bg-card border border-line elevated-3 overflow-hidden animate-scale-in origin-bottom">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 border-b border-line">
        <div role="tablist" className="inline-flex p-0.5 rounded-xl bg-paper border border-line">
          {(['stickers', 'gifs'] as const).map(k => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`h-8 px-4 rounded-[0.6rem] text-sm transition-[background-color,color,box-shadow] duration-[var(--dur-fast)] ${tab === k ? 'bg-card text-green font-bold elevated-1' : 'text-muted hover:text-ink'}`}>
              {k === 'stickers' ? t.stickersTab : t.gifsTab}
            </button>
          ))}
        </div>
        <button type="button" className="ms-auto w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:bg-green-soft hover:text-green transition-colors duration-[var(--dur-instant)]" aria-label={t.closePanel} title={t.closePanel} onClick={onClose}><Icon name="x" className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {tab === 'stickers' ? (
          <>
            {recentStickers.length > 0 && <>{head(t.recentlyUsed)}<ul className="flex flex-wrap gap-1.5">{recentStickers.slice(0, 8).map(x => <li key={`${x.pack}/${x.id}`}><button type="button" onClick={() => sticker(x.pack, x.id)} aria-label={findSticker(x.pack, x.id)?.text || x.id} className="p-1 rounded-xl flex items-center justify-center hover:bg-green-soft active:scale-95 transition-[background-color,transform] duration-[var(--dur-fast)]"><StickerView pack={x.pack} id={x.id} small /></button></li>)}</ul></>}
            {STICKER_PACKS.map(p => <div key={p.id}>{head(t.packNames[p.id] ?? p.id)}{grid(p.id, p.items)}</div>)}
          </>
        ) : gifs && !gifs.configured ? (
          <div role="status" className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
            <span className="w-12 h-12 rounded-2xl bg-green-soft text-green flex items-center justify-center"><Icon name="image" className="w-6 h-6" /></span>
            <p className="text-sm text-muted">{t.gifsNotSetUp}</p>
          </div>
        ) : (
          <div className="pt-2">
            <label className="flex items-center gap-2 h-10 px-3 mb-2 rounded-xl bg-paper border border-line focus-within:border-green">
              <Icon name="search" className="w-4 h-4 text-muted" />
              <input className="bare-input flex-1 bg-transparent text-sm" value={q} placeholder={t.searchGifs} aria-label={t.searchGifs} onChange={e => setQ(e.target.value)} />
            </label>
            {!q && recentGifs.length > 0 && <>{head(t.recentlyUsed)}<div className="mb-2">{gifGrid(recentGifs)}</div></>}
            {gifs && (gifs.items.length ? gifGrid(gifs.items) : <p className="text-sm text-muted p-2">{t.noResults}</p>)}
            <p className="text-[10px] text-muted mt-2 text-center" dir="ltr">{t.poweredByGiphy}</p>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- contact -----------------------------------------------------------------------------------

/** A contact in a bubble. "Message" opens the chat with that number if it is on Tamtim; "Save" hands the phone a contact file. */
export function ContactCard({ card, mine }: { card: Extract<Card, { type: 'contact' }>; mine: boolean }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  async function message() {
    setNote('');
    try { const r = await api<{ id: number }>('/direct', { body: { phone: card.phones[0] } }); location.hash = `/circle/${r.id}`; }
    catch (e) { setNote(e instanceof ApiError && e.code === 'user_not_found' ? t.contactNotOnApp : t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  function save() {
    const url = URL.createObjectURL(new Blob([vcard(card.name, card.phones)], { type: 'text/vcard' }));
    const a = document.createElement('a'); a.href = url; a.download = `${card.name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'contact'}.vcf`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return (
    <div className="min-w-[13rem]" data-card="contact">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${mine ? 'bg-current/15' : 'bg-green-soft text-green'}`}><Icon name="you" className="w-5 h-5" /></span>
        <span className="min-w-0"><b className="block truncate" dir="auto">{card.name}</b>
          {card.phones.map(p => <a key={p} href={`tel:${p.replace(/[^\d+]/g, '')}`} className="block text-sm underline underline-offset-2" dir="ltr">{p}</a>)}</span>
      </div>
      <div className="mt-2 flex gap-2">
        {!mine && <button type="button" className="btn btn-ghost !py-1 flex-1 text-sm" onClick={message}>{t.messageContact}</button>}
        <button type="button" className="btn btn-ghost !py-1 flex-1 text-sm" onClick={save}>{t.saveContact}</button>
      </div>
      {note && <p role="status" className="text-xs mt-1 opacity-80">{note}</p>}
    </div>
  );
}
/** Choosing a contact to send: from the phone's address book where the browser can, or typed in. */
export function ContactSheet({ onClose, onSend }: { onClose: () => void; onSend: (name: string, phones: string[]) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [phones, setPhones] = useState(['']);
  const canPick = typeof navigator !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window;
  async function pick() {
    try {
      const res: Array<{ name?: string[]; tel?: string[] }> = await (navigator as any).contacts.select(['name', 'tel'], { multiple: false });
      const c = res[0]; if (!c?.tel?.length) return;
      setName(c.name?.[0] ?? c.tel[0]); setPhones(c.tel.slice(0, 5));
    } catch { /* cancelled */ }
  }
  const clean = phones.map(p => p.trim()).filter(Boolean);
  const ok = name.trim().length > 0 && clean.length > 0 && clean.every(p => /^\+?[\d\s().-]{3,30}$/.test(p) && p.replace(/\D/g, '').length >= 3);
  return (
    <Dialog onClose={onClose} label={t.shareContact}>
      <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="you" className="w-5 h-5 text-green" />{t.shareContact}</h2>
      {canPick && <button type="button" className="btn btn-ghost w-full mt-3 inline-flex items-center justify-center gap-2" onClick={pick}><Icon name="phone" className="w-5 h-5" />{t.pickFromPhone}</button>}
      <form className="mt-3 flex flex-col gap-2" onSubmit={e => { e.preventDefault(); if (ok) onSend(name.trim(), clean); }}>
        <input className="field" value={name} maxLength={100} placeholder={t.contactName} aria-label={t.contactName} onChange={e => setName(e.target.value)} />
        {phones.map((p, i) => <input key={i} className="field" dir="ltr" inputMode="tel" value={p} maxLength={30} placeholder={t.contactPhone} aria-label={t.contactPhone} onChange={e => setPhones(list => list.map((x, j) => (j === i ? e.target.value : x)))} />)}
        {phones.length < 5 && <button type="button" className="text-sm font-bold text-green self-start inline-flex items-center gap-1.5 py-1" onClick={() => setPhones(l => [...l, ''])}><Icon name="plus-circle" className="w-5 h-5" />{t.addAnotherPhone}</button>}
        <div className="mt-2 flex gap-2">
          <button className="btn flex-1" disabled={!ok}>{t.sendContact}</button>
          <button type="button" className="btn btn-ghost flex-1" onClick={onClose}>{t.cancel}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- location ----------------------------------------------------------------------------------

/** A place in a bubble: a pin, the coordinates, and where to open it. No map picture is fetched from anyone. */
export function LocationCard({ card, mine }: { card: Extract<Card, { type: 'location' }>; mine: boolean }) {
  const { t } = useI18n();
  const links = mapLinks(card.lat, card.lng);
  return (
    <div className="min-w-[13rem]" data-card="location">
      <div className={`rounded-xl px-3 py-3 flex items-center gap-3 ${mine ? 'bg-current/10' : 'bg-green-soft'}`}>
        <span aria-hidden className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${mine ? 'bg-current/15' : 'bg-card text-green'}`}><Icon name="location" className="w-5 h-5" /></span>
        <span className="min-w-0">
          <b className="block truncate" dir="auto">{card.label || t.locationWord}</b>
          <span className="block text-xs opacity-80 tabular-nums" dir="ltr">{card.lat.toFixed(5)}, {card.lng.toFixed(5)}</span>
          {card.accuracy !== null && <span className="block text-[11px] opacity-70">{fill(t.locationAccuracy, { m: card.accuracy })}</span>}
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        <a className="btn btn-ghost !py-1 flex-1 text-sm text-center" href={links.google} {...OUT}>{t.openGoogleMaps}</a>
        <a className="btn btn-ghost !py-1 flex-1 text-sm text-center" href={links.apple} {...OUT}>{t.openAppleMaps}</a>
      </div>
    </div>
  );
}
/**
 * A live location in a bubble: the latest point, when it arrived, and until when it runs. The person sharing it
 * sees a Stop button for as long as this device is the one sharing. There is no trail to draw, by design.
 */
export function LiveCard({ card, mine, mid, onChanged }: { card: Extract<Card, { type: 'live' }>; mine: boolean; mid: number; onChanged?: () => void }) {
  const { t, lang } = useI18n();
  const [stopping, setStopping] = useState(false);
  const [, redraw] = useState(0);
  useEffect(() => onShareChange(() => redraw(n => n + 1)), []);   // the watcher may stop a share on its own
  const links = mapLinks(card.lat, card.lng);
  const until = Date.parse(card.until);
  const over = card.ended || !(until > Date.now());
  const time = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString(intlLocale(lang), { hour: '2-digit', minute: '2-digit' }); };
  return (
    <div className="min-w-[13rem]" data-card="live">
      <div className={`rounded-xl px-3 py-3 flex items-center gap-3 ${mine ? 'bg-current/10' : 'bg-green-soft'}`}>
        <span aria-hidden className={`relative w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${mine ? 'bg-current/15' : 'bg-card text-green'}`}>
          <Icon name="location" className="w-5 h-5" />
          {!over && <span className="absolute -top-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-danger animate-pulse" />}
        </span>
        <span className="min-w-0">
          <b className="block truncate">{t.liveWord}</b>
          <span className="block text-xs opacity-80">{over ? t.liveEnded : fill(t.liveUntil, { time: time(card.until) })}</span>
          <span className="block text-[11px] opacity-70 tabular-nums" dir="ltr">{card.lat.toFixed(5)}, {card.lng.toFixed(5)}</span>
          {card.at && <span className="block text-[11px] opacity-70">{fill(t.liveUpdated, { time: time(card.at) })}</span>}
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        <a className="btn btn-ghost !py-1 flex-1 text-sm text-center" href={links.google} {...OUT}>{t.openGoogleMaps}</a>
        <a className="btn btn-ghost !py-1 flex-1 text-sm text-center" href={links.apple} {...OUT}>{t.openAppleMaps}</a>
      </div>
      {mine && !over && isSharing(mid) && (
        <button type="button" disabled={stopping} className="btn btn-ghost !py-1 w-full mt-2 text-sm text-danger"
          onClick={() => { setStopping(true); stopSharing(mid).then(() => onChanged?.()).finally(() => setStopping(false)); }}>{t.liveStop}</button>
      )}
    </div>
  );
}

type Fix = { lat: number; lng: number; accuracy: number };
/**
 * Sending where I am now. The device is asked for its best reading and keeps listening for a better one while the sheet is open;
 * the person sees the accuracy and sends when it is good. If permission is refused, the sheet says exactly what to do.
 */
export function LocationSheet({ onClose, onSend, onSendLive }: { onClose: () => void; onSend: (fix: Fix, label: string) => void; onSendLive?: (fix: Fix, minutes: number) => void }) {
  const { t } = useI18n();
  const [fix, setFix] = useState<Fix | null>(null);
  const [problem, setProblem] = useState<'denied' | 'unavailable' | 'unsupported' | null>(null);
  const [label, setLabel] = useState('');
  const [round, setRound] = useState(0);
  const best = useRef<Fix | null>(null);
  useEffect(() => {
    if (!('geolocation' in navigator) || !window.isSecureContext) { setProblem('unsupported'); return; }
    setProblem(null); setFix(null); best.current = null;
    const id = navigator.geolocation.watchPosition(
      p => { const f = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }; if (!best.current || f.accuracy <= best.current.accuracy) { best.current = f; setFix(f); } },
      e => { if (!best.current) setProblem(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [round]);
  return (
    <Dialog onClose={onClose} label={t.shareLocation}>
      <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="location" className="w-5 h-5 text-green" />{t.shareLocation}</h2>
      {problem ? (
        <>
          <p role="alert" className="mt-3 text-sm text-danger flex items-start gap-2"><Icon name="alert" className="w-5 h-5 shrink-0" /><span>{problem === 'denied' ? t.locationDenied : problem === 'unavailable' ? t.locationUnavailable : t.locationUnsupported}</span></p>
          <div className="mt-4 flex gap-2">
            {problem !== 'unsupported' && <button type="button" className="btn flex-1" onClick={() => setRound(n => n + 1)}>{t.tryAgain}</button>}
            <button type="button" className="btn btn-ghost flex-1" onClick={onClose}>{t.cancel}</button>
          </div>
        </>
      ) : !fix ? (
        <>
          <p role="status" className="mt-3 text-sm text-muted flex items-center gap-2"><Spinner />{t.locating}</p>
          <button type="button" className="btn btn-ghost w-full mt-4" onClick={onClose}>{t.cancel}</button>
        </>
      ) : (
        <>
          <div className="mt-3 rounded-2xl bg-card border border-line elevated-1 px-3 py-3 flex items-center gap-3">
            <span aria-hidden className="w-10 h-10 rounded-xl bg-green-soft text-green flex items-center justify-center shrink-0"><Icon name="location" className="w-5 h-5" /></span>
            <span><b className="block tabular-nums" dir="ltr">{fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}</b>
              <span role="status" className="block text-xs text-muted">{fill(t.locationAccuracy, { m: Math.round(fix.accuracy) })}{fix.accuracy > 50 ? ` · ${t.improvingAccuracy}` : ''}</span></span>
          </div>
          <input className="field mt-3" value={label} maxLength={100} placeholder={t.locationLabelHint} aria-label={t.locationLabelHint} onChange={e => setLabel(e.target.value)} />
          <p className="text-xs text-muted mt-2">{t.locationPrivacyNote}</p>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn flex-1" onClick={() => onSend(fix, label.trim())}>{t.sendLocation}</button>
            <button type="button" className="btn btn-ghost flex-1" onClick={onClose}>{t.cancel}</button>
          </div>
          {onSendLive && (
            <div className="mt-4 pt-3 border-t border-line">
              <p className="text-sm font-bold flex items-center gap-2"><Icon name="location" className="w-4 h-4 text-green" />{t.liveFor}</p>
              <div className="mt-2 flex gap-2">
                {[15, 60, 480].map((m, i) => (
                  <button key={m} type="button" className="btn btn-ghost flex-1 !py-1 text-sm" onClick={() => onSendLive(fix, m)}>{t.liveMins[i]}</button>
                ))}
              </div>
              <p className="text-xs text-muted mt-2">{t.liveNote}</p>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
