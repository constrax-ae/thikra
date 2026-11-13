import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FORWARD, Icon, type IconName } from './icons';
import { dur, elevation, font, radius, space, useText, usePalette, type Palette, NATIVE_DRIVER } from './theme';

/**
 * The controls every screen shares — the phone's copy of the web's design system
 * (web/src/styles.css + States.tsx). One place for type, buttons, avatars, sheets and
 * loading states, so every screen looks like the same product as the website.
 */

type Size = keyof ReturnType<typeof useText>;
type Weight = keyof typeof font;
type Tone = keyof Palette;

// ---- text ----------------------------------------------------------------------------

/** All text goes through here so the font, scale (large-text setting) and colour tokens apply. */
export function Txt(
  { children, size = 'body', weight = 'regular', color = 'ink', style, ...rest }:
  { children?: ReactNode; size?: Size; weight?: Weight; color?: Tone; style?: StyleProp<TextStyle> }
  & Omit<React.ComponentProps<typeof Text>, 'style' | 'children'>,
) {
  const p = usePalette();
  const type = useText();
  return (
    <Text style={[{ fontFamily: font[weight], fontSize: type[size], color: p[color] as string, lineHeight: Math.round(type[size] * 1.4) }, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Txt size="display" weight="medium" style={[{ letterSpacing: -0.4 }, style]}>{children}</Txt>;
}

export function Muted({ children, style, ...rest }: { children: ReactNode; style?: StyleProp<TextStyle> } & Omit<React.ComponentProps<typeof Text>, 'style' | 'children'>) {
  return <Txt size="small" color="muted" style={style} {...rest}>{children}</Txt>;
}

/** The small uppercase label over a heading ("YOUR PEOPLE"). */
export function Eyebrow({ children, color = 'muted', style }: { children: ReactNode; color?: Tone; style?: StyleProp<TextStyle> }) {
  return <Txt size="caption" weight="heavy" color={color} style={[{ textTransform: 'uppercase', letterSpacing: 1.6 }, style]}>{children}</Txt>;
}

/** A page title block: eyebrow, big heading, optional action on the end. */
export function PageHeader({ eyebrow, title, action, sub }: { eyebrow?: string; title: string; action?: ReactNode; sub?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.md }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        {!!eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Title style={{ marginTop: 2 }}>{title}</Title>
        {!!sub && <Muted style={{ marginTop: 4 }}>{sub}</Muted>}
      </View>
      {action}
    </View>
  );
}

/**
 * The header of the three main screens (Chats, Memory, You): the app icon, a small eyebrow
 * and the page title, with an optional action on the end. One component so the three can
 * never drift apart.
 */
export function AppHeader({ eyebrow, title, action, sub }: { eyebrow: string; title: string; action?: ReactNode; sub?: string }) {
  const p = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Image source={require('../assets/logo.png')} style={[{ width: 48, height: 48, borderRadius: 14 }, elevation(p, 1)]} accessibilityIgnoresInvertColors />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Eyebrow>{eyebrow}</Eyebrow>
          <Txt size="display" weight="medium" numberOfLines={1} style={{ letterSpacing: -0.4, lineHeight: 34 }}>{title}</Txt>
        </View>
        {action}
      </View>
      {!!sub && <Muted style={{ lineHeight: 19 }}>{sub}</Muted>}
    </View>
  );
}

// ---- motion --------------------------------------------------------------------------

/** Fades and lifts its children in when they first mount (the web's animate-slide-up).
 *  `delay` staggers a list. Runs on the native driver, so it stays smooth while JS works. */
export function FadeIn({ children, delay = 0, style, from = 8 }: { children: ReactNode; delay?: number; style?: StyleProp<ViewStyle>; from?: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: dur.normal, delay, easing: Easing.bezier(0.16, 0.84, 0.44, 1), useNativeDriver: NATIVE_DRIVER }).start();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/** A Pressable that dips slightly when touched — the press is visible even under a thumb. */
export function Press(
  { children, onPress, onLongPress, style, disabled, scaleTo = 0.97, label, role = 'button', selected, hitSlop }:
  {
    children: ReactNode; onPress?: () => void; onLongPress?: () => void; style?: StyleProp<ViewStyle>;
    disabled?: boolean; scaleTo?: number; label?: string; role?: 'button' | 'tab' | 'link'; selected?: boolean; hitSlop?: number;
  },
) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(s, { toValue: v, useNativeDriver: NATIVE_DRIVER, speed: 40, bounciness: 4 }).start();
  // How the control sits in its row (flex: 1, width, margins…) belongs on the outer Pressable;
  // on the inner view a "flex: 1" button shrank to its label instead of sharing the row.
  const flat = StyleSheet.flatten(style) ?? {};
  const outer: ViewStyle = {};
  for (const k of OUTER_KEYS) if (flat[k] !== undefined) (outer as any)[k] = flat[k];
  const inner: Record<string, unknown> = { ...flat };
  for (const k of OUTER_KEYS) if (k !== 'width' && k !== 'minWidth' && k !== 'maxWidth') delete (inner as any)[k];   // a fixed size stays on the visible view too
  if (outer.flex !== undefined || outer.alignSelf === 'stretch') inner.flexGrow = 1;   // only a flexible control fills its outer box
  return (
    <Pressable
      onPress={disabled ? undefined : onPress} onLongPress={disabled ? undefined : onLongPress} delayLongPress={320}
      onPressIn={() => to(scaleTo)} onPressOut={() => to(1)} disabled={disabled}
      accessibilityRole={role} accessibilityLabel={label} accessibilityState={{ disabled: !!disabled, selected }}
      hitSlop={hitSlop} style={outer}>
      <Animated.View style={[inner, { transform: [{ scale: s }] }, disabled && { opacity: 0.5 }]}>{children}</Animated.View>
    </Pressable>
  );
}

/** Layout keys that place a control within its parent (they go on Press's outer Pressable). */
const OUTER_KEYS = ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'width', 'minWidth', 'maxWidth',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginStart', 'marginEnd', 'marginHorizontal', 'marginVertical',
  'position', 'top', 'bottom', 'left', 'right', 'start', 'end'] as const;

