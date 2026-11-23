// "last seen today at 4:30 PM": the sentence under a person's name when they are not online.
// The server stores UTC ("YYYY-MM-DD HH:MM:SS"); the reader sees their own clock, calendar and language.

interface Texts { lastSeenToday: string; lastSeenYesterday: string; lastSeenOn: string }
const locale = (lang: string) => (lang === 'tl' ? 'fil' : lang);
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function lastSeenText(lastSeen: string, now: Date, lang: string, t: Texts): string {
  const at = new Date(lastSeen.replace(' ', 'T') + 'Z');
  if (Number.isNaN(at.getTime())) return '';
  const time = new Intl.DateTimeFormat(locale(lang), { hour: 'numeric', minute: '2-digit' }).format(at);
  // Whole calendar days between the two, in the reader's zone. A time ahead of this clock (the two clocks differ a little) is "today".
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days <= 0) return t.lastSeenToday.replace('{time}', time);
  if (days === 1) return t.lastSeenYesterday.replace('{time}', time);
  const sameYear = at.getFullYear() === now.getFullYear();
  const date = new Intl.DateTimeFormat(locale(lang), sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(at);
  return t.lastSeenOn.replace('{date}', date);
}
