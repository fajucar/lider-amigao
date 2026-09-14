import { proxyRequest } from "../_proxy.js";

// Encaminha /api/cerebras/* para https://api.cerebras.ai/v1/*, injetando a chave
// (CEREBRAS_API_KEY, configurada nas variáveis de ambiente da Vercel) no servidor.
export default function handler(req, res) {
  return proxyRequest(req, res, {
    targetBase: "https://api.cerebras.ai/v1",
    buildHeaders: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY || ""}`,
    }),
  });
}
