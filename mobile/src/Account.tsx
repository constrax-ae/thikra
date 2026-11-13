import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Notices } from './Notices';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, apiForm, ApiError, avatarSource, openRemote, type Me } from './api';
import * as ImagePicker from 'expo-image-picker';
import { hasCamera } from './Attach';
import { Icon, type IconName } from './icons';
import { API_URL } from './config';
import { LANG_INFO, lang, locale, t, useLang } from './i18n';
import { LangSheet } from './Language';
import { CodeBoxes } from './CodeBoxes';
import { setPref, usePrefs, type TextSize, type ThemePref } from './prefs';
import { AppHeader, Avatar, Badge, Button, Card, FadeIn, ListRow, Muted, Sheet, SheetRow, Toggle, Txt, ask } from './ui';
import { elevation, font, radius, space, usePalette } from './theme';

type Panel = null | 'account' | 'privacy' | 'appearance' | 'notifications' | 'help' | 'pin' | 'language';
interface Case { id: number; subject: string; status: 'open' | 'answered' | 'closed'; messages: Array<{ fromStaff: number; body: string }> }

/**
 * You: the web's You page for a phone. A profile card, then one list of sections; each
 * opens as a sheet from the bottom, so the page itself stays a short, scannable menu.
 */
export function Account({ me, onChanged, onSignedOut, onSealed }: { me: Me; onChanged: () => void; onSignedOut: () => void; onSealed: () => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const prefs = usePrefs();
  const current = useLang();
  const [panel, setPanel] = useState<Panel>(null);
  const [receipts, setReceipts] = useState(!!me.read_receipts);
  const [preview, setPreview] = useState(!!me.push_preview);
  useEffect(() => { setReceipts(!!me.read_receipts); setPreview(!!me.push_preview); }, [me]);
  // Circles you deleted, restorable for 90 days (the web's "Recently deleted").
  const [deleted, setDeleted] = useState<Array<{ id: number; name: string; daysLeft: number }>>([]);
  const loadDeleted = () => api<Array<{ id: number; name: string; daysLeft: number }>>('/me/deleted-circles').then(setDeleted).catch(() => {});
  useEffect(() => { void loadDeleted(); }, []);
  async function restore(id: number) {
    try { await api(`/circles/${id}/restore`, { method: 'POST', body: {} }); await loadDeleted(); onChanged(); }
    catch { Alert.alert(t.failed); }
  }

  const save = async (body: Record<string, unknown>, undo: () => void) => {
    try { await api('/me', { method: 'PATCH', body }); onChanged(); } catch { undo(); }
  };
  async function signOut() { await api('/auth/logout', { body: {} }).catch(() => {}); onSignedOut(); }
  function confirmDelete() {
    Alert.alert(t.deleteTitle, t.deleteWarn, [
      { text: t.cancel, style: 'cancel' },
      { text: t.deleteConfirm, style: 'destructive', onPress: async () => {
        try { await api('/me', { method: 'DELETE' }); onSignedOut(); }
        catch (e) { Alert.alert(e instanceof ApiError && e.code === 'owns_circles' ? t.deleteOwns : t.failed); }
      } },
    ]);
  }
  const themes: Array<{ value: ThemePref; label: string }> = [{ value: 'system', label: t.themeSystem }, { value: 'light', label: t.themeLight }, { value: 'dark', label: t.themeDark }];
  const sizes: Array<{ value: TextSize; label: string }> = [{ value: 'normal', label: t.sizeNormal }, { value: 'large', label: t.sizeLarge }, { value: 'xlarge', label: t.sizeXLarge }];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.paper }} contentContainerStyle={{ paddingTop: inset.top + space.md, paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.lg }}>
      <Notices />

      {/* The profile, as Staicy shows it: the picture rising out of the card (tap to change it), the name
          (tap to edit), the number written the way people write it, and how long they have been here. */}
      <FadeIn>
        <ProfileCard me={me} onChanged={onChanged} />
      </FadeIn>

      <FadeIn delay={60} style={{ gap: 10 }}>
        <MenuRow icon="key" tint="#2f7d64" label={t.rowAccount} sub={t.subAccount} onPress={() => setPanel('account')} />
        <MenuRow icon="lock" tint="#3b82f6" label={t.rowPrivacy} sub={t.subPrivacy} onPress={() => setPanel('privacy')} />
        <MenuRow icon="palette" tint="#8b5cf6" label={t.rowAppearance} sub={themes.find(x => x.value === prefs.theme)?.label} onPress={() => setPanel('appearance')} />
        <MenuRow icon="globe" tint="#0e9f9a" label={t.languageTitle} sub={LANG_INFO[current].name} onPress={() => setPanel('language')} />
        <MenuRow icon="bell" tint="#d97706" label={t.rowNotifications} sub={t.subNotifications} onPress={() => setPanel('notifications')} />
        <MenuRow icon="help" tint="#64748b" label={t.rowHelp} sub={t.subHelp} onPress={() => setPanel('help')} />
        <MenuRow icon="envelope" tint="#b98a2f" label={t.sealedTitle} sub={t.subSealed} onPress={onSealed} />
        <MenuRow icon="heart" tint="#e11d48" label={t.rowInvite} sub={t.subInvite} onPress={() => { void Share.share({ message: `${t.inviteFriendText}${API_URL}` }); }} />
      </FadeIn>

      {deleted.length > 0 && (
        <FadeIn delay={140}>
          <Card style={{ gap: space.sm }}>
            <Txt weight="medium">{t.recentlyDeleted}</Txt>
            {deleted.map(d => (
              <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 4 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt weight="medium" numberOfLines={1}>{d.name}</Txt>
                  <Muted style={{ fontSize: 12 }}>{d.daysLeft} {t.daysLeftWord}</Muted>
                </View>
                <Button label={t.restore} icon="refresh" onPress={() => { void restore(d.id); }} style={{ minWidth: 120 }} />
              </View>
            ))}
          </Card>
        </FadeIn>
      )}

      <View style={{ gap: 10, marginTop: space.sm }}>
        <Pressable onPress={signOut} accessibilityRole="button"
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 26, borderWidth: 1.5, borderColor: p.danger }, pressed && { backgroundColor: p.dangerSoft }]}>
          <Icon name="arrow-back" size={18} color={p.danger} />
          <Txt weight="medium" style={{ color: p.danger }}>{t.logout}</Txt>
        </Pressable>
        <Pressable onPress={confirmDelete} accessibilityRole="button"
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 26, backgroundColor: p.danger }, pressed && { opacity: 0.85 }]}>
          <Icon name="trash" size={18} color="#fff" />
          <Txt weight="medium" style={{ color: '#fff' }}>{t.deleteTitle}</Txt>
        </Pressable>
      </View>

      <Muted style={{ textAlign: 'center', fontSize: 12 }}>{t.aboutApp}</Muted>

      {/* Account */}
      <Sheet open={panel === 'account'} onClose={() => setPanel(null)} title={t.rowAccount}>
        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <Card style={{ gap: space.sm }}>
            <Txt weight="medium">{t.pinTitle}</Txt>
            <Muted>{me.has_pin ? t.pinOnShort : t.pinOffNote}</Muted>
            <Button label={me.has_pin ? t.pinChange : t.pinTurnOn} kind={me.has_pin ? 'ghost' : 'primary'} icon="key" onPress={() => setPanel('pin')} />
          </Card>
          <ChangeNumber onDone={onChanged} />
          <DataRights />

        </View>
      </Sheet>
      <PinSheet open={panel === 'pin'} hasPin={!!me.has_pin} onClose={() => setPanel(null)} onDone={() => { setPanel(null); onChanged(); }} />

      <LangSheet open={panel === 'language'} onClose={() => setPanel(null)} signedIn />

      {/* Privacy */}
      <Sheet open={panel === 'privacy'} onClose={() => setPanel(null)} title={t.rowPrivacy}>
        <Toggle label={t.readReceipts} note={t.readReceiptsNote} value={receipts} onChange={v => { setReceipts(v); void save({ read_receipts: v }, () => setReceipts(!v)); }} />
      </Sheet>

      {/* Appearance */}
      <Sheet open={panel === 'appearance'} onClose={() => setPanel(null)} title={t.rowAppearance}>
        <Muted style={{ marginBottom: space.sm }}>{t.appearanceNote}</Muted>
        <Txt size="small" weight="medium" style={{ marginBottom: 4 }}>{t.theme}</Txt>
        {themes.map(o => <SheetRow key={o.value} icon={o.value === 'dark' ? 'clock' : o.value === 'light' ? 'sparkle' : 'phone'} label={o.label} selected={prefs.theme === o.value} onPress={() => void setPref('theme', o.value)} />)}
        <Txt size="small" weight="medium" style={{ marginTop: space.md, marginBottom: 4 }}>{t.textSize}</Txt>
        <View style={{ flexDirection: 'row', gap: space.sm, paddingBottom: space.sm }}>
          {sizes.map(o => (
            <Button key={o.value} label={o.label} kind={prefs.textSize === o.value ? 'primary' : 'ghost'} onPress={() => void setPref('textSize', o.value)} style={{ flex: 1 }} />
          ))}
        </View>
      </Sheet>

      {/* Notifications */}
      <Sheet open={panel === 'notifications'} onClose={() => setPanel(null)} title={t.rowNotifications}>
        <Toggle label={t.pushPreview} note={t.pushPreviewNote} value={preview} onChange={v => { setPreview(v); void save({ push_preview: v }, () => setPreview(!v)); }} />
      </Sheet>

      {/* Help */}
      <Sheet open={panel === 'help'} onClose={() => setPanel(null)} title={t.rowHelp}>
        <Support />
      </Sheet>
    </ScrollView>
  );
}

