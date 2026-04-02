const CACHE_NAME = 'diet-store-v2'; // Incrementa questa versione ad ogni deploy

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['index.html', 'app.js']))
  );
  self.skipWaiting(); // Attiva subito il nuovo SW senza aspettare
});

self.addEventListener('activate', (e) => {
  // Elimina tutte le cache vecchie
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim(); // Prende controllo di tutte le tab aperte subito
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
