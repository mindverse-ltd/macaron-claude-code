// Macaron push service worker. Deliberately push-only: it does NOT precache
// app HTML/JS, so a rebuild + refresh always serves the latest bundle. Its
// only jobs are showing Web Push notifications and routing clicks back into
// the SPA.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Macaron', body: event.data && event.data.text() };
  }
  const title = payload.title || 'Macaron';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      requireInteraction: Boolean(payload.requireInteraction),
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            client.postMessage({ type: 'macaron:navigate', url });
            return undefined;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
