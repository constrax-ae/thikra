import { useMemo, useState } from 'react';
import { LANG_INFO, SUPPORTED, useI18n, type Lang } from './i18n';
import { Dialog } from './Dialog';
import { Icon } from './icons';

/** The language list (each in its own language). Picking one is remembered on this device;
 *  `onPick` lets a signed-in screen also save it on the account.
 *
 *  This used to be a bare <select>, which renders as an unstyled operating-system dropdown:
 *  the one control on the sign-in screen that did not belong to the app. It is now a normal
 *  control that opens the same searchable sheet pattern the country picker uses, so with
 *  21 languages the list is actually navigable. */
export function LangPicker({ onPick, className = '' }: { onPick?: (l: Lang) => void; className?: string }) {
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);

  const choose = (l: Lang) => { setLang(l); onPick?.(l); setOpen(false); };

  return (
    <>
      <button type="button" aria-label={t.languageTitle} aria-haspopup="dialog" onClick={() => setOpen(true)}
        className={`field w-auto! h-10! px-3.5! inline-flex items-center gap-2 cursor-pointer ${className}`}>
        <Icon name="globe" className="w-4 h-4 text-muted" />
        <span className="font-medium">{LANG_INFO[lang].name}</span>
        <span aria-hidden className="text-muted text-xs">▾</span>
      </button>
      {open && <LangSheet current={lang} onPick={choose} onClose={() => setOpen(false)} />}
    </>
  );
}

function LangSheet({ current, onPick, onClose }: { current: Lang; onPick: (l: Lang) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  // The current language first, then the two originals (Arabic and English), then the rest:
  // the machine-translated packs are the long tail and should not bury the originals.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? SUPPORTED.filter(l => LANG_INFO[l].name.toLowerCase().includes(needle) || l.includes(needle)) : SUPPORTED;
    const rank = (l: Lang) => (l === current ? 0 : LANG_INFO[l].machine ? 2 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [q, current]);

  return (
    <Dialog onClose={onClose} label={t.languageTitle}>
      <h2 className="text-lg font-bold mb-3">{t.languageTitle}</h2>
      <input className="field mb-3" autoFocus type="search" placeholder={t.searchLanguage} value={q} onChange={e => setQ(e.target.value)} />
      <ul className="max-h-80 overflow-y-auto -mx-2" role="listbox" aria-label={t.languageTitle}>
        {shown.length === 0 && <li className="p-3 text-center text-muted">{t.noResults}</li>}
        {shown.map(l => (
          <li key={l} role="option" aria-selected={l === current}>
            {/* <bdi> renders each name in its own script without letting an RTL name
                right-align its row, which would leave the list ragged. */}
            <button className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-start hover:bg-paper ${l === current ? 'bg-green-soft' : ''}`}
              onClick={() => onPick(l)}>
              <span className="flex-1 min-w-0 truncate"><bdi>{LANG_INFO[l].name}</bdi></span>
              {l === current && <Icon name="check" className="w-4 h-4 text-green shrink-0" />}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** For a machine-translated language: the original (Arabic or English) is the legal text and prevails, and the translation is automatic. Nothing for Arabic and English. */
export function MachineNote({ className = '' }: { className?: string }) {
  const { t, machine } = useI18n();
  if (!machine) return null;
  return <p role="note" className={`text-xs text-muted rounded-lg bg-card border border-line p-2 ${className}`}>{t.legalNote}</p>;
}
