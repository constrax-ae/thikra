import { useEffect, type ReactNode } from 'react';

/** A centred card over a dimmed page. Escape or a click outside closes it. */
export function Dialog({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label} className="card p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
