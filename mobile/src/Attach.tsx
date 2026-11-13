import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Keyboard, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Paths } from 'expo-file-system';
import { sendFiles } from './api';
import { t } from './i18n';
import { Button, Sheet, SheetRow } from './ui';
import { Icon, type IconName } from './icons';
import { font } from './theme';
import { radius, space, text as type, usePalette } from './theme';

export type Picked = { uri: string; name: string; type: string; blob?: Blob; isVideo: boolean; isFile?: boolean; size?: number };

/** Turn what the picker returned into what the upload needs. */
async function toPicked(a: ImagePicker.ImagePickerAsset): Promise<Picked> {
  const isVideo = a.type === 'video';
  const type = a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg');
  // The name follows the real type: a converted photo keeps "IMG_0111.HEIC" as its file name.
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov' } as Record<string, string>)[type] ?? (isVideo ? 'mp4' : 'jpg');
  const base = (a.fileName ?? `${isVideo ? 'video' : 'photo'}-${Date.now()}`).replace(/\.[^.]+$/, '');
  const name = `${base}.${ext}`;
  console.log('[attach] picked', type, name, a.fileSize ?? '');
  // In a browser the picker hands back a blob URL; on a phone the upload reads the file itself.
  const blob = Platform.OS === 'web' ? await (await fetch(a.uri)).blob() : undefined;
  return { uri: a.uri, name, type, blob, isVideo };
}

export type Source = 'camera' | 'images' | 'videos' | 'files';

/**
 * Whether this phone can take a picture. The iOS Simulator has no camera; its app storage lives
 * under the Mac's CoreSimulator folder, which a real phone's never does.
 */
export function hasCamera(): boolean {
  if (Platform.OS !== 'ios') return Platform.OS === 'android';
  try { return !Paths.document.uri.includes('/CoreSimulator/'); } catch { return true; }
}

/**
 * Open the camera or the library. Returns [] when the person cancels; throws ApiError-like
 * codes the menu turns into a message: 'denied' (permission off), 'no_camera' (a simulator).
 */
export async function pickMedia(kind: Source): Promise<Picked[]> {
  if (kind === 'camera') {
    // Checked BEFORE asking iOS: on a device without a camera, iOS's picker throws a native
    // exception ([UIImagePickerController setSourceType:]) that crashes the app outright.
    if (!hasCamera()) throw new Error('no_camera');
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('denied');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.8, videoMaxDuration: 120 })
      .catch((e: Error) => { throw new Error(/simulator|not available|unavailable/i.test(String(e?.message)) ? 'no_camera' : String(e?.message ?? e)); });
    if (r.canceled) return [];
    return Promise.all(r.assets.map(toPicked));
  }
  if (kind === 'files') {
    // Any document (a PDF, a Word file, a spreadsheet…), up to ten, as the server allows.
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
    if (r.canceled) return [];
    return r.assets.slice(0, 10).map(a => ({ uri: a.uri, name: a.name, type: a.mimeType ?? 'application/octet-stream', isVideo: false, isFile: true, size: a.size ?? undefined }));
  }
  // The library needs no permission on iOS 14+ (the system picker shows only what is chosen).
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: [kind], quality: 0.8,
    // iPhones keep photos as HEIC, which no browser shows and the server files as a document:
    // "compatible" makes iOS hand back a JPEG (and an H.264 video), smaller as well.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    // A family sends the four photos from the wedding, not one at a time.
    allowsMultipleSelection: kind === 'images', selectionLimit: 10,
  });
  if (r.canceled) return [];
  return Promise.all(r.assets.map(toPicked));
}

/**
 * What was picked, before it is sent.
 *
 * The web lets you write a caption with an attachment and the phone did not, so a photo
 * arrived with no word about what it is. Everything picked is shown first, with one caption
 * for the batch, and can still be thrown away.
 */