// ---- buttons -------------------------------------------------------------------------

type ButtonKind = 'primary' | 'ghost' | 'danger' | 'soft';

export function Button(
  { label, onPress, kind = 'primary', busy, disabled, style, icon }:
  { label: string; onPress: () => void; kind?: ButtonKind; busy?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; icon?: IconName },
) {
  const p = usePalette();
  const off = disabled || busy;
  const fill = kind === 'primary' ? p.brand : kind === 'danger' ? p.dangerFill : kind === 'soft' ? p.greenSoft : p.card;
  const ink = kind === 'ghost' || kind === 'soft' ? p.green : p.onBrand;
  return (
    <Press onPress={onPress} disabled={off} label={label}
      style={[
        { minHeight: 50, borderRadius: radius.md + 2, paddingHorizontal: space.lg, flexDirection: 'row',
          alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: fill },
        kind === 'ghost' && { borderWidth: 1, borderColor: p.line },
        kind === 'primary' && elevation(p, 1),
        style,
      ]}>
      {busy ? <ActivityIndicator size="small" color={ink} /> : icon ? <Icon name={icon} size={19} color={ink} /> : null}
      <Text style={{ color: ink, fontSize: 16, fontFamily: font.medium }}>{label}</Text>
    </Press>
  );
}

/** A square icon button, 44pt so a thumb can hit it. `tone` picks plain, soft-tinted or filled. */
export function IconButton(
  { name, onPress, label, tone = 'plain', size = 44, active, style }:
  { name: IconName; onPress: () => void; label: string; tone?: 'plain' | 'soft' | 'brand'; size?: number; active?: boolean; style?: StyleProp<ViewStyle> },
) {
  const p = usePalette();
  const bg = tone === 'brand' ? p.brand : tone === 'soft' || active ? p.greenSoft : 'transparent';
  const fg = tone === 'brand' ? p.onBrand : active ? p.green : tone === 'soft' ? p.green : p.muted;
  return (
    <Press onPress={onPress} label={label} hitSlop={6} scaleTo={0.92}
      style={[{ width: size, height: size, borderRadius: size * 0.32, alignItems: 'center', justifyContent: 'center', backgroundColor: bg },
        tone === 'brand' && elevation(p, 2), style]}>
      <Icon name={name} size={Math.round(size * 0.48)} color={fg} />
    </Press>
  );
}

