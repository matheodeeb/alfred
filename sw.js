const V = 'alfred-v18';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

// addAll is all-or-nothing: one missing file and the whole install rejects, the worker is
// thrown away, and the app has no offline copy at all — which is exactly what happened while
// the icons were absent from the repo. So each file is fetched on its own and a miss is
// allowed to be a miss. The shell is what matters; an icon that failed to cache is a
// cosmetic loss, not a reason to have no app.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V)
      .then(c => Promise.all(CORE.map(u =>
        c.add(u).catch(err => console.warn('[sw] could not cache', u, err.message)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('.supabase.co')) return; // never cache data calls

  // App shell: network-first so updates land, cache fallback so offline works.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) {                       // never cache a 404/502 as the app shell
          const copy = r.clone();
          caches.open(V).then(c => c.put('./index.html', copy));
        }
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else (icons, fonts): cache-first with backfill.
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(V).then(c => c.put(e.request, copy));
      }
      return r;
    }))
  );
});
