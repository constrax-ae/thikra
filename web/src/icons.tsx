// One line-icon set for the whole app (replaces emoji, which render differently on every phone and look cheap).
// 24×24, 1.75 stroke, currentColor: icons take the text colour, so they follow the light and dark themes automatically.
import type { ReactElement } from 'react';

export type IconName =
  | 'chats' | 'memory' | 'you' | 'star' | 'key' | 'lock' | 'palette' | 'bell'
  | 'storage' | 'phone' | 'help' | 'heart' | 'tools' | 'search' | 'image' | 'pin' | 'archive'
  | 'alert' | 'refresh' | 'globe' | 'check'
  | 'video' | 'mic' | 'file' | 'group' | 'mute' | 'ban' | 'forward' | 'down' | 'attach' | 'stop' | 'send' | 'chevron' | 'check-double' | 'clock' | 'play' | 'pause' | 'smile'
  | 'plus' | 'plus-circle' | 'arrow-out' | 'more' | 'envelope' | 'sparkle' | 'link'
  | 'book' | 'upload' | 'calendar' | 'trash' | 'arrow-back' | 'album'
  | 'x' | 'copy' | 'pen' | 'cake' | 'star-fill' | 'shield' | 'snow';

const paths: Record<IconName, ReactElement> = {
  chats: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />,
  memory: <><path d="M12 21v-7" /><path d="M12 14c-3.5 0-6-2.3-6-5.3C6 5.5 8.7 3 12 3s6 2.5 6 5.7c0 3-2.5 5.3-6 5.3z" /><path d="M9 21h6" /></>,
  you: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></>,
  star: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" /><circle cx="7.5" cy="11.5" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="8" r="1" /></>,
  bell: <><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z" /><path d="M10 21h4" /></>,
  storage: <><ellipse cx="12" cy="6" rx="7" ry="2.5" /><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" /><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" /><path d="M12 17h.01" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" />,
  tools: <path d="M14.5 6.5a4 4 0 0 0 5 5l-8 8a2.1 2.1 0 0 1-3-3l8-8a4 4 0 0 0-2-2z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m20.5 16-5-5-8.5 8.5" /></>,
  pin: <><path d="M9 3.5h6l-1 6 3 3H7l3-3z" /><path d="M12 12.5V21" /></>,
  archive: <><rect x="3.5" y="4" width="17" height="4.5" rx="1" /><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" /><path d="M10 12.5h4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5h.01" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4.5h-4.5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3.5 9.5h17M3.5 14.5h17" /><path d="M12 3c2.2 2.4 3.3 5.4 3.3 9s-1.1 6.6-3.3 9c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3z" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  'check-double': <><path d="m2 12.5 4.5 4.5L13 8.5" /><path d="m11 16 1 1 9.5-9.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></>,
  pause: <><rect x="7" y="5.5" width="3.5" height="13" rx="1" fill="currentColor" stroke="none" /><rect x="13.5" y="5.5" width="3.5" height="13" rx="1" fill="currentColor" stroke="none" /></>,
  video: <><rect x="3" y="6" width="12" height="12" rx="2.5" /><path d="m15 11 5.5-3.2v8.4L15 13z" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></>,
  file: <><path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20z" /><path d="M13 3.5V9h5" /></>,
  group: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.9-2.8 3-4.3 5.5-4.3s4.6 1.5 5.5 4.3" /><path d="M16 5.5a3.2 3.2 0 0 1 0 6.1" /><path d="M17.5 14.9c1.6.6 2.7 1.9 3.3 3.6" /></>,
  mute: <><path d="M6 16.5V11a6 6 0 0 1 8.7-5.3" /><path d="M18 11v5.5l1.5 2H4.5" /><path d="M10 21h4" /><path d="m4 3 16 18" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>,
  forward: <><path d="m14 5 6 5-6 5" /><path d="M20 10H9a5 5 0 0 0-5 5v4" /></>,
  down: <><path d="M12 4.5v14" /><path d="m6 13 6 6 6-6" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  attach: <path d="M19 11.5 12.2 18.3a4.5 4.5 0 0 1-6.4-6.4l7.3-7.3a3 3 0 0 1 4.3 4.3l-7.3 7.3a1.5 1.5 0 0 1-2.1-2.1l6.5-6.5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  'plus-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M12 8.5v7M8.5 12h7" /></>,
  'arrow-out': <><path d="M7.5 16.5 16.5 7.5" /><path d="M9 7.5h7.5V15" /></>,
  more: <><circle cx="5.5" cy="12" r="1.1" fill="currentColor" /><circle cx="12" cy="12" r="1.1" fill="currentColor" /><circle cx="18.5" cy="12" r="1.1" fill="currentColor" /></>,
  envelope: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  sparkle: <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M6 18l2.6-2.6M15.4 8.6 18 6" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  book: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></>,
  upload: <><path d="M12 15.5V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></>,
  trash: <><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" /></>,
  'arrow-back': <><path d="M19 12H5.5" /><path d="m11 6-6 6 6 6" /></>,
  album: <><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><circle cx="9" cy="9" r="1.8" /><path d="m20.5 15-4.5-4.5-9 9" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  copy: <><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  pen: <><path d="M15.5 4.5 19.5 8.5 8.5 19.5H4.5v-4z" /><path d="m13 7 4 4" /></>,
  cake: <><path d="M4.5 20.5h15v-6a2 2 0 0 0-2-2h-11a2 2 0 0 0-2 2z" /><path d="M4.5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 1.5-.5 1.5-.5" /><path d="M12 12.5V9" /><path d="M12 6.5c-.8-.6-.8-1.6 0-3 .8 1.4.8 2.4 0 3z" /></>,
  'star-fill': <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor" />,
  shield: <><path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  snow: <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5" />,
  send: <><path d="M4.5 12 20 4.5l-4 15.5-4.2-5.8z" /><path d="m11.8 14.2 8.2-9.7" /></>,
};

export function Icon({ name, className = 'w-5 h-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/** The wordmark in the header: the app icon (owner's ذكرى calligraphy) and the name. */
export function Wordmark({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <img src="/icons/logo-160.png" alt="" width={40} height={40} className="w-10 h-10 rounded-xl elevated-1" />
      <span className="text-2xl font-bold text-green tracking-tight">{name}</span>
    </span>
  );
}
