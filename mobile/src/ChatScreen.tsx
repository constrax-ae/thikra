import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAudioPlayer } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { api, mediaSource, sendPhoto, type Chat, type Me, type Msg } from './api';
import { live } from './live';
import { t } from './i18n';
import { colorOf, theme } from './theme';

const hhmm = (iso: string) => { const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

/** A voice message: tap to play or pause. */
function Voice({ id }: { id: number }) {
  const player = useAudioPlayer(mediaSource(`/api/messages/${id}/audio`));
  const [playing, setPlaying] = useState(false);
  return (
    <Pressable accessibilityRole="button" onPress={() => { if (player.playing) { player.pause(); setPlaying(false); } else { player.play(); setPlaying(true); } }} style={s.voice}>
      <Text style={s.voiceIcon}>{playing ? '⏸' : '▶️'}</Text><Text style={s.body}>🎙 {t.voice}</Text>
    </Pressable>
  );
}

export function ChatScreen({ chat, me, onBack, onInvite }: { chat: Chat; me: Me; onBack: () => void; onInvite?: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const last = useRef(0);
  const list = useRef<FlatList<Msg>>(null);
  const sending = useRef(false);

  const pull = useCallback(async () => {
    try {
      const fresh = await api<Msg[]>(`/circles/${chat.id}/messages?after=${last.current}`);
      if (fresh.length) {
        last.current = Math.max(last.current, ...fresh.map(m => m.id));
        setMsgs(prev => { const ids = new Set(prev.map(m => m.id)); return [...prev, ...fresh.filter(m => !ids.has(m.id))]; });
        api(`/circles/${chat.id}/read`, { body: {} }).catch(() => {});
      }
    } catch { /* the next poll tries again */ }
  }, [chat.id]);
  useEffect(() => { const id = setTimeout(() => list.current?.scrollToEnd({ animated: false }), 80); return () => clearTimeout(id); }, [msgs.length]);
  useEffect(() => {
    pull();
    // live: a new message for this chat (or a reconnect) pulls at once; the slow poll is only the safety net
    const off = live.on(f => { if (f.t === 'open' || (f.t === 'msg' && f.circle === chat.id)) pull(); });
    const id = setInterval(pull, 15000);
    return () => { off(); clearInterval(id); };
  }, [pull, chat.id]);

  async function attach() {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (r.canceled || !r.assets[0]) return;
      const a = r.assets[0];
      const name = a.fileName ?? `photo-${Date.now()}.jpg`, type = a.mimeType ?? 'image/jpeg';
      // in a browser the picker hands back a blob URL; on a phone a local file the upload reads itself
      const blob = Platform.OS === 'web' ? await (await fetch(a.uri)).blob() : undefined;
      await sendPhoto(chat.id, { uri: a.uri, name, type }, blob);
      await pull();
    } catch { /* cancelled or failed: nothing is sent */ }
  }
  async function send() {
    const body = text.trim();
    if (!body || sending.current) return;
    sending.current = true; setText('');
    try { await api(`/circles/${chat.id}/messages`, { body: { body, client_msg_id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } }); await pull(); }
    catch { setText(body); } finally { sending.current = false; }
  }
  return (
    <KeyboardAvoidingView style={s.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.head}><Pressable onPress={onBack} accessibilityLabel={t.back} style={s.back}><Text style={s.backText}>←</Text></Pressable><Text style={s.title} numberOfLines={1}>{chat.name}</Text>{onInvite && chat.kind !== 'direct' && <Pressable onPress={onInvite} accessibilityRole="button" style={s.back}><Text style={s.backText}>👥</Text></Pressable>}</View>
      <FlatList
        ref={list} onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        data={msgs.filter(m => !m.deleted)} keyExtractor={m => String(m.id)}
        contentContainerStyle={{ padding: 12, gap: 6 }}
        renderItem={({ item: m }) => m.kind === 'system'
          ? <Text style={s.system}>{m.body}</Text>
          : (
            <View style={[s.bubble, m.userId === me.id ? s.mine : s.theirs]}>
              {m.userId !== me.id && chat.kind !== 'direct' && <Text style={[s.author, { color: colorOf(m.userId) }]}>{m.author}</Text>}
              {m.attachments?.filter(a => a.kind === 'image').map(a => <Image key={a.id} source={mediaSource(`/api/media/${a.thumb ?? a.id}`)} style={[s.photo, a.w && a.h ? { aspectRatio: a.w / a.h } : null]} resizeMode="cover" accessibilityLabel={t.photo} />)}
              {m.kind === 'voice' ? <Voice id={m.id} /> : !!m.body && <Text style={s.body}>{m.body}</Text>}
              <Text style={s.time}>{hhmm(m.createdAt)}</Text>
            </View>
          )}
      />
      <View style={s.bar}>
        <Pressable onPress={attach} accessibilityRole="button" accessibilityLabel={t.photo} style={s.clip}><Text style={s.backText}>📎</Text></Pressable>
        <TextInput style={s.input} value={text} onChangeText={setText} placeholder={t.write} placeholderTextColor={theme.muted} multiline />
        <Pressable onPress={send} accessibilityRole="button" style={[s.send, !text.trim() && { opacity: 0.5 }]} disabled={!text.trim()}><Text style={s.sendText}>{t.send}</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 56, paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 24, color: theme.green },
  title: { flex: 1, fontSize: 20, fontWeight: '500', color: theme.ink },
  bubble: { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  mine: { alignSelf: 'flex-end', backgroundColor: theme.mine },
  theirs: { alignSelf: 'flex-start', backgroundColor: theme.white },
  author: { fontSize: 13, fontWeight: '500', marginBottom: 2 },
  body: { fontSize: 17, color: theme.ink },
  photo: { width: 240, maxWidth: '100%', aspectRatio: 4 / 3, borderRadius: 10, marginBottom: 4, backgroundColor: theme.line },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingEnd: 8 }, voiceIcon: { fontSize: 22 },
  clip: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  time: { fontSize: 11, color: theme.muted, alignSelf: 'flex-end', marginTop: 2 },
  system: { alignSelf: 'center', color: theme.muted, fontSize: 13, textAlign: 'center', paddingVertical: 4 },
  bar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, backgroundColor: theme.card },
  input: { flex: 1, maxHeight: 120, borderWidth: 1, borderColor: theme.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17, color: theme.ink, backgroundColor: theme.white },
  send: { backgroundColor: theme.green, borderRadius: 20, paddingHorizontal: 16, height: 44, justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 16, fontWeight: '500' },
});
