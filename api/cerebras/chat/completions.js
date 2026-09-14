// Ver comentário em api/groq/chat/completions.js — mesmo padrão, provedor reserva.
export default async function handler(req, res) {
  try {
    const upstream = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CEREBRAS_API_KEY || ""}`,
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: { message: "Falha ao conectar com o Cerebras." } });
  }
}
