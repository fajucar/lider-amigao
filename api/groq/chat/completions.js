// Substitui, em produção na Vercel, o proxy que no vite.config.js só existe em
// desenvolvimento (npm run dev). Sem isso, a chamada de chat do app (POST
// /api/groq/chat/completions) dá 404 em produção. Cada arquivo aqui é autocontido
// (sem import de outro arquivo) porque rotas dinâmicas/compartilhadas tiveram
// problema de reconhecimento neste projeto da Vercel — arquivo estático simples é
// o formato mais confiável.
export default async function handler(req, res) {
  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY || ""}`,
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: { message: "Falha ao conectar com o Groq." } });
  }
}
