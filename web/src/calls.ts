// Voice calls (trial): the parts of the call screen that are plain logic, so they can be tested without a browser.
// The rest (the peer connection, the sheet) is in CallUi.tsx. Design: docs/superpowers/specs/2026-11-19-calls-design.md.

/** The DTLS fingerprint of an SDP (the first `a=fingerprint:` line), upper case, or null. */
export function fingerprintOf(sdp: string): string | null {
  // More than one DIFFERENT fingerprint in one SDP is refused: a decoy first line would make both codes match while the browser uses another key.
  const all = new Set([...sdp.matchAll(/^a=fingerprint:\S+\s+([0-9A-Fa-f:]+)/gm)].map(m => m[1].toUpperCase()));
  return all.size === 1 ? [...all][0] : null;
}

/**
 * A short code both people read aloud. Both phones hash the two DTLS fingerprints (sorted, so the order does not matter) and show 15 digits.
 * If the codes differ, someone in the middle changed a key. Null when an SDP carries no fingerprint.
 */
export async function safetyCode(sdpA: string, sdpB: string): Promise<string | null> {
  const a = fingerprintOf(sdpA), b = fingerprintOf(sdpB);
  if (!a || !b) return null;
  const data = new TextEncoder().encode(`tamtim-call-v1|${[a, b].sort().join('|')}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let n = 0n;
  for (let i = 0; i < 7; i++) n = (n << 8n) | BigInt(h[i]);      // 56 bits
  const digits = (n % 10n ** 15n).toString().padStart(15, '0');   // 15 digits, about 49.8 bits
  return `${digits.slice(0, 5)} ${digits.slice(5, 10)} ${digits.slice(10)}`;
}

export type Quality = 'good' | 'weak' | 'bad';
export function gradeQuality(s: { rttMs: number | null; lossPct: number | null }): Quality | null {
  const { rttMs, lossPct } = s;
  if (rttMs === null && lossPct === null) return null;
  if ((rttMs ?? 0) > 400 || (lossPct ?? 0) > 10) return 'bad';
  if ((rttMs ?? 0) > 200 || (lossPct ?? 0) > 3) return 'weak';
  return 'good';
}

export interface StatsMark { lost: number; got: number }
/** Round trip (ms) from the active candidate pair, else the remote report; loss (%) over what arrived since `prev`. */
export function readQuality(report: Iterable<any>, prev: StatsMark | null): { rttMs: number | null; lossPct: number | null; next: StatsMark | null } {
  let pair: number | null = null, remote: number | null = null, lost = 0, got = 0, seen = false;
  for (const r of report) {
    if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') pair = r.currentRoundTripTime;
    else if (r.type === 'remote-inbound-rtp' && r.kind === 'audio' && typeof r.roundTripTime === 'number') remote = r.roundTripTime;
    else if (r.type === 'inbound-rtp' && r.kind === 'audio') { seen = true; lost += r.packetsLost ?? 0; got += r.packetsReceived ?? 0; }
  }
  const rtt = pair ?? remote;
  const next = seen ? { lost, got } : prev;
  let lossPct: number | null = null;
  if (seen) {
    const dl = lost - (prev?.lost ?? 0), dg = got - (prev?.got ?? 0);
    if (dl + dg > 0) lossPct = Math.max(0, Math.round((dl / (dl + dg)) * 100));
  }
  return { rttMs: rtt === null ? null : Math.round(rtt * 1000), lossPct, next };
}

export const clock = (secs: number) => {
  const s = Math.max(0, Math.floor(secs)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

/** Which text explains how a call ended (a key of t.calls). */
export function endKey(reason: string): string {
  switch (reason) {
    case 'declined': return 'declined';
    case 'timeout': return 'noAnswer';
    case 'busy': return 'busy';
    case 'offline': return 'offline';
    case 'lost': return 'lost';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'frozen': return 'frozen';
    case 'maintenance': return 'maintenance';
    case 'in_call': return 'inCall';
    case 'rate_limited': return 'rateLimited';
    case 'not_allowed': case 'bad_request': return 'notAllowed';
    default: return 'ended';
  }
}
