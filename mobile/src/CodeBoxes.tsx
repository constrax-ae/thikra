import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ComponentRef } from 'react';
import { elevation, font, radius, space, usePalette } from './theme';

/**
 * Six boxes for a six-digit code, as the web shows it.
 *
 * One hidden field holds the value and the boxes are drawn from it: six real inputs mean
 * six places focus can be, and moving between them on a phone keyboard is miserable. The
 * boxes are a picture of what was typed; the next one to fill is outlined in green.
 */
export function CodeBoxes(
  { value, onChange, disabled, invalid, label, autoFocus = true, secure }:
  { value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean; label: string; autoFocus?: boolean; /** A PIN: dots instead of digits. */ secure?: boolean },
) {
  const p = usePalette();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? '');

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => input.current?.focus()}>
      <View style={{ flexDirection: 'row', gap: space.sm, justifyContent: 'center' }}>
        {digits.map((d, i) => {
          const active = focused && i === Math.min(value.length, 5);
          return (
            <View key={i} style={[{
              flex: 1, maxWidth: 52, height: 58, borderRadius: radius.md + 2, borderWidth: active ? 2 : 1,
              borderColor: invalid ? p.danger : active ? p.green : d ? p.green + '66' : p.line,
              backgroundColor: p.card, alignItems: 'center', justifyContent: 'center',
            }, elevation(p, 1)]}>
              <Text style={{ fontSize: 24, fontFamily: font.heavy, color: p.ink }}>{d && secure ? '•' : d}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={input} value={value} onChangeText={v => onChange(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" maxLength={6} editable={!disabled} autoFocus={autoFocus}
        textContentType="oneTimeCode" autoComplete="sms-otp"
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        accessibilityLabel={label}
        // Off-screen rather than hidden: a display:none field cannot take focus.
        style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
      />
    </Pressable>
  );
}
