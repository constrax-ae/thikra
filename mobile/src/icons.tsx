import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';
import type { ReactElement } from 'react';
import { I18nManager } from 'react-native';
import { usePalette } from './theme';

/** A chevron pointing "forward" (right in English, left in Arabic) for rows that open something. */
export const FORWARD = I18nManager.isRTL ? 90 : -90;

// The web's icon set (web/src/icons.tsx), generated from the same paths so both apps draw
// the same glyphs: 24×24, 1.75 stroke, round caps. Emoji used to stand in for these and
// render differently on every phone; these take the theme's colours like text does.

export type IconName =
  | 'chats' | 'memory' | 'you' | 'star' | 'key' | 'lock' | 'palette' | 'bell'
  | 'storage' | 'phone' | 'help' | 'heart' | 'tools' | 'search' | 'image' | 'pin' | 'archive'
  | 'alert' | 'refresh' | 'globe' | 'check'
  | 'video' | 'mic' | 'file' | 'group' | 'mute' | 'ban' | 'forward' | 'down' | 'attach' | 'stop' | 'send' | 'chevron' | 'check-double' | 'clock' | 'play' | 'pause' | 'smile'
  | 'plus' | 'plus-circle' | 'arrow-out' | 'more' | 'envelope' | 'sparkle' | 'link' | 'camera' | 'reply' | 'hide'
  | 'book' | 'upload' | 'calendar' | 'trash' | 'arrow-back' | 'album'
  | 'x' | 'copy' | 'pen' | 'cake' | 'star-fill' | 'shield' | 'snow';

