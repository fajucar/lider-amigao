// Ver comentário em api/groq/chat/completions.js — usado pra extração de PDF do
// regulamento e visão (análise de fotos de ocorrência).
export default async function handler(req, res) {
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: { message: "Falha ao conectar com a Anthropic." } });
  }
}
