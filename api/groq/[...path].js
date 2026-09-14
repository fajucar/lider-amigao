import { proxyRequest } from "../_proxy.js";

// Encaminha /api/groq/* para https://api.groq.com/openai/v1/*, injetando a chave
// (GROQ_API_KEY, configurada nas variáveis de ambiente da Vercel) no servidor.
export default function handler(req, res) {
  return proxyRequest(req, res, {
    targetBase: "https://api.groq.com/openai/v1",
    buildHeaders: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY || ""}`,
    }),
  });
}
