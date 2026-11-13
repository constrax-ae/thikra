import { useEffect, useMemo, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { callingCode, flagEmoji, formatTyped, guessCountry, listCountries, type CountryCode } from '../../core/phone.ts';
import { api, ApiError } from './api';
import { isArabic, lang, locale, t } from './i18n';
import { Icon } from './icons';
import { CodeBoxes } from './CodeBoxes';
import { LangButton, MachineNote } from './Language';
import { Button, Card, FadeIn, Field, Muted, Sheet, Txt } from './ui';
import { elevation, font, radius, space, usePalette } from './theme';

const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;
type Step = 'phone' | 'code' | 'name' | 'pin';

function firstCountry(): CountryCode {
  const o = Intl.DateTimeFormat().resolvedOptions();
  return guessCountry({ languages: [o.locale], timeZone: o.timeZone, fallback: isArabic ? 'SA' : 'AE' });
}

/**
 * Sign-in, step for step the web's (web/src/Login.tsx): the phone number with a country
 * picker and live formatting, "is this your number?", the six-digit code that submits
 * itself, a name for a new account, and the PIN when two-step verification is on.
 */
export function Login({ onDone }: { onDone: () => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('phone');
  const [country, setCountry] = useState<CountryCode>(firstCountry);
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [newUser, setNewUser] = useState(false);
  const [devCode, setDevCode] = useState<string>();
  const [ticket, setTicket] = useState('');
  const [pin, setPin] = useState('');
  const [resetAt, setResetAt] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A number typed with a leading "+" is read as international and picks its own country, like WhatsApp.
  const international = text.trim().startsWith('+');
  const parsed = useMemo(() => parsePhoneNumberFromString(text, international ? undefined : country), [text, country, international]);
  const e164 = parsed?.isPossible() ? parsed.number : null;
  // Only complain once there are enough digits to judge.
  const invalid = text.replace(/\D/g, '').length >= 7 && !e164;

  useEffect(() => { if (international && parsed?.country && parsed.country !== country) setCountry(parsed.country); }, [international, parsed?.country, country]);
  useEffect(() => {
    if (left <= 0) return;
    const h = setTimeout(() => setLeft(l => l - 1), 1000);
    return () => clearTimeout(h);
  }, [left]);

  const fail = (e: unknown) => {
    const c = e instanceof ApiError ? e.code : 'generic';
    setError(c === 'offline' ? t.offline : t.errors[c] ?? t.errors.generic ?? t.failed);
  };

  async function requestCode() {
    if (!e164) return;
    setBusy(true); setError(''); setConfirming(false);
    try {
      const r = await api<{ newUser: boolean; devCode?: string }>('/auth/request', { body: { phone: e164 } });
      setNewUser(r.newUser); setDevCode(r.devCode); setCode(''); setLeft(RESEND_SECONDS); setStep('code');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function verify(withCode: string, withName = name) {
    setBusy(true); setError('');
    try {
      const r = await api<{ needPin?: boolean; ticket?: string }>('/auth/verify', { body: { phone: e164, code: withCode, name: withName.trim(), lang } });
      if (r.needPin && r.ticket) { setTicket(r.ticket); setPin(''); setStep('pin'); return; }   // two-step verification
      onDone();
    } catch (e) { fail(e); setCode(''); setStep('code'); } finally { setBusy(false); }
  }
  async function submitPin(value: string) {
    setBusy(true); setError('');
    try { await api('/auth/pin', { body: { ticket, pin: value } }); onDone(); }
    catch (e) { setPin(''); fail(e); } finally { setBusy(false); }
  }
  async function forgotPin() {
    setError('');
    try { const r = await api<{ resetAt: number }>('/auth/pin-forgot', { body: { ticket } }); setResetAt(r.resetAt); } catch (e) { fail(e); }
  }
  function onCode(v: string) {
    setCode(v); setError('');
    if (v.length === CODE_LENGTH) { if (newUser) setStep('name'); else void verify(v); }
  }

  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const pretty = parsed?.formatInternational() ?? text;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.lg, paddingTop: inset.top + space.lg, paddingBottom: inset.bottom + space.lg, gap: space.xl }}>

        <FadeIn style={{ alignItems: 'center', gap: space.sm }}>
          <Image source={require('../assets/splash-icon.png')} style={[{ width: 88, height: 88, borderRadius: 24 }, elevation(p, 2)]} accessibilityIgnoresInvertColors />
          <Txt size="display" weight="medium" color="green" style={{ marginTop: space.sm, fontSize: 34, letterSpacing: -0.5 }}>{t.appName}</Txt>
          <Muted style={{ fontSize: 16, textAlign: 'center' }}>{t.tagline}</Muted>
        </FadeIn>

        <FadeIn delay={90}>
          <Card style={[{ padding: space.xl - 4 }, elevation(p, 2)]}>
            {/* Keyed on the step: each stage slides in, so the card reads as moving forward. */}
            <FadeIn key={step} from={10} style={{ gap: space.lg }}>
              {step === 'phone' && (
                <>
                  <View style={{ gap: 6 }}>
                    <Txt size="title" weight="medium">{t.loginTitle}</Txt>
                    <Muted style={{ fontSize: 15, lineHeight: 22 }}>{t.loginSubtitle}</Muted>
                  </View>
                  <View style={{ gap: 6 }}>
                    <Txt size="small" weight="medium">{t.phone.replace(/\s*\(.*\)$/, '')}</Txt>
                    {/* The country and the number are one control, like the web's field-group. */}
                    <View style={[{ direction: 'ltr', flexDirection: 'row', alignItems: 'center', minHeight: 54, borderWidth: 1, borderRadius: radius.md + 2,
                      borderColor: invalid ? p.danger : p.line, backgroundColor: p.card, overflow: 'hidden' }, elevation(p, 1)]}>
                      <Pressable onPress={() => setPicker(true)} accessibilityRole="button" accessibilityLabel={`${t.country}: +${callingCode(country)}`}
                        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, alignSelf: 'stretch',
                          borderRightWidth: 1, borderRightColor: p.line }, pressed && { backgroundColor: p.greenSoft }]}>
                        <Text style={{ fontSize: 22 }}>{flagEmoji(country)}</Text>
                        <Text style={{ fontSize: 16, fontFamily: font.medium, color: p.ink, fontVariant: ['tabular-nums'] }}>+{callingCode(country)}</Text>
                        <Icon name="chevron" size={16} color={p.muted} />
                      </Pressable>
                      <TextInput
                        value={text} onChangeText={v => { setError(''); setText(formatTyped(v, country)); }}
                        keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel"
                        accessibilityLabel={t.phone} placeholderTextColor={p.muted}
                        style={{ flex: 1, minHeight: 52, paddingHorizontal: space.md, fontSize: 18, letterSpacing: 0.5, fontFamily: font.regular, color: p.ink, writingDirection: 'ltr', textAlign: 'left' }}
                      />
                    </View>
                    {invalid && <Txt size="small" color="danger" accessibilityRole="alert">{t.invalidNumber}</Txt>}
                  </View>
                  <Button label={t.next} onPress={() => e164 && setConfirming(true)} busy={busy} disabled={!e164} />
                </>
              )}

              {step === 'code' && (
                <>
                  <View style={{ gap: 6 }}>
                    <Txt size="title" weight="medium">{t.codeTitle}</Txt>
                    <Muted style={{ fontSize: 15, lineHeight: 22 }}>
                      {t.codeBody} <Text style={{ fontFamily: font.heavy, color: p.ink, writingDirection: 'ltr' }}>{pretty}</Text>
                    </Muted>
                    <Pressable onPress={() => { setStep('phone'); setError(''); }} accessibilityRole="button" hitSlop={8}>
                      <Txt size="small" weight="medium" color="green">{t.wrongNumber}</Txt>
                    </Pressable>
                  </View>
                  <CodeBoxes value={code} onChange={onCode} disabled={busy} invalid={!!error} label={t.code} />
                  {/* No SMS provider yet outside production: the server hands the code back. */}
                  {!!devCode && (
                    <Pressable onPress={() => onCode(devCode)} accessibilityRole="button"
                      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm + 2,
                        borderRadius: radius.md, backgroundColor: '#c79a3b1f', borderWidth: 1, borderColor: '#c79a3b55' }}>
                      <Icon name="key" size={16} color={p.goldDark} />
                      <Txt size="small" color="goldDark" style={{ flex: 1 }}>{t.devCode}: <Text style={{ fontFamily: font.heavy }}>{devCode}</Text></Txt>
                      <Txt size="small" weight="heavy" color="green">{t.fillDev}</Txt>
                    </Pressable>
                  )}
                  <View style={{ alignItems: 'center' }}>
                    {left > 0
                      ? <Muted>{t.resendIn} {mmss}</Muted>
                      : <Pressable onPress={requestCode} disabled={busy} accessibilityRole="button" hitSlop={8}><Txt size="small" weight="medium" color="green">{t.resend}</Txt></Pressable>}
                  </View>
                </>
              )}

              {step === 'name' && (
                <>
                  <View style={{ gap: 6 }}>
                    <Txt size="title" weight="medium">{t.nameTitle}</Txt>
                    <Muted style={{ fontSize: 15 }}>{t.nameBody}</Muted>
                  </View>
                  <Field icon="you" value={name} onChange={setName} placeholder={t.name} autoFocus maxLength={60}
                    textContentType="name" autoComplete="name" returnKeyType="done" onSubmitEditing={() => name.trim() && verify(code)} />
                  <Button label={t.start} onPress={() => verify(code)} busy={busy} disabled={!name.trim()} />
                </>
              )}

              {step === 'pin' && (
                <>
                  <View style={{ gap: 6 }}>
                    <Txt size="title" weight="medium">{t.loginPinTitle}</Txt>
                    <Muted style={{ fontSize: 15 }}>{t.loginPinBody}</Muted>
                  </View>
                  <CodeBoxes secure value={pin} onChange={v => { setPin(v); setError(''); if (v.length === CODE_LENGTH) void submitPin(v); }} disabled={busy} invalid={!!error} label={t.loginPinTitle} />
                  {resetAt
                    ? <Muted>{t.pinResetScheduled} {new Date(resetAt).toLocaleDateString(locale(), { dateStyle: 'long' })}</Muted>
                    : <Pressable onPress={forgotPin} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'center' }}><Txt size="small" weight="medium" color="green">{t.pinForgot}</Txt></Pressable>}
                </>
              )}

              {!!error && <Txt size="small" color="danger" accessibilityRole="alert">{error}</Txt>}
            </FadeIn>
          </Card>
        </FadeIn>

        {/* Language, as on the web's sign-in screen: under the card, centred. */}
        <FadeIn delay={160} style={{ alignItems: 'center', gap: space.md }}>
          <LangButton />
          <MachineNote />
        </FadeIn>
      </ScrollView>

      {/* "Is this your number?" — a wrong number costs an SMS and a wait, so it is checked first. */}
      <Sheet open={confirming} onClose={() => setConfirming(false)} title={t.confirmTitle}>
        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <Muted style={{ fontSize: 15 }}>{t.confirmBody}</Muted>
          <Txt size="title" weight="heavy" style={{ textAlign: 'center', fontSize: 24, paddingVertical: space.sm, writingDirection: 'ltr' }}>{pretty}</Txt>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label={t.edit} kind="ghost" onPress={() => setConfirming(false)} style={{ flex: 1 }} />
            <Button label={t.ok} onPress={requestCode} busy={busy} style={{ flex: 1 }} />
          </View>
        </View>
      </Sheet>

      <CountrySheet open={picker} current={country} onClose={() => setPicker(false)}
        onPick={c => { setCountry(c); setPicker(false); setError(''); if (!international) setText(formatTyped(text, c)); }} />
    </KeyboardAvoidingView>
  );
}

