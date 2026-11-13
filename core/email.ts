// Checking an email address.
//
// In core/ because the form and the server must agree: a field that accepts what the server
// then rejects is worse than one that never accepted it.
//
// The check is deliberately loose. The only way to know an address works is to send to it,
// and every clever pattern rejects somebody's real address — apostrophes, plus-addressing,
// long new top-level domains, non-Latin scripts. This catches the typo (no @, no dot, a
// stray space) and lets the rest through.

/** Trimmed and lowercased, which is how it is stored, or '' for nothing worth storing. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True if `raw` is empty (an email is optional) or looks like an address. */
export function isEmail(raw: string): boolean {
  const e = normalizeEmail(raw);
  if (!e) return true;                      // optional: nothing to object to
  if (e.length > 254) return false;         // the limit on an address in practice
  if (/\s/.test(e)) return false;
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return false;   // one @, not leading
  const domain = e.slice(at + 1);
  if (domain.length < 3 || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return !e.slice(0, at).startsWith('.') && !e.slice(0, at).endsWith('.');
}
