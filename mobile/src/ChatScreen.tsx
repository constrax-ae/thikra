import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, avatarSource, type Chat, type CircleDetail, type Me, type Msg } from './api';
import { Bubble, DayDivider, SystemNote, toDate } from './Bubble';
import { ForwardSheet, MessageActions } from './MessageActions';
import { TodayBanner } from './CircleExtras';
import { AttachMenu, AttachTray, type Picked } from './Attach';
import { Recorder } from './Recorder';
import { Archive } from './Archive';
import { CircleSettings } from './CircleSettings';
import { live } from './live';
import { systemText, t } from './i18n';
import { Icon } from './icons';
import { Avatar, Badge, IconButton, MessagesSkeleton, Muted, Txt, ask } from './ui';
import { dur, elevation, font, radius, space, useIsDark, usePalette, type Palette, NATIVE_DRIVER } from './theme';

type Tab = 'chat' | 'archive' | 'settings';

// The last page seen of each chat, kept for this session: reopening a chat paints at once
// and is then brought up to date (the web does the same).
const pageCache = new Map<number, Msg[]>();
const detailCache = new Map<number, CircleDetail>();

export function ChatScreen({ chat, me, onBack, onSealed, onOpenChat }: { chat: Chat; me: Me; onBack: () => void; onSealed?: (circleId: number) => void; onOpenChat?: (c: Chat) => void }) {
  const p = usePalette();
  const dark = useIsDark();
  const inset = useSafeAreaInsets();
  const s = useMemo(() => styles(p), [p]);
  const [detail, setDetail] = useState<CircleDetail | null>(() => detailCache.get(chat.id) ?? null);
  const [msgs, setMsgs] = useState<Msg[]>(() => pageCache.get(chat.id) ?? []);
  const [loaded, setLoaded] = useState(() => pageCache.has(chat.id));
  const [text, setText] = useState('');
  const [acting, setActing] = useState<Msg | null>(null);   // the message a long press opened
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [recording, setRecording] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Msg[]>([]);
  const [failed, setFailed] = useState(false);
  const [pins, setPins] = useState<Msg[]>([]);
  const [pinIdx, setPinIdx] = useState(0);
  const [forwarding, setForwarding] = useState<Msg | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);   // the search panel's "Starred" view
  const [tab, setTab] = useState<Tab>(chat.openInvite ? 'settings' : chat.openArchive ? 'archive' : 'chat');
  const list = useRef<FlatList<Msg>>(null);
  const sending = useRef(false);
  const lastId = useRef(0);

  /** The pinned messages, newest first, as the web loads them. */
  const loadPins = useCallback(() => api<Msg[]>(`/circles/${chat.id}/pins`).then(l => { setPins(l); setPinIdx(0); }).catch(() => {}), [chat.id]);
  useEffect(() => { void loadPins(); }, [loadPins]);
  // Roles and members change without a live event (a transfer, a promotion on another phone):
  // opening Settings always shows the circle as it is now.
  useEffect(() => { if (tab === 'settings') void loadDetail(); }, [tab]);   // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = useCallback(() => api<CircleDetail>(`/circles/${chat.id}`).then(d => { detailCache.set(chat.id, d); setDetail(d); }).catch(() => {}), [chat.id]);

  /** Everything from the start: a reaction, an edit or a delete changes a message already on screen. */
  const reload = useCallback(async () => {
    try {
      const all = await api<Msg[]>(`/circles/${chat.id}/messages`);
      setMsgs(all); pageCache.set(chat.id, all);
      lastId.current = all.length ? Math.max(...all.map(m => m.id)) : 0;
      setFailed(false);
      const top = Math.max(0, ...all.map(m => m.seq ?? 0));
      if (top) api(`/circles/${chat.id}/read`, { body: { seq: top } }).catch(() => {});
    } catch { setFailed(true); }
    finally { setLoaded(true); }
  }, [chat.id]);

  useEffect(() => {
    loadDetail(); reload();
    // Live: a new or changed message, a receipt, or a reconnect brings the screen up to date; the poll is only the safety net.
    const off = live.on(f => {
      if (f.t === 'open') { reload(); return; }
      if (f.circle !== chat.id) return;
      if (f.t === 'receipt') loadDetail(); else { reload(); void loadPins(); }
    });
    const id = setInterval(reload, 12000);
    return () => { off(); clearInterval(id); };
  }, [reload, loadDetail, loadPins, chat.id]);

  // Search inside the chat, as the web's search panel does.
  useEffect(() => {
    if (searching && starredOnly) { api<Msg[]>(`/circles/${chat.id}/starred`).then(setResults).catch(() => setResults([])); return; }
    if (!searching || !query.trim()) { setResults([]); return; }
    const h = setTimeout(() => api<Msg[]>(`/circles/${chat.id}/search?q=${encodeURIComponent(query.trim())}`).then(setResults).catch(() => setResults([])), 250);
    return () => clearTimeout(h);
  }, [query, searching, starredOnly, chat.id]);

  const shown = useMemo(() => msgs.filter(m => !m.deleted), [msgs]);
  // Newest first for the inverted list: it opens at the latest message with no jump from the top.
  const rev = useMemo(() => [...shown].reverse(), [shown]);
  // A pinned message you deleted for yourself is not shown in the banner either.
  const visiblePins = useMemo(() => (loaded ? pins.filter(x => shown.some(m => m.id === x.id)) : pins), [pins, shown, loaded]);
  const members = detail?.members ?? [];
  const kind = detail?.kind ?? chat.kind;
  // A one-to-one chat: the other person, and whether you blocked them (the web's Block button).
  const other = kind === 'direct' ? detail?.members.find(m => m.id !== me.id) : undefined;
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!other) return;
    api<Array<{ id: number }>>('/me/blocks').then(l => setBlocked(l.some(x => x.id === other.id))).catch(() => {});
  }, [other?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function setBlock(on: boolean) {
    if (!other) return;
    setBlocked(on);
    try { await api(`/users/${other.id}/block`, { body: { on } }); } catch { setBlocked(!on); }
  }
  const toggleBlock = () => (blocked ? void setBlock(false) : ask(t.block, `${t.block} ${other?.name ?? ''}?`, t.block, t.cancel, () => { void setBlock(true); }));
  const tabs: Tab[] = kind === 'direct' ? ['chat'] : kind === 'group' ? ['chat', 'settings'] : ['chat', 'archive', 'settings'];

  async function send() {
    const body = text.trim();
    if (!body || sending.current) return;
    sending.current = true;
    const wasEditing = editing, wasReply = replyTo;
    setText(''); setEditing(null); setReplyTo(null);
    try {
      if (wasEditing) await api(`/messages/${wasEditing.id}`, { method: 'PATCH', body: { body } });
      else await api(`/circles/${chat.id}/messages`, { body: { body, client_msg_id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, reply_to: wasReply?.id ?? null } });
      await reload();
      setTimeout(() => list.current?.scrollToOffset({ offset: 0, animated: true }), 60);
    } catch { setText(body); setEditing(wasEditing); setReplyTo(wasReply); }
    finally { sending.current = false; }
  }

  const jumpTo = (id: number) => {
    setSearching(false); setQuery('');
    const index = rev.findIndex(m => m.id === id);
    if (index >= 0) setTimeout(() => list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 }), 80);
  };

  const subtitle = kind === 'direct' ? '' : members.length === 1 ? t.oneMember : `${members.length || chat.members || 1} ${t.members}`;
  const sameBlock = (a?: Msg, b?: Msg) =>
    !!a && !!b && a.kind !== 'system' && b.kind !== 'system' && a.userId === b.userId &&
    Math.abs(toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime()) < 5 * 60_000;
  const dayKey = (m?: Msg) => (m ? toDate(m.createdAt).toDateString() : '');

  return (
    <KeyboardAvoidingView style={s.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header: back, who this is, and what you can do here. */}
      <View style={[s.head, { paddingTop: inset.top + 4 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, minHeight: 56 }}>
          <IconButton name="arrow-back" label={t.back} onPress={onBack} />
          <Avatar name={detail?.name ?? chat.name} kind={kind} size={40} photo={other ? avatarSource(other.id, other.avatarAt) : undefined} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt size="bodyLg" weight="medium" numberOfLines={1}>{detail?.name ?? chat.name}</Txt>
            {!!subtitle && <Muted numberOfLines={1}>{subtitle}</Muted>}
          </View>
          {kind === 'circle' && !!detail?.agentActive && <View style={{ marginEnd: tab === 'chat' ? 0 : space.sm }}><Badge tone="warn">{t.agentDocumenting}</Badge></View>}
          {!!other && tab === 'chat' && <IconButton name="ban" label={blocked ? t.unblock : t.block} onPress={toggleBlock} active={blocked} />}
          {tab === 'chat' && <IconButton name={searching ? 'x' : 'search'} label={t.searchChats} onPress={() => { setSearching(v => !v); setQuery(''); setStarredOnly(false); }} active={searching} />}
        </View>
        {tabs.length > 1 && (
          <View style={{ flexDirection: 'row', paddingHorizontal: space.md }}>
            {tabs.map(k => (
              <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)}
                style={{ paddingHorizontal: space.md, paddingVertical: space.sm + 2, borderBottomWidth: 2.5, borderBottomColor: tab === k ? p.green : 'transparent' }}>
                <Txt weight={tab === k ? 'heavy' : 'medium'} color={tab === k ? 'green' : 'muted'}>
                  {k === 'chat' ? t.chatTab : k === 'archive' ? t.archiveTab : t.settingsTab}
                </Txt>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {tab === 'settings' ? (
        <CircleSettings chat={chat} detail={detail} me={me} reload={loadDetail} openInvite={chat.openInvite} onLeft={onBack} onOpenArchive={() => setTab('archive')} onSealed={onSealed ? () => onSealed(chat.id) : undefined} onOpenChat={onOpenChat} />
      ) : tab === 'archive' ? (
        <Archive chat={chat} detail={detail} />
      ) : (
        <>
          {searching && (
            <View style={{ backgroundColor: p.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.line, padding: space.md, gap: space.sm, maxHeight: 280 }}>
              <View style={s.searchBox}>
                <Icon name="search" size={18} color={p.muted} />
                <TextInput autoFocus={!starredOnly} value={query} onChangeText={v => { setQuery(v); if (v) setStarredOnly(false); }} placeholder={t.searchChats} placeholderTextColor={p.muted}
                  style={{ flex: 1, fontSize: 15, fontFamily: font.regular, color: p.ink, paddingVertical: 8 }} returnKeyType="search" />
              </View>
              {/* The web's "Starred" view: every message you starred in this chat. */}
              <Pressable onPress={() => { setStarredOnly(v => !v); setQuery(''); }} accessibilityRole="button" accessibilityState={{ selected: starredOnly }}
                style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16,
                  backgroundColor: starredOnly ? p.brand : p.greenSoft }}>
                <Icon name={starredOnly ? 'star-fill' : 'star'} size={14} color={starredOnly ? p.onBrand : p.green} />
                <Txt size="small" weight="medium" style={{ color: starredOnly ? p.onBrand : p.green }}>{t.starred}</Txt>
              </Pressable>
              <FlatList data={results} keyExtractor={m => `r${m.id}`} keyboardShouldPersistTaps="handled"
                ListEmptyComponent={starredOnly ? <Muted style={{ textAlign: 'center', padding: space.sm }}>{t.starredNone}</Muted>
                  : query.trim() ? <Muted style={{ textAlign: 'center', padding: space.sm }}>{t.chatNoMatch}</Muted> : undefined}
                renderItem={({ item: m }) => (
                  <Pressable onPress={() => jumpTo(m.id)} style={({ pressed }) => [{ padding: space.sm, borderRadius: radius.md }, pressed && { backgroundColor: p.greenSoft }]}>
                    <Muted>{m.author} · {toDate(m.createdAt).toLocaleDateString()}</Muted>
                    <Txt size="small" numberOfLines={2}>{m.body || m.transcript}</Txt>
                  </Pressable>
                )} />
            </View>
          )}

          {kind === 'circle' && <TodayBanner circleId={chat.id} onOpenArchive={() => setTab('archive')} />}
          {/* The pinned message on top, as the web shows it: tap to go to it, and to the next one. */}
          {visiblePins.length > 0 && (() => {
            const pm = visiblePins[Math.min(pinIdx, visiblePins.length - 1)];
            return (
              <Pressable onPress={() => { jumpTo(pm.id); setPinIdx(i => (i + 1) % visiblePins.length); }} accessibilityRole="button" accessibilityLabel={t.pinnedLabel}
                style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm,
                  backgroundColor: p.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.line }, pressed && { backgroundColor: p.greenSoft }]}>
                <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: p.gold }} />
                <Icon name="pin" size={16} color={p.goldDark} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt size="caption" weight="heavy" style={{ color: p.goldDark }}>{t.pinnedLabel}{visiblePins.length > 1 ? ` ${Math.min(pinIdx, visiblePins.length - 1) + 1}/${visiblePins.length}` : ''}</Txt>
                  <Txt size="small" numberOfLines={1}>{pm.kind === 'voice' ? t.voice : pm.body || pm.transcript || '📎'}</Txt>
                </View>
              </Pressable>
            );
          })()}

          <View style={{ flex: 1, backgroundColor: p.wall }}>
            {!loaded && shown.length === 0 ? <MessagesSkeleton /> : (
              <FlatList
                ref={list} data={rev} keyExtractor={m => String(m.id)} inverted
                onScrollToIndexFailed={e => setTimeout(() => list.current?.scrollToOffset({ offset: e.averageItemLength * e.index, animated: true }), 50)}
                contentContainerStyle={{ padding: space.md, paddingTop: space.lg, flexGrow: 1 }}
                keyboardDismissMode="interactive"
                ListEmptyComponent={
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl, paddingVertical: 80 }}>
                    <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="chats" size={28} color={p.green} /></View>
                    <Txt weight="medium" color="green">{t.chatEmptyTitle}</Txt>
                    <Muted style={{ textAlign: 'center' }}>{t.chatEmptyBody}</Muted>
                    {kind === 'circle' && <Muted style={{ textAlign: 'center', fontSize: 12 }}>{t.chatEmptyCircle}</Muted>}
                  </View>
                }
                renderItem={({ item: m, index }) => {
                  // The list is newest-first: the message before this one in time is the next item.
                  const prev = rev[index + 1], next = rev[index - 1];
                  const newDay = dayKey(prev) !== dayKey(m);
                  if (m.kind === 'system') return <View>{newDay && <DayDivider iso={m.createdAt} p={p} />}<SystemNote text={systemText(m.body)} p={p} /></View>;
                  // One View per row: the inverted list reverses loose siblings, which put each
                  // day's label under its first message instead of above it.
                  return (
                    <View>
                      {newDay && <DayDivider iso={m.createdAt} p={p} />}
                      <Bubble
                        msg={m} mine={m.userId === me.id} dark={dark} p={p} meId={me.id} members={members}
                        showAuthor={newDay || !sameBlock(prev, m)} lastOfBlock={!sameBlock(m, next) || dayKey(next) !== dayKey(m)}
                        isGroup={kind !== 'direct'} onLongPress={setActing}
                        onOpenArchive={kind === 'circle' ? () => setTab('archive') : undefined}
                      />
                    </View>
                  );
                }}
              />
            )}
            {failed && <Txt size="small" color="danger" style={{ position: 'absolute', top: 8, alignSelf: 'center' }}>{t.offline}</Txt>}
          </View>

          {/* What you are answering, or the message you are fixing, sits above the box. */}
          {(replyTo || editing) && (
            <View style={s.context}>
              <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: p.green }} />
              <Icon name={editing ? 'pen' : 'forward'} size={18} color={p.green} />
              <View style={{ flex: 1 }}>
                <Txt size="caption" weight="heavy" color="green">{editing ? t.edit : `${t.replyingTo} ${replyTo?.author ?? ''}`}</Txt>
                <Muted numberOfLines={1}>{(editing ?? replyTo)?.body || t.photo}</Muted>
              </View>
              <IconButton name="x" label={t.cancel} size={36} onPress={() => { setReplyTo(null); setEditing(null); if (editing) setText(''); }} />
            </View>
          )}

          {/* Blocked: say so where you would type, with the way back. */}
          {blocked && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: p.dangerSoft }}>
              <Icon name="ban" size={16} color={p.danger} />
              <Txt size="small" color="danger" style={{ flex: 1 }}>{t.errors.blocked}</Txt>
              <Pressable onPress={() => { void setBlock(false); }} accessibilityRole="button" hitSlop={8}>
                <Txt size="small" weight="heavy" color="danger">{t.unblock}</Txt>
              </Pressable>
            </View>
          )}
          <View style={[s.bar, { paddingBottom: Math.max(inset.bottom, space.sm) }]}>
            {recording ? (
              <Recorder circleId={chat.id} onSent={() => { setRecording(false); void reload(); }} onCancel={() => setRecording(false)} />
            ) : (
              <>
                {/* One pill holding attach, the text and the mic, with a round send button
                    beside it: the shape people already know from every chat app. */}
                <View style={s.pill}>
                  <IconButton name="attach" label={t.attachPhoto} size={40} onPress={() => setAttachOpen(true)} />
                  <TextInput style={s.input} value={text} onChangeText={setText} placeholder={t.write} placeholderTextColor={p.muted} multiline maxLength={4000} />
                </View>
                <SendButton active={!!text.trim()} onPress={() => (text.trim() ? send() : setRecording(true))} />
              </>
            )}
          </View>
        </>
      )}

      <AttachMenu open={attachOpen} onClose={() => setAttachOpen(false)} onPick={setPicked} />
      <AttachTray circleId={chat.id} items={picked} replyTo={replyTo?.id}
        onClose={() => setPicked([])} onSent={() => { setPicked([]); setReplyTo(null); void reload(); }} />
      <MessageActions
        msg={acting} mine={acting?.userId === me.id} meId={me.id} kind={kind} pinned={!!acting && pins.some(x => x.id === acting.id)}
        onClose={() => setActing(null)} onReply={setReplyTo} onEdit={m => { setEditing(m); setText(m.body); }} onChanged={reload}
        onForward={setForwarding} onPinsChanged={() => { void loadPins(); }}
      />
      <ForwardSheet msg={forwarding} onClose={() => setForwarding(null)} />
    </KeyboardAvoidingView>
  );
}

