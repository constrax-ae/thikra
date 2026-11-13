import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { api, mediaSource, openRemote, type CircleDetail } from './api';
import { t } from './i18n';
import { Icon } from './icons';
import { IconButton, Muted, Skeleton, Txt, ask } from './ui';
import { elevation, font, radius, space, usePalette } from './theme';

// The family's albums: the photos and voices kept from an old chat (the WhatsApp import makes
// them). Everyone browses; managers can delete. The phone's version of web/src/Album.tsx.

interface Year { year: number; image: number; voice: number; video: number }
export interface Album { id: number; title: string; source: string; rangeFrom: string | null; rangeTo: string | null; years: Year[] }
interface Item { id: number; kind: 'image' | 'voice' | 'video'; takenAt: string; year: number; sender: string | null; name: string | null; hasThumb: boolean }

const fileUrl = (id: number, thumb = false) => `/api/album-items/${id}/file${thumb ? '?thumb=1' : ''}`;
const total = (a: Album, k: 'image' | 'voice' | 'video') => a.years.reduce((n, y) => n + y[k], 0);

/** The list of albums, shown in the Archive. Nothing at all when there are none. */
export function AlbumsSection({ circle, refreshKey }: { circle: CircleDetail; refreshKey?: number }) {
  const p = usePalette();
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [open, setOpen] = useState<Album | null>(null);
  const manager = circle.role === 'owner' || circle.role === 'admin';
  const load = useCallback(() => api<Album[]>(`/circles/${circle.id}/albums`).then(setAlbums).catch(() => setAlbums([])), [circle.id]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  if (!albums || albums.length === 0) return null;

  const remove = (a: Album) => ask(t.albumDelete, t.albumDeleteNote.replace('{title}', a.title), t.albumDelete, t.cancel, () => {
    api(`/circles/${circle.id}/albums/${a.id}`, { method: 'DELETE' }).then(load).catch(() => Alert.alert(t.failed));
  });

  return (
    <View style={{ gap: space.sm }}>
      <Txt size="caption" weight="heavy" color="muted" style={{ letterSpacing: 1.2, textTransform: 'uppercase' }}>{t.albumsTitle}</Txt>
      {albums.map(a => (
        <Pressable key={a.id} onPress={() => setOpen(a)} accessibilityRole="button" accessibilityLabel={a.title}
          style={({ pressed }) => [{ flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.lg + 2, backgroundColor: p.card,
            borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 1), pressed && { backgroundColor: p.greenSoft }]}>
          <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="album" size={24} color={p.green} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Txt weight="medium" numberOfLines={1}>{a.title}</Txt>
            {!!a.rangeFrom && !!a.rangeTo && <Muted style={{ fontSize: 12, writingDirection: 'ltr' }}>{a.rangeFrom} → {a.rangeTo}</Muted>}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
              <Chip icon="image" text={`${total(a, 'image')} ${t.albumPhotos}`} />
              <Chip icon="mic" text={`${total(a, 'voice')} ${t.albumVoices}`} />
              {!!total(a, 'video') && <Chip icon="video" text={`${total(a, 'video')} ${t.albumVideos}`} />}
              <Chip icon="calendar" text={`${a.years.length} ${t.albumYears}`} />
            </View>
          </View>
          {manager && (
            <Pressable onPress={() => remove(a)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.albumDelete}
              style={({ pressed }) => [{ width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, pressed && { backgroundColor: p.dangerSoft }]}>
              <Icon name="trash" size={16} color={p.muted} />
            </Pressable>
          )}
        </Pressable>
      ))}
      <AlbumView album={open} manager={manager} onClose={() => { setOpen(null); void load(); }} />
    </View>
  );
}

function Chip({ icon, text }: { icon: 'image' | 'mic' | 'video' | 'calendar'; text: string }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: p.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }}>
      <Icon name={icon} size={11} color={p.muted} />
      <Text style={{ fontSize: 11, fontFamily: font.medium, color: p.muted }}>{text}</Text>
    </View>
  );
}

