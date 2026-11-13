import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { hasCamera } from './Attach';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { api, apiForm, ApiError, type Chat, type CircleDetail } from './api';
import { locale, t } from './i18n';
import { Icon, type IconName } from './icons';
import { DateTimeSheet } from './DatePicker';
import { MachineNote } from './Language';
import { Badge, Button, Card, EnvelopeSkeleton, FadeIn, Field, IconButton, IconTile, Muted, Picker, Toggle, Txt } from './ui';
import { elevation, font, radius, space, usePalette } from './theme';
import { toDate } from './Bubble';

type Trigger = 'date' | 'event' | 'death';
interface Sealed {
  id: number; circleId: number; circleName: string; trigger: Trigger; occasion: string | null; kind: 'text' | 'voice' | 'video' | 'image';
  body: string; fileName: string | null; unlockAt: string | null; yearly: boolean; status: 'sealed' | 'waiting' | 'stopped';
  releaseAt: string | null; note: string | null; recipient: string | null;
}
interface Evidence { messages: number; members: number; needMessages: number; needMembers: number }
interface Envelopes {
  total: number; deathEnabled?: boolean; waitHours: number; agentActive: boolean;
  events: Array<{ id: number; author: string; waiting: boolean; releaseAt: string | null; evidence: Evidence; canStop: boolean }>;
  deaths: Array<{ authorId: number; author: string; count: number; waiting: boolean; releaseAt: string | null; evidence: Evidence; canStop: boolean }>;
}
type Attached = { uri: string; name: string; type: string; kind: 'voice' | 'video' | 'image'; ms: number | null };

const clock = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const errText = (e: unknown) => { const c = e instanceof ApiError ? e.code : 'generic'; return c === 'offline' ? t.offline : t.errors[c] ?? t.errors.generic; };

/**
 * Sealed letters: write today, delivered on the day — the web's page (web/src/Sealed.tsx)
 * for the phone. The disclosure comes first, because this version keeps the content on
 * Thekra's servers. Then the family's waiting envelopes, the form, and your own letters.
 */
