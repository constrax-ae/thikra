// Service worker: makes the app installable and shows push notifications. API traffic is never cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// A push carries {title, body, circle, tag}. The tag replaces the previous notification of the same chat instead of stacking.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON: show a generic one */ }
  event.waitUntil((async () => {
    // An encrypted chat: the server sent no text. An open page of the app (it holds the keys) may read the newest message and give the words; if none answers, the generic line stays.
    if (data.enc && Number.isInteger(data.circle)) {
      try {
        const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of pages) {
          const text = await new Promise(res => { const ch = new MessageChannel(); const t = setTimeout(() => res(null), 1500); ch.port1.onmessage = e => { clearTimeout(t); res(e.data); }; c.postMessage({ t: 'decrypt', circle: data.circle }, [ch.port2]); });
          if (text && typeof text.text === 'string') { data = { ...data, body: text.text.slice(0, 120) }; break; }
        }
      } catch { /* generic */ }
    }
    return self.registration.showNotification(data.title || 'Tamtim', {
    body: data.body || '', tag: data.tag || 'thikra', renotify: true, icon: '/app-icons/icon-192.png', badge: '/app-icons/icon-mono-96.png',
    data: { circle: data.circle, url: data.url },
  });
  })());
});

// Tapping it opens (or focuses) the app on that chat. Only a path inside this app is ever opened.
function targetPath(d) {
  const url = d && d.url, circle = d && d.circle;
  if (typeof url === 'string' && /^\/(?![\/\\])/.test(url)) return url;
  return Number.isInteger(circle) && circle > 0 ? `/#/circle/${circle}` : '/';
}
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = targetPath(event.notification.data);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        // The page changes its own route: works for an open tab on any screen, with no reload.
        c.postMessage({ t: 'open', path });
        return;
      }
    }
    await self.clients.openWindow(path);
  })());
});
