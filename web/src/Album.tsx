import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CircleDetail } from './api';
import { useI18n } from './i18n';
import { Dialog } from './Dialog';

interface Year { year: number; image: number; voice: number; video: number }
interface Album { id: number; title: string; source: string; rangeFrom: string | null; rangeTo: string | null; years: Year[] }
interface Item { id: number; kind: 'image' | 'voice' | 'video'; takenAt: string; year: number; sender: string | null; name: string | null; hasThumb: boolean }

const fileUrl = (id: number, thumb = false) => `/api/album-items/${id}/file${thumb ? '?thumb=1' : ''}`;

/** The family's albums (photos and voices kept from an old chat). Everyone browses; managers can remove. */
export function AlbumsSection({ circle }: { circle: CircleDetail }) {
  const { t } = useI18n();
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [open, setOpen] = useState<Album | null>(null);
  const [del, setDel] = useState<Album | null>(null);
  const [error, setError] = useState('');
  const manager = circle.role === 'owner' || circle.role === 'admin';
  const load = useCallback(() => api<Album[]>(`/circles/${circle.id}/albums`).then(setAlbums).catch(() => setAlbums([])), [circle.id]);
  useEffect(() => { load(); }, [load]);
  if (!albums || albums.length === 0) return null;
  if (open) return <AlbumView album={open} manager={manager} onBack={() => { setOpen(null); load(); }} />;
  const total = (a: Album, k: 'image' | 'voice' | 'video') => a.years.reduce((n, y) => n + y[k], 0);
  async function remove(a: Album) {
    try { await api(`/circles/${circle.id}/albums/${a.id}`, { method: 'DELETE' }); setDel(null); load(); } catch (e) { setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
  }
  return (
    <section className="space-y-2">
      <h3 className="font-bold text-green">{t.albumsTitle}</h3>
      <ul className="space-y-2">
        {albums.map(a => (
          <li key={a.id} className="card p-3">
            <button className="w-full text-start" onClick={() => setOpen(a)}>
              <b className="block">📔 {a.title}</b>
              <span className="text-xs text-muted" dir="ltr">{a.rangeFrom && a.rangeTo ? `${a.rangeFrom} → ${a.rangeTo}` : ''}</span>
              <span className="block text-sm text-muted">{total(a, 'image')} {t.albumPhotos} · {total(a, 'voice')} {t.albumVoices}{total(a, 'video') ? ` · ${total(a, 'video')} ${t.albumVideos}` : ''} · {a.years.length} {t.albumYears}</span>
            </button>
            {manager && <button className="mt-1 text-xs text-danger underline" onClick={() => setDel(a)}>{t.albumDelete}</button>}
          </li>
        ))}
      </ul>
      {del && (
        <Dialog onClose={() => setDel(null)} label={t.albumDelete}>
          <h2 className="text-lg font-bold">{t.albumDelete}</h2>
          <p className="text-sm text-muted mt-2">{t.albumDeleteNote.replace('{title}', del.title)}</p>
          {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
          <div className="flex gap-2 mt-3"><button className="btn !bg-red-700 flex-1" onClick={() => remove(del)}>{t.albumDelete}</button><button className="btn btn-ghost" onClick={() => setDel(null)}>{t.cancel}</button></div>
        </Dialog>
      )}
    </section>
  );
}

function AlbumView({ album, manager, onBack }: { album: Album; manager: boolean; onBack: () => void }) {
  const { t } = useI18n();
  const [year, setYear] = useState<number>(album.years[0]?.year ?? 0);   // newest year first
  const [kind, setKind] = useState<'' | 'image' | 'voice' | 'video'>('');
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [light, setLight] = useState<Item | null>(null);
  const load = useCallback(async (after = 0) => {
    const r = await api<Item[]>(`/albums/${album.id}/items?year=${year}${kind ? `&kind=${kind}` : ''}&limit=60${after ? `&after=${after}` : ''}`).catch(() => [] as Item[]);
    setItems(p => (after ? [...p, ...r] : r)); setMore(r.length === 60);
  }, [album.id, year, kind]);
  useEffect(() => { load(); }, [load]);
  async function remove(it: Item) { await api(`/album-items/${it.id}`, { method: 'DELETE' }); setItems(p => p.filter(x => x.id !== it.id)); setLight(null); }
  const when = (it: Item) => `${it.takenAt}${it.sender ? ` · ${it.sender}` : ''}`;
  const yearInfo = album.years.find(y => y.year === year);
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2"><button className="btn btn-ghost !px-3" onClick={onBack} aria-label={t.back}>←</button><b className="flex-1 truncate">📔 {album.title}</b></div>
      <div role="tablist" aria-label={t.albumYears} className="flex gap-1 overflow-x-auto">
        {album.years.map(y => <button key={y.year} role="tab" aria-selected={y.year === year} onClick={() => setYear(y.year)}
          className={`px-3 py-1 rounded-full border text-sm whitespace-nowrap ${y.year === year ? 'bg-green-soft border-green text-green font-bold' : 'border-line bg-card'}`}>{y.year}</button>)}
      </div>
      <div className="flex gap-2 text-sm">
        {([['', t.albumAll], ['image', t.albumPhotos], ['voice', t.albumVoices], ['video', t.albumVideos]] as const).filter(([k]) => !k || (yearInfo && yearInfo[k] > 0)).map(([k, label]) =>
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={`px-3 py-1 rounded-full border ${kind === k ? 'border-green text-green font-bold' : 'border-line text-muted'}`}>{label}</button>)}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1">
        {items.filter(i => i.kind !== 'voice').map(i => (
          <button key={i.id} className="relative aspect-square overflow-hidden rounded-lg bg-line" onClick={() => setLight(i)} aria-label={when(i)}>
            <img alt="" loading="lazy" className="w-full h-full object-cover" src={fileUrl(i.id, i.hasThumb)} />
            {i.kind === 'video' && <span className="absolute bottom-1 start-1 text-xs bg-black/60 text-white rounded px-1">▶</span>}
          </button>
        ))}
      </div>
      <ul className="space-y-2">
        {items.filter(i => i.kind === 'voice').map(i => (
          <li key={i.id} className="card p-2 space-y-1"><div className="text-xs text-muted" dir="ltr">🎙 {when(i)}</div><audio controls preload="none" className="w-full" src={fileUrl(i.id)} /></li>
        ))}
      </ul>
      {items.length === 0 && <p className="text-sm text-muted">{t.albumEmptyYear}</p>}
      {more && <button className="btn btn-ghost w-full" onClick={() => load(items[items.length - 1].id)}>{t.admMore}</button>}
      {light && (
        <Dialog onClose={() => setLight(null)} label={when(light)}>
          <p className="text-xs text-muted mb-2" dir="ltr">{when(light)}</p>
          {light.kind === 'video'
            ? <video controls autoPlay preload="metadata" playsInline className="w-full rounded-lg max-h-[70vh] bg-black" src={fileUrl(light.id)} />
            : <img alt={light.name ?? ''} className="max-w-full max-h-[70vh] mx-auto rounded-lg" src={fileUrl(light.id)} />}
          <div className="flex gap-2 mt-3">{manager && <button className="btn btn-ghost !text-danger" onClick={() => remove(light)}>{t.deleteEntry}</button>}<button className="btn flex-1" onClick={() => setLight(null)}>{t.cancel}</button></div>
        </Dialog>
      )}
    </section>
  );
}
