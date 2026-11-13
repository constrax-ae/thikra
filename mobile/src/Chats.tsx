import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Notices } from './Notices';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError, type Chat } from './api';
import { live } from './live';
import { locale, t } from './i18n';
import { Icon, type IconName } from './icons';
import {
  Avatar, Button, Chip, Eyebrow, FadeIn, Field, HeroArt, IconButton, IconTile, ChatListSkeleton, Muted,
  AppHeader, Press, SectionLabel, Sheet, SheetRow, Txt,
} from './ui';
import { elevation, font, radius, space, usePalette } from './theme';

type Filter = 'all' | 'unread' | 'favourites' | 'groups' | 'archived';
type Form = null | 'menu' | 'chat' | 'group' | 'circle' | 'join';
interface Person { id: number; name: string; via: string; chatId: number | null }

const toDate = (iso: string) => new Date(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z');

/** WhatsApp-style list time (the web's listTime): time today, Yesterday, weekday this week, else the date. */
function listTime(iso: string) {
  const d = toDate(iso), now = new Date();
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return t.yesterday;
  if (diff < 7) return d.toLocaleDateString(locale(), { weekday: 'long' });
  return d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const KIND_ICON: Record<string, IconName> = { image: 'image', video: 'video', voice: 'mic', file: 'file', deleted: 'ban' };

/** One chat row. Memoised: the list refreshes every few seconds and unchanged rows should not redraw. */
const Row = memo(function Row({ c, onOpen, onMenu }: { c: Chat; onOpen: (c: Chat) => void; onMenu: (c: Chat) => void }) {
  const p = usePalette();
  const unread = c.unread > 0 || !!c.markedUnread;
  const who = c.lastFromMe ? t.you : c.lastAuthor && c.kind !== 'direct' ? c.lastAuthor : '';
  const body = c.lastKind === 'voice' ? t.voice : c.lastKind === 'image' ? t.photo : c.lastKind === 'video' ? t.attachVideo
    : c.lastKind === 'file' ? t.attachFile : c.lastText;
  return (
    <Pressable onPress={() => onOpen(c)} onLongPress={() => onMenu(c)} delayLongPress={320}
      accessibilityRole="button" accessibilityLabel={c.name} accessibilityHint={unread ? `${c.unread}` : undefined}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: p.greenSoft }]}>
      <Avatar name={c.name} kind={c.kind} size={50} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={s.line}>
          <Txt weight="medium" numberOfLines={1} style={{ flex: 1 }}>{c.name}</Txt>
          <Txt size="caption" weight={unread && !c.muted ? 'heavy' : 'regular'} color={unread && !c.muted ? 'green' : 'muted'}>{listTime(c.lastAt)}</Txt>
        </View>
        <View style={s.line}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 }}>
            {!c.lastKind ? (
              <Txt size="small" color="muted" numberOfLines={1}>{(c.members ?? 1) === 1 ? t.oneMember : `${c.members} ${t.members}`}</Txt>
            ) : (
              <>
                {!!who && <Txt size="small" color={unread ? 'ink' : 'muted'}>{who}:</Txt>}
                {KIND_ICON[c.lastKind] && <Icon name={KIND_ICON[c.lastKind]} size={14} color={p.muted} />}
                <Txt size="small" color={unread ? 'ink' : 'muted'} numberOfLines={1} style={{ flex: 1 }}>{body}</Txt>
              </>
            )}
          </View>
          {c.muted && <Icon name="mute" size={15} color={p.muted} />}
          {c.pinned && <Icon name="pin" size={15} color={p.muted} />}
          {unread && (
            <View style={[s.badge, { backgroundColor: c.muted ? p.mutedFill : p.brand }]}>
              <Text style={{ color: p.onBrand, fontSize: 11, fontFamily: font.heavy }}>{c.unread > 0 ? (c.unread > 99 ? '99+' : c.unread) : ''}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
});

type Item =
  | { k: 'label'; id: string; text: string }
  | { k: 'chat'; id: string; c: Chat; i: number }
  | { k: 'person'; id: string; person: Person };