export function SealedScreen({ me, onBack, circleId }: { me: { id: number }; onBack: () => void; circleId?: number }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const [circles, setCircles] = useState<Chat[]>([]);
  const [mine, setMine] = useState<Sealed[] | null>(null);
  const [circle, setCircle] = useState<number | null>(circleId ?? null);
  const [members, setMembers] = useState<CircleDetail['members']>([]);
  const [env, setEnv] = useState<Envelopes | null>(null);
  const [trigger, setTrigger] = useState<Trigger>('date');
  const [to, setTo] = useState(0);   // 0 = the whole circle
  const [dates, setDates] = useState<Array<Date | null>>([null]);
  const [editingDate, setEditingDate] = useState<number | null>(null);
  const [occasion, setOccasion] = useState('');
  const [yearly, setYearly] = useState(false);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<Attached | null>(null);
  const [picker, setPicker] = useState<null | 'circle' | 'to'>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = () => api<Sealed[]>('/me/sealed').then(setMine).catch(() => setMine(l => l ?? []));
  const loadEnv = (c: number | null) => (c == null ? setEnv(null) : api<Envelopes>(`/circles/${c}/sealed-envelopes`).then(setEnv).catch(() => setEnv(null)));
  useEffect(() => {
    api<Chat[]>('/circles').then(l => { const c = l.filter(x => x.kind !== 'direct'); setCircles(c); setCircle(cur => cur ?? c[0]?.id ?? null); }).catch(() => {});
    load();
  }, []);
  useEffect(() => {
    if (circle == null) return;
    api<CircleDetail>(`/circles/${circle}`).then(d => setMembers(d.members.filter(m => m.id !== me.id))).catch(() => setMembers([]));
    setTo(0); loadEnv(circle);
  }, [circle, me.id]);

  async function chooseMedia() {
    setError('');
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 }).catch(() => null);
    if (!r || r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    const video = a.type === 'video';
    setFile({ uri: a.uri, name: a.fileName ?? (video ? 'video.mp4' : 'photo.jpg'), type: a.mimeType ?? (video ? 'video/mp4' : 'image/jpeg'), kind: video ? 'video' : 'image', ms: a.duration ?? null });
  }

  /**
   * A video message recorded now, for the letter. Checked for a camera first: on a device without one
   * (the iOS Simulator) iOS's picker throws a native exception that would crash the app. Medium quality
   * and five minutes keep a recording under the server's 64 MB for a letter.
   */
  async function recordVideo() {
    setError('');
    if (!hasCamera()) { Alert.alert(t.noCamera); return; }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(t.cameraOffTitle, t.cameraOffBody, [{ text: t.cancel, style: 'cancel' }, { text: t.openSettings, onPress: () => { void Linking.openSettings(); } }]);
      return;
    }
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ['videos'], videoMaxDuration: 300,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    }).catch(e => { console.warn('[sealed] camera', (e as Error)?.message); return null; });
    if (!r || r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    if (a.fileSize && a.fileSize > 64 * 1024 * 1024) { setError(t.errors.attachment_too_large); return; }
    setFile({ uri: a.uri, name: a.fileName ?? `letter-${Date.now()}.mov`, type: a.mimeType ?? 'video/quicktime', kind: 'video', ms: a.duration ?? null });
  }

  async function seal() {
    if (circle == null) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const fd = new FormData();
      if (file) { fd.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob); if (file.ms) fd.append('duration', String(Math.round(file.ms))); }
      fd.append('body', body); fd.append('trigger', trigger); if (occasion.trim()) fd.append('occasion', occasion.trim());
      if (trigger === 'date') {
        fd.append('dates', JSON.stringify(dates.map(d => d!.toISOString())));
        if (yearly && dates.length === 1) fd.append('yearly', 'true');
        if (to) fd.append('recipientId', String(to));
      }
      await apiForm(`/circles/${circle}/sealed`, fd);
      setBody(''); setDates([null]); setOccasion(''); setYearly(false); setFile(null); setMsg(t.sealedDone); load(); loadEnv(circle);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const act = async (path: string, method = 'POST') => {
    try { await api(path, { method, body: method === 'DELETE' ? undefined : {} }); } catch (e) { setError(errText(e)); }
    load(); loadEnv(circle);
  };

  const min = new Date(Date.now() + 10 * 60_000);
  const dt = (iso: string) => toDate(iso).toLocaleString(locale(), { dateStyle: 'long', timeStyle: 'short' });
  const canSeal = (!!file || !!body.trim()) && circle != null && (trigger !== 'date' || dates.every(Boolean)) && (trigger !== 'event' || !!occasion.trim());
  const triggers: Array<[Trigger, string, IconName]> = [['date', t.trigDate, 'calendar'], ['event', t.trigEvent, 'sparkle'], ...(env?.deathEnabled ? [['death', t.trigDeath, 'heart'] as [Trigger, string, IconName]] : [])];
  const circleName = circles.find(c => c.id === circle)?.name ?? '';
  const toName = to ? members.find(m => m.id === to)?.name ?? '' : t.sealedWhole;

  return (
    <View style={{ flex: 1, backgroundColor: p.paper }}>
      <View style={[s.head(p), { paddingTop: inset.top + 4 }]}>
        <IconButton name="arrow-back" label={t.back} onPress={onBack} />
        <IconTile name="lock" size={38} />
        <Txt size="title" weight="medium" style={{ flex: 1 }} numberOfLines={1}>{t.sealedTitle}</Txt>
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: inset.bottom + space.xxl }} keyboardShouldPersistTaps="handled">
        <Muted style={{ fontSize: 15, lineHeight: 22 }}>{t.sealedIntro}</Muted>
        {/* Honest first: the content sits on the server until it opens. */}
        <View style={{ padding: space.md, borderRadius: radius.md + 2, backgroundColor: '#c79a3b1f', borderWidth: 1, borderColor: '#c79a3b66', flexDirection: 'row', gap: space.sm }}>
          <Icon name="alert" size={18} color={p.goldDark} />
          <Txt size="small" style={{ flex: 1, lineHeight: 20 }}>{t.sealedDisclosure}</Txt>
        </View>
        <MachineNote />

        {/* The family's side: envelopes waiting for an event or for sad news — never any content. */}
        {env && env.total > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="envelope" size={16} color={p.goldDark} /><Txt size="small" color="goldDark">{t.sealedCount.replace('{n}', String(env.total))}</Txt>
          </View>
        )}
        {env && (env.events.length > 0 || env.deaths.length > 0) && (
          <Card style={{ gap: space.md }}>
            <Txt weight="medium" color="green">{t.envelopesTitle}</Txt>
            {!env.agentActive && <Txt size="small" color="danger">{t.agentOffWarning}</Txt>}
            {env.events.map(ev => (
              <View key={ev.id} style={{ gap: 6 }}>
                <Txt size="small"><Txt size="small" weight="heavy">{ev.author}</Txt> — {t.trigEvent}</Txt>
                <Muted>{ev.waiting ? `${t.countdownEvent.replace('{h}', String(env.waitHours / 24))} ${ev.releaseAt ? dt(ev.releaseAt) : ''}` : `${t.evidenceSoFar}: ${ev.evidence.messages}/${ev.evidence.needMessages} ${t.evMessages} · ${ev.evidence.members}/${ev.evidence.needMembers} ${t.evMembers}`}</Muted>
                {ev.canStop && <Button label={t.stopCountdown} kind="soft" onPress={() => act(`/sealed/${ev.id}/stop`)} />}
              </View>
            ))}
            {env.deaths.map(d => (
              <View key={d.authorId} style={{ gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line, paddingTop: space.sm }}>
                <Txt size="small"><Txt size="small" weight="heavy">{d.author}</Txt> — {d.count} {t.afterDeathLetters}</Txt>
                <Txt size="small" color={d.waiting ? 'danger' : 'muted'}>{d.waiting ? `${t.deathCountdown.replace('{h}', String(env.waitHours / 24))} ${d.releaseAt ? dt(d.releaseAt) : ''}` : `${t.evidenceSoFar}: ${d.evidence.messages}/${d.evidence.needMessages} ${t.evMessages} · ${d.evidence.members}/${d.evidence.needMembers} ${t.evMembers}`}</Txt>
                {d.canStop && <Button label={d.authorId === me.id ? t.imAlive : t.stopCountdown} kind="soft" onPress={() => act(`/circles/${circle}/sealed/death/${d.authorId}/stop`)} />}
              </View>
            ))}
          </Card>
        )}

        {/* Write a letter. */}
        <Card style={{ gap: space.lg }}>
          <Select label={t.sealedCircle} value={circleName} onPress={() => setPicker('circle')} />

          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {triggers.map(([k, label, ic]) => {
                const on = trigger === k;
                return (
                  <Pressable key={k} onPress={() => setTrigger(k)} accessibilityRole="button" accessibilityState={{ selected: on }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: space.md, borderRadius: radius.pill,
                      borderWidth: 1, borderColor: on ? p.green : p.line, backgroundColor: on ? p.greenSoft : p.card }}>
                    <Icon name={ic} size={15} color={on ? p.green : p.muted} />
                    <Txt size="small" weight={on ? 'heavy' : 'medium'} color={on ? 'green' : 'ink'}>{label}</Txt>
                  </Pressable>
                );
              })}
            </View>
            <Muted>{trigger === 'date' ? t.trigDateHelp : trigger === 'event' ? t.trigEventHelp : t.trigDeathHelp}</Muted>
          </View>

          <Field label={`${t.occasionLabel}${trigger === 'event' ? ' *' : ''}`} value={occasion} onChange={setOccasion} placeholder={t.occasionHint} maxLength={80} />

          {trigger === 'date' && (
            <>
              <View style={{ gap: space.sm }}>
                <Txt size="small" weight="medium">{dates.length > 1 ? t.sealedWhenMany : t.sealedWhen}</Txt>
                {dates.map((d, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                    <Pressable onPress={() => setEditingDate(i)} accessibilityRole="button"
                      style={({ pressed }) => [s.select(p), { flex: 1 }, pressed && { borderColor: p.green }]}>
                      <Icon name="calendar" size={18} color={p.muted} />
                      <Txt weight={d ? 'medium' : 'regular'} color={d ? 'ink' : 'muted'} style={{ flex: 1 }}>{d ? d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : t.sealedWhen}</Txt>
                    </Pressable>
                    {dates.length > 1 && <IconButton name="x" label={t.sealedRemoveDate} tone="soft" size={50} onPress={() => setDates(x => x.filter((_, j) => j !== i))} />}
                  </View>
                ))}
                {dates.length < 12 && (
                  <Pressable onPress={() => setDates(x => [...x, null])} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 6 }}>
                    <Icon name="plus" size={16} color={p.green} /><Txt size="small" weight="heavy" color="green">{t.sealedAddDate}</Txt>
                  </Pressable>
                )}
              </View>
              {dates.length === 1 && <Toggle value={yearly} onChange={setYearly} label={t.sealedYearly} />}
              <Select label={t.sealedTo} value={toName} onPress={() => setPicker('to')} />
            </>
          )}

          <View style={{ gap: space.sm }}>
            <Txt size="small" weight="medium">{t.letterContent}</Txt>
            {!file && <VoiceRecorder onDone={setFile} onError={setError} />}
            {!file && (
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button label={t.recordVideo} icon="video" kind="ghost" onPress={() => { void recordVideo(); }} style={{ flex: 1 }} />
                <Button label={t.chooseFile} icon="attach" kind="ghost" onPress={chooseMedia} style={{ flex: 1 }} />
              </View>
            )}
            {file && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md + 2, borderWidth: 1, borderColor: p.line, backgroundColor: p.paper }}>
                {file.kind === 'image' ? <Image source={{ uri: file.uri }} style={{ width: 56, height: 56, borderRadius: radius.md }} />
                  : <IconTile name={file.kind === 'voice' ? 'mic' : 'video'} size={56} />}
                <View style={{ flex: 1 }}>
                  <Txt weight="medium" numberOfLines={1}>{file.kind === 'voice' ? t.recordVoice : file.name}</Txt>
                  {!!file.ms && <Muted>{clock(file.ms)}</Muted>}
                </View>
                <IconButton name="trash" label={t.removeFile} onPress={() => setFile(null)} />
              </View>
            )}
            <TextInput value={body} onChangeText={setBody} multiline maxLength={4000} placeholder={file ? t.captionHint : t.sealedText} placeholderTextColor={p.muted}
              style={{ minHeight: file ? 70 : 130, borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2, padding: space.md, fontSize: 16, fontFamily: font.regular,
                color: p.ink, backgroundColor: p.card, textAlignVertical: 'top', ...({ outlineStyle: 'none' } as object) }} />
          </View>

          <Muted style={{ fontSize: 12 }}>{t.openedForever}</Muted>
          {!!error && <Txt size="small" color="danger" accessibilityRole="alert">{error}</Txt>}
          {!!msg && <Txt size="small" color="green">{msg}</Txt>}
          <Button label={t.sealedSeal} icon="lock" onPress={seal} busy={busy} disabled={!canSeal} />
        </Card>

        {/* My letters, each an envelope whose wax seal shows its state. */}
        <View style={{ gap: space.sm }}>
          <Txt weight="medium" color="green">{t.sealedMine}</Txt>
          {mine === null && <EnvelopeSkeleton />}
          {mine !== null && mine.length === 0 && <Card><Muted>{t.sealedNone}</Muted></Card>}
          {(mine ?? []).map((l, i) => <Envelope key={l.id} l={l} delay={i * 40} dt={dt} onOpen={() => act(`/sealed/${l.id}/open`)}
            onCancel={() => Alert.alert(t.sealedCancel, l.occasion ?? '', [{ text: t.cancel, style: 'cancel' }, { text: t.sealedCancel, style: 'destructive', onPress: () => act(`/sealed/${l.id}`, 'DELETE') }])} />)}
        </View>
      </ScrollView>

      <Picker open={picker === 'circle'} onClose={() => setPicker(null)} title={t.sealedCircle} value={circle ?? 0}
        options={circles.map(c => ({ value: c.id, label: c.name }))} onPick={v => setCircle(v)} />
      <Picker open={picker === 'to'} onClose={() => setPicker(null)} title={t.sealedTo} value={to}
        options={[{ value: 0, label: t.sealedWhole }, ...members.map(m => ({ value: m.id, label: m.name }))]} onPick={setTo} />
      <DateTimeSheet open={editingDate !== null} title={t.sealedWhen} min={min} value={editingDate !== null ? dates[editingDate] : null}
        onClose={() => setEditingDate(null)} onPick={d => setDates(x => x.map((v, j) => (j === editingDate ? d : v)))} />
    </View>
  );
}