/** Turn on, change or remove the two-step PIN (the web's Account section). */
function PinSheet({ open, hasPin, onClose, onDone }: { open: boolean; hasPin: boolean; onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setCurrent(''); setPin(''); setError(''); } }, [open]);
  async function go(remove = false) {
    setBusy(true); setError('');
    try {
      if (remove) await api('/me/pin/remove', { body: { pin: current } });
      else await api('/me/pin', { body: { pin, ...(hasPin ? { current } : {}) } });
      onDone();
    } catch { setError(t.pinWrong); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={hasPin ? t.pinChange : t.pinTurnOn}>
      <View style={{ gap: space.lg, paddingBottom: space.sm }}>
        {hasPin && <View style={{ gap: space.sm }}><Muted>{t.pinCurrent}</Muted><CodeBoxes value={current} onChange={setCurrent} label={t.pinCurrent} invalid={!!error} /></View>}
        <View style={{ gap: space.sm }}><Muted>{t.pinNew}</Muted><CodeBoxes value={pin} onChange={setPin} label={t.pinNew} autoFocus={!hasPin} /></View>
        {!!error && <Txt size="small" color="danger">{error}</Txt>}
        <Button label={t.save} onPress={() => go(false)} busy={busy} disabled={pin.length < 6 || (hasPin && current.length < 6)} />
        {hasPin && <Button label={t.pinTurnOff} kind="ghost" onPress={() => go(true)} disabled={current.length < 6} />}
      </View>
    </Sheet>
  );
}

