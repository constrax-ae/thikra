import { useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { parseWhatsApp, type ParsedChat } from '../../core/whatsapp.ts';
import { buildDraft } from '../../core/importer.ts';
import { defaultAlbumTitle, planAlbum, zipResolver, type AlbumKind } from '../../core/album.ts';
import { ApiError, api, apiForm, type CircleDetail } from './api';
import { lang, t } from './i18n';
import { Icon } from './icons';
import { openZip, type Zip } from './zip';
import { Button, IconButton, Muted, Txt } from './ui';
import { font, radius, space, usePalette } from './theme';

// Importing a family's history from a WhatsApp export, on the phone. As on the web, the file is
// read here and never uploaded: only the events ticked, and the photos and voices chosen for the
// album, reach the server. The parsing and drafting are the shared core/ code, so the phone and
// the web find the same events. A zip can be gigabytes: only its index, the chat text and the
// chosen files are ever read (see zip.ts).

type Sens = 'strict' | 'medium' | 'lenient';
const mb = (n: number) => `${Math.max(1, Math.round(n / 1048576))} MB`;

export function ImportScreen({ circle, open, onClose, onDone }: { circle: CircleDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedChat | null>(null);
  const [zip, setZip] = useState<Zip | null>(null);
  const [sensitivity, setSensitivity] = useState<Sens>(circle.sensitivity);
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const [years, setYears] = useState<Set<number>>(new Set());
  const [kinds, setKinds] = useState<Record<AlbumKind, boolean>>({ image: true, voice: true, video: false });
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ n: number; m: number } | null>(null);
  const cancel = useRef(false);
  const albumId = useRef<number | null>(null);

  const plan = useMemo(() => (parsed ? planAlbum(parsed.messages, zip ? zipResolver(zip.entries.keys()) : () => undefined) : null), [parsed, zip]);
  const draft = useMemo(() => (parsed ? buildDraft(parsed.messages.filter(m => years.has(Number(m.date.slice(0, 4)))), sensitivity) : null), [parsed, sensitivity, years]);
  const wanted = useMemo(() => (plan ? plan.items.filter(i => years.has(i.year) && kinds[i.kind]) : []), [plan, years, kinds]);
  const bytes = useMemo(() => wanted.reduce((n, i) => n + (zip?.entries.get(i.entry)?.usize ?? 0), 0), [wanted, zip]);
  const chosen = draft ? draft.events.filter((_, i) => !unticked.has(i)) : [];
  const fail = (err: unknown) => setError(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic);

  function reset() { zip?.close(); setParsed(null); setZip(null); setFileName(''); setError(''); setResult(''); setUnticked(new Set()); albumId.current = null; }

  async function pick() {
    const r = await DocumentPicker.getDocumentAsync({ type: ['text/plain', 'application/zip', 'public.zip-archive', '*/*'], copyToCacheDirectory: true }).catch(() => null);
    if (!r || r.canceled) return;
    const f = r.assets[0];
    reset(); setFileName(f.name);
    try {
      let text: string, z: Zip | null = null;
      if (/\.zip$/i.test(f.name) || (f.mimeType ?? '').includes('zip')) {
        z = await openZip(f.uri);
        const txt = [...z.entries.values()].filter(x => /\.txt$/i.test(x.name) && x.usize < 50_000_000).sort((a, b) => b.usize - a.usize)[0];
        if (!txt) throw new Error('no chat');
        text = await z.text(txt.name);
      } else {
        const { File } = await import('expo-file-system');
        text = await new File(f.uri).text();
      }
      const chat = parseWhatsApp(text);
      if (chat.messages.length === 0) { z?.close(); setError(t.importUnrecognized); return; }
      setParsed(chat); setZip(z);
      setYears(new Set(chat.messages.map(m => Number(m.date.slice(0, 4)))));
      setTitle(defaultAlbumTitle(chat.range ?? null, lang));
    } catch (e) {
      console.warn('[import] read failed', (e as Error)?.message);
      setError(t.importUnrecognized);
    }
  }

  const toggleYear = (y: number) => { setYears(prev => { const n = new Set(prev); if (n.has(y)) n.delete(y); else n.add(y); return n; }); setUnticked(new Set()); };

  /** Make the album and upload what was chosen, two files at a time; one bad file is skipped, a full vault stops. */
  async function upload() {
    if (!zip || !plan || wanted.length === 0) return;
    setBusy(true); setError(''); cancel.current = false;
    const { File, Paths } = await import('expo-file-system');
    try {
      if (!albumId.current) {
        const r = await api<{ id: number }>(`/circles/${circle.id}/albums`, { body: { title: title.trim() || defaultAlbumTitle(plan.range, lang), source: 'whatsapp', from: plan.range?.from, to: plan.range?.to } });
        albumId.current = r.id;
      }
      let n = 0, stop = false;
      setProgress({ n, m: wanted.length });
      const queue = [...wanted];
      const worker = async () => {
        for (let it = queue.shift(); it && !stop && !cancel.current; it = queue.shift()) {
          const tmp = new File(Paths.cache, `import-${albumId.current}-${n}-${it.file.replace(/[^\w.-]+/g, '_')}`);
          try {
            // Out of the zip into a temporary file: the upload reads it from disk, so memory holds one file at a time.
            tmp.write(await zip.read(it.entry));
            const form = new FormData();
            form.append('file', { uri: tmp.uri, name: it.file, type: 'application/octet-stream' } as unknown as Blob);
            form.append('takenAt', it.takenAt); form.append('sender', it.sender);
            await apiForm(`/albums/${albumId.current}/items`, form);
          } catch (err) {
            if (err instanceof ApiError && (err.code === 'storage_full' || err.code === 'archive_readonly' || err.code === 'forbidden')) { stop = true; fail(err); if (err.code === 'storage_full') setError(t.impFull); }
            else console.warn('[import] skipped', it.file, (err as Error)?.message);
          } finally { try { tmp.delete(); } catch { /* already gone */ } }
          setProgress({ n: ++n, m: wanted.length });
        }
      };
      await Promise.all([worker(), worker()]);
      if (stop) return;
      if (cancel.current) { setError(t.impPartial.replace('{n}', String(n)).replace('{m}', String(wanted.length))); return; }
      setResult(t.impAlbumDone.replace('{n}', String(n)));
      if (chosen.length > 0) await sendEvents();
      onDone();
    } catch (err) { fail(err); } finally { setBusy(false); setProgress(null); }
  }

  async function sendEvents() {
    const r = await api<{ added: number; skipped: number }>(`/circles/${circle.id}/import`, {
      body: { entries: chosen.map(({ date, title: tl, summary, category }) => ({ date, title: tl, summary, category })) },
    });
    setResult(prev => `${prev ? `${prev} · ` : ''}${t.importDone.replace('{a}', String(r.added)).replace('{s}', String(r.skipped))}`);
    zip?.close(); setParsed(null); setZip(null);
  }
  async function eventsOnly() {
    setBusy(true); setError('');
    try { setResult(''); await sendEvents(); onDone(); } catch (err) { fail(err); } finally { setBusy(false); }
  }

  const hasMedia = !!plan && plan.items.length > 0;
  const close = () => { if (busy) return; reset(); onClose(); };

  return (
    <Modal visible={open} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: p.paper, paddingTop: inset.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, minHeight: 56 }}>
          <IconButton name="arrow-back" label={t.back} onPress={close} />
          <Txt size="bodyLg" weight="medium" numberOfLines={1} style={{ flex: 1 }}>{t.importButton}</Txt>
        </View>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: inset.bottom + space.xxl }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="upload" size={22} color={p.green} /></View>
            <View style={{ flex: 1, gap: 4 }}>
              <Txt weight="medium">{t.importWhatsapp}</Txt>
              <Muted style={{ lineHeight: 19 }}>{t.importPrivacy}</Muted>
              <Muted style={{ fontSize: 12, lineHeight: 18 }}>{t.importHow}</Muted>
            </View>
          </View>

          {/* The export to read: a .txt (events only) or a .zip with media (album and events). */}
          <Pressable onPress={busy ? undefined : () => { void pick(); }} accessibilityRole="button" accessibilityLabel={t.importPick}
            style={({ pressed }) => [{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl, borderRadius: radius.lg + 4, borderWidth: 2, borderStyle: 'dashed',
              borderColor: pressed ? p.green : p.line, backgroundColor: pressed ? p.greenSoft : p.card, opacity: busy ? 0.6 : 1 }]}>
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="file" size={24} color={p.green} /></View>
            <Txt weight="heavy" color="green" numberOfLines={1} style={{ paddingHorizontal: space.lg }}>{fileName || t.importPick}</Txt>
            <Muted style={{ fontSize: 12 }}>.txt · .zip</Muted>
          </Pressable>
          {!!error && <Txt size="small" color="danger">{error}</Txt>}
          {!!result && <Txt size="small" color="green">{result}</Txt>}

          {parsed && draft && plan && (
            <>
              <Muted><Text style={{ writingDirection: 'ltr' }}>{parsed.range?.from} → {parsed.range?.to}</Text> · {parsed.messages.length} {t.importMessages}</Muted>
              <Muted style={{ fontSize: 12 }}>{t.importParticipants}: {parsed.senders.slice(0, 6).map(s => s.name).join('، ')}</Muted>

              <Txt size="small" weight="medium">{t.impYearsLbl}</Txt>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {plan.years.map(y => (
                  <Choice key={y.year} on={years.has(y.year)} disabled={busy} onPress={() => toggleYear(y.year)}
                    label={`${y.year}  (${y.image + y.voice}${y.video ? `+${y.video}` : ''})`} />
                ))}
              </View>

              <Section title={t.impAlbumHead} />
              {!hasMedia ? <Muted>{t.impNoMedia}</Muted> : (
                <View style={{ gap: space.sm }}>
                  <Txt size="small" weight="medium">{t.impAlbumName}</Txt>
                  <TextInput value={title} onChangeText={setTitle} maxLength={80} editable={!busy} placeholderTextColor={p.muted}
                    style={{ height: 50, borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2, paddingHorizontal: space.md, fontSize: 16, fontFamily: font.regular, color: p.ink, backgroundColor: p.card }} />
                  {([['image', t.impPhotos], ['voice', t.impVoices], ['video', t.impVideos]] as const).map(([k, label]) => {
                    if (!plan.items.some(i => i.kind === k)) return null;
                    const count = plan.items.filter(i => years.has(i.year) && i.kind === k).length;
                    return <Check key={k} on={kinds[k]} disabled={busy} onPress={() => setKinds(prev => ({ ...prev, [k]: !prev[k] }))} label={`${label} (${count})`} />;
                  })}
                  <Muted style={{ fontSize: 12 }}>
                    {wanted.length} · {t.impSize}: {mb(bytes)}{plan.missing > 0 ? ` · ${plan.missing} ${t.impMissing}` : ''}{plan.notKept > 0 ? ` · ${plan.notKept} ${t.impNotKept}` : ''}
                  </Muted>
                  {progress && (
                    <View style={{ gap: 6 }}>
                      <View style={{ height: 8, borderRadius: 4, backgroundColor: p.line, overflow: 'hidden' }}>
                        <View style={{ width: `${(progress.n / progress.m) * 100}%`, height: '100%', backgroundColor: p.green }} />
                      </View>
                      <Muted style={{ fontSize: 12 }}>{t.impUploading.replace('{n}', String(progress.n)).replace('{m}', String(progress.m))}</Muted>
                    </View>
                  )}
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    <Button label={`${t.impMake} (${wanted.length})`} icon="upload" onPress={() => { void upload(); }} busy={busy && !!progress}
                      disabled={busy || wanted.length === 0 || years.size === 0} style={{ flex: 1 }} />
                    {busy && !!progress && <Button label={t.impCancel} kind="ghost" onPress={() => { cancel.current = true; }} style={{ flex: 1 }} />}
                  </View>
                </View>
              )}

              <Section title={t.impEventsHead} />
              <Txt size="small" weight="medium">{t.sensitivity}</Txt>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {(['strict', 'medium', 'lenient'] as const).map(sv => (
                  <Choice key={sv} on={sensitivity === sv} disabled={busy} onPress={() => { setSensitivity(sv); setUnticked(new Set()); }}
                    label={sv === 'strict' ? t.sensStrict : sv === 'medium' ? t.sensMedium : t.sensLenient} />
                ))}
              </View>
              {draft.events.length === 0 ? <Muted>{t.importNone}</Muted> : draft.events.map((ev, i) => {
                const on = !unticked.has(i);
                return (
                  <Pressable key={`${ev.date}-${i}`} disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                    onPress={() => setUnticked(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    style={{ flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: on ? p.green : p.line }}>
                    <Box on={on} />
                    <View style={{ flex: 1, gap: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <View style={{ paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center', backgroundColor: p.greenSoft }}>
                          <Text style={{ fontSize: 11, fontFamily: font.bold, color: p.green }}>{t.cat[ev.category ?? 'other'] ?? ev.category}</Text>
                        </View>
                        <Muted style={{ fontSize: 12, writingDirection: 'ltr' }}>{ev.date}</Muted>
                        {ev.reactions > 0 && <Muted style={{ fontSize: 12 }}>+{ev.reactions}</Muted>}
                      </View>
                      <Txt size="small" style={{ lineHeight: 20, writingDirection: 'auto' }}>{ev.summary}</Txt>
                    </View>
                  </Pressable>
                );
              })}
              <Button label={`${t.importAdd} (${chosen.length})`} kind="ghost" onPress={() => { void eventsOnly(); }} disabled={busy || chosen.length === 0} />
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Section({ title }: { title: string }) {
  return <Txt weight="heavy" color="green" style={{ marginTop: space.sm }}>{title}</Txt>;
}
function Box({ on }: { on: boolean }) {
  const p = usePalette();
  return (
    <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: on ? p.green : p.line, backgroundColor: on ? p.green : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
      {on && <Icon name="check" size={13} color={p.onBrand} />}
    </View>
  );
}
function Check({ on, label, onPress, disabled }: { on: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 }}>
      <Box on={on} /><Txt size="small">{label}</Txt>
    </Pressable>
  );
}
function Choice({ on, label, onPress, disabled }: { on: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center', borderWidth: 1, borderColor: on ? p.green : p.line, backgroundColor: on ? p.greenSoft : p.card }}>
      <Text style={{ fontSize: 13, fontFamily: on ? font.bold : font.medium, color: on ? p.green : p.muted }}>{label}</Text>
    </Pressable>
  );
}
