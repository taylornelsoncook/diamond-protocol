// The athlete app's service worker (version 70): keeps the app's shell so it opens with no signal, and shows push
// notifications. A push carries nothing; the worker asks the server what's new for this phone (POST /push/pending with
// its own subscription endpoint) and shows that, so nothing personal travels through the push service.
const SHELL = 'dp-app-shell-v1';
const SHELL_FILES = ['/app', '/client.css', '/styles.css', '/engage.css', '/brand/mark.png', '/app.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first; the shell from the cache when there's no signal. API calls are never cached here (the app keeps its own copy).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/app/api') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/portal/api')) return;
  const shellPath = e.request.mode === 'navigate' ? '/app' : url.pathname;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (e.request.mode === 'navigate' || /\.(css|js|mjs|png|webmanifest)$/.test(url.pathname))) caches.open(SHELL).then((c) => c.put(shellPath, res.clone())).catch(() => {});
    return res;
  }).catch(() => caches.match(shellPath).then((hit) => hit || Response.error())));
});
// A push: ask what to show for this phone, then show each notice. With nothing waiting, a quiet nudge to open the app.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const sub = await self.registration.pushManager.getSubscription();
    let notices = [];
    if (sub) {
      try { const r = await fetch('/push/pending', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); if (r.ok) notices = (await r.json()).data ?? []; } catch { /* offline: show the plain nudge */ }
    }
    if (!notices.length) notices = [{ title: 'Diamond Protocol', body: 'Something new from your coach. Open the app.', url: '/app' }];
    for (const n of notices) await self.registration.showNotification(n.title, { body: n.body || '', icon: '/brand/logo.png', badge: '/brand/mark.png', tag: n.id || n.kind || 'dp', data: { url: n.url || '/app' } });
  })());
});
// Tapping a notification opens the app (an open window is focused and sent there).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/app', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(location.origin + '/app'));
    if (open) return open.focus().then((c) => c.navigate?.(url) ?? c);
    return self.clients.openWindow(url);
  }));
});
