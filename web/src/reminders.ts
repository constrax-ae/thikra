import { useEffect, useState } from 'react';

// "Remind me about this message": a reminder kept on THIS device only (the spec's "scheduled local reminders").
// Nothing goes to the server, and no words of the message are stored: only which chat and which message, and when.
// So a reminder on an encrypted chat leaves no readable trace behind it.

import type { Reminder } from '../../core/reminders.ts';
export { presets, split, type Reminder } from '../../core/reminders.ts';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const key = (uid: number) => `tamtim_reminders_${uid}`;
const EVENT = 'tamtim:reminders';
const store = (): Store | null => { try { return localStorage; } catch { return null; } };

export function readReminders(uid: number, s: Store | null = store()): Reminder[] {
  try {
    const raw = JSON.parse(s?.getItem(key(uid)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r): r is Reminder => r && typeof r.id === 'string' && Number.isFinite(r.at) && Number.isInteger(r.circleId) && Number.isInteger(r.messageId)) : [];
  } catch { return []; }
}
function write(uid: number, list: Reminder[], s: Store | null = store()) {
  try { s?.setItem(key(uid), JSON.stringify(list.sort((a, b) => a.at - b.at).slice(0, 200))); } catch { /* full or private: the reminder is lost, nothing else breaks */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}
/** Sets (or moves) the reminder for one message: one per message. */
export function remind(uid: number, r: Omit<Reminder, 'id' | 'created'>, s: Store | null = store(), now = Date.now()): Reminder {
  const next: Reminder = { ...r, id: `${r.circleId}:${r.messageId}`, created: now };
  write(uid, [...readReminders(uid, s).filter(x => x.id !== next.id), next], s);
  return next;
}
export function forget(uid: number, id: string, s: Store | null = store()) { write(uid, readReminders(uid, s).filter(x => x.id !== id), s); }
/** This person's reminders, kept up to date when they change (in this tab or another). */
export function useReminders(uid: number | undefined): Reminder[] {
  const [list, setList] = useState<Reminder[]>(() => (uid ? readReminders(uid) : []));
  useEffect(() => {
    if (!uid) return;
    const load = () => setList(readReminders(uid));
    load();
    const onStorage = (e: StorageEvent) => { if (e.key === key(uid)) load(); };
    window.addEventListener(EVENT, load); window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(EVENT, load); window.removeEventListener('storage', onStorage); };
  }, [uid]);
  return list;
}

/** The message a reminder (or a notification) asked to show, picked up by the chat once it has loaded. */
export const JUMP_KEY = 'tamtim_jump_to';
/** Fired after JUMP_KEY is set, so a chat that is already open looks for the message again. */
export const JUMP_EVENT = 'tamtim:jump';
