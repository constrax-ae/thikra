// Observability (F-10): what the server can say about its own health without ever touching message content.
// Latency samples live in a ring buffer per metric (the last N), counters and gauges in plain numbers. All in memory,
// per process: enough for one server and for the bench; a multi-server deployment exports these to a real metrics store.
// Rule: nothing recorded here or logged from here contains a message body, a phone number, or a name.

const WINDOW = 2000;
const samples = new Map<string, { buf: number[]; i: number; n: number }>();
const counters = new Map<string, number>();

export function observe(name: string, ms: number) {
  let s = samples.get(name);
  if (!s) samples.set(name, (s = { buf: new Array(WINDOW).fill(0), i: 0, n: 0 }));
  s.buf[s.i] = ms; s.i = (s.i + 1) % WINDOW; s.n++;
}

export const count = (name: string, by = 1) => { counters.set(name, (counters.get(name) ?? 0) + by); };

const pct = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : null;
const r1 = (v: number | null) => v === null ? null : Math.round(v * 10) / 10;

export function snapshot(gauges: Record<string, number> = {}) {
  const latency: Record<string, { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }> = {};
  for (const [name, s] of samples) {
    const xs = s.buf.slice(0, Math.min(s.n, WINDOW)).sort((a, b) => a - b);
    latency[name] = { n: s.n, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)), p99: r1(pct(xs, 99)), max: r1(xs.at(-1) ?? null) };
  }
  return { uptimeSeconds: Math.round(process.uptime()), counters: Object.fromEntries(counters), gauges, latency, windowSamples: WINDOW };
}

/** Time a synchronous section and record it. */
export function timed<T>(name: string, fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  const ms = performance.now() - t;
  observe(name, ms);
  return { value, ms };
}

/** One JSON object per line on stdout: easy to grep locally, easy to ship anywhere later. No content, ever. */
export const logging = process.env.THIKRA_LOG === '1' || (process.env.NODE_ENV === 'production' && process.env.THIKRA_LOG !== '0');
export function log(event: string, fields: Record<string, unknown> = {}) {
  if (logging) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