export function Chats({ onOpen, onUnread }: { onOpen: (c: Chat) => void; onUnread?: (n: number) => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const [list, setList] = useState<Chat[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Chat | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [field, setField] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api<Chat[]>('/circles');
      setList(rows); setFailed(false);
      // The badge on the tab bar counts what a muted chat does not shout about.
      onUnread?.(rows.filter(c => !c.muted && !c.archived).reduce((n, c) => n + (c.unread || 0), 0));
    } catch { setFailed(true); setList(l => l ?? []); }
    api<Person[]>('/people').then(setPeople).catch(() => {});
  }, [onUnread]);
  useEffect(() => {
    load();
    const off = live.on(f => { if (f.t === 'open' || f.t === 'msg') load(); });   // a new message refreshes the list; the poll is the safety net
    const id = setInterval(load, 15000);
    return () => { off(); clearInterval(id); };
  }, [load]);

  const all = list ?? [];
  const visible = all.filter(c => !c.archived);
  const counts = {
    unread: visible.filter(c => c.unread > 0 || c.markedUnread).length,
    favourites: visible.filter(c => c.favourite).length,
    groups: visible.filter(c => c.kind !== 'direct').length,
    archived: all.filter(c => c.archived).length,
  };

  const items: Item[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = all.filter(c => {
      if (filter === 'archived' ? !c.archived : c.archived) return false;
      if (filter === 'unread' && !(c.unread > 0 || c.markedUnread)) return false;
      if (filter === 'favourites' && !c.favourite) return false;
      if (filter === 'groups' && c.kind === 'direct') return false;
      return !q || c.name.toLowerCase().includes(q) || (c.lastText ?? '').toLowerCase().includes(q);
    });
    const out: Item[] = [];
    const push = (cs: Chat[]) => cs.forEach((c, i) => out.push({ k: 'chat', id: `c${c.id}`, c, i }));
    if (filter === 'all' && !q) {
      // Family circles stay on top (the web's rule); everything else keeps the server's order by time.
      const fam = rows.filter(c => c.kind === 'circle'), rest = rows.filter(c => c.kind !== 'circle');
      if (fam.length) { out.push({ k: 'label', id: 'lf', text: t.sectionFamily }); push(fam); }
      if (rest.length) { out.push({ k: 'label', id: 'lc', text: t.sectionChats }); push(rest); }
    } else push(rows);
    if (filter === 'all') {
      const ppl = people.filter(x => !x.chatId && (!q || x.name.toLowerCase().includes(q)));
      if (ppl.length) { out.push({ k: 'label', id: 'lp', text: t.sectionPeople }); ppl.forEach(x => out.push({ k: 'person', id: `p${x.id}`, person: x })); }
    }
    return out;
  }, [all, people, filter, query]);

  const openSheet = (f: Form) => { setForm(f); setField(''); setError(''); };
  const openById = async (id: number) => {
    const rows = await api<Chat[]>('/circles').catch(() => all);
    setList(rows);
    const c = rows.find(x => x.id === id);
    if (c) onOpen(c);
  };
  async function submit() {
    if (!field.trim() || busy) return;
    setBusy(true); setError('');
    try {
      let r: { id: number };
      if (form === 'chat') r = await api('/direct', { body: { phone: field.trim() } });
      else if (form === 'join') r = await api('/circles/join', { body: { code: field.trim() } });
      else r = await api('/circles', { body: { name: field.trim(), kind: form === 'group' ? 'group' : 'circle' } });
      setForm(null);
      await openById(r.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(code === 'user_not_found' ? `${t.errUserNotFound}. ${t.notRegisteredHint}` : code === 'invalid_invite' ? t.errInvalidInvite : code === 'offline' ? t.offline : t.failed);
    } finally { setBusy(false); }
  }
  async function openPerson(x: Person) {
    try { const r = await api<{ id: number }>('/direct', { body: { userId: x.id } }); await openById(r.id); } catch { /* the row stays */ }
  }
  async function pref(c: Chat, body: object) {
    setMenu(null);
    setList(l => l?.map(x => (x.id === c.id ? { ...x, ...body } : x)) ?? l);   // answer the tap at once; the reload is the truth
    try { await api(`/circles/${c.id}/prefs`, { method: 'PATCH', body }); } catch { /* reload below restores */ }
    load();
  }
  const goInvite = () => {
    const fam = all.find(c => c.kind === 'circle');
    if (fam) onOpen({ ...fam, openInvite: true } as Chat); else openSheet('circle');
  };

  const header = (
    <View style={{ paddingHorizontal: space.lg, gap: space.lg, paddingBottom: space.sm }}>
      {/* One header row, the way a phone heads its main screen: the app icon, the page title
          with its eyebrow, and the one primary action. (The separate "Thekra" wordmark row and a
          Memory shortcut used to sit above this; the icon already carries the brand, and Memory
          is a tab right below.) */}
      <AppHeader eyebrow={t.hubEyebrow} title={t.hubTitle}
        action={<IconButton name="plus-circle" tone="brand" size={48} label={t.newChatTitle} onPress={() => openSheet('menu')} style={{ borderRadius: 16 }} />} />
      <Notices />
      <Field icon="search" value={query} onChange={setQuery} placeholder={t.searchChats} returnKeyType="search" autoCorrect={false} />
      {all.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }} style={{ marginHorizontal: -4 }}>
          <Chip label={t.filterAll} on={filter === 'all'} onPress={() => setFilter('all')} />
          <Chip label={t.filterUnread} on={filter === 'unread'} count={counts.unread} onPress={() => setFilter('unread')} />
          <Chip label={t.filterFavourites} on={filter === 'favourites'} count={counts.favourites} onPress={() => setFilter('favourites')} />
          <Chip label={t.filterGroups} on={filter === 'groups'} count={counts.groups} onPress={() => setFilter('groups')} />
          {counts.archived > 0 && <Chip label={t.archivedChats} on={filter === 'archived'} count={counts.archived} onPress={() => setFilter('archived')} />}
        </ScrollView>
      )}
      {failed && <Txt size="small" color="danger" accessibilityRole="alert">{t.offline}</Txt>}
    </View>
  );

  const footer = list && all.length > 0 ? (
    <FadeIn delay={120} style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm }}>
      <Press onPress={goInvite} label={t.closerTitle}
        style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md + 2, borderRadius: radius.lg + 2,
          backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 1)]}>
        <IconTile name="group" size={44} />
        <View style={{ flex: 1 }}>
          <Txt weight="medium">{t.closerTitle}</Txt>
          <Muted>{people.length === 0 && all.some(c => c.kind === 'circle') ? t.lonelyAction : t.closerBody}</Muted>
        </View>
        <Icon name="arrow-out" size={20} color={p.muted} />
      </Press>
    </FadeIn>
  ) : undefined;

  const empty = list === null ? <ChatListSkeleton /> : all.length === 0 ? (
    <Onboarding onCreate={() => openSheet('circle')} onJoin={() => openSheet('join')} />
  ) : (
    <FilterEmpty filter={query.trim() ? 'search' : filter} query={query.trim()}
      onAll={() => { setQuery(''); setFilter('all'); }} onGroup={() => openSheet('group')} />
  );

  const sheetTitle = { menu: t.newChatTitle, chat: t.newChat, group: t.newGroup, circle: t.newFamilyCircle, join: t.joinWithInvite }[form ?? 'menu'];

  return (
    <View style={{ flex: 1, backgroundColor: p.paper, paddingTop: inset.top + space.sm }}>
      <FlatList
        data={items} keyExtractor={x => x.id}
        ListHeaderComponent={header} ListEmptyComponent={empty}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space.md }}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.green} colors={[p.brand]}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        renderItem={({ item }) => item.k === 'label' ? (
          <SectionLabel style={{ paddingHorizontal: space.lg + 4, marginTop: space.md }}>{item.text}</SectionLabel>
        ) : item.k === 'chat' ? (
          <FadeIn delay={Math.min(item.i, 8) * 35}><Row c={item.c} onOpen={onOpen} onMenu={setMenu} /></FadeIn>
        ) : (
          <Pressable onPress={() => openPerson(item.person)} accessibilityRole="button"
            style={({ pressed }) => [s.row, pressed && { backgroundColor: p.greenSoft }]}>
            <Avatar name={item.person.name} size={50} />
            <View style={{ flex: 1 }}><Txt weight="medium" numberOfLines={1}>{item.person.name}</Txt><Muted numberOfLines={1}>{item.person.via}</Muted></View>
            <Icon name="chats" size={20} color={p.muted} />
          </Pressable>
        )}
      />
      {/* Pinned above the tab bar: the same place whatever the list shows. */}
      {footer}

      {/* Long press on a chat. */}
      <Sheet open={!!menu} onClose={() => setMenu(null)}>
        {menu && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingBottom: space.md, paddingHorizontal: space.xs }}>
              <Avatar name={menu.name} kind={menu.kind} size={44} />
              <Txt size="title" weight="medium" numberOfLines={1} style={{ flex: 1 }}>{menu.name}</Txt>
            </View>
            <SheetRow icon="pin" label={menu.pinned ? t.unpin : t.pin} onPress={() => pref(menu, { pinned: !menu.pinned })} />
            {menu.muted
              ? <SheetRow icon="bell" label={t.unmute} onPress={() => pref(menu, { muted: false })} />
              : <>
                  <SheetRow icon="mute" label={t.mute8h} onPress={() => pref(menu, { muted: true, muteHours: 8 })} />
                  <SheetRow icon="mute" label={t.mute1w} onPress={() => pref(menu, { muted: true, muteHours: 168 })} />
                  <SheetRow icon="mute" label={t.muteAlways} onPress={() => pref(menu, { muted: true })} />
                </>}
            <SheetRow icon={menu.favourite ? 'star-fill' : 'star'} label={menu.favourite ? t.removeFavourite : t.addFavourite} onPress={() => pref(menu, { favourite: !menu.favourite })} />
            <SheetRow icon="archive" label={menu.archived ? t.unarchiveChat : t.archiveChat} onPress={() => pref(menu, { archived: !menu.archived })} />
            {menu.unread === 0 && !menu.markedUnread && <SheetRow icon="chats" label={t.markUnread} onPress={() => pref(menu, { markedUnread: true })} />}
          </>
        )}
      </Sheet>

      {/* New chat: the four ways in, then one field for whichever was chosen. */}
      <Sheet open={!!form} onClose={() => setForm(null)} title={sheetTitle}>
        {form === 'menu' ? (
          <View style={{ paddingBottom: space.sm }}>
            <SheetRow icon="chats" label={t.newChat} chevron onPress={() => openSheet('chat')} />
            <SheetRow icon="group" label={t.newGroup} chevron onPress={() => openSheet('group')} />
            <SheetRow icon="heart" label={t.newFamilyCircle} chevron onPress={() => openSheet('circle')} />
            <SheetRow icon="link" label={t.joinWithInvite} chevron onPress={() => openSheet('join')} />
          </View>
        ) : (
          <View style={{ gap: space.md, paddingBottom: space.sm }}>
            <Field
              value={field} onChange={setField} autoFocus invalid={!!error}
              placeholder={form === 'chat' ? t.phoneNumber : form === 'join' ? t.inviteCode : t.circleName}
              keyboardType={form === 'chat' ? 'phone-pad' : 'default'} autoCapitalize={form === 'join' ? 'none' : 'sentences'}
              maxLength={60} returnKeyType="done" onSubmitEditing={submit}
            />
            {form === 'circle' && <Muted>{t.kindCircle}</Muted>}
            {!!error && <Txt size="small" color="danger" accessibilityRole="alert">{error}</Txt>}
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button label={t.back} kind="ghost" onPress={() => openSheet('menu')} style={{ flex: 1 }} />
              <Button label={form === 'chat' ? t.startChat : form === 'join' ? t.join : t.create} onPress={submit} busy={busy} disabled={!field.trim()} style={{ flex: 1 }} />
            </View>
          </View>
        )}
      </Sheet>
    </View>
  );
}

