import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Image, Linking, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { api, mediaSource, openBook, type Chat, type CircleDetail } from './api';
import { API_URL } from './config';
import { lang, locale, t } from './i18n';
import { Icon, type IconName } from './icons';
import { Avatar, Badge, EmptyState, Eyebrow, FadeIn, Field, IconTile, TimelineSkeleton, Muted, Picker, Txt } from './ui';
import { Summary } from './Memory';
import { AlbumsSection } from './Albums';
import { ImportScreen } from './Import';
import { elevation, radius, space, usePalette } from './theme';

export interface Entry {
  id: number; title: string; summary: string; category: string | null;
  eventDate: string; source: 'auto' | 'manual'; kind: string; status?: string;
  protected?: number; pending?: number; canAct?: boolean;
  media?: Array<{ id: number; kind?: string; thumb?: number | null }>;
}

const CAT_ICON: Record<string, IconName> = {
  birth: 'heart', marriage: 'heart', graduation: 'star', achievement: 'star', travel: 'globe',
  health: 'shield', passing: 'memory', family_news: 'chats', other: 'sparkle',
};
const monthOf = (iso: string) => {
  const d = new Date(`${String(iso).slice(0, 7)}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
};

/**
 * One circle's archive: what the agent documented from this family's messages — the
 * thing Thekra does that WhatsApp does not. Same shape as the web's Archive tab: search,
 * the family story book, then the events by month on a gold rail.
 */
export function Archive({ chat, detail }: { chat: Chat; detail: CircleDetail | null }) {
  const p = usePalette();
  const [list, setList] = useState<Entry[] | null>(null);
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [yearOpen, setYearOpen] = useState(false);
  const manager = detail?.role === 'owner' || detail?.role === 'admin';
  const [importing, setImporting] = useState(false);
  const [albumsKey, setAlbumsKey] = useState(0);   // bumped after an import so the albums list reloads

  const load = useCallback(async () => {
    try { setList(await api<Entry[]>(`/circles/${chat.id}/archive?q=${encodeURIComponent(q)}`)); } catch { setList(l => l ?? []); }
  }, [chat.id, q]);
  useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [load]);

  const remove = (e: Entry) => Alert.alert(t.removeFromArchive, e.summary.slice(0, 120), [
    { text: t.cancel, style: 'cancel' },
    { text: t.removeFromArchive, style: 'destructive', onPress: async () => { try { await api(`/archive/${e.id}`, { method: 'DELETE' }); await load(); } catch { Alert.alert(t.failed); } } },
  ]);

  const years = Array.from({ length: 12 }, (_, i) => new Date().getFullYear() - i);
  const rows = list ?? [];
  const header = (
    <View style={{ gap: space.md, paddingBottom: space.lg }}>
      {/* This circle's memory at a glance — the same card as the Memory tab. */}
      {!q.trim() && rows.length > 0 && <Summary entries={rows} />}

      {/* The family story in one row: the book, the year, and the way to read it. */}
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.lg + 2,
        backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 1)]}>
        <IconTile name="book" size={44} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt weight="medium" numberOfLines={1}>{detail?.storyTitle || t.storyHead}</Txt>
          <Pressable onPress={() => setYearOpen(true)} accessibilityRole="button" accessibilityLabel={`${t.bookYear}: ${year}`} hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 2 }}>
            <Icon name="calendar" size={13} color={p.green} />
            <Txt size="small" weight="heavy" color="green">{year}</Txt>
            <Icon name="chevron" size={13} color={p.green} />
          </Pressable>
        </View>
        <Pressable onPress={() => { openBook(chat.id, year, lang).catch(() => Alert.alert(t.failed)); }} accessibilityRole="button" accessibilityLabel={t.archRead}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: space.md + 2, borderRadius: radius.md + 2,
            backgroundColor: p.brand }, pressed && { opacity: 0.85 }]}>
          <Txt size="small" weight="medium" style={{ color: p.onBrand }}>{t.archRead}</Txt>
          <Icon name="arrow-out" size={14} color={p.onBrand} />
        </Pressable>
      </View>

      {/* The family's albums (from a WhatsApp import), and the way to make one. */}
      {!!detail && !q.trim() && <AlbumsSection circle={detail} refreshKey={albumsKey} />}
      {manager && !q.trim() && (
        <Pressable onPress={() => setImporting(true)} accessibilityRole="button" accessibilityLabel={t.importButton}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, height: 46, borderRadius: radius.md + 2,
            borderWidth: 1, borderColor: p.line, backgroundColor: pressed ? p.greenSoft : p.card }]}>
          <Icon name="upload" size={18} color={p.green} />
          <Txt size="small" weight="medium" color="green">{t.importButton}</Txt>
        </Pressable>
      )}

      <Field icon="search" value={q} onChange={setQ} placeholder={t.searchArchive} returnKeyType="search" />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.paper }}>
      <FlatList
        data={rows} keyExtractor={e => String(e.id)} ListHeaderComponent={header}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.green} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={list === null ? <TimelineSkeleton rows={3} /> : (
          <View style={{ borderRadius: 24, borderWidth: 1, borderStyle: 'dashed', borderColor: p.line, backgroundColor: p.card }}>
            <EmptyState art icon="archive" title={q.trim() ? t.chatNoMatch : t.archEmptyTitle}
              body={q.trim() ? undefined : detail?.agentActive ? t.emptyArchive : t.archiveAgentOff} />
          </View>
        )}
        renderItem={({ item: e, index }) => {
          const m = monthOf(e.eventDate);
          const first = index === 0 || monthOf(rows[index - 1].eventDate) !== m;
          const last = index === rows.length - 1 || monthOf(rows[index + 1].eventDate) !== m;
          // The summary is "Author: what was said"; show the words once and the author quietly below.
          const split = /^([^:：]{1,40})[:：]\s*([\s\S]+)$/.exec(e.summary || e.title || '');
          const author = split?.[1] ?? '';
          const text = split?.[2] ?? (e.summary || e.title);
          const d = new Date(`${String(e.eventDate).slice(0, 10)}T00:00:00`);
          const when = Number.isNaN(d.getTime()) ? e.eventDate : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
          return (
            <FadeIn delay={Math.min(index, 8) * 40}>
              {first && <Eyebrow color="goldDark" style={{ marginBottom: space.sm, marginTop: index ? space.md : 0 }}>{m}</Eyebrow>}
              {/* Same timeline as Memory: one unbroken gold line, a dot level with each label. */}
              <View style={{ flexDirection: 'row', gap: space.md, paddingBottom: last ? 0 : space.md }}>
                <View style={{ width: 14 }}>
                  <View style={{ position: 'absolute', left: 6, width: 2, backgroundColor: '#c79a3b59', top: first ? 26 : 0, ...(last ? { height: first ? 0 : 26 } : { bottom: -space.md }) }} />
                  <View style={{ position: 'absolute', left: 1, top: 20, width: 12, height: 12, borderRadius: 6, backgroundColor: p.gold, borderWidth: 2, borderColor: p.paper }} />
                </View>
                <Pressable onLongPress={manager && !e.protected ? () => remove(e) : undefined} delayLongPress={400}
                  style={[{ flex: 1, backgroundColor: p.card, borderRadius: radius.lg + 2, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, padding: space.md + 2, gap: space.sm }, elevation(p, 1)]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 }}>
                    {!!e.category && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, height: 24, borderRadius: 12, backgroundColor: p.greenSoft }}>
                        <Icon name={CAT_ICON[e.category] ?? 'sparkle'} size={13} color={p.green} />
                        <Txt size="caption" weight="heavy" color="green">{t.cat[e.category] ?? e.category}</Txt>
                      </View>
                    )}
                    {!!e.pending && <Badge tone="warn">{t.pending}</Badge>}
                    {e.source === 'manual' && <Badge tone="neutral">{t.manual}</Badge>}
                    <View style={{ flex: 1 }} />
                    <Muted style={{ fontSize: 12 }}>{when}</Muted>
                    {manager && !e.protected && (
                      <Pressable onPress={() => remove(e)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.removeFromArchive}
                        style={({ pressed }) => [{ width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginEnd: -6 }, pressed && { backgroundColor: p.dangerSoft }]}>
                        <Icon name="trash" size={15} color={p.muted} />
                      </Pressable>
                    )}
                  </View>
                  <Txt weight="medium" style={{ lineHeight: 23, writingDirection: 'auto' }}>{text}</Txt>
                  {!!e.media?.length && (
                    <View style={{ flexDirection: 'row', gap: space.xs }}>
                      {e.media.slice(0, 4).map(md => (
                        <Image key={md.id} source={mediaSource(`/api/album-items/${md.id}/file`)} style={{ width: 64, height: 64, borderRadius: radius.md, backgroundColor: p.line }} />
                      ))}
                    </View>
                  )}
                  {!!author && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Avatar name={author} size={18} />
                      <Muted numberOfLines={1} style={{ fontSize: 12 }}>{author}</Muted>
                    </View>
                  )}
                </Pressable>
              </View>
            </FadeIn>
          );
        }}
      />
      {!!detail && <ImportScreen circle={detail} open={importing} onClose={() => setImporting(false)} onDone={() => { setAlbumsKey(k => k + 1); void load(); }} />}
      <Picker open={yearOpen} onClose={() => setYearOpen(false)} title={t.bookYear} value={year} columns={3}
        options={years.map(y => ({ value: y, label: String(y) }))} onPick={setYear} />
    </View>
  );
}
