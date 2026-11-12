// App-shell service worker. API calls and uploaded media are never cached here.
const CACHE = 'mm-shell-v4';
const SHELL = [
  '/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest',
  '/img/logo.png', '/img/icon-192.png', '/img/icon-512.png',
  '/fonts/Figma-Sans-Text-Regular.otf', '/fonts/Figma-Sans-Text-Bold.otf',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/admin')) return;
  // Network-first so organisers' updates ship instantly; fall back to cache offline.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});
