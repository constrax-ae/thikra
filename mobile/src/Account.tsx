import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError } from './api';
import { t } from './i18n';
import { theme } from './theme';


interface Case { id: number; subject: string; status: 'open' | 'answered' | 'closed'; messages: Array<{ fromStaff: number; body: string }> }
/** Write to the team and read their answers (the same service as the web app). Only what you write here is sent. */
function Support() {
  const [cases, setCases] = useState<Case[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState('');
  const load = () => api<Case[]>('/support').then(setCases).catch(() => {});
  useEffect(() => { load(); }, []);
  const fail = (e: unknown) => setMsg(e instanceof ApiError && e.code === 'too_many_open' ? t.supportTooMany : t.failed);
  async function send() { setMsg(''); try { await api('/support', { body: { subject, body } }); setSubject(''); setBody(''); setMsg(t.supportSent); load(); } catch (e) { fail(e); } }
  async function answer(id: number) { const text = (reply[id] ?? '').trim(); if (!text) return; try { await api(`/support/${id}/reply`, { body: { body: text } }); setReply(r => ({ ...r, [id]: '' })); load(); } catch (e) { fail(e); } }
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.h}>{t.supportWrite}</Text>
      <TextInput style={s.input} value={subject} onChangeText={setSubject} placeholder={t.supportSubject} maxLength={80} placeholderTextColor={theme.muted} />
      <TextInput style={[s.input, { minHeight: 90, textAlignVertical: 'top' }]} value={body} onChangeText={setBody} placeholder={t.supportBody} multiline maxLength={2000} placeholderTextColor={theme.muted} />
      <Pressable accessibilityRole="button" style={[s.btn, (!subject.trim() || !body.trim()) && { opacity: 0.5 }]} disabled={!subject.trim() || !body.trim()} onPress={send}><Text style={s.btnText}>{t.supportSend}</Text></Pressable>
      {!!msg && <Text style={{ color: theme.green }}>{msg}</Text>}
      {cases.map(k => (
        <View key={k.id} style={s.card}>
          <Text style={s.name}>{k.subject} · {t.supportStatus[k.status]}</Text>
          {k.messages.map((m, i) => <Text key={i} style={[s.msg, m.fromStaff ? { backgroundColor: theme.greenSoft } : null]}>{m.fromStaff ? `${t.supportTeam}: ` : ''}{m.body}</Text>)}
          {k.status !== 'closed' && <TextInput style={s.input} value={reply[k.id] ?? ''} onChangeText={v => setReply(r => ({ ...r, [k.id]: v }))} onSubmitEditing={() => answer(k.id)} placeholder={t.supportReply} placeholderTextColor={theme.muted} returnKeyType="send" />}
        </View>
      ))}
    </View>
  );
}

/** The account screen. Deleting the account from inside the app is required by both app stores. */
export function Account({ onBack, onSignedOut }: { onBack: () => void; onSignedOut: () => void }) {
  const [me, setMe] = useState<{ name: string; phone: string } | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<{ name: string; phone: string }>('/me').then(setMe).catch(() => {}); }, []);

  async function signOut() { await api('/auth/logout', { body: {} }).catch(() => {}); onSignedOut(); }
  function confirmDelete() {
    Alert.alert(t.deleteTitle, t.deleteWarn, [
      { text: t.cancel, style: 'cancel' },
      { text: t.deleteConfirm, style: 'destructive', onPress: async () => {
        try { await api('/me', { method: 'DELETE' }); onSignedOut(); }
        catch (e) { setMsg(e instanceof ApiError && e.code === 'owns_circles' ? t.deleteOwns : t.failed); }
      } },
    ]);
  }
  return (
    <View style={s.wrap}>
      <View style={s.head}><Pressable onPress={onBack} accessibilityLabel={t.back} style={s.back}><Text style={s.backText}>←</Text></Pressable><Text style={s.title}>{t.account}</Text></View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {me && <View style={s.card}><Text style={s.name}>{me.name}</Text><Text style={s.num}>{me.phone}</Text></View>}
        <Pressable accessibilityRole="button" style={s.btn} onPress={signOut}><Text style={s.btnText}>{t.logout}</Text></Pressable>
        <Pressable accessibilityRole="button" style={[s.btn, s.danger]} onPress={confirmDelete}><Text style={[s.btnText, { color: theme.danger }]}>{t.deleteTitle}</Text></Pressable>
        {!!msg && <Text accessibilityRole="alert" style={{ color: theme.danger }}>{msg}</Text>}
        <Text style={s.note}>{t.deleteNote}</Text>
        <Support />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 56, paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, backText: { fontSize: 24, color: theme.green },
  title: { flex: 1, fontSize: 20, fontWeight: '500', color: theme.ink },
  card: { backgroundColor: theme.card, borderRadius: 14, borderWidth: 1, borderColor: theme.line, padding: 14 },
  name: { fontSize: 20, fontWeight: '500', color: theme.ink }, num: { color: theme.muted, marginTop: 2 },
  btn: { backgroundColor: theme.green, borderRadius: 12, padding: 14, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  danger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.danger },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '500' },
  h: { fontSize: 17, fontWeight: '500', color: theme.ink, marginTop: 8 },
  input: { borderWidth: 1, borderColor: theme.line, borderRadius: 12, padding: 12, fontSize: 16, color: theme.ink, backgroundColor: theme.white },
  msg: { fontSize: 15, color: theme.ink, borderRadius: 8, padding: 8, marginTop: 6 },
  note: { color: theme.muted, fontSize: 12, textAlign: 'center' },
});
