import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './theme';
import { api, type Me } from './api';
import { I18nProvider, useI18n } from './i18n';
import { EmptyState } from './States';
import { ChatList, ChatWelcome } from './ChatList';

import { CircleView } from './CircleView';
import { Notices } from './Notices';
import { Icon, Wordmark, type IconName } from './icons';
// After an update, a browser that still holds the OLD app asks for a screen file the server no longer has ("Failed to fetch dynamically
// imported module") and would show a blank page. Reload once to pick up the new app; the flag stops a loop if the file is really missing.
const staleChunk = (m: string) => /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(m);
const reloadOnce = () => { try { if (sessionStorage.getItem('thikra_chunk_reload')) return; sessionStorage.setItem('thikra_chunk_reload', '1'); } catch { /* no storage: reload anyway once per page life */ } location.reload(); };
window.addEventListener('vite:preloadError', () => reloadOnce());
window.addEventListener('unhandledrejection', e => { if (staleChunk(String((e.reason as Error)?.message ?? e.reason))) reloadOnce(); });
setTimeout(() => { try { sessionStorage.removeItem('thikra_chunk_reload'); } catch { /* ok */ } }, 15_000);   // a healthy page forgets the flag; a missing file cannot loop forever

// Rarely used screens load on demand, so the first screen stays small and fast on a cheap phone.
// Split by WHO needs it. The sign-in screen is the only thing that reads the phone-number library (154 kB of country
// metadata), and a family already signed in never renders it, so that weight now belongs to the one visit that signs in
// rather than to every app open. Settings and the memory screen are a tap away, not on the first paint.
const Login = lazy(() => import('./Login').then(m => ({ default: m.Login })));
const You = lazy(() => import('./You').then(m => ({ default: m.You })));
const Memory = lazy(() => import('./Memory').then(m => ({ default: m.Memory })));
const Plans = lazy(() => import('./Plans').then(m => ({ default: m.Plans })));
const Admin = lazy(() => import('./Admin').then(m => ({ default: m.Admin })));
const SealedPage = lazy(() => import('./Sealed').then(m => ({ default: m.SealedPage })));

type Route = { name: 'circles' } | { name: 'sealed' } | { name: 'memory' } | { name: 'you' } | { name: 'circle'; id: number; tab?: 'archive' | 'settings' } | { name: 'admin' } | { name: 'plans'; id: number } | { name: 'join'; code: string };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'admin') return { name: 'admin' };
  if (h === 'memory') return { name: 'memory' };
  if (h === 'sealed') return { name: 'sealed' };
  if (h === 'you') return { name: 'you' };
  const j = h.match(/^join\/([A-Za-z0-9]{4,32})$/);
  if (j) return { name: 'join', code: j[1] };
  const pl = h.match(/^plans\/(\d+)$/);
  if (pl) return { name: 'plans', id: Number(pl[1]) };
  const m = h.match(/^circle\/(\d+)(?:\/(archive|settings))?$/);
  return m ? { name: 'circle', id: Number(m[1]), tab: (m[2] as 'archive' | 'settings' | undefined) } : { name: 'circles' };
}

