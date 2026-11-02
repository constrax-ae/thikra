import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, type Chat } from './api';
import { live } from './live';
import { t } from './i18n';
import { theme } from './theme';

const preview = (c: Chat) => (c.lastKind === 'voice' ? `🎙 ${t.voice}` : c.lastKind === 'image' ? `📷 ${t.photo}` : c.lastText);

export function Chats({ onOpen, onAccount }: { onOpen: (c: Chat) => void; onAccount: () => void }) {
  const [list, setList] = useState<Chat[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => { try { setList(await api<Chat[]>('/circles')); } catch { setList(l => l ?? []); } }, []);
  useEffect(() => {
    load();
    const off = live.on(f => { if (f.t === 'open' || f.t === 'msg') load(); });   // any new message refreshes the list; the slow poll is the safety net
    const id = setInterval(load, 20000);
    return () => { off(); clearInterval(id); };
  }, [load]);
  // Family circles stay on top (the same rule as the web app); everything else keeps the server's order by time.
  const rows = list ?? [];
  const sorted = [...rows.filter(c => c.kind === 'circle'), ...rows.filter(c => c.kind !== 'circle')];
  return (
    <View style={s.wrap}>
      <View style={s.head}><Text style={s.title}>{t.chats}</Text><Pressable onPress={onAccount} accessibilityRole="button"><Text style={s.link}>{t.account}</Text></Pressable></View>
      <FlatList
        data={sorted} keyExtractor={c => String(c.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={list ? <Text style={s.empty}>{t.noChats}</Text> : undefined}
        renderItem={({ item: c }) => (
          <Pressable onPress={() => onOpen(c)} style={s.row} accessibilityRole="button">
            <View style={s.avatar}><Text style={s.avatarText}>{c.kind === 'group' ? '👥' : c.name.slice(0, 1)}</Text></View>
            <View style={{ flex: 1 }}>
              <View style={s.line}><Text style={s.name} numberOfLines={1}>{c.name}</Text>{c.muted && <Text>🔕</Text>}</View>
              <Text style={s.preview} numberOfLines={1}>{c.lastFromMe ? `${t.you}: ` : c.lastAuthor && c.kind !== 'direct' ? `${c.lastAuthor}: ` : ''}{preview(c)}</Text>
            </View>
            {c.unread > 0 && <View style={[s.badge, c.muted && { backgroundColor: theme.muted }]}><Text style={s.badgeText}>{c.unread > 99 ? '99+' : c.unread}</Text></View>}
          </Pressable>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg, paddingTop: 56 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: '500', color: theme.ink },
  link: { color: theme.green, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.greenSoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.green, fontSize: 20, fontWeight: '500' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontSize: 17, fontWeight: '500', color: theme.ink },
  preview: { color: theme.muted, marginTop: 2 },
  badge: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 6, backgroundColor: theme.green, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  empty: { textAlign: 'center', color: theme.muted, marginTop: 40 },
});