/** A coloured square holding an icon: the lead of a settings row, a card, a feature. */
export function IconTile({ name, size = 40, tone = 'soft' }: { name: IconName; size?: number; tone?: 'soft' | 'brand' | 'danger' | 'gold' }) {
  const p = usePalette();
  const bg = tone === 'brand' ? p.brand : tone === 'danger' ? p.dangerSoft : tone === 'gold' ? '#c79a3b22' : p.greenSoft;
  const fg = tone === 'brand' ? p.onBrand : tone === 'danger' ? p.danger : tone === 'gold' ? p.goldDark : p.green;
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={name} size={Math.round(size * 0.5)} color={fg} />
    </View>
  );
}

// ---- input ---------------------------------------------------------------------------

export function Field(
  { value, onChange, placeholder, label, invalid, icon, ...rest }:
  { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; invalid?: boolean; icon?: IconName }
  & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'onChangeText' | 'onChange' | 'style'>,
) {
  const p = usePalette();
  const type = useText();
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {!!label && <Txt size="small" weight="medium">{label}</Txt>}
      <View style={[
        { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderRadius: radius.md + 2,
          paddingHorizontal: space.md + 2, backgroundColor: p.card, borderColor: invalid ? p.danger : focus ? p.green : p.line },
        elevation(p, 1),
      ]}>
        {icon && <Icon name={icon} size={19} color={p.muted} />}
        <TextInput
          value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={p.muted}
          accessibilityLabel={label ?? placeholder} aria-invalid={invalid}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ flex: 1, minHeight: 48, fontSize: type.body, fontFamily: font.regular, color: p.ink, paddingVertical: 10, ...({ outlineStyle: 'none' } as object) }}
          {...rest}
        />
      </View>
    </View>
  );
}

// ---- small pieces --------------------------------------------------------------------

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'brand' }) {
  const p = usePalette();
  const bg = tone === 'good' ? p.greenSoft : tone === 'warn' ? '#c79a3b2e' : tone === 'bad' ? p.dangerSoft : tone === 'brand' ? p.brand : p.line;
  const fg = tone === 'bad' ? p.danger : tone === 'warn' ? p.goldDark : tone === 'brand' ? p.onBrand : tone === 'neutral' ? p.muted : p.green;
  return (
    <View style={{ paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: bg }}>
      <Text style={{ fontSize: 11, fontFamily: font.heavy, color: fg }}>{children}</Text>
    </View>
  );
}

export function Toggle({ value, onChange, label, note }: { value: boolean; onChange: (v: boolean) => void; label: string; note?: string }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52, paddingVertical: space.xs }}>
      <View style={{ flex: 1 }}>
        <Txt weight="medium">{label}</Txt>
        {!!note && <Muted style={{ marginTop: 2 }}>{note}</Muted>}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label}
        trackColor={{ true: p.green, false: p.line }} thumbColor="#ffffff" ios_backgroundColor={p.line}
        {...({ activeThumbColor: '#ffffff' } as object)} />
    </View>
  );
}

/**
 * The avatar, with the web's meaning: a family circle is the brand fill with a gold ring
 * (it is the heart of the product), a group is a rounded square with the group glyph, a
 * person is a circle with their initial.
 */