/** One album, full screen: a year, then what kind, then the photo grid and the voices. */
function AlbumView({ album, manager, onClose }: { album: Album | null; manager: boolean; onClose: () => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [year, setYear] = useState(0);
  const [kind, setKind] = useState<'' | 'image' | 'voice' | 'video'>('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [more, setMore] = useState(false);
  const [light, setLight] = useState<Item | null>(null);
  useEffect(() => { if (album) { setYear(album.years[0]?.year ?? 0); setKind(''); } }, [album]);

  const load = useCallback(async (after = 0) => {
    if (!album || !year) return;
    if (!after) setItems(null);
    const r = await api<Item[]>(`/albums/${album.id}/items?year=${year}${kind ? `&kind=${kind}` : ''}&limit=60${after ? `&after=${after}` : ''}`).catch(() => [] as Item[]);
    setItems(prev => (after ? [...(prev ?? []), ...r] : r)); setMore(r.length === 60);
  }, [album, year, kind]);
  useEffect(() => { void load(); }, [load]);

  const yearInfo = album?.years.find(y => y.year === year);
  const pics = (items ?? []).filter(i => i.kind !== 'voice');
  const voices = (items ?? []).filter(i => i.kind === 'voice');
  const tile = Math.floor((width - space.md * 2 - 8) / 3);
  const when = (it: Item) => `${it.takenAt}${it.sender ? ` · ${it.sender}` : ''}`;
  const remove = (it: Item) => ask(t.deleteEntry, when(it), t.deleteEntry, t.cancel, () => {
    api(`/album-items/${it.id}`, { method: 'DELETE' }).then(() => { setItems(prev => (prev ?? []).filter(x => x.id !== it.id)); setLight(null); }).catch(() => Alert.alert(t.failed));
  });

  return (
    <Modal visible={!!album} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: p.paper, paddingTop: inset.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, minHeight: 56 }}>
          <IconButton name="arrow-back" label={t.back} onPress={onClose} />
          <Txt size="bodyLg" weight="medium" numberOfLines={1} style={{ flex: 1 }}>{album?.title}</Txt>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: space.md, paddingBottom: space.sm }} style={{ flexGrow: 0 }}>
          {album?.years.map(y => <Pill key={y.year} on={y.year === year} label={String(y.year)} onPress={() => setYear(y.year)} />)}
        </ScrollView>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space.md, paddingBottom: space.md }}>
          {([['', t.albumAll], ['image', t.impPhotos], ['voice', t.impVoices], ['video', t.albumVideos]] as const)
            .filter(([k]) => !k || (yearInfo && yearInfo[k] > 0))
            .map(([k, label]) => <Pill key={k || 'all'} on={kind === k} label={label} onPress={() => setKind(k)} quiet />)}
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: space.md, paddingBottom: inset.bottom + space.xl, gap: space.md }}>
          {/* A plain wrapping grid: three square tiles a row, the same on every platform. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {items === null
              ? Array.from({ length: 9 }, (_, i) => <Skeleton key={i} width={tile} height={tile} radius={10} />)
              : pics.map(i => (
                <Pressable key={i.id} onPress={() => (i.kind === 'video' ? openRemote(fileUrl(i.id), i.name ?? `video-${i.id}.mp4`, `album-${i.id}`).catch(() => Alert.alert(t.failed)) : setLight(i))}
                  onLongPress={manager ? () => remove(i) : undefined} accessibilityLabel={when(i)}
                  style={{ width: tile, height: tile, borderRadius: 10, overflow: 'hidden', backgroundColor: p.line }}>
                  <Image source={mediaSource(fileUrl(i.id, i.hasThumb))} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  {i.kind === 'video' && (
                    <View style={{ position: 'absolute', left: 6, bottom: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="play" size={11} color="#fff" />
                    </View>
                  )}
                </Pressable>
              ))}
          </View>
          {items !== null && pics.length === 0 && voices.length === 0 && <Muted style={{ textAlign: 'center', paddingVertical: space.xl }}>{t.albumEmptyYear}</Muted>}
          {voices.map(v => <AlbumVoice key={v.id} item={v} label={when(v)} onLongPress={manager ? () => remove(v) : undefined} />)}
          {more && (
            <Pressable onPress={() => { const last = items?.[items.length - 1]; if (last) void load(last.id); }}
              style={{ alignSelf: 'center', paddingHorizontal: space.lg, height: 40, borderRadius: 20, justifyContent: 'center', backgroundColor: p.greenSoft }}>
              <Txt size="small" weight="medium" color="green">{t.loadMore}</Txt>
            </Pressable>
          )}
        </ScrollView>
      </View>

      {/* A photo full screen on black; a manager can remove it from here. */}
      <Modal visible={!!light} transparent animationType="fade" onRequestClose={() => setLight(null)}>
        <View style={{ flex: 1, backgroundColor: '#000', paddingTop: inset.top, paddingBottom: inset.bottom }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm }}>
            <Pressable onPress={() => setLight(null)} accessibilityRole="button" accessibilityLabel={t.back} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="x" size={22} color="#fff" />
            </Pressable>
            <Text numberOfLines={1} style={{ flex: 1, color: '#ffffffcc', fontFamily: font.regular, fontSize: 13 }}>{light ? when(light) : ''}</Text>
            {manager && light && (
              <Pressable onPress={() => remove(light)} accessibilityRole="button" accessibilityLabel={t.deleteEntry} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="trash" size={20} color="#fff" />
              </Pressable>
            )}
          </View>
          {light && <Image source={mediaSource(fileUrl(light.id))} style={{ flex: 1 }} resizeMode="contain" />}
        </View>
      </Modal>
    </Modal>
  );
}

function Pill({ on, label, onPress, quiet }: { on: boolean; label: string; onPress: () => void; quiet?: boolean }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={{ height: 32, paddingHorizontal: 14, borderRadius: 16, justifyContent: 'center', borderWidth: 1,
        borderColor: on ? p.green : p.line, backgroundColor: on ? (quiet ? 'transparent' : p.greenSoft) : p.card }}>
      <Text style={{ fontSize: 13, fontFamily: on ? font.bold : font.medium, color: on ? p.green : p.muted }}>{label}</Text>
    </Pressable>
  );
}

/** A voice kept in the album, with who sent it and when. */
function AlbumVoice({ item, label, onLongPress }: { item: Item; label: string; onLongPress?: () => void }) {
  const p = usePalette();
  const player = useAudioPlayer(mediaSource(fileUrl(item.id)), { updateInterval: 250 });
  const st = useAudioPlayerStatus(player);
  const total = st.duration || 0, pos = st.currentTime || 0;
  useEffect(() => { if (st.didJustFinish) { player.seekTo(0); player.pause(); } }, [st.didJustFinish, player]);
  return (
    <Pressable onLongPress={onLongPress} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md + 2, backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }}>
      <Pressable onPress={() => (st.playing ? player.pause() : player.play())} accessibilityRole="button" accessibilityLabel={st.playing ? 'pause' : t.voice}
        style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={st.playing ? 'pause' : 'play'} size={16} color={p.onBrand} />
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <Text numberOfLines={1} style={{ fontSize: 12, fontFamily: font.regular, color: p.muted, writingDirection: 'ltr' }}>{label}</Text>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: p.line, overflow: 'hidden' }}>
          <View style={{ width: `${total ? Math.min(100, (pos / total) * 100) : 0}%`, height: '100%', backgroundColor: p.green }} />
        </View>
      </View>
    </Pressable>
  );
}
