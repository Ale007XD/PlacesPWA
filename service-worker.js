const CACHE_NAME = "osm-food-finder-pwa-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Не кэшируем POST-запросы (в т.ч. к Overpass) через эту стратегию
  if (request.method !== "GET") {
    return;
  }

  // Простая стратегия: cache-first для статики, network-first для остального
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request)
        .then((response) => {
          // Кэшируем только успешные базовые ответы
          if (
            response &&
            response.status === 200 &&
            response.type === "basic"
          ) {
            const respClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, respClone);
            });
          }
          return response;
        })
        .catch(() => {
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
