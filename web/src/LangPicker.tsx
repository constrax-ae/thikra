import { LANG_INFO, SUPPORTED, useI18n, type Lang } from './i18n';

/** The language list (each in its own language). Picking one is remembered on this device; `onPick` lets a signed-in screen also save it on the account. */
export function LangPicker({ onPick, className = '' }: { onPick?: (l: Lang) => void; className?: string }) {
  const { lang, setLang } = useI18n();
  return (
    <select aria-label="Language" className={`field !w-auto !py-1 ${className}`} value={lang} onChange={e => { const l = e.target.value as Lang; setLang(l); onPick?.(l); }}>
      {SUPPORTED.map(l => <option key={l} value={l}>{LANG_INFO[l].name}</option>)}
    </select>
  );
}

/** For a machine-translated language: the original (Arabic or English) is the legal text and prevails, and the translation is automatic. Nothing for Arabic and English. */
export function MachineNote({ className = '' }: { className?: string }) {
  const { t, machine } = useI18n();
  if (!machine) return null;
  return <p role="note" className={`text-xs text-muted rounded-lg bg-card border border-line p-2 ${className}`}>{t.legalNote}</p>;
}