export function Avatar({ name, size = 48, kind = 'direct', photo }: { name: string; size?: number; kind?: 'circle' | 'group' | 'direct';
  /** A person's picture (avatarSource): shown instead of the initial, with the initial behind it while it loads. */
  photo?: { uri: string; headers?: Record<string, string> } }) {
  const p = usePalette();
  const round = kind === 'direct' ? size / 2 : size * 0.3;
  if (photo && kind === 'direct') {
    return (
      <View style={{ width: size, height: size, borderRadius: round, overflow: 'hidden', backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ position: 'absolute', color: p.green, fontSize: size * 0.4, fontFamily: font.medium }}>{(name || '?').slice(0, 1).toUpperCase()}</Text>
        <Image source={photo} style={{ width: size, height: size }} resizeMode="cover" accessibilityIgnoresInvertColors />
      </View>
    );
  }
  const core = (
    <View style={{ width: size, height: size, borderRadius: round, alignItems: 'center', justifyContent: 'center',
      backgroundColor: kind === 'circle' ? p.brand : p.greenSoft }}>
      {kind === 'group'
        ? <Icon name="group" size={size * 0.5} color={p.green} />
        : <Text style={{ color: kind === 'circle' ? p.onBrand : p.green, fontSize: size * 0.4, fontFamily: font.medium }}>{(name || '?').slice(0, 1).toUpperCase()}</Text>}
    </View>
  );
  if (kind !== 'circle') return core;
  return (
    <View style={{ padding: 2, borderRadius: round + 4, borderWidth: 2, borderColor: '#c79a3b80' }}>{core}</View>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const p = usePalette();
  return <View style={[{ backgroundColor: p.card, borderRadius: radius.lg + 2, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }, padded && { padding: space.lg }, elevation(p, 1), style]}>{children}</View>;
}

/** A small uppercase heading over a group of rows ("MY FAMILY"). */
export function SectionLabel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ paddingHorizontal: space.xs, marginBottom: space.sm }, style]}><Eyebrow>{children}</Eyebrow></View>;
}

/** One row of a settings list: icon tile, label (and a note), an optional value, a chevron. */
export function ListRow(
  { icon, label, note, value, onPress, danger, right, last }:
  { icon: IconName; label: string; note?: string; value?: string; onPress?: () => void; danger?: boolean; right?: ReactNode; last?: boolean },
) {
  const p = usePalette();
  const inner = (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 60, paddingHorizontal: space.lg, paddingVertical: space.sm },
      !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.line }]}>
      <IconTile name={icon} tone={danger ? 'danger' : 'soft'} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt weight="medium" color={danger ? 'danger' : 'ink'}>{label}</Txt>
        {!!note && <Muted numberOfLines={2} style={{ marginTop: 1 }}>{note}</Muted>}
      </View>
      {!!value && <Muted>{value}</Muted>}
      {right ?? (onPress ? <Icon name="chevron" size={18} color={p.muted} rotate={FORWARD} /> : null)}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => pressed && { backgroundColor: p.greenSoft }}>{inner}</Pressable>
  );
}

/** A two-to-four way switch (Members / Media / Settings). */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignSelf: 'center', padding: 4, gap: 4, borderRadius: radius.lg, backgroundColor: p.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[{ paddingHorizontal: space.lg, height: 38, borderRadius: radius.md, justifyContent: 'center' }, on && [{ backgroundColor: p.card }, elevation(p, 1)]]}>
            <Txt size="small" weight={on ? 'heavy' : 'medium'} color={on ? 'green' : 'muted'}>{o.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A filter tab on the chat list: tinted when on, with an optional count. */
export function Chip({ label, on, count, onPress }: { label: string; on: boolean; count?: number; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={[{ height: 36, paddingHorizontal: 14, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: 6 },
        on && [{ backgroundColor: p.greenSoft }, elevation(p, 1)]]}>
      <Txt size="small" weight={on ? 'heavy' : 'medium'} color={on ? 'green' : 'muted'}>{label}</Txt>
      {!!count && (
        <View style={{ minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? p.brand : p.line }}>
          <Text style={{ fontSize: 11, fontFamily: font.heavy, color: on ? p.onBrand : p.muted }}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </Pressable>
  );
}

// ---- states --------------------------------------------------------------------------

/** One grey bar that breathes while content loads (the web's shimmer). */
export function Skeleton({ height = 16, width = '100%', radius: r = radius.sm }: { height?: number; width?: number | `${number}%`; radius?: number }) {
  const p = usePalette();
  const v = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.9, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(v, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ height, width, borderRadius: r, backgroundColor: p.line, opacity: v }} />;
}

/** The chat list while it loads: the real row's shape, so nothing jumps when it arrives. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="loading" style={{ paddingVertical: space.sm, gap: space.lg }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md }}>
          <Skeleton height={50} width={50} radius={16} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton height={14} width="55%" />
            <Skeleton height={12} width="80%" />
          </View>
          <Skeleton height={10} width={36} />
        </View>
      ))}
    </View>
  );
}

/** A card-shaped placeholder: the real card's surface, border and radius, with bars inside. */
function SkelCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[{ backgroundColor: p.card, borderRadius: radius.lg + 2, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, padding: space.md + 2 }, style]}>{children}</View>;
}

