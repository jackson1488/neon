/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'neongram-v15';
const PRECACHE_URLS = [
    '/',
];

// Install — caches shell
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// Fetch — network-first strategy
self.addEventListener('fetch', (event) => {
    // Skip non-GET and API/socket requests
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Cache successful responses
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fallback to cache on network failure
                return caches.match(event.request).then((cached) => {
                    return cached || new Response('Offline', { status: 503 });
                });
            })
    );
});
