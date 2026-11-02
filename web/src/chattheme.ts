import { useEffect, useState } from 'react';

/** Chat wallpaper and "my bubble" colour: WhatsApp's "Chat theme", kept on this device. Wallpapers are plain CSS (no image files); every bubble colour carries white text at AA. */
export const WALLPAPERS = ['none', 'dots', 'dusk', 'dunes', 'forest', 'rose'] as const;
export type Wallpaper = typeof WALLPAPERS[number];
export const BUBBLES: Array<[string, string | null]> = [['default', null], ['green', '#1f4d3f'], ['bronze', '#6b4a0f'], ['navy', '#1d3557'], ['plum', '#5b2a5e'], ['teal', '#0f5a5a'], ['slate', '#3d4552']];

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not remembered, still works */ } };

const readWall = (): Wallpaper => { const v = get('thikra_wall'); return (WALLPAPERS as readonly string[]).includes(v ?? '') ? v as Wallpaper : 'none'; };
const readBubble = (): string => { const v = get('thikra_bubble'); return BUBBLES.some(([k]) => k === v) ? v! : 'default'; };

const apply = (wall: Wallpaper, bubble: string) => {
  const el = document.documentElement;
  el.setAttribute('data-wall', wall);
  const colour = BUBBLES.find(([k]) => k === bubble)?.[1];
  const vars: Array<[string, string]> = [['--bubble-mine', colour ?? ''], ['--bubble-ink', '#fff'], ['--bubble-tick-user', '#7dd3fc'], ['--bubble-edge', 'transparent']];
  for (const [k, v] of vars) { if (colour) el.style.setProperty(k, v); else el.style.removeProperty(k); }
};

if (typeof document !== 'undefined') apply(readWall(), readBubble());

export function useChatTheme() {
  const [wall, setWall] = useState<Wallpaper>(readWall);
  const [bubble, setBubble] = useState<string>(readBubble);
  useEffect(() => { apply(wall, bubble); set('thikra_wall', wall === 'none' ? null : wall); set('thikra_bubble', bubble === 'default' ? null : bubble); }, [wall, bubble]);
  return { wall, setWall, bubble, setBubble };
}
