import { useEffect, useState } from 'react';

/** Small on/off preferences kept on this device (WhatsApp's in-app sounds, reduced animations, data saver). */
const read = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
const write = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* not remembered, still works */ } };

export const prefOn = (key: PrefKey) => read(`thikra_${key}`, DEFAULTS[key]);
export type PrefKey = 'sound' | 'motion' | 'saver';
const DEFAULTS: Record<PrefKey, boolean> = { sound: true, motion: true, saver: false };

const applyMotion = (on: boolean) => { if (typeof document !== 'undefined') document.documentElement.setAttribute('data-motion', on ? 'on' : 'off'); };
if (typeof document !== 'undefined') applyMotion(prefOn('motion'));

export function usePref(key: PrefKey) {
  const [on, set] = useState(() => prefOn(key));
  useEffect(() => { write(`thikra_${key}`, on); if (key === 'motion') applyMotion(on); }, [key, on]);
  return [on, set] as const;
}

let ctx: AudioContext | undefined;
/** A short, soft two-note chime for a message that arrives while the app is open. Never throws (no audio, blocked autoplay). */
export function chime() {
  try {
    if (!prefOn('sound')) return;
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const t0 = ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.09); g.gain.exponentialRampToValueAtTime(0.08, t0 + i * 0.09 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.22);
      o.connect(g).connect(ctx!.destination); o.start(t0 + i * 0.09); o.stop(t0 + i * 0.09 + 0.25);
    });
  } catch { /* silent */ }
}
