// The mark beside a sent message's time. It comes from the other members' "up to here" marks, as in WhatsApp:
//   pending   - still leaving this device
//   sent      - the server has it; at least one person has not received it yet
//   delivered - everyone else has received it
//   read      - everyone else has read it (a person whose reads are not shared never counts as having read: readSeq is null)
export type Tick = 'pending' | 'sent' | 'delivered' | 'read';

export function tickOf(m: { seq?: number; pending?: boolean }, others: Array<{ deliveredSeq: number; readSeq: number | null }>): Tick {
  if (m.pending || !m.seq) return 'pending';
  const seq = m.seq;
  if (others.length && others.every(o => o.readSeq !== null && o.readSeq >= seq)) return 'read';
  if (others.length && others.every(o => o.deliveredSeq >= seq)) return 'delivered';
  return 'sent';
}
