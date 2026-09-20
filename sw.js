/* Study OS — Service Worker: App-Shell offline, Push-Erinnerungen. Daten bleiben lokal (localStorage). */
const VERSION = '2026-09-21-2';
const SHELL_CACHE = 'studyos-shell-' + VERSION;
const RUNTIME_CACHE = 'studyos-runtime';
const CONFIG_CACHE = 'studyos-config';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  // Kein skipWaiting: die Seite entscheidet über das Update (nie mitten in einer Eingabe).
  // Fehlende Einzeldateien (z. B. ein nicht hochgeladenes Icon) dürfen die Installation nicht verhindern.
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))));
});
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL_CACHE, RUNTIME_CACHE, CONFIG_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Nie cachen: GitHub-API (Sync), Worker (Push), alles andere Fremde ausser CDN-Bibliotheken und Schriften
  if (url.origin !== self.location.origin) {
    if (/(^|\.)cdnjs\.cloudflare\.com$|(^|\.)cdn\.jsdelivr\.net$|(^|\.)fonts\.googleapis\.com$|(^|\.)fonts\.gstatic\.com$/.test(url.hostname)) {
      e.respondWith(cacheFirst(req, RUNTIME_CACHE));
    }
    return;
  }
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
    e.respondWith(networkFirst(req));
  } else {
    e.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});
async function networkFirst(req) {
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) { const c = await caches.open(SHELL_CACHE); c.put('./index.html', res.clone()); }
    return res;
  } catch (err) {
    const c = await caches.open(SHELL_CACHE);
    return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
  }
}
async function cacheFirst(req, name) {
  const c = await caches.open(name), hit = await c.match(req);
  if (hit) return hit;
  try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }
  catch (err) { return hit || Response.error(); }
}

// ── Push: der Server sendet ein leeres Signal, der Inhalt wird beim Worker abgeholt ──
async function pushConfig() {
  try { const r = await (await caches.open(CONFIG_CACHE)).match('push-config'); return r ? await r.json() : null; } catch (e) { return null; }
}
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let items = [];
    try {
      const cfg = await pushConfig();
      if (cfg && cfg.worker && cfg.id) {
        const r = await fetch(cfg.worker.replace(/\/$/, '') + '/pending?id=' + encodeURIComponent(cfg.id), { cache: 'no-store' });
        if (r.ok) items = await r.json();
      }
    } catch (err) { /* offline: generische Meldung */ }
    if (!items.length) items = [{ title: 'Study OS', body: 'Du hast eine Erinnerung.', tag: 'studyos' }];
    for (const it of items.slice(0, 5)) {
      await self.registration.showNotification(it.title || 'Study OS', { body: it.body || '', tag: it.tag || undefined, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: it.url || './' } });
    }
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); return; } }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
