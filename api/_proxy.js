// Helper compartilhado pelas serverless functions de /api/anthropic, /api/groq e
// /api/cerebras. Substitui, em produção na Vercel, o proxy que existia só no servidor
// de desenvolvimento do Vite (vite.config.js) — sem isso, o app builda mas nenhuma
// chamada de IA funciona, porque o Vercel não roda o dev server.
export async function proxyRequest(req, res, { targetBase, buildHeaders }) {
  const path = Array.isArray(req.query.path) ? req.query.path.join("/") : req.query.path || "";
  const url = `${targetBase}/${path}`;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: buildHeaders(req),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: { message: "Falha ao conectar com o provedor de IA." } });
  }
}
