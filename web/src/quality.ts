import { useEffect, useState } from 'react';

/** Photo upload quality, WhatsApp's "Upload quality": standard (about 1600 px, small, the default) or original (as the camera made it). Kept on this device. */
export type Quality = 'standard' | 'original';
const KEY = 'thikra_quality';
export const readQuality = (): Quality => { try { return localStorage.getItem(KEY) === 'original' ? 'original' : 'standard'; } catch { return 'standard'; } };

export function useUploadQuality() {
  const [q, set] = useState<Quality>(readQuality);
  useEffect(() => { try { if (q === 'original') localStorage.setItem(KEY, q); else localStorage.removeItem(KEY); } catch { /* not remembered, still works */ } }, [q]);
  return [q, set] as const;
}
