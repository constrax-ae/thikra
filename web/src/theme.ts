import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const read = (): Theme => {
  try { const v = localStorage.getItem('thikra_theme'); return v === 'light' || v === 'dark' || v === 'system' ? v : 'light'; } catch { return 'light'; }
};
const apply = (t: Theme) => { if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); };

// Applied before the first paint, so a dark-mode user never sees a white flash.
if (typeof document !== 'undefined') apply(read());

/** Light, dark, or follow the device (dark is the default). Remembered on this device. */
export function useTheme() {
  const [theme, set] = useState<Theme>(read);
  useEffect(() => {
    apply(theme);
    try { localStorage.setItem('thikra_theme', theme); } catch { /* not remembered, still works */ }
  }, [theme]);
  return [theme, set] as const;
}
