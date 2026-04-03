const CACHE_NAME = 'diet-store-v4';
const FILES_TO_CACHE = [
    'index.html',
    'app.js',
    'manifest.json'
];

// Risorse CDN da cachare al primo caricamento
const CDN_RESOURCES = [
    'https://unpkg.com/dexie/dist/dexie.js',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await cache.addAll(FILES_TO_CACHE);
            // Cacha le CDN in parallelo, senza bloccare l'install se falliscono
            for (const url of CDN_RESOURCES) {
                try { await cache.add(url); } catch (err) { console.log('CDN cache skip:', url, err); }
            }
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(nomi => {
            return Promise.all(
                nomi.filter(nome => nome !== CACHE_NAME)
                    .map(nome => caches.delete(nome))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = e.request.url;

    // Le chiamate API non vanno mai in cache
    if (url.includes('generativelanguage.googleapis.com')) {
        return;
    }

    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(response => {
                // Cacha al volo le risorse CDN non ancora in cache
                if (response.ok && (url.startsWith('https://unpkg.com/') || url.startsWith('https://cdn.jsdelivr.net/'))) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return response;
            });
        })
    );
});
