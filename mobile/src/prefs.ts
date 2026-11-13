import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

/**
 * What this device remembers, as opposed to what the account remembers.
 *
 * Theme and text size belong to the phone, not the person: the same account on a tablet
 * and a phone should be allowed to look different. Read receipts and the notification
 * preview live on the server, because they affect what other people see.
 *
 * SecureStore is used because it is already a dependency; these are preferences, not
 * secrets, and storing them there costs nothing.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type TextSize = 'normal' | 'large' | 'xlarge';

interface Prefs { theme: ThemePref; textSize: TextSize }
const DEFAULTS: Prefs = { theme: 'system', textSize: 'normal' };
const KEY = 'thekra.prefs';

let current: Prefs = DEFAULTS;
let loaded = false;
const listeners = new Set<(p: Prefs) => void>();

async function read() {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* first run, or storage refused: the defaults are fine */ }
  loaded = true;
  listeners.forEach(l => l(current));
}
void read();

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  current = { ...current, [key]: value };
  listeners.forEach(l => l(current));
  try { await SecureStore.setItemAsync(KEY, JSON.stringify(current)); } catch { /* it still holds for this run */ }
}

/** Re-renders whatever uses it when a preference changes. */
export function usePrefs(): Prefs & { loaded: boolean } {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => { listeners.delete(setP); };
  }, []);
  return { ...p, loaded };
}

/** How much to scale every size in the type scale. The web offers the same three steps. */
export const textScale = (s: TextSize) => (s === 'xlarge' ? 1.3 : s === 'large' ? 1.15 : 1);