/**
 * The chat list while it loads, laid out like the real one: a section label, chat rows (a 50pt
 * rounded avatar, the name with its time, the preview), a second section, the invite card.
 */
export function ChatListSkeleton() {
  const row = (w1: `${number}%`, w2: `${number}%`, i: number) => (
    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.sm, paddingHorizontal: space.md, paddingVertical: space.md }}>
      <Skeleton width={50} height={50} radius={15} />
      <View style={{ flex: 1, gap: 9 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Skeleton height={14} width={w1} /><Skeleton height={10} width={52} /></View>
        <Skeleton height={12} width={w2} />
      </View>
    </View>
  );
  const label = (w: number) => <View style={{ paddingHorizontal: space.lg + 4, marginTop: space.md, marginBottom: 2 }}><Skeleton height={10} width={w} /></View>;
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="loading">
      {label(80)}
      {row('48%', '82%', 0)}
      {label(54)}
      {row('36%', '60%', 1)}{row('52%', '44%', 2)}{row('30%', '50%', 3)}
      <View style={{ padding: space.lg, paddingTop: space.md }}>
        <SkelCard style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Skeleton width={44} height={44} radius={13} />
          <View style={{ flex: 1, gap: 8 }}><Skeleton height={14} width="55%" /><Skeleton height={11} width="40%" /></View>
        </SkelCard>
      </View>
    </View>
  );
}

/**
 * Memory and Archive while they load: the summary card, a month label, then timeline moments
 * on the gold rail — each a card with the category pill and date, two lines, the author line.
 */
