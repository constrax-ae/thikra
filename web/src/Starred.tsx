import { useEffect, useState } from 'react';
import { api, toDate, type Across, type MessageHit } from './api';
import { useI18n, intlLocale } from './i18n';
import { Icon } from './icons';
import { JUMP_KEY } from './reminders';
import { plainText } from '../../core/format';

/**
 * Everything you have starred, from every chat, newest first — until now a star could only be found again inside the
 * chat it was made in, which is no use for "where was that address?". Choosing one opens its chat on the message.
 * Encrypted chats are not here: the server holds only ciphertext, so their stars stay on their own screen.
 */
export function StarredAll() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<MessageHit[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<Across>('/starred').then(r => { setRows(r.results); setSkipped(r.skipped); }).catch(() => setFailed(true));
  }, []);
  const open = (m: MessageHit) => {
    try { sessionStorage.setItem(JUMP_KEY, String(m.id)); } catch { /* the chat still opens, without the jump */ }
    location.hash = `#/circle/${m.circleId}`;
  };
  if (failed) return <p className="text-muted">{t.errors.generic}</p>;
  if (rows === null) return <p className="text-muted">{t.loading}</p>;
  if (!rows.length) return <p className="text-muted">{t.starredNone}</p>;
  return (
    <ul className="divide-y divide-line -mx-1">
      {rows.map(m => (
        <li key={m.id}>
          <button className="row-interactive w-full px-2 py-2.5 rounded-xl text-start" onClick={() => open(m)}>
            <span className="flex items-baseline gap-2">
              <Icon name="star-fill" className="w-3.5 h-3.5 text-gold-dark shrink-0" />
              <b className="min-w-0 flex-1 truncate"><bdi>{m.circleName}</bdi></b>
              <span className="text-caption text-muted shrink-0">{toDate(m.createdAt).toLocaleDateString(intlLocale(lang), { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </span>
            <span className="block text-muted truncate ps-5">
              {m.author ? <span className="text-ink">{m.author}: </span> : null}
              {m.kind === 'voice' ? (m.transcript || t.voiceWord)
                : m.body ? plainText(m.body)
                : m.attachment === 'image' ? t.photoWord : m.attachment === 'video' ? t.videoWord : t.fileWord}
            </span>
          </button>
        </li>
      ))}
      {skipped > 0 && <li className="px-2 py-2 text-caption text-muted">{t.searchSkipped.replace('{n}', String(skipped))}</li>}
    </ul>
  );
}