const paths = (c: string): Record<IconName, ReactElement> => ({
  chats: <Path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />,
  memory: <><Path d="M12 21v-7" /><Path d="M12 14c-3.5 0-6-2.3-6-5.3C6 5.5 8.7 3 12 3s6 2.5 6 5.7c0 3-2.5 5.3-6 5.3z" /><Path d="M9 21h6" /></>,
  you: <><Circle cx="12" cy="8" r="4" /><Path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></>,
  star: <Path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  key: <><Circle cx="8" cy="15" r="4" /><Path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" /></>,
  lock: <><Rect x="5" y="10.5" width="14" height="10" rx="2" /><Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  palette: <><Path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" /><Circle cx="7.5" cy="11.5" r="1" /><Circle cx="10.5" cy="7.5" r="1" /><Circle cx="15" cy="8" r="1" /></>,
  bell: <><Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z" /><Path d="M10 21h4" /></>,
  storage: <><Ellipse cx="12" cy="6" rx="7" ry="2.5" /><Path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" /><Path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" /></>,
  phone: <><Rect x="7" y="2.5" width="10" height="19" rx="2.5" /><Path d="M11 18.5h2" /></>,
  help: <><Circle cx="12" cy="12" r="9" /><Path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" /><Path d="M12 17h.01" /></>,
  heart: <Path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" />,
  tools: <Path d="M14.5 6.5a4 4 0 0 0 5 5l-8 8a2.1 2.1 0 0 1-3-3l8-8a4 4 0 0 0-2-2z" />,
  search: <><Circle cx="11" cy="11" r="6.5" /><Path d="m20 20-4.2-4.2" /></>,
  image: <><Rect x="3.5" y="4.5" width="17" height="15" rx="2" /><Circle cx="9" cy="10" r="1.5" /><Path d="m20.5 16-5-5-8.5 8.5" /></>,
  pin: <><Path d="M9 3.5h6l-1 6 3 3H7l3-3z" /><Path d="M12 12.5V21" /></>,
  archive: <><Rect x="3.5" y="4" width="17" height="4.5" rx="1" /><Path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" /><Path d="M10 12.5h4" /></>,
  alert: <><Circle cx="12" cy="12" r="9" /><Path d="M12 7.5v5.5" /><Path d="M12 16.5h.01" /></>,
  refresh: <><Path d="M20 12a8 8 0 1 1-2.3-5.6" /><Path d="M20 4v4.5h-4.5" /></>,
  globe: <><Circle cx="12" cy="12" r="9" /><Path d="M3.5 9.5h17M3.5 14.5h17" /><Path d="M12 3c2.2 2.4 3.3 5.4 3.3 9s-1.1 6.6-3.3 9c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3z" /></>,
  check: <Path d="m5 12.5 4.5 4.5L19 7.5" />,
  'check-double': <><Path d="m2 12.5 4.5 4.5L13 8.5" /><Path d="m11 16 1 1 9.5-9.5" /></>,
  clock: <><Circle cx="12" cy="12" r="8.5" /><Path d="M12 7.5V12l3 2" /></>,
  play: <Path d="M8 5.5v13l11-6.5z" fill={c} stroke="none" />,
  smile: <><Circle cx="12" cy="12" r="9" /><Path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><Path d="M9 9.5h.01M15 9.5h.01" /></>,
  pause: <><Rect x="7" y="5.5" width="3.5" height="13" rx="1" fill={c} stroke="none" /><Rect x="13.5" y="5.5" width="3.5" height="13" rx="1" fill={c} stroke="none" /></>,
  video: <><Rect x="3" y="6" width="12" height="12" rx="2.5" /><Path d="m15 11 5.5-3.2v8.4L15 13z" /></>,
  mic: <><Rect x="9" y="3" width="6" height="11" rx="3" /><Path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><Path d="M12 18v3" /></>,
  file: <><Path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20z" /><Path d="M13 3.5V9h5" /></>,
  group: <><Circle cx="9" cy="8" r="3.2" /><Path d="M3.5 19c.9-2.8 3-4.3 5.5-4.3s4.6 1.5 5.5 4.3" /><Path d="M16 5.5a3.2 3.2 0 0 1 0 6.1" /><Path d="M17.5 14.9c1.6.6 2.7 1.9 3.3 3.6" /></>,
  mute: <><Path d="M6 16.5V11a6 6 0 0 1 8.7-5.3" /><Path d="M18 11v5.5l1.5 2H4.5" /><Path d="M10 21h4" /><Path d="m4 3 16 18" /></>,
  ban: <><Circle cx="12" cy="12" r="9" /><Path d="m6 6 12 12" /></>,
  forward: <><Path d="m14 5 6 5-6 5" /><Path d="M20 10H9a5 5 0 0 0-5 5v4" /></>,
  down: <><Path d="M12 4.5v14" /><Path d="m6 13 6 6 6-6" /></>,
  chevron: <Path d="m7 10 5 5 5-5" />,
  attach: <Path d="M19 11.5 12.2 18.3a4.5 4.5 0 0 1-6.4-6.4l7.3-7.3a3 3 0 0 1 4.3 4.3l-7.3 7.3a1.5 1.5 0 0 1-2.1-2.1l6.5-6.5" />,
  stop: <Rect x="6.5" y="6.5" width="11" height="11" rx="2" fill={c} stroke="none" />,
  plus: <Path d="M12 5v14M5 12h14" />,
  'plus-circle': <><Circle cx="12" cy="12" r="8.5" /><Path d="M12 8.5v7M8.5 12h7" /></>,
  'arrow-out': <><Path d="M7.5 16.5 16.5 7.5" /><Path d="M9 7.5h7.5V15" /></>,
  more: <><Circle cx="5.5" cy="12" r="1.1" fill={c} /><Circle cx="12" cy="12" r="1.1" fill={c} /><Circle cx="18.5" cy="12" r="1.1" fill={c} /></>,
  envelope: <><Rect x="3.5" y="5.5" width="17" height="13" rx="2" /><Path d="m4 7 8 6 8-6" /></>,
  reply: <><Path d="m10 5-6 5 6 5" /><Path d="M4 10h11a5 5 0 0 1 5 5v4" /></>,
  hide: <><Path d="M3.5 12s3-6 8.5-6c1.6 0 3 .5 4.2 1.2M20.5 12s-3 6-8.5 6c-1.6 0-3-.5-4.2-1.2" /><Path d="M4 20 20 4" /></>,
  camera: <><Path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><Circle cx="12" cy="12.8" r="3.4" /></>,
  sparkle: <><Path d="M11 3.5c.7 4.6 2 5.9 6.5 6.5-4.5.7-5.8 2-6.5 6.5-.7-4.5-2-5.8-6.5-6.5 4.5-.6 5.8-1.9 6.5-6.5z" /><Path d="M18.5 14.5c.3 1.9 1 2.6 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.4 2.7-1.1 3-3z" /></>,
  link: <><Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><Path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  book: <><Path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><Path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></>,
  upload: <><Path d="M12 15.5V4" /><Path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><Path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  calendar: <><Rect x="4" y="5" width="16" height="15" rx="2" /><Path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></>,
  trash: <><Path d="M4.5 7h15" /><Path d="M9.5 7V4.5h5V7" /><Path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" /></>,
  'arrow-back': <><Path d="M19 12H5.5" /><Path d="m11 6-6 6 6 6" /></>,
  album: <><Rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><Circle cx="9" cy="9" r="1.8" /><Path d="m20.5 15-4.5-4.5-9 9" /></>,
  x: <Path d="M6 6l12 12M18 6 6 18" />,
  copy: <><Rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><Path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  pen: <><Path d="M15.5 4.5 19.5 8.5 8.5 19.5H4.5v-4z" /><Path d="m13 7 4 4" /></>,
  cake: <><Path d="M4.5 20.5h15v-6a2 2 0 0 0-2-2h-11a2 2 0 0 0-2 2z" /><Path d="M4.5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 1.5-.5 1.5-.5" /><Path d="M12 12.5V9" /><Path d="M12 6.5c-.8-.6-.8-1.6 0-3 .8 1.4.8 2.4 0 3z" /></>,
  'star-fill': <Path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill={c} />,
  shield: <><Path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6z" /><Path d="m9 12 2.2 2.2L15.5 10" /></>,
  snow: <Path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5" />,
  send: <><Path d="M4.5 12 20 4.5l-4 15.5-4.2-5.8z" /><Path d="m11.8 14.2 8.2-9.7" /></>,
});

/** One icon. Decorative by default (hidden from the screen reader): the control around it
 *  carries the label. Pass `label` only when the icon stands alone and means something. */
export function Icon({ name, size = 22, color, strokeWidth = 1.75, label, rotate }: { name: IconName; size?: number; color?: string; strokeWidth?: number; label?: string; rotate?: number }) {
  const p = usePalette();
  const c = color ?? p.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" style={rotate ? { transform: [{ rotate: `${rotate}deg` }] } : undefined}
      accessible={!!label} accessibilityLabel={label} importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}>
      {paths(c)[name]}
    </Svg>
  );
}
