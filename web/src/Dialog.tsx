import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A centred card over a dimmed page. Escape or a click outside closes it. */
export function Dialog({ children, onClose, label, wide }: { children: ReactNode; onClose: () => void; label: string; /** A bigger card (a photo preview), from sm up. */ wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Rendered at the end of <body>, not where it is used: a dialog opened from inside a message bubble (view once, poll voters,
  // a contact card) would otherwise be trapped by the bubble's entrance animation, whose transform makes `fixed` mean "fixed
  // to the bubble", and the sheet showed squeezed inside the chat. Clicks are stopped here so they do not reach the bubble.
  return createPortal(
    // The backdrop fades, the card scales in with the emphasis curve: it should feel like
    // the card arrives, not like it was always there. Both stop under "reduced animations".
    // On a phone it is a bottom sheet (thumb-reachable, slides up, with a grab handle);
    // from sm up it stays the centred card.
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in" onClick={e => { e.stopPropagation(); onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={label}
        className={`sheet card elevated-3 w-full ${wide ? 'sm:max-w-xl' : 'sm:max-w-sm'} max-h-[88dvh] overflow-y-auto
          !rounded-b-none sm:!rounded-2xl !rounded-t-3xl px-5 pt-3 sm:pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]`}
        onClick={e => e.stopPropagation()}>
        <span aria-hidden className="sm:hidden block mx-auto mb-3 w-10 h-1.5 rounded-full bg-line" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
