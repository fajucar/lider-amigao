// Service Worker PWA para Líder Amigona
// Política Network-First (sempre busca a versão mais recente na rede)
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass-through: sempre busca da rede ao vivo para não prender código antigo
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
