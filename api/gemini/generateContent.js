// Ver comentário em api/groq/chat/completions.js — mesmo padrão (arquivo autocontido, sem
// import de outro arquivo, rota estática) exigido pela detecção de functions da Vercel.
//
// A API do Gemini é diferente da Groq/Cerebras/Anthropic: o modelo vai na URL
// (models/<modelo>:generateContent), não no corpo, e a chave vai como query string, não
// como header. Pra manter o mesmo formato de chamada usado pelos outros provedores (modelo
// escolhido no corpo da requisição, em App.jsx), o app manda { model, ...resto } e esta rota
// monta a URL certa aqui dentro.
export default async function handler(req, res) {
  try {
    const { model, ...body } = req.body || {};
    const modelId = model || "gemini-2.5-flash-lite";
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${process.env.GEMINI_API_KEY || ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: { message: "Falha ao conectar com o Gemini." } });
  }
}
