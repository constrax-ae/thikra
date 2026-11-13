import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './icons';
import { t } from './i18n';
import { font, usePalette, NATIVE_DRIVER } from './theme';

export type Tab = 'chats' | 'memory' | 'you';

/**
 * The bar along the bottom: the same three places as the web app (Chats, Memory, You),
 * with the web's icons and its soft pill behind the current one. Each target is the full
 * third of the bar and carries its label — an icon alone is a guess, and this app is used
 * by grandparents.
 */
export function Tabs({ tab, onPick, unread }: { tab: Tab; onPick: (t: Tab) => void; unread?: number }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const items: Array<[Tab, IconName, string]> = [['chats', 'chats', t.tabChats], ['memory', 'memory', t.tabMemory], ['you', 'you', t.tabYou]];
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: p.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line, paddingBottom: Math.max(inset.bottom, 8), paddingTop: 6 }}>
      {items.map(([k, icon, label]) => <Item key={k} on={tab === k} icon={icon} label={label} onPress={() => onPick(k)} badge={k === 'chats' ? unread : 0} />)}
    </View>
  );
}

function Item({ on, icon, label, onPress, badge }: { on: boolean; icon: IconName; label: string; onPress: () => void; badge?: number }) {
  const p = usePalette();
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => { Animated.spring(v, { toValue: on ? 1 : 0, useNativeDriver: NATIVE_DRIVER, speed: 20, bounciness: 6 }).start(); }, [on, v]);
  return (
    <Pressable onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={label}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 54 }}>
      <View style={{ width: 64, height: 32, alignItems: 'center', justifyContent: 'center' }}>
        {/* The pill is absolutely positioned, so the icon needs its own positioned layer above
            it: a browser paints positioned layers over plain content (the web build hid the icon). */}
        <Animated.View style={[StyleSheet.absoluteFill, { zIndex: 0, borderRadius: 16, backgroundColor: p.greenSoft, opacity: v, transform: [{ scaleX: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]} />
        <View style={{ position: 'relative', zIndex: 1 }}><Icon name={icon} size={23} color={on ? p.green : p.muted} /></View>
        {!!badge && (
          <View style={{ position: 'absolute', top: -2, right: 8, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: p.card }}>
            <Text style={{ color: p.onBrand, fontSize: 10, fontFamily: font.heavy }}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
      </View>
      <Text style={{ fontSize: 12, fontFamily: on ? font.heavy : font.medium, color: on ? p.green : p.muted }}>{label}</Text>
    </Pressable>
  );
}
