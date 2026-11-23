import { useState } from 'react';
import { api, ApiError, type Message } from './api';
import { Dialog } from './Dialog';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { Toggle } from './States';

/** A poll inside its message bubble: tap an option to vote (again to take it back), live counts, and who voted on request. */
export function PollBubble({ m, meId, names, onError, onVote }: { m: Message; meId: number; names: Map<number, string>; onError: (code: string) => void; /** An encrypted chat: the vote is a control message sent from this device. */ onVote?: (options: number[]) => Promise<unknown> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);   // the option whose voters are listed
  const [busy, setBusy] = useState(false);
  const poll = m.poll!;
  const mine = new Set(poll.options.filter(o => o.voters.includes(meId)).map(o => o.id));
  const most = Math.max(1, ...poll.options.map(o => o.voters.length));

  async function vote(id: number) {
    if (poll.closed || busy) return;
    const next = new Set(poll.multiple ? mine : []);
    if (mine.has(id)) next.delete(id); else next.add(id);
    setBusy(true);
    try { if (onVote) await onVote([...next]); else await api(`/messages/${m.id}/vote`, { body: { options: [...next] } }); }
    catch (err) { onError(err instanceof ApiError ? err.code : 'generic'); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-1 space-y-2 min-w-[13rem]">
      {poll.options.map(o => (
        <div key={o.id}>
          <div className="flex items-center gap-2">
            <button type="button" disabled={poll.closed || busy} aria-pressed={mine.has(o.id)} onClick={() => vote(o.id)}
              className={`relative flex-1 min-w-0 overflow-hidden rounded-xl border text-start px-3 py-2 text-sm transition-colors duration-[var(--dur-instant)] ${mine.has(o.id) ? 'border-green font-bold' : 'border-line'} ${poll.closed ? 'opacity-80' : 'hover:border-green'}`}>
              <span aria-hidden className="absolute inset-y-0 start-0 bg-current/15 transition-[width] duration-[var(--dur-fast)]" style={{ width: `${Math.round((o.voters.length / most) * 100)}%` }} />
              <span className="relative flex items-center gap-2">
                <span className="flex-1 break-words">{o.text}</span>
                {mine.has(o.id) && <Icon name="check" className="w-4 h-4 shrink-0" />}
              </span>
            </button>
            <button type="button" className="text-xs font-bold tabular-nums min-w-8 h-8 rounded-lg text-center opacity-80 hover:opacity-100 disabled:opacity-50 transition-colors duration-[var(--dur-instant)]" disabled={!o.voters.length}
              aria-expanded={open === o.id} aria-label={t.pollVoters.replace('{n}', String(o.voters.length))} onClick={() => setOpen(open === o.id ? null : o.id)}>{o.voters.length}</button>
          </div>
          {open === o.id && o.voters.length > 0 && <p className="text-xs opacity-80 px-1 pt-0.5">{o.voters.map(id => poll.names?.[id] ?? names.get(id) ?? '…').join('، ')}</p>}
        </div>
      ))}
      <p className="text-xs opacity-80 flex items-center gap-2 px-0.5">
        <span>{t.pollVoters.replace('{n}', String(poll.voters))}</span>
        {poll.closed && <span className="inline-flex items-center gap-1">· <Icon name="lock" className="w-3.5 h-3.5" />{t.pollClosed}</span>}
        {!poll.closed && !onVote && m.userId === meId && (
          <button type="button" className="font-bold underline underline-offset-2 ms-auto" onClick={() => api(`/messages/${m.id}/poll/close`, { body: {} }).catch(() => onError('generic'))}>{t.pollClose}</button>
        )}
      </p>
    </div>
  );
}

/** The sheet for making a poll: a question, 2 to 12 options, one answer or several. */
export function PollComposer({ circleId, onClose, onError, onCreate }: { circleId: number; onClose: () => void; onError: (code: string) => void; onCreate?: (question: string, options: string[], multiple: boolean) => Promise<unknown> }) {
  const { t } = useI18n();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const filled = options.map(o => o.trim()).filter(Boolean);
  const ready = !!question.trim() && filled.length >= 2 && new Set(filled).size === filled.length;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try { if (onCreate) await onCreate(question, filled, multiple); else await api(`/circles/${circleId}/polls`, { body: { question, options: filled, multiple, client_msg_id: crypto.randomUUID() } }); onClose(); }
    catch (err) { onError(err instanceof ApiError ? err.code : 'generic'); setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} label={t.newPoll}>
      <form onSubmit={create} className="space-y-2">
        <h2 className="text-lg font-bold flex items-center gap-2"><Icon name="chart" className="w-5 h-5 text-green" />{t.newPoll}</h2>
        <input className="field" autoFocus maxLength={300} placeholder={t.pollQuestion} aria-label={t.pollQuestion} value={question} onChange={e => setQuestion(e.target.value)} />
        {options.map((o, i) => (
          <input key={i} className="field" maxLength={100} placeholder={t.pollOption.replace('{n}', String(i + 1))} aria-label={t.pollOption.replace('{n}', String(i + 1))}
            value={o} onChange={e => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
        ))}
        {options.length < 12 && <button type="button" className="btn btn-ghost w-full inline-flex items-center justify-center gap-2" onClick={() => setOptions([...options, ''])}><Icon name="plus-circle" className="w-5 h-5" />{t.pollAddOption}</button>}
        <Toggle checked={multiple} onChange={setMultiple} label={t.pollMultiple} />
        <div className="flex gap-2 pt-1">
          <button className="btn flex-1" disabled={!ready || busy}>{t.pollCreate}</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t.cancel}</button>
        </div>
      </form>
    </Dialog>
  );
}