/** Round send button that fills with the brand colour once there is something to send. */
function SendButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  const p = usePalette();
  const v = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => { Animated.timing(v, { toValue: active ? 1 : 0, duration: dur.quick, useNativeDriver: NATIVE_DRIVER }).start(); }, [active, v]);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={active ? t.send : t.voice}
      style={({ pressed }) => [{ width: 48, height: 48, borderRadius: 24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: p.greenSoft },
        elevation(p, active ? 2 : 1), pressed && { transform: [{ scale: 0.94 }] }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: p.brand, opacity: v }]} />
      <Icon name={active ? 'send' : 'mic'} size={21} color={active ? p.onBrand : p.green} />
    </Pressable>
  );
}

const styles = (p: Palette) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: p.card },
  head: { backgroundColor: p.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.line },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: p.line, backgroundColor: p.paper },
  context: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: p.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line },
  bar: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.sm + 2, paddingTop: space.sm, backgroundColor: p.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line },
  pill: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', minHeight: 48, borderRadius: 24, borderWidth: 1, borderColor: p.line, backgroundColor: p.paper, paddingHorizontal: 4, paddingVertical: 4 },
  // outlineStyle: the web build's browser focus ring; phones draw none.
  input: { flex: 1, maxHeight: 120, minHeight: 40, ...({ outlineStyle: 'none' } as object), paddingHorizontal: 4, paddingTop: Platform.OS === 'ios' ? 10 : 8, paddingBottom: 8, fontSize: 16, fontFamily: font.regular, color: p.ink },
});

