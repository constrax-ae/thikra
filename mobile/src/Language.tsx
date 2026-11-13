import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { api } from './api';
import { LANG_INFO, SUPPORTED, isRtl, lang, machine, setLang, t, useLang, type Lang } from './i18n';
import { Icon } from './icons';
import { elevation, radius, space, usePalette } from './theme';
import { Field, Muted, Sheet, Txt } from './ui';

/**
 * The language control, the web's LangPicker: a pill with the globe and the current
 * language's own name, opening a searchable sheet of all 21. Each language is listed in its
 * own script; the current one first, then the two originals, then the machine translations.
 * Signed in, the choice is also saved on the account (the web does the same).
 */
export function LangButton({ signedIn }: { signedIn?: boolean }) {
  const p = usePalette();
  const current = useLang();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={t.languageTitle}
        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 42, paddingHorizontal: space.md + 2,
          borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, backgroundColor: p.card }, elevation(p, 1),
          pressed && { backgroundColor: p.greenSoft }]}>
        <Icon name="globe" size={17} color={p.muted} />
        <Txt weight="medium">{LANG_INFO[current].name}</Txt>
        <Icon name="chevron" size={15} color={p.muted} />
      </Pressable>
      <LangSheet open={open} onClose={() => setOpen(false)} signedIn={signedIn} />
    </>
  );
}

export function LangSheet({ open, onClose, signedIn }: { open: boolean; onClose: () => void; signedIn?: boolean }) {
  const p = usePalette();
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? SUPPORTED.filter(l => LANG_INFO[l].name.toLowerCase().includes(needle) || l.includes(needle)) : SUPPORTED;
    const rank = (l: Lang) => (l === lang ? 0 : LANG_INFO[l].machine ? 2 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [q, open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (l: Lang) => {
    onClose(); setQ('');
    if (l === lang) return;
    if (signedIn) api('/me', { method: 'PATCH', body: { lang: l } }).catch(() => {});
    void setLang(l);
  };

  return (
    <Sheet open={open} onClose={onClose} title={t.languageTitle}>
      <View style={{ paddingBottom: space.sm }}>
        <Field icon="search" value={q} onChange={setQ} placeholder={t.searchLanguage} autoCorrect={false} />
      </View>
      {shown.length === 0 && <Muted style={{ textAlign: 'center', padding: space.lg }}>{t.noResults}</Muted>}
      {shown.map(l => (
        <Pressable key={l} onPress={() => pick(l)} accessibilityRole="button" accessibilityState={{ selected: l === lang }}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 54, paddingHorizontal: space.md, borderRadius: radius.md },
            (pressed || l === lang) && { backgroundColor: p.greenSoft }]}>
          {/* Aligned to the interface's side, not each name's script, so Arabic and Urdu don't leave the list ragged (the web's <bdi>). */}
          <Txt size="bodyLg" weight={l === lang ? 'heavy' : 'regular'} style={{ flex: 1, textAlign: isRtl ? 'right' : 'left' }}>{LANG_INFO[l].name}</Txt>
          {LANG_INFO[l].machine && <Muted style={{ fontSize: 11 }}>AI</Muted>}
          {l === lang && <Icon name="check" size={18} color={p.green} />}
        </Pressable>
      ))}
    </Sheet>
  );
}

/** For a machine-translated language: the original (Arabic or English) prevails. Nothing for those two. */
export function MachineNote() {
  const p = usePalette();
  useLang();
  if (!machine) return null;
  return (
    <View style={{ padding: space.sm + 2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, backgroundColor: p.card }}>
      <Muted style={{ fontSize: 12, lineHeight: 17 }}>{t.legalNote}</Muted>
    </View>
  );
}
