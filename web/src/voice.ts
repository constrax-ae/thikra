// Voice notes: the small decisions of the recorder that can be tested without a microphone.

/** The loudness samples of a recording, reduced to `n` bars of 0-100 (the loudest sample of each stretch, scaled to the loudest bar). */
export function bars(samples: number[], n = 48): number[] {
  if (!samples.length) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * samples.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * samples.length) / n));
    out.push(Math.max(0, ...samples.slice(a, b)));
  }
  const top = Math.max(...out);
  return out.map(v => (top > 0 ? Math.max(4, Math.round((v / top) * 100)) : 4));
}

export type Gesture = 'none' | 'cancel' | 'lock';
/**
 * While the mic is held: sliding sideways AWAY from the mic (towards the message box) cancels, sliding up locks.
 * The mic sits at the end of the row, which is the right side in English and the left side in Arabic.
 */
export function gesture(dx: number, dy: number, rtl: boolean): Gesture {
  const away = rtl ? dx : -dx;
  if (away >= 90 && away > -dy) return 'cancel';
  if (dy <= -70) return 'lock';
  return 'none';
}
/** A press shorter than this is a tap: the recording locks, hands-free (there is nothing to hold with a mouse or a keyboard). */
export const TAP_MS = 350;
/** The shortest recording worth sending; anything shorter was a slip of the finger. */
export const MIN_MS = 700;

/** The longest recording: a little under the server's 15 minutes. */
export const MAX_MS = 14.5 * 60_000;

export const SPEEDS = [1, 1.5, 2] as const;
export const nextSpeed = (s: number) => SPEEDS[(SPEEDS.indexOf(s as 1) + 1) % SPEEDS.length] ?? 1;
