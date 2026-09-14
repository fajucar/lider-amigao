import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// O app não funciona offline de verdade (depende de chamadas de IA ao vivo), então não
// registramos mais service worker nenhum. Isso também limpa qualquer service worker de
// uma versão anterior que ainda esteja preso no navegador de quem já usou o app antes
// desta correção — sem isso, a página fica presa em versões antigas mesmo com F5/hard refresh.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    const registros = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registros.map((registro) => registro.unregister()));
    if (window.caches) {
      const nomes = await caches.keys();
      await Promise.all(nomes.map((nome) => caches.delete(nome)));
    }
  });
}
