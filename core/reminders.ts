// "Remind me about this message": the shared, pure part (the web keeps reminders in localStorage, the phone in its own
// storage and as a scheduled notification). Only which chat, which message and when; never the message's words.

export interface Reminder { id: string; circleId: number; messageId: number; chat: string; at: number; created: number }

/** The reminders whose time has come, and the rest. */
export function split(list: Reminder[], now: number) { return { due: list.filter(r => r.at <= now), later: list.filter(r => r.at > now) }; }

/** The quick choices: in 20 minutes, in an hour, in 3 hours, this evening (only while it is still before 6 pm), tomorrow morning. */
export function presets(now: Date): Array<{ k: 'm20' | 'h1' | 'h3' | 'evening' | 'tomorrow'; at: number }> {
  const t = now.getTime();
  const evening = new Date(now); evening.setHours(20, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [
    { k: 'm20' as const, at: t + 20 * 60_000 },
    { k: 'h1' as const, at: t + 3600_000 },
    { k: 'h3' as const, at: t + 3 * 3600_000 },
    ...(now.getHours() < 18 ? [{ k: 'evening' as const, at: evening.getTime() }] : []),
    { k: 'tomorrow' as const, at: tomorrow.getTime() },
  ];
}
