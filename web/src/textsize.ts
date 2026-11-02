import { useEffect, useState } from 'react';

export type TextSize = 'normal' | 'large' | 'xlarge';

const read = (): TextSize => {
  try { const v = localStorage.getItem('thikra_text'); return v === 'large' || v === 'xlarge' ? v : 'normal'; } catch { return 'normal'; }
};

/** Text size (WCAG: users must be able to enlarge text). Remembered on this device; if storage is unavailable it still works for the session. */
export function useTextSize() {
  const [size, setSize] = useState<TextSize>(read);
  useEffect(() => {
    if (size === 'normal') document.documentElement.removeAttribute('data-text'); else document.documentElement.setAttribute('data-text', size);
    try { localStorage.setItem('thikra_text', size); } catch { /* not remembered, still works */ }
  }, [size]);
  return [size, setSize] as const;
}
