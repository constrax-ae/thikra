import { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Contact } from 'expo-contacts';
import { api, type Chat } from './api';
import { API_URL } from './config';
import { t } from './i18n';
import { theme } from './theme';

interface Picked { name: string; number: string }
const digits = (n: string) => n.replace(/[^\d+]/g, '');
const international = (n: string) => { const d = digits(n); return d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : null; };   // wa.me needs the country code

/**
 * Invite people to a circle from the phone's contacts. It uses the system's own contact picker: the app never reads the address book and nothing is uploaded.
 * What you pick only opens a message (SMS or WhatsApp) with the invite link in it.
 */
export function Invite({ chat, onBack }: { chat: Chat; onBack: () => void }) {
  const [link, setLink] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [error, setError] = useState('');

  async function ensureLink() {
    if (link) return link;
    const d = await api<{ inviteCode?: string }>(`/circles/${chat.id}`);
    if (!d.inviteCode) throw new Error('no_code');
    const url = `${API_URL}/#/join/${d.inviteCode}`;
    setLink(url);
    return url;
  }
  const text = (url: string) => t.inviteText.replace('{name}', chat.name).replace('{link}', url);

  async function pick() {
    setError('');
    try {
      await ensureLink();
      const c = await Contact.presentPicker();
      if (!c) return;
      const phones = (await c.getPhones()).filter(p => p.number);
      if (!phones.length) { setError(t.noNumber); return; }
      const name = await c.getFullName();
      setPicked(prev => [...prev, { name: name || phones[0].number!, number: phones[0].number! }]);
    } catch (e) { setError(e instanceof Error && e.message === 'no_code' ? t.noInviteCode : t.failed); }
  }
  async function share() { try { await Share.share({ message: text(await ensureLink()) }); } catch { setError(t.failed); } }
  const sms = (p: Picked) => Linking.openURL(`sms:${digits(p.number)}${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(text(link))}`);
  const whatsapp = (p: Picked) => { const w = international(p.number); if (w) Linking.openURL(`https://wa.me/${w}?text=${encodeURIComponent(text(link))}`); };

  return (
    <View style={s.wrap}>
      <View style={s.head}><Pressable onPress={onBack} accessibilityLabel={t.back} style={s.back}><Text style={s.backText}>←</Text></Pressable><Text style={s.title} numberOfLines={1}>{t.inviteTitle} · {chat.name}</Text></View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Pressable accessibilityRole="button" style={s.btn} onPress={pick}><Text style={s.btnText}>👥 {t.inviteFromContacts}</Text></Pressable>
        <Pressable accessibilityRole="button" style={[s.btn, s.ghost]} onPress={share}><Text style={[s.btnText, { color: theme.green }]}>🔗 {t.inviteShare}</Text></Pressable>
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.danger }}>{error}</Text>}
        {picked.map((p, i) => (
          <View key={`${p.number}-${i}`} style={s.row}>
            <View style={{ flex: 1 }}><Text style={s.name}>{p.name}</Text><Text style={s.num}>{p.number}</Text></View>
            <Pressable style={s.small} onPress={() => sms(p)}><Text style={s.smallText}>SMS</Text></Pressable>
            {international(p.number) && <Pressable style={s.small} onPress={() => whatsapp(p)}><Text style={s.smallText}>WhatsApp</Text></Pressable>}
          </View>
        ))}
        <Text style={s.note}>{t.invitePrivacy}</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 56, paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, backText: { fontSize: 24, color: theme.green },
  title: { flex: 1, fontSize: 18, fontWeight: '500', color: theme.ink },
  btn: { backgroundColor: theme.green, borderRadius: 12, padding: 14, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.green },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.line, padding: 10 },
  name: { fontSize: 16, color: theme.ink, fontWeight: '500' }, num: { color: theme.muted, fontSize: 13 },
  small: { backgroundColor: theme.greenSoft, borderRadius: 10, paddingHorizontal: 12, height: 40, justifyContent: 'center' }, smallText: { color: theme.green, fontWeight: '500' },
  note: { color: theme.muted, fontSize: 12, textAlign: 'center', marginTop: 8 },
});
