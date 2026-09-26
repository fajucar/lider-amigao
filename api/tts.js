// Serverless Function (Vercel) — Text-to-Speech via Microsoft Edge TTS
// Voz: pt-BR-FranciscaNeural (feminina, natural)
// Recebe: POST { text: "..." }
// Retorna: stream de áudio audio/mpeg

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido." });
    return;
  }

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    res.status(400).json({ error: "Campo 'text' vazio ou ausente." });
    return;
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      "pt-BR-FranciscaNeural",
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );

    const { audioStream } = await tts.toStream(text.trim());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    audioStream.on("data", (chunk) => res.write(chunk));
    audioStream.on("end", () => res.end());
    audioStream.on("error", (err) => {
      console.error("Erro no audioStream TTS:", err);
      if (!res.headersSent) res.status(500).json({ error: "Erro no stream de áudio." });
      else res.end();
    });
  } catch (err) {
    console.error("Erro TTS Francisca:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Erro interno no TTS." });
    }
  }
}
