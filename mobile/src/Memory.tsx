import { useCallback, useEffect, useState } from 'react';
import { Animated, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Notices } from './Notices';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type Chat } from './api';
import { locale, t } from './i18n';
import { AppHeader, Avatar, Card, Eyebrow, FadeIn, HeroArt, IconTile, TimelineSkeleton, Muted, Press, Txt } from './ui';
import { FORWARD, Icon, type IconName } from './icons';
import { elevation, radius, space, usePalette, NATIVE_DRIVER } from './theme';

export interface Entry {
  id: number; title: string; summary: string; category: string | null;
  eventDate: string; kind: string; circleId: number; circleName: string;
}

const monthOf = (iso: string) => {
  const d = new Date(`${String(iso).slice(0, 7)}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
};

/**
 * Memory: everything the agent documented, across every family circle — the reason the
 * product exists. The web's page, laid out for a phone: the timeline by month, then a card
 * per circle that opens its archive.
 */
export function Memory({ onOpenCircle }: { onOpenCircle?: (c: Chat) => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const [list, setList] = useState<Entry[] | null>(null);
  const [circles, setCircles] = useState<Chat[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setList(await api<Entry[]>('/me/memory')); } catch { setList(l => l ?? []); }
    api<Chat[]>('/circles').then(l => setCircles(l.filter(c => c.kind === 'circle'))).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Grouped by month, newest first, as the server sends them.
  const groups = (list ?? []).reduce<Array<[string, Entry[]]>>((acc, e) => {
    const k = monthOf(e.eventDate); const last = acc[acc.length - 1];
    if (last && last[0] === k) last[1].push(e); else acc.push([k, [e]]);
    return acc;
  }, []);
  const open = (id: number) => { const c = circles.find(x => x.id === id); if (c) onOpenCircle?.({ ...c, openArchive: true }); };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.paper }}
      contentContainerStyle={{ paddingTop: inset.top + space.sm, paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.green} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>

      <AppHeader eyebrow={t.memEyebrow} title={t.memoryTitle} sub={t.memoryIntro} />
      <Notices />

      {/* At a glance: how much the family has kept so far. */}
      {!!list?.length && (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Summary entries={list} />
        </View>
      )}

      {list === null ? <TimelineSkeleton rows={3} /> : groups.length === 0 ? (
        <MemoryEmpty noCircles={circles.length === 0} />
      ) : groups.map(([month, entries], gi) => (
        <View key={month}>
          <Eyebrow color="goldDark" style={{ marginBottom: space.sm }}>{month}</Eyebrow>
          {entries.map((e, i) => (
            <FadeIn key={`${e.circleId}-${e.id}`} delay={Math.min(gi * 3 + i, 10) * 40}>
              <Moment e={e} first={i === 0} last={i === entries.length - 1} onPress={() => open(e.circleId)} />
            </FadeIn>
          ))}
        </View>
      ))}

      {circles.length > 0 && (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <Eyebrow>{t.memoryCircles}</Eyebrow>
          {circles.map((c, i) => (
            <FadeIn key={c.id} delay={i * 50}>
              <Press onPress={() => onOpenCircle?.({ ...c, openArchive: true })} scaleTo={0.98} label={c.name}
                style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.lg + 2, backgroundColor: p.card,
                  borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 1)]}>
                <Avatar name={c.name} kind="circle" size={42} />
                <View style={{ flex: 1 }}>
                  <Txt weight="medium" numberOfLines={1}>{c.name}</Txt>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <AgentDot on={!!c.agentActive} />
                    <Muted>{c.agentActive ? t.memAgentOnShort : t.memoryAgentOff}</Muted>
                  </View>
                </View>
                <Txt size="small" weight="medium" color="green">{t.openArchive}</Txt>
              </Press>
            </FadeIn>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const CAT_ICON: Record<string, IconName> = {
  birth: 'heart', marriage: 'heart', graduation: 'star', achievement: 'star', travel: 'globe',
  health: 'shield', passing: 'memory', family_news: 'chats', other: 'sparkle',
};

/** The summary often repeats the title with the author in front ("Rizwan: …"); then it says nothing new. */
const sameText = (title: string, summary: string) => {
  const strip = (x: string) => x.replace(/^[^:：]{1,40}[:：]\s*/, '').replace(/[.…\s]+$/g, '').trim().toLowerCase();
  const a = strip(title), b = strip(summary);
  return !b || a === b || b.startsWith(a.replace(/…$/, '')) || a.startsWith(b);
};

/** One documented moment on the timeline: a gold dot on the rail, then the card. */
function Moment({ e, first, last, onPress }: { e: Entry; first: boolean; last: boolean; onPress: () => void }) {
  const p = usePalette();
  const d = new Date(`${String(e.eventDate).slice(0, 10)}T00:00:00`);
  const when = Number.isNaN(d.getTime()) ? e.eventDate : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  // The server shortens titles; the summary usually holds the whole sentence after "Author: ".
  // Show the fuller of the two once, and the summary as a second line only when it adds something.
  const full = (e.summary ?? '').replace(/^[^:：]{1,40}[:：]\s*/, '').trim();
  const main = full.length > e.title.replace(/…$/, '').length && sameText(e.title, e.summary ?? '') ? full : e.title.replace(/…$/, '');
  const extra = !sameText(e.title, e.summary ?? '');
  return (
    // The gap to the next moment is this row's paddingBottom; the line reaches down through it
    // (bottom: -gap) to meet the next row's line, so the rail runs unbroken from dot to dot.
    <View style={{ flexDirection: 'row', gap: space.md, paddingBottom: last ? 0 : space.md }}>
      {/* The rail: one continuous gold line through a dot per moment. The dot sits level with
          the card's category label (card padding 14 + half the 24pt label = 26, minus half the dot). */}
      <View style={{ width: 14 }}>
        <View style={{ position: 'absolute', left: 6, width: 2, backgroundColor: '#c79a3b59', top: first ? 26 : 0, ...(last ? { height: first ? 0 : 26 } : { bottom: -space.md }) }} />
        <View style={{ position: 'absolute', left: 1, top: 20, width: 12, height: 12, borderRadius: 6, backgroundColor: p.gold, borderWidth: 2, borderColor: p.paper }} />
      </View>
      <Press onPress={onPress} scaleTo={0.98} label={e.title}
        style={[{ flex: 1, padding: space.md + 2, borderRadius: radius.lg + 2, backgroundColor: p.card,
          borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, gap: space.sm }, elevation(p, 1)]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          {!!e.category && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, height: 24, borderRadius: 12, backgroundColor: p.greenSoft }}>
              <Icon name={CAT_ICON[e.category] ?? 'sparkle'} size={13} color={p.green} />
              <Txt size="caption" weight="heavy" color="green">{t.cat[e.category] ?? e.category}</Txt>
            </View>
          )}
          <View style={{ flex: 1 }} />
          <Muted style={{ fontSize: 12 }}>{when}</Muted>
        </View>
        <Txt weight="medium" numberOfLines={4} style={{ lineHeight: 23, writingDirection: 'auto' }}>{main}</Txt>
        {extra && <Muted numberOfLines={2} style={{ writingDirection: 'auto' }}>{e.summary}</Muted>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Avatar name={e.circleName} kind="direct" size={18} />
          <Muted numberOfLines={1} style={{ fontSize: 12, flex: 1 }}>{e.circleName}</Muted>
          <Icon name="chevron" size={14} color={p.muted} rotate={FORWARD} />
        </View>
      </Press>
    </View>
  );
}

/**
 * The family's memory at a glance: how many moments are kept, since when, and of what kind.
 * A brand card so it reads as the page's headline, not as one more list item.
 */
export function Summary({ entries }: { entries: Array<{ category: string | null; eventDate: string }> }) {
  const p = usePalette();
  const byCat = Object.entries(entries.reduce<Record<string, number>>((acc, e) => { const c = e.category ?? 'other'; acc[c] = (acc[c] ?? 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1]);
  const oldest = entries.reduce((m, e) => (e.eventDate < m ? e.eventDate : m), entries[0]?.eventDate ?? '');
  const since = oldest ? new Date(`${oldest.slice(0, 10)}T00:00:00`).toLocaleDateString(locale(), { month: 'short', year: 'numeric' }) : '';
  return (
    <View style={[{ borderRadius: radius.lg + 4, backgroundColor: p.brand, padding: space.lg, gap: space.md, overflow: 'hidden' }, elevation(p, 2)]}>
      {/* A soft gold glow in the corner, the brand's accent. */}
      <View pointerEvents="none" style={{ position: 'absolute', right: -60, top: -70, width: 200, height: 200, borderRadius: 100, backgroundColor: '#c79a3b', opacity: 0.1 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Txt weight="heavy" style={{ color: '#ffffff', fontSize: 40, lineHeight: 44, letterSpacing: -1 }}>{entries.length}</Txt>
        <View style={{ flex: 1 }}>
          <Txt weight="medium" style={{ color: '#ffffff' }}>{t.archEntries}</Txt>
          {!!since && <Txt size="small" style={{ color: '#ffffffb3' }}>{since} →</Txt>}
        </View>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#ffffff1f', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="sparkle" size={22} color="#f0d9a0" />
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {byCat.map(([c, n]) => (
          <View key={c} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: '#ffffff1f' }}>
            <Icon name={CAT_ICON[c] ?? 'sparkle'} size={13} color="#ffffff" />
            <Txt size="caption" weight="medium" style={{ color: '#ffffff' }}>{t.cat[c] ?? c}</Txt>
            <Txt size="caption" weight="heavy" style={{ color: '#f0d9a0' }}>{n}</Txt>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A dot that breathes while the agent is documenting, and sits still and grey when it is off. */
function AgentDot({ on }: { on: boolean }) {
  const p = usePalette();
  const [v] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!on) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.35, duration: 900, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(v, { toValue: 1, duration: 900, useNativeDriver: NATIVE_DRIVER }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [on, v]);
  return <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: on ? p.brand : p.line, opacity: on ? v : 1 }} />;
}

/** Nothing documented yet: what this page will hold, and the three steps that fill it. */
function MemoryEmpty({ noCircles }: { noCircles: boolean }) {
  const p = usePalette();
  const steps = [t.memStep1, t.memStep2, t.memStep3];
  return (
    <Card style={{ alignItems: 'center', gap: space.lg, paddingVertical: space.xl }}>
      <HeroArt icon="memory" size={0.9} />
      <FadeIn delay={80} style={{ alignItems: 'center', gap: space.sm }}>
        <Txt size="title" weight="medium" style={{ textAlign: 'center' }}>{t.memEmptyTitle}</Txt>
        <Muted style={{ textAlign: 'center', lineHeight: 20 }}>{noCircles ? t.memoryEmptyBody : t.memoryNoEntries}</Muted>
      </FadeIn>
      <View style={{ alignSelf: 'stretch', gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line, paddingTop: space.lg }}>
        <Eyebrow>{t.memHowTitle}</Eyebrow>
        {steps.map((s, i) => (
          <FadeIn key={i} delay={140 + i * 70} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md + 2, backgroundColor: p.paper }}>
            <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Txt size="small" weight="heavy" color="green">{i + 1}</Txt>
            </View>
            <Txt size="small" style={{ flex: 1 }}>{s}</Txt>
          </FadeIn>
        ))}
      </View>
    </Card>
  );
}