/** Every country with its flag and code, searchable by name (in English too) or by the code. */
function CountrySheet({ open, current, onClose, onPick }: { open: boolean; current: CountryCode; onClose: () => void; onPick: (c: CountryCode) => void }) {
  const p = usePalette();
  const [q, setQ] = useState('');
  const all = useMemo(() => listCountries(locale()), []);
  const english = useMemo(() => new Map(listCountries('en').map(c => [c.code, c.name.toLowerCase()])), []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^\+/, '');
    const list = needle ? all.filter(c => c.name.toLowerCase().includes(needle) || english.get(c.code)!.includes(needle) || c.code.toLowerCase() === needle || c.dial.startsWith(needle)) : all;
    return [...list.filter(c => c.code === current), ...list.filter(c => c.code !== current)];
  }, [all, english, q, current]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={t.country}>
      <View style={{ paddingBottom: space.sm }}>
        <Field icon="search" value={q} onChange={setQ} placeholder={t.searchCountry} autoCorrect={false} />
      </View>
      {shown.length === 0 && <Muted style={{ textAlign: 'center', padding: space.lg }}>{t.noResults}</Muted>}
      {shown.slice(0, q ? 80 : 250).map(c => (
        <Pressable key={c.code} onPress={() => onPick(c.code)} accessibilityRole="button" accessibilityState={{ selected: c.code === current }}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52, paddingHorizontal: space.sm, borderRadius: radius.md },
            (pressed || c.code === current) && { backgroundColor: p.greenSoft }]}>
          <Text style={{ fontSize: 22 }}>{c.flag}</Text>
          <Txt numberOfLines={1} style={{ flex: 1 }}>{c.name}</Txt>
          <Muted style={{ writingDirection: 'ltr' }}>+{c.dial}</Muted>
          {c.code === current && <Icon name="check" size={18} color={p.green} />}
        </Pressable>
      ))}
    </Sheet>
  );
}
