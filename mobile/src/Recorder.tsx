import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Linking, Platform, Pressable, Text, View } from 'react-native';
import { Icon } from './icons';
import {
  AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import { sendVoice } from './api';
import { t } from './i18n';
import { font, radius, space, text as type, usePalette, NATIVE_DRIVER } from './theme';

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The server refuses anything over five megabytes, which is about this long. */
const MAX_MS = 4 * 60_000;

/**
 * Recording a voice note.
 *
 * Tap to start, tap to send — not hold-to-talk. Holding is fine for a ten second clip and
 * miserable for a grandmother telling a story, which is exactly what this app is for. The
 * recording can also be thrown away, which hold-to-talk makes awkward.
 */
export function Recorder({ circleId, onSent, onCancel }: { circleId: number; onSent: () => void; onCancel: () => void }) {
  const p = usePalette();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);
  const [busy, setBusy] = useState(false);
  const started = useRef(Date.now());
  // The red dot breathes while recording, so it is obvious the microphone is live.
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(blink, { toValue: 0.25, duration: 600, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(blink, { toValue: 1, duration: 600, useNativeDriver: NATIVE_DRIVER }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [blink]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const granted = await AudioModule.requestRecordingPermissionsAsync();
      if (!granted.granted) {
        // iOS asks only once; after a "Don't allow" the only way back is the app's page in Settings.
        Alert.alert(t.micOffTitle, t.micOffBody, [
          { text: t.cancel, style: 'cancel' },
          { text: t.openSettings, onPress: () => { void Linking.openSettings(); } },
        ]);
        onCancel(); return;
      }
      // Without this a recording on iOS is silent, or plays through the earpiece afterwards.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (!alive) return;
      await recorder.prepareToRecordAsync();
      recorder.record();
      started.current = Date.now();
    })().catch(() => onCancel());
    return () => { alive = false; recorder.stop().catch(() => {}); };
  }, []);

  const elapsed = state.durationMillis || (Date.now() - started.current);

  // A clip that runs past the server's size limit is sent rather than lost.
  useEffect(() => { if (elapsed >= MAX_MS && !busy) void finish(); }, [elapsed]);

  async function finish() {
    if (busy) return;
    setBusy(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) { onCancel(); return; }
      const blob = Platform.OS === 'web' ? await (await fetch(uri)).blob() : undefined;
      await sendVoice(circleId, uri, elapsed, blob);
      onSent();
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e as Error)?.message;
      console.warn('[voice] send failed:', code, 'uri:', recorder.uri, 'ms:', elapsed);
      // invalid_audio: the server refused the file (empty, too large, or a type it does not take); the server log says which.
      Alert.alert(code === 'invalid_audio' ? t.voiceEmptyTitle : t.failed, code === 'invalid_audio' ? t.voiceEmptyBody : undefined);
      onCancel();
    } finally {
      setBusy(false);
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
  }

  async function discard() {
    try { await recorder.stop(); } catch { /* nothing recorded */ }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    onCancel();
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xs, minHeight: 48 }}>
      {/* Throwing it away is as easy to reach as sending it: a voice note is often a false start. */}
      <Pressable accessibilityRole="button" accessibilityLabel={t.cancel} onPress={discard} disabled={busy}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="trash" size={22} color={p.danger} />
      </Pressable>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 }}>
        <Animated.View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.danger, opacity: blink }} />
        <Text style={{ fontSize: type.bodyLg, fontFamily: font.medium, color: p.ink, fontVariant: ['tabular-nums'] }}>{mmss(elapsed)}</Text>
        <Text style={{ fontSize: type.small, fontFamily: font.regular, color: p.muted }}>{t.recording}</Text>
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel={t.send} onPress={finish} disabled={busy}
        style={({ pressed }) => [
          { width: 48, height: 48, borderRadius: 24, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center' },
          (pressed || busy) && { opacity: 0.7 },
        ]}>
        <Icon name="send" size={20} color={p.onBrand} />
      </Pressable>
    </View>
  );
}
