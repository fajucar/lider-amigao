import { proxyRequest } from "../_proxy.js";

// Encaminha /api/anthropic/* para https://api.anthropic.com/*, injetando a chave
// (ANTHROPIC_API_KEY, configurada nas variáveis de ambiente da Vercel) no servidor —
// ela nunca chega ao navegador do usuário.
export default function handler(req, res) {
  return proxyRequest(req, res, {
    targetBase: "https://api.anthropic.com",
    buildHeaders: () => ({
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    }),
  });
}