/** An invite link (/#/join/CODE): once signed in, the person joins that circle and lands in it. */
function JoinByLink({ code, onDone }: { code: string; onDone: (id: number | null) => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => { api<{ id: number }>('/circles/join', { body: { code } }).then(r => onDone(r.id)).catch(() => setFailed(true)); }, [code]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="max-w-2xl mx-auto px-4 py-20 text-center">{failed ? <><p role="alert" className="text-danger">{t.errors.invalid_invite ?? t.errors.generic}</p><button className="btn mt-4" onClick={() => onDone(null)}>{t.back}</button></> : <p className="text-muted">…</p>}</div>;
}

/** True while the window is at least `px` wide; follows resizes. */
function useWide(px = 1024) {
  const q = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return wide;
}

function App() {
  const { t } = useI18n();
  // How many chats the sidebar found, so the welcome pane can tell a first run from a
  // conversation simply not opened yet.
  const [chatCount, setChatCount] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(parseHash);

  const loadMe = useCallback(() => api<Me>('/me').then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { loadMe(); }, [loadMe]);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const wide = useWide();
  const go = (hash: string) => { location.hash = hash; };
  const toCircles = useCallback(() => go('/'), []);
  /** The address for a circle's tab: the chat tab is the bare circle, so the URL stays short. */
  const circleHash = (id: number, tab?: string) => `/circle/${id}${!tab || tab === 'chat' ? '' : `/${tab}`}`;

  if (me === undefined) return null;
  if (me === null) return <Suspense fallback={null}><Login onDone={loadMe} /></Suspense>;
  if (route.name === 'join') return <JoinByLink code={route.code} onDone={id => go(id ? `/circle/${id}` : '/')} />;

  async function logout() { await api('/auth/logout', { method: 'POST', body: {} }); setMe(null); go('/'); }
  async function deleteAccount() {
    if (!confirm(t.confirmDelete)) return;
    try { await api('/me', { method: 'DELETE' }); setMe(null); } catch (e: any) { alert(t.errors[e.code] ?? t.errors.generic); }
  }

  // The bottom tab bar is WhatsApp's: always there on the main screens, out of the way inside a chat.
  const tabs: Array<[Route['name'], string, IconName, string]> = [
    ['circles', t.tabChats, 'chats', '/'], ['memory', t.tabMemory, 'memory', '/memory'], ['you', t.tabYou, 'you', '/you'],
  ];
  // The bottom bar is the phone's way back to the chat list. A route that falls outside
  // the desktop shell (admin) used to render it on a 1680px screen, under a page with no
  // sidebar: two navigation patterns at once, neither belonging to that width.
  const showTabs = !wide && route.name !== 'circle' && route.name !== 'plans';

  // Wide screens get the messenger layout: the list stays in a sidebar and the open chat
  // (or a welcome) fills the rest, so opening a chat never throws the list away.
  // Memory, You and Sealed open in the same shell, in the right-hand pane, so moving between
  // them never drops you out of the desktop layout.
  if (wide && ['circles', 'circle', 'memory', 'you', 'sealed', 'plans'].includes(route.name)) {
    const iconBtn = (on: boolean) => `w-10 h-10 rounded-xl flex items-center justify-center transition-colors duration-[var(--dur-instant)] ${on ? 'bg-green-soft text-green' : 'text-muted hover:bg-green-soft hover:text-green'}`;
    const page = (node: React.ReactNode) => <div key={route.name} className="h-full overflow-y-auto animate-fade-in"><div className="px-8 xl:px-10 py-8">{node}</div></div>;
    const openId = route.name === 'circle' ? route.id : undefined;
    return (
      <div className="h-[100dvh] flex bg-paper overflow-clip">
        {/* The sidebar comes first in the source, so without this a keyboard user tabs through
            every chat in the list before reaching the conversation they already opened.
            Centred rather than tucked into the corner: at the start edge it landed on top of
            the wordmark, which read as a rendering fault rather than as a control. */}
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:top-4 focus:left-1/2 focus:-translate-x-1/2
            focus:px-5 focus:py-2.5 focus:rounded-full focus:bg-brand focus:text-white focus:font-bold focus:shadow-e3
            focus:ring-2 focus:ring-white/70 focus:whitespace-nowrap"
          onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>{t.skipToMain}</a>
        <aside aria-label={t.tabChats} className="w-[380px] xl:w-[420px] shrink-0 flex flex-col border-e border-line">
          <header className="h-20 shrink-0 px-5 flex items-center gap-3">
            <button onClick={toCircles} aria-label={t.appName}><Wordmark name={t.appName} /></button>
            <span className="flex-1" />
            {!!me.is_admin && <button className={iconBtn(false)} onClick={() => go('/admin')} aria-label={t.rowAdmin} title={t.rowAdmin}><Icon name="tools" className="w-5 h-5" /></button>}
            <button className={iconBtn(route.name === 'memory')} aria-current={route.name === 'memory' ? 'page' : undefined} onClick={() => go('/memory')} aria-label={t.tabMemory} title={t.tabMemory}><Icon name="memory" className="w-5 h-5" /></button>
          </header>
          <div className="px-5"><Notices /></div>
          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
            <ChatList onOpen={id => go(`/circle/${id}`)} activeId={openId} onCount={setChatCount} />
          </div>
          <footer className="shrink-0 border-t border-line p-3">
            <button onClick={() => go('/you')} data-selected={route.name === 'you' || route.name === 'sealed' || undefined} className="row-interactive w-full flex items-center gap-3 p-2 rounded-2xl text-start">
              <span className="w-11 h-11 rounded-full bg-brand text-white flex items-center justify-center font-bold text-lg shrink-0">{(me.name || '?').slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <b className="block truncate text-ink">{me.name || t.tabYou}</b>
                <span className="block text-sm text-muted truncate" dir="ltr">{me.phone}</span>
              </span>
              <Icon name="chevron" className="w-5 h-5 text-muted -rotate-90 rtl:rotate-90" />
            </button>
          </footer>
        </aside>
        <main id="main" tabIndex={-1} aria-label={t.appName} className="flex-1 min-w-0 bg-card outline-none">
          <Suspense fallback={null}>
            {route.name === 'circle' ? <div key={route.id} className="h-full animate-fade-in"><CircleView docked id={route.id} me={me} initialTab={route.tab} onBack={toCircles} onLeft={toCircles} onTab={t => go(circleHash((route as { id: number }).id, t))} /></div>
              : route.name === 'memory' ? page(<Memory onOpenArchive={id => go(`/circle/${id}/archive`)} />)
              : route.name === 'you' ? page(<You me={me} onLogout={logout} onDeleteAccount={deleteAccount} onAdmin={() => go('/admin')} onSealed={() => go('/sealed')} onChanged={loadMe} />)
              : route.name === 'sealed' ? page(<SealedPage meId={me.id} onBack={() => go('/you')} />)
              : route.name === 'plans' ? page(<Plans circleId={route.id} onBack={() => go(circleHash((route as { id: number }).id, 'settings'))} />)
              : <ChatWelcome empty={chatCount === 0} />}
          </Suspense>
        </main>
      </div>
    );
  }

  return (
    // The admin area is tables and dense lists: a 5xl column left most of a desktop screen
    // empty while its own rows were cramped.
    <div className={`${route.name === 'admin' ? 'max-w-[1400px]' : route.name === 'plans' ? 'max-w-5xl' : 'max-w-2xl'} mx-auto px-4`}>
      {route.name !== 'circle' && (
        <header className="h-16 pt-1 flex items-center gap-3">
          <button onClick={toCircles} aria-label={t.appName}><Wordmark name={t.appName} /></button>
          <span className="flex-1" />
          {route.name === 'admin' && <button className="text-sm text-green underline" onClick={() => go('/you')}>{t.back}</button>}
          {/* !! matters: is_admin is a number, and `0 && <jsx>` renders a literal "0"
              in the header for every non-admin. */}
          {!!me.is_admin && route.name !== 'admin' && <button className="flex items-center gap-1.5 text-sm text-green rounded-full border border-line px-3 py-1.5 transition-colors duration-[var(--dur-instant)] hover:bg-green-soft" onClick={() => go('/admin')} aria-label={t.rowAdmin}><Icon name="tools" className="w-4 h-4" /><span>{t.rowAdmin}</span></button>}
          {/* Same Memory shortcut as the desktop sidebar header, so the two layouts match. */}
          {route.name !== 'admin' && (
            <button onClick={() => go('/memory')} aria-label={t.tabMemory} title={t.tabMemory} aria-current={route.name === 'memory' ? 'page' : undefined}
              className={`w-11 h-11 rounded-xl flex items-center justify-center transition-colors duration-[var(--dur-instant)]
                ${route.name === 'memory' ? 'bg-green-soft text-green' : 'text-muted hover:bg-green-soft hover:text-green'}`}>
              <Icon name="memory" className="w-5 h-5" />
            </button>
          )}
        </header>
      )}
      {route.name !== 'circle' && <Notices />}
      <main className={showTabs ? 'pb-24' : ''}>
        <Suspense fallback={null}>
        {route.name === 'circles' && <ChatList onOpen={id => go(`/circle/${id}`)} />}
        {route.name === 'memory' && <Memory onOpenArchive={id => go(`/circle/${id}/archive`)} />}
        {route.name === 'sealed' && <SealedPage meId={me.id} onBack={() => go('/you')} />}
        {route.name === 'plans' && <Plans circleId={route.id} onBack={() => go(circleHash(route.id, 'settings'))} />}
        {route.name === 'you' && <You me={me} onLogout={logout} onDeleteAccount={deleteAccount} onAdmin={() => go('/admin')} onSealed={() => go('/sealed')} onChanged={loadMe} />}
        {route.name === 'circle' && <CircleView key={route.id} id={route.id} me={me} initialTab={route.tab} onBack={toCircles} onLeft={toCircles} onTab={t => go(circleHash(route.id, t))} />}
        {/* Rendering null here left a blank page, which reads as a broken app rather
            than as a door that is closed. */}
        {route.name === 'admin' && (me.is_admin
          ? <Admin />
          : <EmptyState icon="ban" title={t.errors.forbidden} action={<button className="btn btn-primary" onClick={toCircles}>{t.tabChats}</button>} />)}
        </Suspense>
      </main>
      {showTabs && (
        <nav aria-label={t.appName} className="fixed bottom-0 inset-x-0 z-20 bg-paper/95 backdrop-blur border-t border-line pb-[env(safe-area-inset-bottom)]">
          <ul className="max-w-2xl mx-auto grid grid-cols-3">
            {tabs.map(([name, label, icon, hash]) => (
              <li key={name}>
                <button onClick={() => go(hash)} aria-current={route.name === name ? 'page' : undefined}
                  className={`w-full py-2 flex flex-col items-center gap-0.5 text-xs ${route.name === name ? 'text-green font-bold' : 'text-muted'}`}>
                  <span aria-hidden className={`px-4 py-1 rounded-full ${route.name === name ? 'bg-green-soft' : ''}`}><Icon name={icon} className="w-6 h-6" /></span>{label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nProvider><App /></I18nProvider></StrictMode>,
);
