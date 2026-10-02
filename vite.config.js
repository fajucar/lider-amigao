import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// A API do Gemini não dá pra proxyar com o "server.proxy" declarativo (target+rewrite) que os
// outros provedores usam: o modelo faz parte da URL (models/<modelo>:generateContent) e a
// chave vai em query string, não em header — e o "rewrite" do proxy só enxerga o path, não o
// corpo da requisição. Por isso este plugin lê o corpo (onde o app manda { model, ...resto },
// igual faz pra Groq/Cerebras) e monta a URL certa, espelhando exatamente o que
// api/gemini/generateContent.js faz em produção (Vercel).
function gemeniDevProxyPlugin(env) {
  return {
    name: 'gemini-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gemini/generateContent', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8')
          const { model, ...body } = raw ? JSON.parse(raw) : {}
          const modelId = model || 'gemini-2.5-flash-lite'
          const upstream = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${env.GEMINI_API_KEY || ''}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          )
          const text = await upstream.text()
          res.statusCode = upstream.status
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
          res.end(text)
        } catch (e) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'Falha ao conectar com o Gemini.' } }))
        }
      })
    },
  }
}

// Plugin de desenvolvimento para o TTS local: executa a mesma lógica de api/tts.js
// sem precisar de um servidor separado. Em produção (Vercel) a Serverless Function
// api/tts.js é chamada diretamente pelo frontend.
function ttsDevPlugin() {
  return {
    name: 'tts-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/tts', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8')
          const { text } = raw ? JSON.parse(raw) : {}
          if (!text || !text.trim()) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: "Campo 'text' vazio ou ausente." }))
            return
          }
          const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
          const tts = new MsEdgeTTS()
          await tts.setMetadata('pt-BR-FranciscaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
          const { audioStream } = await tts.toStream(text.trim())
          res.statusCode = 200
          res.setHeader('Content-Type', 'audio/mpeg')
          res.setHeader('Cache-Control', 'no-store')
          audioStream.on('data', (chunk) => res.write(chunk))
          audioStream.on('end', () => res.end())
          audioStream.on('error', (err) => {
            console.error('Erro no audioStream TTS (dev):', err)
            res.end()
          })
        } catch (e) {
          console.error('Erro TTS dev:', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), gemeniDevProxyPlugin(env), ttsDevPlugin()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY || '',
            'anthropic-version': '2023-06-01',
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('x-api-key', env.ANTHROPIC_API_KEY || '')
              proxyReq.setHeader('anthropic-version', '2023-06-01')
              proxyReq.removeHeader('origin')
              proxyReq.removeHeader('referer')
            })
          },
        },
        '/api/groq': {
          target: 'https://api.groq.com/openai/v1',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/groq/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${env.GROQ_API_KEY || ''}`)
            })
          },
        },
        '/api/cerebras': {
          target: 'https://api.cerebras.ai/v1',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cerebras/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${env.CEREBRAS_API_KEY || ''}`)
            })
          },
        },
      },
    },
  }
})
