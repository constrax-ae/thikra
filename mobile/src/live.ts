import { Platform } from 'react-native';
import { API_URL } from './config';
import { sessionCookie } from './api';

// The live gateway (server/ws.ts), the same one the web app uses. It only makes things FASTER: every screen still works over plain HTTP,
// so while the socket is down (no signal, server asleep) the app keeps polling, and when it is back screens catch up. Nothing depends on it.
type Frame = Record<string, any> & { t: string };
type Listener = (f: Frame) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
let wanted = false;

function url() {
  const base = Platform.OS === 'web' ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` : API_URL.replace(/^http/, 'ws');
  return `${base}/ws`;
}
function connect() {
  if (!wanted || ws) return;
  let sock: WebSocket;
  try {
    // A phone's WebSocket may carry headers: the session cookie authenticates it like any request. A browser sends its own cookies.
    const cookie = sessionCookie();
    sock = Platform.OS !== 'web' && cookie ? new (WebSocket as any)(url(), undefined, { headers: { cookie } }) : new WebSocket(url());
  } catch { return schedule(); }
  ws = sock;
  sock.onopen = () => { retry = 0; emit({ t: 'open' }); };
  sock.onmessage = ev => { try { emit(JSON.parse(String(ev.data))); } catch { /* a bad frame is ignored */ } };
  sock.onclose = () => { ws = null; schedule(); };
  sock.onerror = () => { try { sock.close(); } catch { /* already closing */ } };
}
function schedule() {
  if (!wanted || timer) return;
  const delay = Math.min(15_000, 500 * 2 ** retry++) * (0.7 + Math.random() * 0.6);   // 0.5 s, 1 s, 2 s … capped, with jitter
  timer = setTimeout(() => { timer = undefined; connect(); }, delay);
}
const emit = (f: Frame) => listeners.forEach(l => l(f));

export const live = {
  on(l: Listener) {
    listeners.add(l); wanted = true; connect();
    return () => { listeners.delete(l); if (!listeners.size) live.stop(); };
  },
  stop() { wanted = false; clearTimeout(timer); timer = undefined; retry = 0; const s = ws; ws = null; s?.close(); },
};
