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

/** The longest recording: a little under the 30 minutes of MED-01, which the server also enforces. */
export const MAX_MS = 29.5 * 60_000;

export const SPEEDS = [1, 1.5, 2] as const;
export const nextSpeed = (s: number) => SPEEDS[(SPEEDS.indexOf(s as 1) + 1) % SPEEDS.length] ?? 1;

/**
 * MED-02 (P1) "sequential notes": when a voice note ends, which one plays next. Only the message RIGHT after it, and only when
 * that message is itself a voice note: a run of voice notes plays through like one long message, and anything else in between
 * (a text, a photo) stops it, so nobody hears a note that arrived much later out of context. `order` is the chat's messages
 * in the order they are shown.
 */
export function nextVoiceNote(order: ReadonlyArray<{ id: number; voice: boolean }>, endedId: number): number | null {
  const at = order.findIndex(m => m.id === endedId);
  const next = at >= 0 ? order[at + 1] : undefined;
  return next?.voice ? next.id : null;
}

/**
 * A playhead that moves on every frame. Browsers only advance an audio element's `currentTime` in steps (often every 100-250
 * ms), so reading it on each frame still stutters. This carries the position forward from the moment it last changed, at the
 * playback speed, and never runs more than `slack` seconds ahead of what the element reports (a stall stops the dot quickly).
 * `memo` is kept between frames by the caller.
 */
export interface Clock { t: number; at: number }
export function smoothTime(memo: Clock | null, reported: number, nowMs: number, rate: number, slack = 0.3): { time: number; memo: Clock } {
  const m = !memo || reported !== memo.t ? { t: reported, at: nowMs } : memo;
  const ahead = Math.min(slack, Math.max(0, ((nowMs - m.at) / 1000) * rate));
  return { time: reported + ahead, memo: m };
}
