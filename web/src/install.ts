import { useEffect, useState } from 'react';

// Installing the site as an app. Chrome on Android offers a real "Install" prompt (we keep it for a button); iPhone has no prompt, only Share > Add to Home Screen.
type Prompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: Prompt | null = null;
const subs = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as Prompt; subs.forEach(f => f()); });
  window.addEventListener('appinstalled', () => { deferred = null; subs.forEach(f => f()); });
}
export const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
export const isIOS = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

export function useInstall() {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump(n => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return {
    installed: isStandalone(),
    canPrompt: !!deferred,
    ios: isIOS(),
    async install() { if (!deferred) return false; await deferred.prompt(); const r = await deferred.userChoice; deferred = null; bump(n => n + 1); return r.outcome === 'accepted'; },
  };
}
