import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { useI18n } from './i18n';

/**
 * "Are you sure?" in the app's own sheet, instead of the browser's confirm() box: that one ignores the theme and the
 * language, looks different in every browser, and freezes the whole page (timers, live updates) while it is open.
 *
 *   if (!(await askConfirm(t.priv.clearConfirm, { danger: true }))) return;
 *
 * The answer is false when the sheet is closed any other way (Escape, the dimmed area, Cancel).
 */
interface Ask { message: string; confirmLabel?: string; danger?: boolean; single?: boolean; done: (yes: boolean) => void }
let show: ((a: Ask) => void) | null = null;

export function askConfirm(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise(done => {
    if (!show) { done(window.confirm(message)); return; }   // before the app has mounted its host (it always has, in practice)
    show({ message, ...opts, done });
  });
}

/** A message with only an OK button, in place of the browser's alert(). */
export function tellUser(message: string): Promise<void> {
  return new Promise(done => {
    if (!show) { window.alert(message); done(); return; }
    show({ message, single: true, danger: true, done: () => done() });
  });
}

/** Mounted once, at the root of the app. */
export function ConfirmHost() {
  const { t } = useI18n();
  const [ask, setAsk] = useState<Ask | null>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { show = a => setAsk(prev => { prev?.done(false); return a; }); return () => { show = null; }; }, []);
  useEffect(() => { if (ask) requestAnimationFrame(() => yesRef.current?.focus()); }, [ask]);
  if (!ask) return null;
  const answer = (yes: boolean) => { ask.done(yes); setAsk(null); };
  return (
    <Dialog onClose={() => answer(false)} label={ask.message}>
      <div className="flex items-start gap-3 pt-1">
        <span aria-hidden className={`w-10 h-10 rounded-xl shrink-0 flex items-center justify-center ${ask.danger ? 'bg-danger/10 text-danger' : 'bg-green-soft text-green'}`}>
          <Icon name={ask.danger ? 'alert' : 'help'} className="w-5 h-5" />
        </span>
        <p className="text-[15px] leading-relaxed text-ink pt-1.5" dir="auto" data-confirm-message>{ask.message}</p>
      </div>
      <div className="mt-5 flex gap-2">
        <button ref={yesRef} type="button" data-confirm-yes className={`btn flex-1 ${ask.single ? 'btn-primary' : ask.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => answer(true)}>{ask.single ? t.closePanel : ask.confirmLabel ?? t.confirmOk}</button>
        {!ask.single && <button type="button" data-confirm-no className="btn btn-ghost flex-1" onClick={() => answer(false)}>{t.cancel}</button>}
      </div>
    </Dialog>
  );
}
