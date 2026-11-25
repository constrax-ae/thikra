import { Fragment, type ReactNode } from 'react';
import { parseFormat, type Seg } from '../../core/format';

/**
 * A message's text with its *bold*, _italic_, ~strike~ and `code` drawn as such. Every piece is a
 * React text node, so whatever a message contains is shown as text and never run as markup.
 * `leaf` draws the plain stretches (links and @mentions live there).
 */
export function Formatted({ text, leaf }: { text: string; leaf: (s: string, key: number) => ReactNode }) {
  let n = 0;
  const draw = (segs: Seg[]): ReactNode[] => segs.map(x => {
    const k = n++;
    if ('text' in x) return <Fragment key={k}>{leaf(x.text, k)}</Fragment>;
    const inner = draw(x.children);
    switch (x.style) {
      case 'b': return <strong key={k} className="font-bold">{inner}</strong>;
      case 'i': return <em key={k} className="italic">{inner}</em>;
      case 's': return <s key={k}>{inner}</s>;
      default: return <code key={k} dir="ltr" className="font-mono text-[0.9em] rounded px-1 py-px bg-current/10">{inner}</code>;
    }
  });
  return <>{draw(parseFormat(text))}</>;
}
