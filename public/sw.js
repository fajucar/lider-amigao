// Este service worker existiu numa versão anterior do app e causava páginas presas em
// cache antigo mesmo depois de hard refresh. O app não registra mais service worker (ver
// src/main.jsx), então este arquivo agora só serve para remover, de forma automática, o
// registro antigo de quem já tinha instalado a versão anterior — sem exigir limpeza manual.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(nomes.map((nome) => caches.delete(nome)));
      await self.registration.unregister();
      const clientes = await self.clients.matchAll({ type: "window" });
      clientes.forEach((cliente) => cliente.navigate(cliente.url));
    })()
  );
});
