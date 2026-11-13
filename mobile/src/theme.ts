import { useColorScheme } from 'react-native';
import { textScale, usePrefs } from './prefs';

/**
 * The same palette the web app uses, token for token (web/src/styles.css).
 *
 * The rule the design rests on: a received bubble is always the card colour and mine is
 * soft green, so a conversation reads as two voices without colouring the words. Colour
 * carries meaning — a name, a warning, the agent — never decoration.
 *
 * `green` is a TEXT colour and turns light in the dark theme; `brand` is for fills that
 * carry white text. Using one for the other is how you get white on pale gold.
 */
const light = {
  paper: '#f5f1e8', card: '#fffdf8', line: '#eadfc6', ink: '#2b3832', muted: '#55615b',
  green: '#1f4d3f', greenSoft: '#e3eee9', brand: '#1f4d3f', mutedFill: '#55615b',
  gold: '#c79a3b', goldDark: '#7a5a13', danger: '#b91c1c', dangerSoft: '#fef2f2',
  dangerFill: '#b91c1c', onBrand: '#ffffff', mine: '#d9f2d6', focus: '#1f4d3f',
  /** My bubble's edge, and the quiet recess the conversation sits on (web: .bubble-mine, .chat-wall). */
  mineEdge: '#bfe3bb', other: '#ffffff', otherEdge: '#e6e1d6', wall: '#ece9df', shadow: '#1f3028',
};

const dark: typeof light = {
  paper: '#0d1411', card: '#151d19', line: '#2c3a32', ink: '#eef3ef', muted: '#a9bab1',
  green: '#f0b957', greenSoft: '#2b2415', brand: '#3d3624', mutedFill: '#5a5148',
  gold: '#e8a33d', goldDark: '#f0b957', danger: '#ff8f8f', dangerSoft: '#3b1d1d',
  // White on #ff8f8f is about 2:1. A destructive button keeps the solid red in both themes.
  dangerFill: '#b91c1c', onBrand: '#ffffff', mine: '#24352b', focus: '#f0b957',
  mineEdge: '#2f4a3a', other: '#1b2520', otherEdge: '#2c3a32', wall: '#0a100d', shadow: '#000000',
};

export type Palette = typeof light;

/** Follows the phone's setting, unless the person chose a theme for this device. */
export function usePalette(): Palette {
  const system = useColorScheme();
  const { theme } = usePrefs();
  const isDark = theme === 'system' ? system === 'dark' : theme === 'dark';
  return isDark ? dark : light;
}

/** True when the dark palette is in use, for the few places that need to know. */
export function useIsDark(): boolean {
  const system = useColorScheme();
  const { theme } = usePrefs();
  return theme === 'system' ? system === 'dark' : theme === 'dark';
}

/** The type scale at the size this device asked for. Someone who needs larger text needs
 *  it everywhere, not only where a designer remembered. */
export function useText() {
  const { textSize } = usePrefs();
  const k = textScale(textSize);
  return {
    caption: Math.round(text.caption * k), small: Math.round(text.small * k),
    body: Math.round(text.body * k), bodyLg: Math.round(text.bodyLg * k),
    title: Math.round(text.title * k), display: Math.round(text.display * k),
  };
}

/** For the few places outside a component that need a colour before render. */
export const palettes = { light, dark };

// Spacing, radius and type follow the web's scale so the two apps feel like one product.
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };
export const text = {
  caption: 11, small: 13, body: 16, bodyLg: 17, title: 20, display: 28,
};

/**
 * Tajawal, as on the web. The files in assets/fonts are the stock Google Fonts files with
 * one change, the same one web/src/styles.css makes with ascent-override 94% /
 * descent-override 31% / line-gap 0: the stock metrics (643/357/200) put the middle of the
 * line box well below the middle of the letters, so text and the caret sat high in every
 * button and field. Regenerate with fontTools if the font is ever updated.
 * The web renders "bold" at 500 (owner's rule: calm type), so `bold` is Medium and `heavy` is 700.
 */
export const font = { regular: 'Thekra-Regular', medium: 'Thekra-Medium', bold: 'Thekra-Medium', heavy: 'Thekra-Bold' };

/** Three elevation levels, green-tinted in light mode like the web's --shadow-e1..e3. */
export const elevation = (p: Palette, level: 1 | 2 | 3) => ({
  shadowColor: p.shadow,
  shadowOpacity: level === 1 ? 0.06 : level === 2 ? 0.09 : 0.14,
  shadowRadius: level === 1 ? 3 : level === 2 ? 10 : 24,
  shadowOffset: { width: 0, height: level === 1 ? 1 : level === 2 ? 4 : 10 },
  elevation: level === 1 ? 1 : level === 2 ? 3 : 8,
});

/**
 * Whether animations run on the native driver. Off: on Expo Go 58 (RN 0.88, new
 * architecture) a native-driven animation started when a view mounts never reached its end
 * value on the iPhone simulator, so faded-in screens stayed invisible and sheets stayed
 * off-screen. These are small fades and slides; the JS driver runs them smoothly.
 */
export const NATIVE_DRIVER = false;

/** How long a motion lasts. Short enough to feel instant, long enough to be followed. */
export const dur = { instant: 120, quick: 180, normal: 260, slow: 400 };

/** A member's name colour. Stable per person, so the same cousin is the same colour every time. */
const nameColors = ['#8A3B2E', '#1F5A8C', '#6B4A8E', '#2E6B4F', '#9A5B13', '#2F6B7A', '#8E3A5E', '#4D5A1F', '#5A3E8C', '#7A4A2A'];
const nameColorsDark = ['#e79b86', '#8fc0e8', '#c0a5e0', '#8fd0ab', '#e8bf7a', '#8fc8d6', '#e49bbb', '#c3d184', '#b8a3e8', '#dcae8c'];
export const colorOf = (id: number | null, isDark = false) =>
  (isDark ? nameColorsDark : nameColors)[Math.abs(id ?? 0) % nameColors.length];
