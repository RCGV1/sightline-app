const CACHE_NAME = 'sightline-shell-__SIGHTLINE_CACHE_VERSION__';
const APP_ENTRY = new URL('./index.html', self.registration.scope).href;
const APP_ROOT_PATH = new URL('./', self.registration.scope).pathname;
const APP_ENTRY_PATH = new URL('./index.html', self.registration.scope).pathname;
const SHELL_ASSETS = [
  './',
  './index.html',
  './static/style.css',
  './static/app.js',
  './static/engine.js',
  './static/global-data.js',
  './static/manifest.webmanifest',
  './static/favicon.svg',
  './static/icon-192.png',
  './static/icon-512.png',
  './static/scene.json',
  './static/scene-terrain.png',
  './static/scene-classes.png',
  './static/vendor/leaflet/leaflet.css',
  './static/vendor/leaflet/leaflet.js',
  './static/vendor/leaflet/images/marker-icon-2x.png',
  './static/vendor/leaflet/images/marker-icon.png',
  './static/vendor/leaflet/images/marker-shadow.png',
  './LICENSE',
  './THIRD_PARTY_NOTICES.md'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(async keys => {
        const staleKeys = keys.filter(key => key.startsWith('sightline-shell-') && key !== CACHE_NAME);
        await Promise.all(staleKeys.map(key => caches.delete(key)));
        await self.clients.claim();
      })
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range') || url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    const isAppEntry = url.pathname === APP_ROOT_PATH || url.pathname === APP_ENTRY_PATH;
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok && isAppEntry) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(APP_ENTRY, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => (
          cached || (isAppEntry ? caches.match(APP_ENTRY) : undefined)
        )))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