/** Write to the team and read their answers. Only what you write here is sent. */
function Support() {
  const p = usePalette();
  const [cases, setCases] = useState<Case[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<Record<number, string>>({});
  const load = () => api<Case[]>('/support').then(setCases).catch(() => {});
  async function answer(id: number) {
    const text = (reply[id] ?? '').trim(); if (!text) return;
    try { await api(`/support/${id}/reply`, { body: { body: text } }); setReply(x => ({ ...x, [id]: '' })); await load(); }
    catch { setMsg(t.failed); }
  }
  useEffect(() => { load(); }, []);
  async function send() {
    setBusy(true); setMsg('');
    try { await api('/support', { body: { subject, body } }); setSubject(''); setBody(''); setMsg(t.supportSent); load(); }
    catch (e) { setMsg(e instanceof ApiError && e.code === 'too_many_open' ? t.supportTooMany : t.failed); }
    finally { setBusy(false); }
  }
  const input = { borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2, paddingHorizontal: space.md, paddingVertical: 12, fontSize: 16, fontFamily: font.regular, color: p.ink, backgroundColor: p.paper };
  return (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      <Muted>{t.aboutApp}</Muted>
      <Txt weight="medium">{t.supportWrite}</Txt>
      <TextInput style={input} value={subject} onChangeText={setSubject} placeholder={t.supportSubject} maxLength={80} placeholderTextColor={p.muted} />
      <TextInput style={[input, { minHeight: 100, textAlignVertical: 'top' }]} value={body} onChangeText={setBody} placeholder={t.supportBody} multiline maxLength={2000} placeholderTextColor={p.muted} />
      <Button label={t.supportSend} icon="send" onPress={send} busy={busy} disabled={!subject.trim() || !body.trim()} />
      {!!msg && <Txt size="small" color="green">{msg}</Txt>}
      {cases.map(k => (
        <View key={k.id} style={{ borderRadius: radius.md + 2, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, padding: space.md, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Txt weight="medium" style={{ flex: 1 }} numberOfLines={1}>{k.subject}</Txt>
            <Badge tone={k.status === 'answered' ? 'good' : k.status === 'closed' ? 'neutral' : 'warn'}>{t.supportStatus[k.status]}</Badge>
          </View>
          {k.messages.map((m, i) => (
            <View key={i} style={{ padding: space.sm, borderRadius: radius.sm, backgroundColor: m.fromStaff ? p.greenSoft : p.paper, gap: 2 }}>
              <Muted style={{ fontSize: 11 }}>{m.fromStaff ? t.supportTeam : t.supportYou}</Muted>
              <Txt size="small">{m.body}</Txt>
            </View>
          ))}
          {/* Answer the team on the same case, as on the web. */}
          {k.status !== 'closed' && (
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
              <TextInput style={[input, { flex: 1, paddingVertical: 10 }]} value={reply[k.id] ?? ''} onChangeText={v => setReply(x => ({ ...x, [k.id]: v }))}
                placeholder={t.supportReply} placeholderTextColor={p.muted} maxLength={2000} />
              <Button label={t.send} onPress={() => { void answer(k.id); }} disabled={!(reply[k.id] ?? '').trim()} style={{ minWidth: 84 }} />
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

/** Move the account to a new number: a code goes to the new number, and confirming it switches over. */
function ChangeNumber({ onDone }: { onDone: () => void }) {
  const p = usePalette();
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [dev, setDev] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.failed);
  async function request() {
    setError(''); setBusy(true);
    try { const r = await api<{ devCode?: string }>('/me/phone/request', { body: { phone: phone.trim(), lang } }); setDev(r.devCode ?? ''); setStep('code'); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function confirm(value: string) {
    setError(''); setBusy(true);
    try { await api('/me/phone/confirm', { body: { phone: phone.trim(), code: value } }); setDone(true); setStep('idle'); setPhone(''); setCode(''); onDone(); }
    catch (e) { fail(e); setCode(''); } finally { setBusy(false); }
  }
  const input = { height: 50, borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2, paddingHorizontal: space.md, fontSize: 16, fontFamily: font.regular, color: p.ink, backgroundColor: p.paper, writingDirection: 'ltr' as const, textAlign: 'left' as const };
  return (
    <Card style={{ gap: space.sm }}>
      <Txt weight="medium">{t.changeMyNumber}</Txt>
      {done && <Txt size="small" color="green">{t.numberChanged}</Txt>}
      {step === 'idle' ? (
        <>
          <TextInput style={input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+971 50 000 0000" placeholderTextColor={p.muted}
            accessibilityLabel={t.newNumber} autoComplete="off" textContentType="none" />
          <Button label={t.sendNewCode} icon="send" onPress={() => { void request(); }} busy={busy} disabled={phone.replace(/\D/g, '').length < 8} />
        </>
      ) : (
        <>
          <Muted>{t.codeSentTo} <Txt size="small" weight="medium" style={{ writingDirection: 'ltr' }}>{phone}</Txt></Muted>
          <CodeBoxes value={code} label={t.verificationCode} disabled={busy} onChange={v => { setCode(v); if (v.length === 6) void confirm(v); }} />
          {!!dev && (
            <Pressable onPress={() => { setCode(dev); void confirm(dev); }} style={{ alignSelf: 'flex-start' }}>
              <Muted style={{ fontSize: 12 }}>{t.devCodeHint}: <Txt size="small" weight="heavy" style={{ writingDirection: 'ltr' }}>{dev}</Txt></Muted>
            </Pressable>
          )}
          <Button label={t.back} kind="ghost" onPress={() => { setStep('idle'); setCode(''); setError(''); }} />
        </>
      )}
      {!!error && <Txt size="small" color="danger">{error}</Txt>}
      <Muted style={{ fontSize: 12 }}>{t.changeNumberNote}</Muted>
    </Card>
  );
}

interface DataReq { id: number; kind: 'export' | 'delete'; status: string; dueAt: string; response: string | null }
/**
 * Your data: a copy right now (downloaded and handed to the share sheet: save to Files, mail it…),
 * and the formal requests the law gives you (a copy, or erasure), answered by staff with a due date.
 */
function DataRights() {
  const [list, setList] = useState<DataReq[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<DataReq[]>('/me/data-requests').then(setList).catch(() => {});
  useEffect(() => { void load(); }, []);
  async function exportNow() {
    setBusy(true); setMsg('');
    // The server sends a .zip (your messages, files and archive): the name must say so, or iOS offers to open it as text.
    try { await openRemote('/api/me/export', `thekra-my-data-${new Date().toISOString().slice(0, 10)}.zip`, `export-${Date.now()}`); }
    catch (e) { console.warn('[export]', (e as Error)?.message); setMsg(t.failed); } finally { setBusy(false); }
  }
  async function request(kind: 'export' | 'delete') {
    setMsg('');
    try { await api('/me/data-requests', { body: { kind } }); setMsg(t.rightsSent); await load(); }
    catch (e) { setMsg(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.failed); }
  }
  return (
    <Card style={{ gap: space.sm }}>
      <Txt weight="medium">{t.rowRights}</Txt>
      <Button label={t.exportData} icon="down" kind="ghost" onPress={() => { void exportNow(); }} busy={busy} />
      <Muted style={{ fontSize: 12, lineHeight: 18 }}>{t.rightsNote}</Muted>
      <Button label={t.rightsExport} kind="ghost" onPress={() => { void request('export'); }} />
      <Button label={t.rightsDelete} kind="ghost" onPress={() => ask(t.rightsDelete, t.rightsNote, t.rightsDelete, t.cancel, () => { void request('delete'); })} />
      {!!msg && <Txt size="small" color="green">{msg}</Txt>}
      {list.map(r => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Txt size="small" weight="medium" style={{ flex: 1 }}>{t.rightsKind[r.kind] ?? r.kind}</Txt>
          <Badge tone={r.status === 'done' ? 'good' : r.status === 'rejected' ? 'neutral' : 'warn'}>{t.rightsStatus[r.status] ?? r.status}</Badge>
          {r.status === 'open' && <Muted style={{ fontSize: 11, writingDirection: 'ltr' }}>{t.rightsDue} {r.dueAt.slice(0, 10)}</Muted>}
        </View>
      ))}
    </Card>
  );
}

/** A menu row as its own card: a tinted icon tile, the label with a line under it saying what is inside, a chevron. */
function MenuRow({ icon, tint, label, sub, onPress }: { icon: IconName; tint: string; label: string; sub?: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 14, borderRadius: 16, backgroundColor: p.card,
        borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 1), pressed && { backgroundColor: p.greenSoft }]}>
      <View style={{ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: `${tint}1f` }}>
        <Icon name={icon} size={20} color={tint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt weight="medium">{label}</Txt>
        {!!sub && <Muted numberOfLines={1} style={{ fontSize: 13, marginTop: 1 }}>{sub}</Muted>}
      </View>
      <Icon name="chevron" size={16} color={p.muted} rotate={-90} />
    </Pressable>
  );
}

/** The phone number the way people write it (+92 307 2208866), not as stored (+923072208866). */
function prettyPhone(raw?: string) {
  if (!raw) return '';
  try {
    // Loaded here, not at start-up: the library is only needed on this page and at sign-in.
    const { parsePhoneNumberFromString } = require('libphonenumber-js/min') as typeof import('libphonenumber-js/min');
    return parsePhoneNumberFromString(raw)?.formatInternational() ?? raw;
  } catch { return raw; }
}

/**
 * The profile card: the picture in a ring rising out of the top edge, with a camera badge; the name with
 * a pencil; the number; "Member since". The picture is chosen from the camera or the library, cropped
 * square by iOS, and sent to the server, which keeps it for the people who share a circle with you.
 */
function ProfileCard({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const p = usePalette();
  const [photoOpen, setPhotoOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ uri: string } | null>(null);   // the new picture at once, before the server has it
  useEffect(() => { setName(me.name); }, [me.name]);
  const since = me.created_at ? new Date(`${me.created_at.replace(' ', 'T')}Z`).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }) : '';
  const photo = shown ?? avatarSource(me.id, me.avatar_at);

  async function pick(from: 'camera' | 'library') {
    try {
      if (from === 'camera') {
        if (!hasCamera()) { Alert.alert(t.noCamera); return; }
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert(t.cameraOffTitle, t.cameraOffBody, [{ text: t.cancel, style: 'cancel' }, { text: t.openSettings, onPress: () => { void Linking.openSettings(); } }]); return; }
      }
      const opts: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      };
      // The picker opens over this sheet (iOS will not present while a sheet is closing), then the sheet closes.
      const r = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      setPhotoOpen(false);
      if (r.canceled || !r.assets[0]) return;
      const a = r.assets[0];
      setShown({ uri: a.uri }); setBusy(true);
      const form = new FormData();
      form.append('file', { uri: a.uri, name: 'avatar.jpg', type: a.mimeType ?? 'image/jpeg' } as unknown as Blob);
      await apiForm('/me/avatar', form);
      onChanged();
    } catch (e) {
      console.warn('[avatar]', (e as Error)?.message);
      setShown(null); Alert.alert(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.failed);
    } finally { setBusy(false); }
  }
  async function removePhoto() {
    setPhotoOpen(false); setShown(null);
    try { await api('/me/avatar', { method: 'DELETE' }); onChanged(); } catch { Alert.alert(t.failed); }
  }
  async function saveName() {
    const v = name.trim(); if (!v || v === me.name) { setNameOpen(false); return; }
    try { await api('/me', { method: 'PATCH', body: { name: v } }); setNameOpen(false); onChanged(); } catch { Alert.alert(t.failed); }
  }

  return (
    <View style={[{ marginTop: 56, paddingTop: 60, paddingBottom: space.lg, paddingHorizontal: space.lg, alignItems: 'center', borderRadius: 20, backgroundColor: p.card,
      borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, elevation(p, 2)]}>
      {/* The picture, rising out of the card's top edge. */}
      <Pressable onPress={() => setPhotoOpen(true)} accessibilityRole="button" accessibilityLabel={t.profilePhoto} disabled={busy}
        style={[{ position: 'absolute', top: -52, width: 104, height: 104, borderRadius: 52, borderWidth: 4, borderColor: p.card, backgroundColor: p.card,
          alignItems: 'center', justifyContent: 'center' }, elevation(p, 3)]}>
        <Avatar name={me.name} size={96} photo={photo} />
        <View style={{ position: 'absolute', right: -2, bottom: -2, width: 32, height: 32, borderRadius: 16, backgroundColor: p.brand, borderWidth: 3, borderColor: p.card,
          alignItems: 'center', justifyContent: 'center' }}>
          {busy ? <ActivityIndicator size="small" color={p.onBrand} /> : <Icon name="camera" size={15} color={p.onBrand} />}
        </View>
      </Pressable>

      <Pressable onPress={() => setNameOpen(true)} accessibilityRole="button" accessibilityLabel={t.editName} hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Txt size="title" weight="heavy" numberOfLines={1} style={{ fontSize: 24 }}>{me.name}</Txt>
        <Icon name="pen" size={15} color={p.muted} />
      </Pressable>
      <Txt style={{ marginTop: 6, fontSize: 16, color: p.muted, writingDirection: 'ltr', letterSpacing: 0.3 }}>{prettyPhone(me.phone)}</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space.md }}>
        {!!since && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: p.greenSoft }}>
            <Icon name="calendar" size={12} color={p.green} />
            <Text style={{ fontSize: 12, fontFamily: font.medium, color: p.green }}>{t.memberSince.replace('{d}', since)}</Text>
          </View>
        )}
        {!!me.has_pin && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: p.greenSoft }}>
            <Icon name="lock" size={12} color={p.green} />
            <Text style={{ fontSize: 12, fontFamily: font.medium, color: p.green }}>PIN</Text>
          </View>
        )}
      </View>

      <Sheet open={photoOpen} onClose={() => setPhotoOpen(false)} title={t.profilePhoto}>
        <SheetRow icon="camera" label={t.takePhoto} onPress={() => { void pick('camera'); }} />
        <SheetRow icon="image" label={t.choosePhoto} onPress={() => { void pick('library'); }} />
        {!!me.avatar_at && <SheetRow icon="trash" danger label={t.removePhoto} onPress={() => { void removePhoto(); }} />}
      </Sheet>
      <Sheet open={nameOpen} onClose={() => setNameOpen(false)} title={t.editName}>
        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <TextInput value={name} onChangeText={setName} maxLength={60} autoFocus placeholder={t.name} placeholderTextColor={p.muted}
            style={{ height: 50, borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2, paddingHorizontal: space.md, fontSize: 17, fontFamily: font.regular, color: p.ink, backgroundColor: p.paper }} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label={t.cancel} kind="ghost" onPress={() => { setName(me.name); setNameOpen(false); }} style={{ flex: 1 }} />
            <Button label={t.saveName} onPress={() => { void saveName(); }} disabled={!name.trim()} style={{ flex: 1 }} />
          </View>
        </View>
      </Sheet>
    </View>
  );
}
