import { memo, useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { mediaSource, openFile, type Member, type Msg } from './api';
import { locale, t } from './i18n';
import { Icon } from './icons';
import { colorOf, elevation, font, radius, space, usePalette, type Palette } from './theme';

export const toDate = (iso: string) => new Date(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z');
const hhmm = (iso: string) => { const d = toDate(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); };
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A voice message: a round play button, a waveform that fills as it plays, and the length. */
function Voice({ id, ms, mine, p }: { id: number; ms: number | null | undefined; mine: boolean; p: Palette }) {
  // Ten position reports a second (the default is two), and the fill glides between them.
  const player = useAudioPlayer(mediaSource(`/api/messages/${id}/audio`), { updateInterval: 100 });
  const st = useAudioPlayerStatus(player);
  const total = (st.duration ? st.duration * 1000 : 0) || ms || 0;
  const pos = (st.currentTime ?? 0) * 1000;
  const done = total ? Math.min(1, pos / total) : 0;
  const fill = useRef(new Animated.Value(0)).current;
  const [w, setW] = useState(0);
  useEffect(() => {
    // Linear over one report interval: by the time the next position arrives, the fill is there.
    Animated.timing(fill, { toValue: done, duration: st.playing ? 110 : 160, easing: Easing.linear, useNativeDriver: false }).start();
  }, [done, st.playing, fill]);
  useEffect(() => { if (st.didJustFinish) { player.seekTo(0); player.pause(); } }, [st.didJustFinish, player]);
  // A stable pseudo-waveform per message: the real audio peaks are not sent to the phone.
  const bars = Array.from({ length: 28 }, (_, i) => 0.3 + Math.abs(Math.sin((id + 1) * (i + 3) * 0.7)) * 0.7);
  const wave = (color: string, opacity: number) => (
    <View style={{ width: w, height: 28, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      {bars.map((h, i) => <View key={i} style={{ flex: 1, height: `${h * 100}%`, borderRadius: 2, backgroundColor: color, opacity }} />)}
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minWidth: 200, paddingVertical: 2 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={st.playing ? 'pause' : t.voice}
        onPress={() => (st.playing ? player.pause() : player.play())}
        style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: mine ? p.brand : p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={st.playing ? 'pause' : 'play'} size={18} color={mine ? p.onBrand : p.green} />
      </Pressable>
      {/* The waveform twice: muted underneath, green on top revealed by an animated mask. */}
      <View style={{ flex: 1, height: 28 }} onLayout={e => setW(e.nativeEvent.layout.width)}>
        {w > 0 && wave(p.muted, 0.35)}
        {w > 0 && (
          <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, overflow: 'hidden',
            width: fill.interpolate({ inputRange: [0, 1], outputRange: [0, w] }) }}>
            {wave(p.green, 1)}
          </Animated.View>
        )}
      </View>
      <Text style={{ fontSize: 11, fontFamily: font.regular, color: p.muted, fontVariant: ['tabular-nums'], minWidth: 30, textAlign: 'right' }}>{mmss(st.playing || pos > 0 ? pos : total)}</Text>
    </View>
  );
}

/**
 * Ticks the way the web draws them: one tick sent, two delivered to every other member,
 * two in the brand colour once every other member has read it. Worked out from each
 * member's delivered/read position, the same numbers the web uses.
 */
function Ticks({ msg, members, meId, p }: { msg: Msg; members: Member[]; meId: number; p: Palette }) {
  const others = members.filter(m => m.id !== meId);
  const seq = msg.seq ?? Infinity;
  const read = others.length > 0 && others.every(m => (m.readSeq ?? 0) >= seq);
  const delivered = others.length > 0 && others.every(m => m.deliveredSeq >= seq);
  return <Icon name={delivered || read ? 'check-double' : 'check'} size={15} color={read ? '#0b7fb3' : p.muted} label={read ? 'read' : delivered ? 'delivered' : 'sent'} />;
}

/**
 * One message.
 *
 * Consecutive messages from the same person within five minutes are one block: only the
 * first carries the name and only the last carries a tail, which is what makes a chat read
 * as speech rather than as a list of rows.
 */
export const Bubble = memo(function Bubble(
  { msg, mine, showAuthor, lastOfBlock, members, meId, isGroup, dark, p, onLongPress, onOpenArchive }:
  {
    msg: Msg; mine: boolean; showAuthor: boolean; lastOfBlock: boolean; members: Member[]; meId: number;
    isGroup: boolean; dark: boolean; p: Palette; onLongPress: (m: Msg) => void; onOpenArchive?: () => void;
  },
) {
  const { width } = useWindowDimensions();
  const maxW = Math.min(width * 0.8, 420);
  // Start/End, not Left/Right, so the tail follows the speaker's side in right-to-left languages too.
  const tail = lastOfBlock ? (mine ? { borderBottomEndRadius: 6 } : { borderBottomStartRadius: 6 }) : null;
  const images = msg.attachments?.filter(a => a.kind !== 'file') ?? [];
  const files = msg.attachments?.filter(a => a.kind === 'file') ?? [];
  // Reactions arrive one per person; shown grouped, with mine outlined.
  const grouped = Object.values((msg.reactions ?? []).reduce<Record<string, { e: string; n: number; mine: boolean }>>((acc, r) => {
    (acc[r.e] ??= { e: r.e, n: 0, mine: false }).n++;
    if (r.u === meId) acc[r.e].mine = true;
    return acc;
  }, {}));
  const flush = images.length > 0 && !msg.replyTo && !(showAuthor && !mine && isGroup);

  return (
    <Pressable onLongPress={() => onLongPress(msg)} delayLongPress={280} accessibilityRole="button" accessibilityHint="long press for options"
      style={({ pressed }) => [{ maxWidth: maxW, alignSelf: mine ? 'flex-end' : 'flex-start', marginBottom: lastOfBlock ? space.sm + 2 : 3 }, pressed && { opacity: 0.88 }]}>
      <View style={[
        { borderRadius: 18, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 6, borderWidth: StyleSheet.hairlineWidth,
          backgroundColor: mine ? p.mine : p.other, borderColor: mine ? p.mineEdge : p.otherEdge, overflow: 'hidden' },
        flush && { paddingHorizontal: 4, paddingTop: 4 },
        tail, elevation(p, 1),
      ]}>
        {showAuthor && !mine && isGroup && (
          <Text style={{ fontSize: 13, fontFamily: font.heavy, marginBottom: 2, color: colorOf(msg.userId, dark) }}>{msg.author}</Text>
        )}

        {/* What this answers: a coloured bar and a one-line quote. */}
        {!!msg.replyTo && (
          <View style={{ borderStartWidth: 3, borderStartColor: p.green, paddingHorizontal: space.sm, paddingVertical: 4, marginBottom: 6, backgroundColor: mine ? '#0000000d' : p.greenSoft, borderRadius: radius.sm }}>
            <Text numberOfLines={1} style={{ fontSize: 12, fontFamily: font.heavy, color: p.green }}>{msg.replyTo.author ?? ''}</Text>
            <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: font.regular, color: p.muted }}>
              {msg.replyTo.kind === 'voice' ? t.voice : msg.replyTo.text || t.photo}
            </Text>
          </View>
        )}

        {/* Photos at full size: the 320px thumbnail is visibly soft at bubble width on a phone screen. */}
        {images.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginBottom: msg.body ? 6 : 2 }}>
            {images.map(a => (
              <View key={a.id} style={{ width: images.length > 1 ? (maxW - 14) / 2 : maxW - 10, borderRadius: 14, overflow: 'hidden', backgroundColor: p.line }}>
                <Image source={mediaSource(`/api/media/${a.kind === 'video' ? (a.thumb ?? a.id) : a.id}`)} accessibilityLabel={a.name ?? t.photo}
                  style={{ width: '100%', aspectRatio: a.w && a.h ? Math.max(0.6, Math.min(1.8, a.w / a.h)) : 4 / 3 }} resizeMode="cover" />
                {a.kind === 'video' && (
                  <View style={{ position: 'absolute', alignSelf: 'center', top: '42%', width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="play" size={20} color="#fff" />
                  </View>
                )}
              </View>
            ))}
          </View>
        )}
        {files.map(f => (
          // A document: tap to open it (downloaded once, then iOS's share sheet: Quick Look, Files…).
          <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={f.name ?? t.attachFile}
            onPress={() => { openFile(f.id, f.name ?? t.attachFile).catch(e => { console.warn('[file]', (e as Error)?.message); Alert.alert(t.failed); }); }}
            style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: mine ? '#0000000d' : p.paper, marginBottom: 4, minWidth: 200 }, pressed && { opacity: 0.7 }]}>
            <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="file" size={20} color={p.green} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 14, fontFamily: font.medium, color: p.ink }}>{f.name ?? t.attachFile}</Text>
              <Text style={{ fontSize: 11, fontFamily: font.regular, color: p.muted }}>{(f.name?.split('.').pop() ?? '').toUpperCase() || t.attachFile}</Text>
            </View>
            <Icon name="down" size={18} color={p.muted} />
          </Pressable>
        ))}

        <View style={flush ? { paddingHorizontal: 8 } : undefined}>
          {msg.kind === 'voice'
            ? <Voice id={msg.id} ms={msg.audioMs} mine={mine} p={p} />
            : !!msg.body && <Text style={{ fontSize: 16, fontFamily: font.regular, color: p.ink, lineHeight: 23, writingDirection: 'auto' }}>{msg.body}</Text>}
          {msg.kind === 'voice' && !!msg.transcript && <Text style={{ fontSize: 13, fontFamily: font.regular, color: p.muted, marginTop: 4 }}>{msg.transcript}</Text>}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: msg.archiveStatus === 'archived' ? 'stretch' : 'flex-end', marginTop: 4 }}>
            {/* The agent kept this one: a small gold tag beside the time, the way to it in the archive. */}
            {msg.archiveStatus === 'archived' && (
              <>
                <Pressable onPress={onOpenArchive} accessibilityRole="button" accessibilityLabel={t.archivedBadge} hitSlop={8}
                  style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingHorizontal: 8, borderRadius: 11,
                    backgroundColor: '#c79a3b26' }, pressed && { opacity: 0.7 }]}>
                  <Icon name="sparkle" size={11} color={p.goldDark} />
                  <Text style={{ fontSize: 11, fontFamily: font.bold, color: p.goldDark }}>{t.archivedBadge}</Text>
                </Pressable>
                <View style={{ flex: 1, minWidth: space.md }} />
              </>
            )}
            {msg.starred && <Icon name="star-fill" size={11} color={p.goldDark} />}
            {!!msg.editedAt && <Text style={{ fontSize: 11, fontFamily: font.regular, color: p.muted }}>{t.edited}</Text>}
            <Text style={{ fontSize: 11, fontFamily: font.regular, color: p.muted }}>{hhmm(msg.createdAt)}</Text>
            {mine && <Ticks msg={msg} members={members} meId={meId} p={p} />}
          </View>
        </View>

      </View>

      {/* Reactions hang under the bubble, the way WhatsApp places them. */}
      {grouped.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 4, marginTop: -6, paddingHorizontal: 8, alignSelf: mine ? 'flex-end' : 'flex-start' }}>
          {grouped.map(r => (
            <View key={r.e} style={[{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill,
              backgroundColor: p.card, borderWidth: 1, borderColor: r.mine ? p.green : p.line }, elevation(p, 1)]}>
              <Text style={{ fontSize: 13 }}>{r.e}</Text>
              {r.n > 1 && <Text style={{ fontSize: 11, fontFamily: font.medium, color: p.muted }}>{r.n}</Text>}
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
});

/** The date a run of messages belongs to: Today, Yesterday, or the date itself. */
export function DayDivider({ iso, p }: { iso: string; p: Palette }) {
  const d = toDate(iso);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  const yest = new Date(now.getTime() - 86400_000);
  const label = day(d) === day(now) ? t.today : day(d) === day(yest) ? t.yesterday
    : d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return (
    <View style={[{ alignSelf: 'center', paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: p.card,
      borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, marginVertical: space.md }, elevation(p, 1)]}>
      <Text style={{ fontSize: 11, fontFamily: font.medium, color: p.muted }}>{label}</Text>
    </View>
  );
}

/**
 * A system line (the agent was switched on, someone joined): a small, flat, centred notice the
 * way phone chats show them — a soft tint, the agent's spark inline before the words.
 */
export function SystemNote({ text, p }: { text: string; p: Palette }) {
  return (
    <View style={{ alignSelf: 'center', maxWidth: '82%', flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 12, paddingVertical: 7,
      borderRadius: 12, backgroundColor: '#c79a3b1f', marginVertical: space.sm }}>
      <View style={{ paddingTop: 2 }}><Icon name="sparkle" size={13} color={p.goldDark} /></View>
      <Text style={{ flexShrink: 1, fontSize: 12.5, lineHeight: 18, fontFamily: font.medium, color: p.goldDark, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

