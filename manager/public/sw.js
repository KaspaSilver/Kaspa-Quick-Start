/*
 * Service worker for the Kaspa Quick Start panel.
 *
 * Its only job is to make the panel installable (a home-screen / taskbar app)
 * and openable offline enough to show a shell. It is deliberately NOT a cache
 * layer for a live control panel:
 *
 *   - Network-first, always. A control panel that served a stale app.js or a
 *     cached status would be worse than one that simply needs a connection, so
 *     the cache is only ever a fallback for when the network is gone.
 *   - /api/ is never touched -- not the calls, and especially not the log
 *     stream (Server-Sent Events), which a fetch handler would break.
 *   - Only GET is considered; anything else goes straight to the network.
 */

const CACHE = 'kqs-shell-v1';
const SHELL = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/qrcode.js',
    '/qr.js',
    '/favicon.png',
    '/kaspa-mark.png',
    '/icon-192.png',
    '/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            // Individual misses must not fail the whole install.
            .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // never intercept writes

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // third-party, leave alone
    if (url.pathname.startsWith('/api/')) return; // API + SSE: straight to network

    // Network-first: the live server wins whenever it can be reached. Refresh
    // the cached shell copy on the way through, so the offline fallback tracks
    // the newest build rather than freezing at first install.
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.ok && SHELL.includes(url.pathname)) {
                    const copy = res.clone();
                    caches.open(CACHE).then((cache) => cache.put(req, copy));
                }
                return res;
            })
            .catch(() =>
                caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error())),
            ),
    );
});