export function AttachTray(
  { circleId, items, replyTo, onClose, onSent }:
  { circleId: number; items: Picked[]; replyTo?: number; onClose: () => void; onSent: () => void },
) {
  const p = usePalette();
  const [caption, setCaption] = useState('');

  // What the tray shows: kept while it slides away, so the count never reads 0 as it closes.
  const [shownItems, setShownItems] = useState(items);
  useEffect(() => { if (items.length) setShownItems(items); }, [items]);
  // Send closes the tray at once, like any messenger; the upload finishes in the background
  // (the photo appears through the live update) and only a failure comes back as a message.
  async function send() {
    if (!items.length) return;
    const batch = items, text = caption;
    Keyboard.dismiss();
    setCaption('');
    onClose();
    try { await sendFiles(circleId, batch, { caption: text, replyTo }); onSent(); }
    catch (e) { console.warn('[attach] send failed', (e as Error)?.message); Alert.alert(t.failed); }
  }

  return (
    <Sheet open={items.length > 0} onClose={onClose}
      title={shownItems.length === 1 ? (shownItems[0].isFile ? t.attachFile : shownItems[0].isVideo ? t.attachVideo : t.attachPhoto) : t.attachCount.replace('{n}', String(shownItems.length))}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: space.sm }}>
        {shownItems.map((it, i) => (
          <View key={`${it.uri}-${i}`} style={{ width: 110, height: 110, borderRadius: radius.md, overflow: 'hidden', backgroundColor: p.line }}>
            {it.isFile ? (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.sm, gap: 6, backgroundColor: p.greenSoft }}>
                <Icon name="file" size={30} color={p.green} />
                <Text numberOfLines={2} style={{ fontSize: 11, fontFamily: font.medium, color: p.ink, textAlign: 'center' }}>{it.name}</Text>
              </View>
            ) : <Image source={{ uri: it.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" accessibilityLabel={it.name} />}
            {it.isVideo && (
              <View style={{ position: 'absolute', right: 6, bottom: 6, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: 'rgba(0,0,0,0.55)' }}>
                <Icon name="play" size={12} color="#fff" />
              </View>
            )}
          </View>
        ))}
      </ScrollView>

      <TextInput
        value={caption} onChangeText={setCaption} placeholder={t.addCaption} placeholderTextColor={p.muted}
        accessibilityLabel={t.addCaption} multiline maxLength={4000} autoComplete="off" textContentType="none" importantForAutofill="no"
        // A multiline field on iOS starts its text at the top, and a set lineHeight adds its extra
        // space ABOVE the text (which pushed it low). The font's own ~20pt line, with padding sized
        // to it, sits a single line (and the placeholder) in the middle of the 50pt box.
        style={{ minHeight: 50, maxHeight: 120, borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2,
          paddingHorizontal: space.md, paddingTop: 14, paddingBottom: 14, fontSize: 16, fontFamily: font.regular, color: p.ink,
          backgroundColor: p.paper, marginTop: space.sm, textAlignVertical: 'center' }}
      />

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
        <Button label={t.cancel} kind="ghost" onPress={onClose} style={{ flex: 1 }} />
        <Button label={t.send} onPress={send} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

/**
 * The choice of what to attach, from the bottom where a thumb is.
 *
 * iOS will not present a screen while another is closing, so the picker opens over this sheet,
 * and the preview tray opens only once the sheet has fully gone (Sheet's onClosed).
 */
export function AttachMenu({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (items: Picked[]) => void }) {
  const p = usePalette();
  const busy = useRef(false);
  // What was picked waits here until this sheet has fully gone; then the preview tray may open.
  const pending = useRef<Picked[] | null>(null);
  const choose = async (kind: Source) => {
    if (busy.current) return;
    busy.current = true;
    try {
      // The picker opens ON TOP of this sheet, which stays up: iOS refuses to present anything
      // while a screen is closing, which is why closing first made the rows do nothing.
      const got = await pickMedia(kind);
      console.log('[attach]', kind, got.length ? `${got.length} picked` : 'cancelled');
      if (got.length) pending.current = got;
      onClose();
    } catch (e) {
      const code = (e as Error)?.message;
      console.warn('[attach]', kind, code);
      if (code === 'denied') {
        Alert.alert(t.cameraOffTitle, t.cameraOffBody, [
          { text: t.cancel, style: 'cancel' },
          { text: t.openSettings, onPress: () => { void Linking.openSettings(); } },
        ]);
      } else Alert.alert(code === 'no_camera' ? t.noCamera : t.failed);
    } finally { busy.current = false; }
  };
  const closed = () => { const got = pending.current; pending.current = null; if (got) onPick(got); };
  const tiles: Array<[Source, IconName, string]> = [['camera', 'camera', t.attachCamera], ['images', 'image', t.attachPhoto], ['videos', 'video', t.attachVideo], ['files', 'file', t.attachFile]];
  return (
    <Sheet open={open} onClose={onClose} onClosed={closed} title={t.attachTitle}>
      <View style={{ flexDirection: 'row', gap: space.sm, paddingBottom: space.md }}>
        {tiles.map(([kind, icon, label]) => (
          <Pressable key={kind} onPress={() => { void choose(kind); }} accessibilityRole="button" accessibilityLabel={label}
            style={({ pressed }) => [{ flex: 1, alignItems: 'center', gap: space.sm, paddingVertical: space.lg, borderRadius: radius.lg,
              backgroundColor: pressed ? p.greenSoft : p.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }]}>
            <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon} size={24} color={p.green} />
            </View>
            <Text style={{ fontSize: 14, fontFamily: font.medium, color: p.ink }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}