/** A labelled value that opens a sheet to change it. */
function Select({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <Txt size="small" weight="medium">{label}</Txt>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} style={({ pressed }) => [s.select(p), pressed && { borderColor: p.green }]}>
        <Txt weight="medium" style={{ flex: 1 }} numberOfLines={1}>{value}</Txt>
        <Icon name="chevron" size={18} color={p.muted} />
      </Pressable>
    </View>
  );
}

/** Record a voice letter: tap to start, tap to stop; the take can be thrown away. */
function VoiceRecorder({ onDone, onError }: { onDone: (f: Attached) => void; onError: (m: string) => void }) {
  const p = usePalette();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);
  const [on, setOn] = useState(false);
  const started = useRef(0);
  async function start() {
    const g = await AudioModule.requestRecordingPermissionsAsync();
    if (!g.granted) { onError(t.micDenied); return; }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync(); recorder.record(); started.current = Date.now(); setOn(true);
  }
  async function stop() {
    await recorder.stop(); setOn(false);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    if (recorder.uri) onDone({ uri: recorder.uri, name: `letter-${Date.now()}.m4a`, type: 'audio/mp4', kind: 'voice', ms: state.durationMillis || Date.now() - started.current });
  }
  if (on) {
    return (
      <Pressable onPress={stop} accessibilityRole="button" accessibilityLabel={t.stop}
        style={[{ minHeight: 50, borderRadius: radius.md + 2, backgroundColor: p.dangerFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm }, elevation(p, 1)]}>
        <Icon name="stop" size={18} color="#fff" />
        <Txt weight="medium" style={{ color: '#fff' }}>{t.stop} · {clock(state.durationMillis || 0)}</Txt>
      </Pressable>
    );
  }
  return <Button label={t.recordVoice} icon="mic" kind="ghost" onPress={() => { start().catch(() => onError(t.micDenied)); }} />;
}