/** First run: no chats at all. A composed welcome, not an empty list. */
/**
 * A filter or search with nothing in it. Each says what the view is for and offers the next
 * step, inside a card the size of a few chat rows, so the page keeps its shape and the invite
 * card below stays where it always is.
 */
function FilterEmpty({ filter, query, onAll, onGroup }: { filter: Filter | 'search'; query: string; onAll: () => void; onGroup: () => void }) {
  const p = usePalette();
  const c = {
    search: { icon: 'search' as const, title: t.emptySearchTitle.replace('{q}', query), body: t.emptySearchBody, cta: t.emptyClear, go: onAll },
    unread: { icon: 'check' as const, title: t.emptyUnreadTitle, body: t.emptyUnreadBody, cta: t.emptySeeAll, go: onAll },
    favourites: { icon: 'star' as const, title: t.emptyFavTitle, body: t.emptyFavBody, cta: t.emptySeeAll, go: onAll },
    groups: { icon: 'group' as const, title: t.emptyGroupsTitle, body: t.emptyGroupsBody, cta: t.newGroup, go: onGroup },
    archived: { icon: 'archive' as const, title: t.emptyArchivedTitle, body: t.emptyArchivedBody, cta: t.emptySeeAll, go: onAll },
    all: { icon: 'search' as const, title: t.chatNoMatch, body: '', cta: t.emptySeeAll, go: onAll },
  }[filter];
  return (
    <FadeIn style={{ flex: 1, marginHorizontal: space.lg, marginTop: space.md }}>
      <View style={{ flex: 1, minHeight: 300, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl, borderRadius: radius.lg + 4,
        borderWidth: 1, borderStyle: 'dashed', borderColor: p.line, backgroundColor: p.card }}>
        <HeroArt icon={c.icon} size={0.8} />
        <View style={{ alignItems: 'center', gap: 6 }}>
          <Txt size="title" weight="medium" style={{ textAlign: 'center' }}>{c.title}</Txt>
          {!!c.body && <Muted style={{ textAlign: 'center', lineHeight: 21, maxWidth: 280 }}>{c.body}</Muted>}
        </View>
        <Press onPress={c.go} label={c.cta}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: space.lg, borderRadius: 20, backgroundColor: p.greenSoft }}>
          <Txt size="small" weight="medium" color="green">{c.cta}</Txt>
        </Press>
      </View>
    </FadeIn>
  );
}