export function TimelineSkeleton({ summary = true, rows = 3 }: { summary?: boolean; rows?: number }) {
  const p = usePalette();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="loading" style={{ gap: space.md }}>
      {summary && (
        <View style={{ borderRadius: radius.lg + 4, padding: space.lg, gap: space.md, backgroundColor: p.line, opacity: 0.55 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Skeleton width={34} height={40} radius={8} />
            <View style={{ flex: 1, gap: 8 }}><Skeleton height={14} width="55%" /><Skeleton height={10} width="30%" /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>{[70, 60, 90].map((w, i) => <Skeleton key={i} width={w} height={26} radius={13} />)}</View>
        </View>
      )}
      <Skeleton height={10} width={110} />
      <View>
        {Array.from({ length: rows }, (_, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: space.md, paddingBottom: i === rows - 1 ? 0 : space.md }}>
            <View style={{ width: 14 }}>
              <View style={{ position: 'absolute', left: 6, width: 2, backgroundColor: p.line, top: i === 0 ? 26 : 0, ...(i === rows - 1 ? { height: 26 } : { bottom: -space.md }) }} />
              <View style={{ position: 'absolute', left: 1, top: 20, width: 12, height: 12, borderRadius: 6, backgroundColor: p.line }} />
            </View>
            <SkelCard style={{ flex: 1, gap: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Skeleton width={78} height={24} radius={12} /><Skeleton width={40} height={10} /></View>
              <Skeleton height={14} width="92%" />
              <Skeleton height={14} width={i % 2 ? '58%' : '74%'} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Skeleton width={18} height={18} radius={9} /><Skeleton height={10} width={80} /></View>
            </SkelCard>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A chat's Settings tab while it loads: the big avatar and name, the three quick actions, the switcher, rows. */
export function SettingsSkeleton() {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="loading" style={{ padding: space.lg, gap: space.lg }}>
      <View style={{ alignItems: 'center', gap: 10, paddingTop: space.sm }}>
        <Skeleton width={84} height={84} radius={26} />
        <Skeleton width={160} height={20} />
        <Skeleton width={120} height={12} />
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {[0, 1, 2].map(i => <SkelCard key={i} style={{ flex: 1, alignItems: 'center', gap: 8 }}><Skeleton width={38} height={38} radius={12} /><Skeleton width={50} height={10} /></SkelCard>)}
      </View>
      <View style={{ alignSelf: 'center' }}><Skeleton width={250} height={46} radius={radius.lg} /></View>
      <SkelCard style={{ gap: space.md }}>
        {[0, 1, 2].map(i => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Skeleton width={40} height={40} radius={12} />
            <View style={{ flex: 1, gap: 7 }}><Skeleton height={13} width="50%" /><Skeleton height={10} width="75%" /></View>
          </View>
        ))}
      </SkelCard>
    </View>
  );
}

/** Sealed letters while they load: envelopes with the wax-seal circle and a few lines. */
export function EnvelopeSkeleton({ rows = 2 }: { rows?: number }) {
  const p = usePalette();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="loading" style={{ gap: space.sm }}>
      {Array.from({ length: rows }, (_, i) => (
        <SkelCard key={i} style={{ flexDirection: 'row', gap: space.md, borderStartWidth: 4, borderStartColor: p.line }}>
          <Skeleton width={40} height={40} radius={20} />
          <View style={{ flex: 1, gap: 8 }}><Skeleton height={10} width="60%" /><Skeleton height={14} width="45%" /><Skeleton height={12} width="85%" /></View>
        </SkelCard>
      ))}
    </View>
  );
}

/** Message bubbles while a chat opens, so it never claims "no messages" while loading. */
export function MessagesSkeleton() {
  const rows: Array<[boolean, number, number]> = [[false, 170, 40], [true, 140, 40], [false, 230, 64], [true, 200, 92], [false, 130, 40], [true, 160, 40]];
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="loading" style={{ padding: space.md, gap: space.md }}>
      {rows.map(([mine, w, h], i) => (
        <View key={i} style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}><Skeleton width={w} height={h} radius={18} /></View>
      ))}
    </View>
  );
}

/** The illustration the empty states share: two stacked tiles and two gold sparkles. */
export function HeroArt({ icon = 'group', size = 1 }: { icon?: IconName; size?: number }) {
  const p = usePalette();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(pulse, { toValue: 0.45, duration: 900, useNativeDriver: NATIVE_DRIVER }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const k = size;
  return (
    <FadeIn from={12} style={{ width: 168 * k, height: 132 * k }}>
      <View style={{ position: 'absolute', right: 8 * k, top: 0, width: 104 * k, height: 104 * k, borderRadius: 30 * k, backgroundColor: p.line,
        borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, transform: [{ rotate: '6deg' }], alignItems: 'center', justifyContent: 'center', opacity: 0.85 }}>
        <View style={{ width: 44 * k, height: 44 * k, borderRadius: 22 * k, borderWidth: 5 * k, borderColor: p.green, opacity: 0.45 }} />
      </View>
      <View style={[{ position: 'absolute', left: 16 * k, bottom: 0, width: 82 * k, height: 82 * k, borderRadius: 24 * k, backgroundColor: p.brand,
        alignItems: 'center', justifyContent: 'center', borderWidth: 4, borderColor: p.paper }, elevation(p, 3)]}>
        <Icon name={icon} size={40 * k} color={p.onBrand} />
      </View>
      <Animated.View style={{ position: 'absolute', left: 0, top: 6 * k, opacity: pulse }}><Icon name="sparkle" size={20} color={p.goldDark} /></Animated.View>
      <Animated.View style={{ position: 'absolute', right: 0, bottom: 12 * k, opacity: pulse }}><Icon name="sparkle" size={16} color={p.goldDark} /></Animated.View>
    </FadeIn>
  );
}

export function EmptyState({ icon, title, body, action, art }: { icon: IconName; title: string; body?: string; action?: ReactNode; art?: boolean }) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: space.xxl, gap: space.md }}>
      {art ? <HeroArt icon={icon} /> : <IconTile name={icon} size={64} />}
      <FadeIn delay={80} style={{ alignItems: 'center', gap: space.sm }}>
        <Txt size="title" weight="medium" style={{ textAlign: 'center' }}>{title}</Txt>
        {!!body && <Txt color="muted" style={{ textAlign: 'center', lineHeight: 23 }}>{body}</Txt>}
      </FadeIn>
      {action}
    </View>
  );
}

// ---- a sheet from the bottom ----------------------------------------------------------

