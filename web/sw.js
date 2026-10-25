// Service worker: makes the web app installable and lets the shell and practice tools
// load offline. API responses (personal data) are never cached.
const VERSION = 'vocalize-v2';
const SHELL = [
  './', 'index.html', 'css/app.css', 'css/landing.css',
  'js/config.js', 'js/app.js', 'js/api.js', 'js/ui.js', 'js/audio.js', 'js/charts.js', 'js/landing.js', 'js/reminders.js',
  'js/views/today.js', 'js/views/record.js', 'js/views/sessions.js', 'js/views/practice.js',
  'js/views/progress.js', 'js/views/profile.js',
  'js/views/tools/common.js', 'js/views/tools/tuner.js', 'js/views/tools/warmup.js', 'js/views/tools/match.js',
  'js/views/tools/range.js', 'js/views/tools/breath.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/')) return;   // always live
  // Network first so updates show up immediately; fall back to the cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(event.request, copy)); }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('index.html'))),
  );
});
