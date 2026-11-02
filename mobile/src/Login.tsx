import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError } from './api';
import { t } from './i18n';
import { theme } from './theme';

export function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'phone' | 'code' | 'pin'>('phone');
  const [ticket, setTicket] = useState('');
  const [pin, setPin] = useState('');
  const [forgot, setForgot] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dev, setDev] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(e instanceof ApiError && e.code === 'offline' ? t.offline : t.failed);

  async function request() {
    setBusy(true); setError('');
    try { const r = await api<{ devCode?: string }>('/auth/request', { body: { phone: phone.trim() } }); setDev(r.devCode ?? ''); setStep('code'); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError('');
    try {
      const r = await api<{ ok: boolean; needPin?: boolean; ticket?: string }>('/auth/verify', { body: { phone: phone.trim(), code: code.trim(), name: name.trim() } });
      if (r.needPin && r.ticket) { setTicket(r.ticket); setPin(''); setStep('pin'); } else onDone();   // two-step verification: the code alone is not enough
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function sendPin() {
    setBusy(true); setError('');
    try { await api('/auth/pin', { body: { ticket, pin } }); onDone(); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'code_expired') { setStep('phone'); setError(t.pinExpired); }
      else if (e instanceof ApiError && e.code === 'pin_locked') setError(t.pinLocked);
      else if (e instanceof ApiError && e.code === 'offline') setError(t.offline);
      else setError(t.pinWrong);
    } finally { setBusy(false); }
  }
  async function forgotPin() {
    try { const r = await api<{ resetAt: number }>('/auth/pin-forgot', { body: { ticket } }); setForgot(new Date(r.resetAt).toLocaleDateString()); } catch (e) { fail(e); }
  }
  return (
    <View style={s.wrap}>
      <Text style={s.title}>{t.appName}</Text>
      <Text style={s.tag}>{t.tagline}</Text>
      <View style={s.card}>
        {step === 'pin' ? (
          <>
            <Text style={s.dev}>{t.pinPrompt}</Text>
            <TextInput style={s.input} value={pin} onChangeText={v => setPin(v.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" keyboardType="number-pad" secureTextEntry maxLength={6} placeholderTextColor={theme.muted} />
            <Button label={t.verify} onPress={sendPin} busy={busy} disabled={pin.length !== 6} />
            <Pressable onPress={forgotPin} accessibilityRole="button"><Text style={s.dev}>{t.pinForgot}</Text></Pressable>
            {!!forgot && <Text style={s.dev}>{t.pinForgotDone.replace('{d}', forgot)}</Text>}
          </>
        ) : step === 'phone' ? (
          <>
            <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder={t.phone} keyboardType="phone-pad" autoComplete="tel" placeholderTextColor={theme.muted} />
            <Button label={t.next} onPress={request} busy={busy} disabled={phone.trim().length < 6} />
          </>
        ) : (
          <>
            {!!dev && <Text style={s.dev}>{t.devCode}: {dev}</Text>}
            <TextInput style={s.input} value={code} onChangeText={setCode} placeholder={t.code} keyboardType="number-pad" maxLength={6} placeholderTextColor={theme.muted} />
            <TextInput style={s.input} value={name} onChangeText={setName} placeholder={t.name} placeholderTextColor={theme.muted} />
            <Button label={t.verify} onPress={verify} busy={busy} disabled={code.trim().length < 4} />
          </>
        )}
        {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      </View>
    </View>
  );
}

export function Button({ label, onPress, busy, disabled }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={busy || disabled} style={[s.btn, (busy || disabled) && { opacity: 0.5 }]}>
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{label}</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: theme.bg },
  title: { fontSize: 40, fontWeight: '500', color: theme.green, textAlign: 'center' },
  tag: { color: theme.muted, textAlign: 'center', marginBottom: 24 },
  card: { backgroundColor: theme.card, borderRadius: 20, padding: 16, gap: 12, borderWidth: 1, borderColor: theme.line },
  input: { borderWidth: 1, borderColor: theme.line, borderRadius: 12, padding: 12, fontSize: 17, color: theme.ink, backgroundColor: theme.white },
  btn: { backgroundColor: theme.green, borderRadius: 12, padding: 14, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '500' },
  error: { color: theme.danger },
  dev: { color: theme.muted, textAlign: 'center' },
});