/** One of my letters: an envelope with a wax seal (gold while waiting, red in the family's countdown, spent once stopped). */
function Envelope({ l, delay, dt, onOpen, onCancel }: { l: Sealed; delay: number; dt: (iso: string) => string; onOpen: () => void; onCancel: () => void }) {
  const p = usePalette();
  const seal = l.status === 'waiting' ? p.dangerFill : l.status === 'stopped' ? p.mutedFill : '#a8811f';
  const kindIcon: IconName = l.kind === 'voice' ? 'mic' : l.kind === 'video' ? 'video' : l.kind === 'image' ? 'image' : 'envelope';
  const trig = l.trigger === 'date' ? (l.unlockAt ? dt(l.unlockAt) : '') : l.trigger === 'event' ? `${t.trigEvent}: ${l.occasion ?? ''}` : t.trigDeath;
  return (
    <FadeIn delay={delay}>
      <View style={[{ flexDirection: 'row', gap: space.md, padding: space.md + 2, borderRadius: radius.lg + 2, backgroundColor: p.card,
        borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, borderStartWidth: 4, borderStartColor: p.gold, opacity: l.status === 'stopped' ? 0.7 : 1 }, elevation(p, 1)]}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: seal, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#ffffff33' }}>
          <Icon name={l.status === 'stopped' ? 'ban' : 'lock'} size={17} color="#fff" />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Icon name={kindIcon} size={13} color={p.muted} />
            <Muted style={{ fontSize: 12 }}>{l.circleName} → {l.recipient ?? t.sealedWhole}</Muted>
            {l.yearly && <Badge tone="good">{t.sealedYearlyTag}</Badge>}
            {l.status === 'waiting' && <Badge tone="bad">{t.deathWaiting}</Badge>}
            {l.status === 'stopped' && <Badge tone="bad">{t.sealedStopped}</Badge>}
          </View>
          <Muted style={{ fontSize: 12 }}>{trig}</Muted>
          {!!l.occasion && l.trigger !== 'event' && <Txt weight="medium">{l.occasion}</Txt>}
          {l.status === 'sealed' && <Countdown at={l.unlockAt} />}
          {l.status === 'waiting' && <Countdown at={l.releaseAt} urgent />}
          {l.kind !== 'text' && !!l.fileName && <Txt size="small">{l.fileName}</Txt>}
          {!!l.body && <Txt size="small" style={{ lineHeight: 20 }}>{l.body}</Txt>}
          <View style={{ flexDirection: 'row', gap: space.lg, paddingTop: 4 }}>
            {l.trigger !== 'death' && l.status === 'sealed' && <Pressable onPress={onOpen} hitSlop={6}><Txt size="small" weight="medium" color="green">{t.openNow}</Txt></Pressable>}
            {l.status !== 'waiting' && <Pressable onPress={onCancel} hitSlop={6}><Txt size="small" weight="medium" color="danger">{t.sealedCancel}</Txt></Pressable>}
          </View>
        </View>
      </View>
    </FadeIn>
  );
}

/** How long a letter still waits, in the reader's language (Intl handles plurals). */
function Countdown({ at, urgent }: { at: string | null; urgent?: boolean }) {
  if (!at) return null;
  const ms = toDate(at).getTime() - Date.now();
  if (ms <= 0) return null;
  let when: string;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    const days = Math.round(ms / 86_400_000);
    when = days >= 1 ? rtf.format(days, 'day') : rtf.format(Math.round(ms / 3_600_000), 'hour');
  } catch { when = toDate(at).toLocaleDateString(locale()); }
  return <Txt size="caption" weight={urgent ? 'heavy' : 'medium'} color={urgent ? 'danger' : 'goldDark'}>{t.opensLabel} {when}</Txt>;
}

const s = {
  head: (p: ReturnType<typeof usePalette>) => ({ flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.sm, backgroundColor: p.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.line }),
  select: (p: ReturnType<typeof usePalette>) => ({ minHeight: 50, flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.sm, paddingHorizontal: space.md + 2, borderRadius: radius.md + 2, borderWidth: 1, borderColor: p.line, backgroundColor: p.card }),
};
