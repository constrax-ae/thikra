import { useEffect, useState } from 'react';

/** Photo upload quality: standard (about 1600 px, small, the default) or HD (up to 4096 px; stored under its old name `original`). The default is kept on this device, and each send can choose. */
export type Quality = 'standard' | 'original';
const KEY = 'thikra_quality';
export const readQuality = (): Quality => { try { return localStorage.getItem(KEY) === 'original' ? 'original' : 'standard'; } catch { return 'standard'; } };

export function useUploadQuality() {
  const [q, set] = useState<Quality>(readQuality);
  useEffect(() => { try { if (q === 'original') localStorage.setItem(KEY, q); else localStorage.removeItem(KEY); } catch { /* not remembered, still works */ } }, [q]);
  return [q, set] as const;
}
