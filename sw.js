const CACHE_NAME = "dnevnik-zdorovia-v9";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/storage.js",
  "js/config.js",
  "js/db.js",
  "js/app.js",
  "manifest.webmanifest",
  "favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // внешние API (Open Food Facts, Firebase, OpenAI) — только сеть, без кэша
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return resp;
      }).catch(() => {
        if (req.mode === "navigate") return caches.match("index.html");
        return new Response("offline", { status: 503 });
      });
    })
  );
});
