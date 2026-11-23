// Which chats this device KNOWS are end-to-end encrypted. The server tells the screen whether a chat is encrypted, but a hostile server could say "not encrypted" about a chat that is,
// and the screen would then send readable text into it. A chat's type never changes (it is chosen at creation), so once this device has seen a chat as encrypted it stays encrypted
// here, whatever the server says later. Plain sending routes refuse such a chat (`guardPlain`, called by the app's `api` and by the sender).
// Only chat numbers are kept (the server knows them anyway); nothing secret.

const KEY = 'thikra_e2ee_known_chats';
let known: Set<number> | null = null;
const load = (): Set<number> => {
  if (known) return known;
  known = new Set();
  try { for (const x of JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]')) if (Number.isInteger(x)) known.add(x); } catch { /* no storage: this visit only */ }
  return known;
};
export function markEncrypted(circle: number): void {
  if (!Number.isInteger(circle) || load().has(circle)) return;
  known!.add(circle);
  // Another tab may have marked chats since this one loaded its list: read again and keep both, so no tab erases another's marks.
  try { for (const x of JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]')) if (Number.isInteger(x)) known!.add(x); } catch { /* none */ }
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify([...known!].slice(-2000))); } catch { /* full or blocked */ }
}
export const isKnownEncrypted = (circle: number): boolean => load().has(circle);
export function resetKnownEncrypted(): void { known = new Set(); try { globalThis.localStorage?.removeItem(KEY); } catch { /* none */ } }

/** The routes that put readable text, files or cards into a chat. (`/uploads` is not here: the engine sends its already-encrypted file bytes there; a plain file only becomes readable through `/attachments`, which is guarded.) */
const PLAIN_POST = /^\/circles\/(\d+)\/(messages|attachments|voice|cards|polls?)(?:[/?]|$)/;
/** Throws (code `encrypted_chat`, status 409) when a readable posting is aimed at a chat this device knows is encrypted. */
export function guardPlain(method: string, path: string): void {
  if (method.toUpperCase() !== 'POST') return;
  const m = PLAIN_POST.exec(path);
  if (m && isKnownEncrypted(Number(m[1]))) throw Object.assign(new Error('encrypted_chat'), { code: 'encrypted_chat', status: 409 });
}
