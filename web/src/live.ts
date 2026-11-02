// One WebSocket per tab to the live gateway (server/ws.ts). It only makes things faster: every screen still works
// through plain HTTP, so while this is down (offline, server asleep, a proxy that refuses upgrades) the app falls
// back to polling and sends over HTTP. When it comes back, screens re-sync by seq and nothing is lost.

type Frame = Record<string, any> & { t: string };
type Listener = (f: Frame) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let wanted = false;
let open = false;

function connect() {
  if (!wanted || ws) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let sock: WebSocket;
  try { sock = new WebSocket(url); } catch { return schedule(); }
  ws = sock;
  sock.onopen = () => { retry = 0; open = true; sendVisible(); emit({ t: 'open' }); };
  sock.onmessage = ev => { try { emit(JSON.parse(String(ev.data))); } catch { /* ignore a bad frame */ } };
  sock.onclose = () => {
    const was = open;
    ws = null; open = false;
    if (was) emit({ t: 'close' });
    schedule();
  };
  sock.onerror = () => { try { sock.close(); } catch { /* already closing */ } };
}

function schedule() {
  if (!wanted || timer) return;
  // 0.5 s, 1 s, 2 s … capped at 15 s, with jitter so a restarted server is not hit by everyone at once.
  const delay = Math.min(15_000, 500 * 2 ** retry++) * (0.7 + Math.random() * 0.6);
  timer = setTimeout(() => { timer = undefined; connect(); }, delay);
}

const emit = (f: Frame) => listeners.forEach(l => l(f));

export const live = {
  /** Start the connection (idempotent) and listen for frames; returns the unsubscribe function. */
  on(l: Listener) {
    listeners.add(l);
    wanted = true;
    connect();
    return () => { listeners.delete(l); if (!listeners.size) live.stop(); };
  },
  get connected() { return open; },
  /** true if the frame went out on the socket; false means the caller must use HTTP. */
  send(f: Frame) {
    if (!ws || !open) return false;
    ws.send(JSON.stringify(f));
    return true;
  },
  stop() {
    wanted = false; clearTimeout(timer); timer = undefined; retry = 0;
    const s = ws; ws = null; open = false; s?.close();
  },
};

// Tell the server whether the app is on screen, so it does not send a notification for what you are already looking at.
const isShown = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();
function sendVisible() { if (ws && open) ws.send(JSON.stringify({ t: 'visible', on: isShown() })); }
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', sendVisible);
  window.addEventListener('focus', sendVisible);
  window.addEventListener('blur', sendVisible);
}

// A phone that wakes up or regains network should not wait out the backoff.
if (typeof window !== 'undefined') {
  const kick = () => { if (wanted && !ws) { clearTimeout(timer); timer = undefined; retry = 0; connect(); } };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
}
