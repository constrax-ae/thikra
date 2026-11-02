// Service worker: makes the app installable and shows push notifications. API traffic is never cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// A push carries {title, body, circle, tag}. The tag replaces the previous notification of the same chat instead of stacking.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON: show a generic one */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Thekra', {
    body: data.body || '', tag: data.tag || 'thikra', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-mono-96.png',
    data: { circle: data.circle },
  }));
});

// Tapping it opens (or focuses) the app on that chat.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const circle = event.notification.data && event.notification.data.circle;
  const url = event.notification.data && event.notification.data.url;
  const path = url || (circle ? `/#/circle/${circle}` : '/');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); if ('navigate' in c) { try { await c.navigate(path); } catch { /* cross-origin guard */ } } return; }
    }
    await self.clients.openWindow(path);
  })());
});