/**
 * Where a phone puts a choice: at the bottom, where the thumb already is. The backdrop
 * fades while the sheet slides up on a spring; it clears the home indicator, follows the
 * keyboard, and scrolls when its content is tall.
 */
export function Sheet({ open, onClose, onClosed, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode;
  /** Once it has fully left the screen: the moment iOS will let another screen (a picker, another sheet) appear. */
  onClosed?: () => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const y = useRef(new Animated.Value(600)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, useNativeDriver: NATIVE_DRIVER, damping: 22, stiffness: 220, mass: 0.9 }),
        Animated.timing(fade, { toValue: 1, duration: dur.quick, useNativeDriver: NATIVE_DRIVER }),
      ]).start();
    } else if (shown) {
      Animated.parallel([
        Animated.timing(y, { toValue: 600, duration: dur.quick, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(fade, { toValue: 0, duration: dur.quick, useNativeDriver: NATIVE_DRIVER }),
      ]).start(() => {
        setShown(false);
        // iOS needs a beat after the Modal unmounts before it will present anything else.
        if (onClosed) setTimeout(onClosed, Platform.OS === 'ios' ? 350 : 0);
      });
    }
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10,16,13,0.45)', opacity: fade }]}>
          <Pressable accessibilityLabel="close" onPress={onClose} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View style={[{ backgroundColor: p.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '88%',
          paddingBottom: Math.max(inset.bottom, space.lg), transform: [{ translateY: y }] }, elevation(p, 3)]}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: p.line, marginTop: 10 }} />
          {!!title && <Txt size="title" weight="medium" style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>{title}</Txt>}
          <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: title ? 0 : space.md }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One row in a sheet: an icon tile and a label, the phone's menu item. */
export function SheetRow({ icon, label, onPress, danger, chevron, selected }: { icon?: IconName; label: string; onPress: () => void; danger?: boolean; chevron?: boolean; selected?: boolean }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}
      style={({ pressed }) => [{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.sm, borderRadius: radius.md },
        (pressed || selected) && { backgroundColor: p.greenSoft }]}>
      {icon && <IconTile name={icon} tone={danger ? 'danger' : 'soft'} />}
      <Txt size="bodyLg" weight="medium" color={danger ? 'danger' : 'ink'} style={{ flex: 1 }}>{label}</Txt>
      {selected && <Icon name="check" size={20} color={p.green} />}
      {chevron && <Icon name="chevron" size={18} color={p.muted} rotate={FORWARD} />}
    </Pressable>
  );
}

/** One choice out of a few — the phone's dropdown, as a sheet. `columns` lays it out as a grid (years). */
export function Picker<T extends string | number>(
  { open, onClose, title, value, options, onPick, columns = 1 }:
  { open: boolean; onClose: () => void; title: string; value: T; options: Array<{ value: T; label: string }>; onPick: (v: T) => void; columns?: number },
) {
  const p = usePalette();
  if (columns > 1) {
    return (
      <Sheet open={open} onClose={onClose} title={title}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingBottom: space.sm }}>
          {options.map(o => {
            const on = o.value === value;
            return (
              <Pressable key={String(o.value)} onPress={() => { onPick(o.value); onClose(); }} accessibilityRole="button" accessibilityState={{ selected: on }}
                style={({ pressed }) => [{ width: `${100 / columns - 3}%`, height: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
                  on ? { backgroundColor: p.brand } : pressed && { backgroundColor: p.greenSoft }]}>
                <Txt size="bodyLg" weight={on ? 'heavy' : 'regular'} color={on ? 'onBrand' : 'ink'}>{o.label}</Txt>
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    );
  }
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {options.map(o => <SheetRow key={String(o.value)} label={o.label} selected={o.value === value} onPress={() => { onPick(o.value); onClose(); }} />)}
    </Sheet>
  );
}

/**
 * Ask before something that cannot be undone. The phone shows its own alert; react-native-web's
 * Alert does nothing at all, so the web build uses the browser's confirm box instead.
 */
export function ask(title: string, body: string, ok: string, cancel: string, onOk: () => void) {
  if (Platform.OS === 'web') { if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${body}`)) onOk(); return; }
  Alert.alert(title, body, [{ text: cancel, style: 'cancel' }, { text: ok, style: 'destructive', onPress: onOk }]);
}