function Onboarding({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.lg }}>
      <HeroArt />
      <FadeIn delay={60} style={{ alignItems: 'center', gap: space.sm }}>
        <Eyebrow color="green">{t.hubWelcomeEyebrow}</Eyebrow>
        <Txt size="title" weight="medium" style={{ fontSize: 24, textAlign: 'center' }}>{t.onbTitle}</Txt>
        <Txt color="muted" size="small" style={{ textAlign: 'center', lineHeight: 21, maxWidth: 340 }}>{t.onbText}</Txt>
      </FadeIn>
      <FadeIn delay={120} style={{ alignSelf: 'stretch', gap: space.sm }}>
        <Button label={t.newFamilyCircle} icon="plus" onPress={onCreate} />
        <Button label={t.joinWithInvite} icon="link" kind="ghost" onPress={onJoin} />
      </FadeIn>
      <FeatureList />
    </View>
  );
}

/** What Thekra is for, in three lines (the web's FeatureList). */
export function FeatureList() {
  const p = usePalette();
  const items: Array<[IconName, string, string]> = [
    ['heart', t.featCircleTitle, t.featCircleBody], ['memory', t.featMemoryTitle, t.featMemoryBody], ['envelope', t.featSealedTitle, t.featSealedBody],
  ];
  return (
    <View style={{ alignSelf: 'stretch', gap: space.sm }}>
      {items.map(([ic, title, body], i) => (
        <FadeIn key={ic} delay={180 + i * 70}
          style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md + 2, borderRadius: radius.lg + 2,
            backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 1)]}>
          <IconTile name={ic} />
          <View style={{ flex: 1 }}><Txt size="small" weight="medium">{title}</Txt><Muted>{body}</Muted></View>
        </FadeIn>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.sm, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.lg + 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
});

