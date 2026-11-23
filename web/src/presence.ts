import { useEffect, useState } from 'react';
import { api } from './api';
import { live } from './live';

// Who of these people is online, and when the others were last seen. Someone who hides it (or whom we may not see) is simply
// not in the map, and the screen shows nothing for them. The first answer comes over HTTP; changes arrive as `presence` frames.
export interface Presence { online: boolean; lastSeen: string | null }

export function usePresence(ids: number[]): Map<number, Presence> {
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',');
  const [map, setMap] = useState<Map<number, Presence>>(new Map());
  useEffect(() => {
    if (!key) { setMap(new Map()); return; }
    const all = key.split(',').map(Number);
    const wanted = new Set(all);
    let stop = false;
    // The server answers for 200 people at a time.
    const load = async () => {
      try {
        const rows: Array<{ id: number; online: boolean; lastSeen: string | null }> = [];
        for (let i = 0; i < all.length; i += 200) rows.push(...await api<typeof rows>(`/presence?ids=${all.slice(i, i + 200).join(',')}`));
        if (!stop) setMap(new Map(rows.map(r => [r.id, { online: r.online, lastSeen: r.lastSeen }])));
      } catch { /* offline: keep what we had */ }
    };
    load();
    const off = live.on(f => {
      if (f.t === 'open') load();   // frames were missed while disconnected
      else if (f.t !== 'presence' || !wanted.has(f.user)) return;
      // `gone`: we may no longer see this person (they hid it, or a block): drop what we showed.
      else if (f.gone) setMap(prev => { const next = new Map(prev); next.delete(f.user); return next; });
      else setMap(prev => new Map(prev).set(f.user, { online: !!f.online, lastSeen: f.last_seen ?? null }));
    });
    // A slow re-check, for changes nobody announces (someone left a shared chat, an unblock, my own privacy setting).
    const timer = setInterval(load, 60_000);
    return () => { stop = true; off(); clearInterval(timer); };
  }, [key]);
  return map;
}
