import React, { useState, useEffect, useRef, useMemo } from "react";
import regrasCondominio from "./data/regras.json";
import { montarContextoRegras, citacaoCurta, buscarArtigosRelevantes } from "./lib/buscaRegras.js";
import { montarSystemPrompt } from "./config/promptAssistente.js";

// ---------- Persistência segura ----------
const store = {
  async get(key, fallback) {
    try {
      if (window.storage) {
        const r = await window.storage.get(key);
        return r && r.value ? JSON.parse(r.value) : fallback;
      }
      const local = localStorage.getItem(key);
      return local ? JSON.parse(local) : fallback;
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try {
      if (window.storage) {
        await window.storage.set(key, JSON.stringify(value));
        return;
      }
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const PDF_DB_NAME = "lider_amigao_files";
const PDF_STORE_NAME = "arquivos";

function abrirBancoPDF() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PDF_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PDF_STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function salvarPDF(file, base64, id = "regulamento") {
  const db = await abrirBancoPDF();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(PDF_STORE_NAME, "readwrite");
    transaction.objectStore(PDF_STORE_NAME).put({
      id,
      nome: file.name,
      tipo: file.type || "application/pdf",
      tamanho: file.size,
      base64,
      salvoEm: new Date().toISOString(),
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function obterPDF(id = "regulamento") {
  const db = await abrirBancoPDF();
  const arquivo = await new Promise((resolve, reject) => {
    const request = db.transaction(PDF_STORE_NAME, "readonly").objectStore(PDF_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return arquivo;
}

function redimensionarImagem(file) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => {
      const imagem = new Image();
      imagem.onload = () => {
        const escala = Math.min(1, 1280 / Math.max(imagem.width, imagem.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(imagem.width * escala));
        canvas.height = Math.max(1, Math.round(imagem.height * escala));
        canvas.getContext("2d").drawImage(imagem, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      imagem.onerror = () => reject(new Error("Não foi possível ler a foto."));
      imagem.src = leitor.result;
    };
    leitor.onerror = () => reject(new Error("Não foi possível ler a foto."));
    leitor.readAsDataURL(file);
  });
}

// ---------- Chamada à IA (chat e relatório de turno) ----------
// Ordem de custo: Gemini (principal, free tier generoso) -> Groq (backup 1) -> Cerebras
// (backup 2). Ver callChatWithFallback.
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GROQ_MODEL = "qwen/qwen3.8-27b";
const CEREBRAS_MODEL = "qwen-3.8-27b";

// Nome/chaves internas mantidos como "Groq" por histórico (não vale a pena migrar o
// localStorage do usuário), mas conta chamada de QUALQUER provedor de IA (Gemini/Groq/Cerebras).
function registrarChamadaIA() {
  try {
    const atual = Number(localStorage.getItem("lider_amigao_groq_chamadas") || 0) + 1;
    localStorage.setItem("lider_amigao_groq_chamadas", String(atual));
    window.dispatchEvent(new CustomEvent("lider-amigao-groq-call", { detail: atual }));
  } catch {}
}

function extrairObjetoJSON(texto) {
  const inicio = texto.indexOf("{");
  if (inicio < 0) return null;
  let profundidade = 0;
  let dentroString = false;
  let escapado = false;
  for (let i = inicio; i < texto.length; i += 1) {
    const caractere = texto[i];
    if (dentroString) {
      if (escapado) escapado = false;
      else if (caractere === "\\") escapado = true;
      else if (caractere === '"') dentroString = false;
      continue;
    }
    if (caractere === '"') dentroString = true;
    else if (caractere === "{") profundidade += 1;
    else if (caractere === "}" && --profundidade === 0) return texto.slice(inicio, i + 1);
  }
  return null;
}

const PALAVRAS_IGNORADAS_REGULAMENTO = new Set([
  "para", "como", "qual", "quando", "onde", "pode", "podem", "deve", "devem", "isso", "essa", "este", "esta",
  "com", "sem", "uma", "que", "dos", "das", "nos", "nas", "por", "mais", "sobre", "durante", "turno",
]);

function normalizarTexto(texto) {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function encontrarTrechoRegulamento(regulamento, ocorrencia) {
  const linhas = regulamento.split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
  const tokensOriginais = normalizarTexto(ocorrencia)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !PALAVRAS_IGNORADAS_REGULAMENTO.has(token));
  const aliases = {
    barulho: ["silencio", "ruido"],
    carro: ["veiculo", "estacionamento", "vaga"],
    estacionado: ["estacionamento", "vaga"],
    estacionada: ["estacionamento", "vaga"],
    vaga: ["estacionamento", "veiculo"],
    visitante: ["visita", "visitantes", "acesso"],
    entrega: ["encomenda", "entregador"],
  };
  const tokens = [...new Set(tokensOriginais.flatMap((token) => [token, ...(aliases[token] || [])]))];
  if (!tokens.length) return null;

  // Pontua por uma janela de linhas (não só a linha isolada), porque um mesmo
  // artigo costuma se estender por várias linhas no texto extraído do PDF.
  const JANELA = 3;
  let melhor = { indice: -1, pontos: 0 };
  linhas.forEach((_, indice) => {
    const texto = normalizarTexto(linhas.slice(indice, indice + JANELA).join(" "));
    const pontos = tokens.reduce((total, token) => total + (texto.includes(token) ? 1 : 0), 0);
    if (pontos > melhor.pontos) melhor = { indice, pontos };
  });
  const minimoDeSinais = tokensOriginais.length >= 2 ? 2 : 1;
  if (melhor.pontos < minimoDeSinais) return null;

  const inicio = Math.max(0, melhor.indice - 2);
  const fim = Math.min(linhas.length, melhor.indice + JANELA + 2);
  return linhas.slice(inicio, fim).join("\n");
}

function termosDeBusca(consulta) {
  return normalizarTexto(consulta)
    .split(/[^a-z0-9]+/)
    .filter((termo) => termo.length >= 3 && !PALAVRAS_IGNORADAS_REGULAMENTO.has(termo));
}

// Casa a palavra buscada mesmo com variação de plural/conjugação (ex.: "vaga" -> "vagas",
// "estacionar" -> "estacionado"), permitindo até 3 letras extras depois do radical buscado.
function regexTermo(termo) {
  const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])(${escapado}[\\p{L}]{0,3})($|[^\\p{L}])`, "gu");
}

function linhaContemTermo(linhaNormalizada, termo) {
  return regexTermo(termo).test(linhaNormalizada);
}

// Busca por palavra-chave no regulamento inteiro, retornando TODAS as linhas que
// batem (não só a melhor), ordenadas por relevância — usado pela caixa de busca da aba Regras.
function buscarNoRegulamento(regulamento, consulta) {
  const termos = termosDeBusca(consulta);
  if (!termos.length || !regulamento) return [];

  const linhas = regulamento.split(/\r?\n/);
  const linhasNormalizadas = linhas.map((linha) => normalizarTexto(linha));

  const frequencia = {};
  termos.forEach((termo) => {
    frequencia[termo] = linhasNormalizadas.filter((linha) => linhaContemTermo(linha, termo)).length;
  });

  const resultados = [];
  linhas.forEach((linha, indice) => {
    if (!linha.trim()) return;
    const linhaNormalizada = linhasNormalizadas[indice];
    const termosEncontrados = termos.filter((termo) => linhaContemTermo(linhaNormalizada, termo));
    if (!termosEncontrados.length) return;
    // Termos raros no documento pesam mais que termos muito comuns.
    const pontos = termosEncontrados.reduce((total, termo) => total + 1 / Math.max(1, frequencia[termo]), 0);
    resultados.push({ indice, linha, termosEncontrados, pontos });
  });

  resultados.sort((a, b) => b.pontos - a.pontos || a.indice - b.indice);
  return resultados;
}

function destacarTermos(linhaOriginal, termos) {
  const linhaNormalizada = normalizarTexto(linhaOriginal);
  const intervalos = [];
  termos.forEach((termo) => {
    const re = regexTermo(termo);
    let m;
    while ((m = re.exec(linhaNormalizada))) {
      const inicio = m.index + m[1].length;
      const fim = inicio + m[2].length;
      intervalos.push([inicio, fim]);
      re.lastIndex = fim;
    }
  });
  if (!intervalos.length) return linhaOriginal;

  intervalos.sort((a, b) => a[0] - b[0]);
  const mesclados = [];
  intervalos.forEach(([inicio, fim]) => {
    const ultimo = mesclados[mesclados.length - 1];
    if (ultimo && inicio <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], fim);
    else mesclados.push([inicio, fim]);
  });

  const partes = [];
  let cursor = 0;
  mesclados.forEach(([inicio, fim], i) => {
    if (inicio > cursor) partes.push(linhaOriginal.slice(cursor, inicio));
    partes.push(
      <mark key={i} className="bg-emerald-400/30 text-emerald-200 rounded px-0.5">
        {linhaOriginal.slice(inicio, fim)}
      </mark>
    );
    cursor = fim;
  });
  if (cursor < linhaOriginal.length) partes.push(linhaOriginal.slice(cursor));
  return partes;
}

function tituloDoTrecho(trecho) {
  const linha = trecho.split("\n").find((item) => /(?:^|\s)(?:#{1,6}\s*)?(?:\d+[.)]\s+|cap[ií]tulo\b|artigo\b|se[cç][aã]o\b)/i.test(item));
  return linha ? linha.replace(/^#+\s*/, "").trim() : "Trecho relacionado (sem numeração)";
}

// Reconstrói um texto corrido (capítulo + artigos) a partir de src/data/regras.json, pra
// preencher a aba Regras por padrão, sem precisar fazer upload manual do PDF. Só usada quando
// ainda não existe nada salvo (upload manual sempre tem prioridade sobre isso).
function textoRegrasDefault(fonte) {
  const artigos = regrasCondominio.filter((r) => r.fonte === fonte);
  if (!artigos.length) return "";
  const capitulos = [];
  const porCapitulo = new Map();
  artigos.forEach((r) => {
    const chave = r.capitulo?.numero ?? "?";
    if (!porCapitulo.has(chave)) {
      porCapitulo.set(chave, []);
      capitulos.push({ chave, titulo: r.capitulo?.titulo || "" });
    }
    porCapitulo.get(chave).push(r);
  });
  return capitulos
    .map(({ chave, titulo }) => {
      const cabecalho = `CAPÍTULO ${chave} – ${titulo}`;
      const corpo = porCapitulo
        .get(chave)
        .map((r) => `Art. ${r.artigo}º ${r.texto}`)
        .join("\n\n");
      return `${cabecalho}\n\n${corpo}`;
    })
    .join("\n\n");
}

function linhaReferenciaRegulamento(referencia) {
  if (!referencia || referencia.artigo === "Não encontrado") {
    return "📖 Referência: Nenhuma regra específica encontrada no regulamento para este caso.";
  }
  return `📖 Referência: ${referencia.artigo} — ${referencia.resumo}`;
}

// Gemini não usa o formato "messages" (OpenAI-style) da Groq/Cerebras: o system vai à parte
// (systemInstruction) e o histórico vira "contents" com role "user"/"model". responseMimeType
// "application/json" força o Gemini a devolver só JSON válido (mais confiável que pedir isso
// só via texto no prompt, como fazemos pra Groq/Cerebras).
async function callGemini(system, messages, options = {}) {
  registrarChamadaIA();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const generationConfig = { maxOutputTokens: 450 };
    // Nem toda chamada quer JSON (ex.: o relatório de turno gera um e-mail em texto livre) —
    // só força responseMimeType quando o chamador realmente espera JSON (padrão: true, é o
    // caso mais comum aqui, o chat e a referência de regulamento).
    if (options.json !== false) generationConfig.responseMimeType = "application/json";
    const res = await fetch("/api/gemini/generateContent", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error?.message || `A API Gemini retornou erro ${res.status}.`);
      error.status = data.error?.code || res.status;
      throw error;
    }
    const texto = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!texto) {
      const error = new Error("O Gemini não retornou texto (resposta bloqueada ou vazia).");
      error.status = "vazio";
      throw error;
    }
    return texto;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroq(system, messages, options = {}) {
  registrarChamadaIA();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("/api/groq/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 450,
        reasoning_effort: "none",
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error?.message || `A API Groq retornou erro ${res.status}.`);
      error.status = res.status;
      throw error;
    }
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function callCerebras(system, messages, options = {}) {
  registrarChamadaIA();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("/api/cerebras/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        max_completion_tokens: 450,
        temperature: 0.2,
        reasoning_effort: "none",
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error?.message || data.message || `A API Cerebras retornou erro ${res.status}.`);
      error.status = res.status;
      throw error;
    }
    console.log("Lider Amigão: resposta do provedor Cerebras");
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function callClaudeVision(system, imageDataUrl, text) {
  const res = await fetch("/api/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 450,
      system,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageDataUrl.split(",")[1] } },
          {
            type: "text",
            text:
              "O texto abaixo foi informado pelo usuário e deve ser usado como contexto factual adicional da imagem. " +
              "Use dados como apartamento, placa, modelo, morador e evento para complementar a ocorrência, mesmo que não estejam visíveis na foto. " +
              "Não descarte nem invente esses dados.\n\n" + text,
          },
        ],
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `A API Claude retornou erro ${res.status}.`);
  console.log("Lider Amigão: resposta visual do provedor Claude");
  return data.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
}

// Ordem de fallback: Gemini (principal, free tier) -> Groq (backup 1, 2 tentativas) ->
// Cerebras (backup 2). Cada provedor só entra se o(s) anterior(es) falharem de verdade.
async function callChatWithFallback(system, messages, options = {}) {
  let erroGemini;
  try {
    const resposta = await callGemini(system, messages, options);
    console.log("Lider Amigão: resposta do provedor Gemini");
    return resposta;
  } catch (e) {
    erroGemini = e;
    console.warn("Lider Amigão: Gemini falhou, tentando Groq", erroGemini);
  }

  let erroGroq;
  try {
    const resposta = await callGroq(system, messages, { json: true });
    console.log("Lider Amigão: resposta do provedor Groq");
    return resposta;
  } catch (e) {
    erroGroq = e;
    console.warn("Lider Amigão: Groq falhou na 1ª tentativa", erroGroq);
    // Falhas de Groq costumam ser engasgos passageiros (limite de requisições, timeout
    // pontual). Uma segunda tentativa rápida resolve a maioria antes de recorrer ao
    // Cerebras, que é só um backup e não deve ser o caminho normal.
    await new Promise((r) => setTimeout(r, 800));
    try {
      const resposta = await callGroq(system, messages, { json: true });
      console.log("Lider Amigão: resposta do provedor Groq (2ª tentativa)");
      return resposta;
    } catch (erroGroq2) {
      console.warn("Lider Amigão: Groq falhou de novo, usando Cerebras", erroGroq2);
      erroGroq = erroGroq2;
    }
  }

  try {
    const resposta = await callCerebras(system, messages, { json: true });
    console.log("Lider Amigão: resposta do provedor Cerebras");
    return resposta;
  } catch (erroCerebras) {
    console.error("Lider Amigão: Gemini, Groq e Cerebras falharam", { erroGemini, erroGroq, erroCerebras });
    const erro = new Error(
      `Gemini (status ${erroGemini.status ?? "?"}): ${erroGemini.message} | ` +
        `Groq (status ${erroGroq.status ?? "?"}): ${erroGroq.message} | ` +
        `Cerebras (status ${erroCerebras.status ?? "?"}): ${erroCerebras.message}`
    );
    erro.status = erroCerebras.name === "AbortError" ? "timeout" : erroCerebras.status;
    erro.statusGroq = erroGroq.name === "AbortError" ? "timeout" : erroGroq.status;
    erro.statusGemini = erroGemini.name === "AbortError" ? "timeout" : erroGemini.status;
    throw erro;
  }
}

const CATEGORIAS = [
  { id: "acesso", label: "Acesso", cor: "bg-sky-500/20 text-sky-300 border-sky-500/30" },
  { id: "encomenda", label: "Encomenda", cor: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  { id: "manutencao", label: "Manutenção", cor: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  { id: "seguranca", label: "Segurança", cor: "bg-red-500/20 text-red-300 border-red-500/30" },
  { id: "outros", label: "Outros", cor: "bg-slate-500/20 text-slate-300 border-slate-500/30" },
];

function catInfo(id) {
  return CATEGORIAS.find((c) => c.id === id) || CATEGORIAS[4];
}

// Cores das etiquetas de categoria no novo visual (vidro), por tema.
function corBadgeCategoria(id, tema) {
  const escuro = {
    acesso: { bg: "rgba(34,197,94,.22)", texto: "#BBF7D0" },
    encomenda: { bg: "rgba(34,211,238,.22)", texto: "#A5F3FC" },
    manutencao: { bg: "rgba(167,139,250,.28)", texto: "#EDE9FE" },
    seguranca: { bg: "rgba(253,224,71,.2)", texto: "#FEF3C7" },
    outros: { bg: "rgba(255,255,255,.14)", texto: "rgba(255,255,255,.85)" },
  };
  const claro = {
    acesso: { bg: "rgba(22,163,74,.16)", texto: "#166534" },
    encomenda: { bg: "rgba(8,145,178,.16)", texto: "#155E75" },
    manutencao: { bg: "rgba(109,40,217,.16)", texto: "#5B21B6" },
    seguranca: { bg: "rgba(202,138,4,.18)", texto: "#854D0E" },
    outros: { bg: "rgba(109,40,217,.08)", texto: "#4C3A6B" },
  };
  const mapa = tema === "light" ? claro : escuro;
  return mapa[id] || mapa.outros;
}

// ---------- Ocorrências: botões de LOCAL (substituem os antigos botões de categoria) ----------
const LOCAIS = [
  { id: "terreo", label: "Térreo" },
  { id: "pav1", label: "1º Pav." },
  { id: "pav2", label: "2º Pav." },
  { id: "pav3", label: "3º Pav." },
  { id: "andar4", label: "4º Andar" },
  { id: "outros", label: "Outros" },
];

// Nome final do local pra salvar/exibir: o rótulo do botão, ou o texto digitado quando for "Outros".
function nomeDoLocal(id, textoCustom) {
  if (id === "outros") return (textoCustom || "").trim() || "Outros";
  return LOCAIS.find((l) => l.id === id)?.label || "Outros";
}

// Cores das etiquetas de local no card de ocorrência, por tema (mesmo estilo vidro das categorias).
function corBadgeLocal(id, tema) {
  const escuro = {
    terreo: { bg: "rgba(34,197,94,.22)", texto: "#BBF7D0" },
    pav1: { bg: "rgba(34,211,238,.22)", texto: "#A5F3FC" },
    pav2: { bg: "rgba(167,139,250,.28)", texto: "#EDE9FE" },
    pav3: { bg: "rgba(253,224,71,.2)", texto: "#FEF3C7" },
    andar4: { bg: "rgba(248,113,113,.22)", texto: "#FECACA" },
    outros: { bg: "rgba(255,255,255,.14)", texto: "rgba(255,255,255,.85)" },
  };
  const claro = {
    terreo: { bg: "rgba(22,163,74,.16)", texto: "#166534" },
    pav1: { bg: "rgba(8,145,178,.16)", texto: "#155E75" },
    pav2: { bg: "rgba(109,40,217,.16)", texto: "#5B21B6" },
    pav3: { bg: "rgba(202,138,4,.18)", texto: "#854D0E" },
    andar4: { bg: "rgba(190,18,60,.16)", texto: "#9F1239" },
    outros: { bg: "rgba(109,40,217,.08)", texto: "#4C3A6B" },
  };
  const mapa = tema === "light" ? claro : escuro;
  return mapa[id] || mapa.outros;
}

// ---------- Rotinas do condomínio (Nativ Tatuapé Garden) ----------
// Horários-chave (mostrados no topo da aba, sempre visíveis)
const ROTINAS_HORARIOS = [
  { hora: "07h00", texto: "Início do plantão — abrir quadra de tênis e áreas do 4º andar" },
  { hora: "a cada 1h", texto: "Ronda: 4º andar, 3º, 2º, 1º pavimentos e térreo" },
  { hora: "17h00", texto: "Retirar forros dos elevadores + acender luzes dos pavimentos" },
  { hora: "17h40", texto: "Acender luzes do hall das Torres 1 e 2 e do 4º andar" },
  { hora: "19h00", texto: "Fim do plantão diurno" },
];

const ROTINAS = [
  {
    id: "inicio",
    icon: "🌅",
    titulo: "Início do plantão",
    grupos: [
      {
        itens: [
          "Retirar a chave nº 54.",
          "Abrir a quadra de tênis do térreo.",
          "Subir ao 4º andar e abrir: brinquedoteca, sala de jogos e quadra.",
        ],
      },
    ],
  },
  {
    id: "ibuttons",
    icon: "📍",
    titulo: "Ronda com bastão (iButtons)",
    grupos: [
      {
        itens: [
          "Iniciar a ronda com o bastão eletrônico, lendo TODOS os iButtons.",
          "Verificar todos os shafts em busca de vazamentos.",
          "Se achar irregularidade: foto da ocorrência + foto do iButton correspondente + publicar no grupo Vigia (WhatsApp).",
        ],
      },
      {
        sub: "Lista de iButtons",
        itens: [
          "1. Portaria",
          "2. Atrás da quadra",
          "3. Área Pet",
          "4. Torre 1 – 25º andar (cavalete)",
          "5. Torre 1 – Térreo (ao lado da porta trancada)",
          "6. Torre 2 – 25º andar (2 iButtons: um no cavalete, outro dentro do shaft)",
          "7. Torre 2 – Andares 23, 20, 17, 14, 11, 8, 5 e 4 (lado do final 6, dentro do shaft)",
          "8. Torre 2 – Térreo (ao lado da porta trancada)",
          "9. Garagem 3º e 2º pav.: dois iButtons de cada lado | 1º pav.: apenas um",
          "10. Térreo garagem: atrás da porta da lixeira T2 | em frente à lixeira T1 | porta branca de entrada T1",
          "11. Mensageria",
        ],
      },
    ],
  },
  {
    id: "prestadores",
    icon: "🔧",
    titulo: "Prestadores de serviço",
    grupos: [
      {
        itens: [
          "Prestadores com máquinas/equipamentos/materiais: acompanhar pela rampa do estacionamento, usando o elevador de serviço do 1º pavimento.",
        ],
      },
      {
        sub: "Prestadores da Enel",
        itens: [
          "Antes de entrar: pedir documento (RG ou crachá funcional).",
          "Comunicar o gerente predial, Fernando.",
          "Só liberar após autorização.",
          "Depois de liberado: acompanhar até o Centro de Medição da Torre 1 ou 2 (1º pavimento).",
        ],
      },
    ],
  },
  {
    id: "eventos",
    icon: "🎊",
    titulo: "Feira e Happy Hour",
    grupos: [
      {
        itens: [
          "Feira: toda terça-feira.",
          "Happy Hour: última sexta-feira do mês.",
        ],
      },
      {
        sub: "Procedimento",
        itens: [
          "Isolar todas as vagas após o segundo portão da triagem.",
          "Aguardar a chegada dos prestadores do evento.",
          "Com todos no local: tampar a facial de saída do P6 e travar o portão P6.",
          "Ficar na rotatória orientando os veículos na entrada e saída.",
          "Ao terminar: liberar a facial e destravar o P6.",
        ],
      },
    ],
  },
  {
    id: "salao",
    icon: "🥳",
    titulo: "Salão de festas e churrasqueiras",
    grupos: [
      {
        sub: "Antes do uso",
        itens: [
          "Fazer o check-list dos itens disponíveis e conferir com a relação existente.",
          "Solicitar a lista de convidados. SEM lista, não entra visitante.",
        ],
      },
      {
        sub: "Depois do evento",
        itens: [
          "Fazer o check-out da área.",
          "Se o morador não descer, pedir à portaria que o chame.",
          "Morador não compareceu: concluir o check-out e registrar no grupo Vigia.",
        ],
      },
      {
        sub: "Regras",
        itens: [
          "Visitantes NÃO acessam: brinquedoteca, sala de jogos, piscina, academia e demais áreas comuns. Ficam só no salão.",
          "Playground: visitante só acompanhado de morador.",
          "Churrasqueira: visitante fica só na área da churrasqueira.",
          "Proibido fumar no salão ou áreas comuns. Fumódromo: ao lado da quadra de tênis do térreo (2 cinzeiros de alumínio).",
        ],
      },
    ],
  },
  {
    id: "areas",
    icon: "🏊",
    titulo: "Áreas comuns",
    grupos: [
      { destaque: "Senha das portas: 1809", itens: [] },
      {
        sub: "Piscina (07h–22h)",
        itens: [
          "Proibido: visitantes, garrafas de vidro, alimentos, bolas e objetos perfurantes.",
          "Crianças só acima de 12 anos.",
          "Chafariz infantil (se o morador pedir): chave de cordão verde na Expedição → casa de bombas infantil (em frente à vaga 513, 3º pav.) → acionar botão do quadro elétrico.",
        ],
      },
      {
        sub: "Sala de jogos e brinquedoteca (07h–22h)",
        itens: [
          "Proibido: visitantes, comer, objetos perfurantes, bebida alcoólica e danificar decoração/patrimônio.",
        ],
      },
      {
        sub: "Quadra do 4º andar (07h–22h)",
        itens: [
          "Proibido: visitantes, comer, objetos perfurantes e garrafas de vidro.",
          "Só aqui é permitido bicicleta, patins e patinete.",
        ],
      },
      {
        sub: "Academia (05h–00h)",
        itens: [
          "Proibido: visitantes, comer, objetos perfurantes, garrafas de vidro e treinar sem camisa.",
        ],
      },
      {
        sub: "Quadra de tênis (térreo)",
        itens: [
          "Proibido: visitantes, comer, objetos perfurantes, garrafas de vidro, tênis de solado preto, bicicleta, skate, patins e patinete.",
        ],
      },
    ],
  },
  {
    id: "pet",
    icon: "🐶",
    titulo: "Área Pet",
    grupos: [
      {
        itens: [
          "Achou dejeto: tirar foto → publicar no grupo Vigia → marcar o administrador ou a subsíndica → recolher as fezes.",
        ],
      },
    ],
  },
  {
    id: "encerramento",
    icon: "🌙",
    titulo: "Encerramento do plantão",
    grupos: [
      {
        itens: [
          "Antes da rendição, preencher o livro de ocorrências.",
          "Informar a equipe presente e os equipamentos utilizados.",
          "Registrar ocorrências de gravidade e infrações de moradores, se houver.",
          "Informar se o posto ficou sem novidades.",
          "Entregar o posto limpo, organizado e em ordem para o próximo colaborador.",
        ],
      },
    ],
  },
];

function hojeISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function fmtHora(ts) {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDataLonga(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}

// ---------- Text-to-Speech: seleção de voz pt-BR + correções fonéticas ----------

// Palavras que o sintetizador de voz costuma pronunciar errado (ex.: lidas como se fossem
// inglês). A chave é comparada sem acento e em minúsculas (via normalizarTexto); o valor é o
// que é realmente enviado pro sintetizador no lugar da palavra original. Adicione novos pares
// aqui conforme forem aparecendo problemas de pronúncia.
const CORRECOES_FONETICAS = {
  lider: "líder",
};

// Troca cada palavra do texto que bater com o mapa de correções, preservando a
// capitalização original (maiúscula inicial vira maiúscula inicial na substituição).
function aplicarCorrecoesFoneticas(texto) {
  return texto.replace(/\p{L}+/gu, (palavra) => {
    const substituicao = CORRECOES_FONETICAS[normalizarTexto(palavra)];
    if (!substituicao) return palavra;
    const eraMaiuscula = palavra[0] === palavra[0].toUpperCase() && palavra[0] !== palavra[0].toLowerCase();
    return eraMaiuscula ? substituicao[0].toUpperCase() + substituicao.slice(1) : substituicao;
  });
}

// getVoices() do navegador às vezes retorna [] na primeira chamada, porque a lista de vozes
// carrega de forma assíncrona. Esta função devolve uma Promise que só resolve quando a lista
// já estiver populada (ouvindo o evento 'voiceschanged'), com um timeout de segurança pra
// navegadores que nunca disparam esse evento.
let vozesCarregadasPromise = null;
function obterVozes() {
  if (!window.speechSynthesis) return Promise.resolve([]);
  const vozesAtuais = window.speechSynthesis.getVoices();
  if (vozesAtuais.length) return Promise.resolve(vozesAtuais);
  if (!vozesCarregadasPromise) {
    vozesCarregadasPromise = new Promise((resolve) => {
      const handler = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", handler);
        resolve(window.speechSynthesis.getVoices());
      };
      window.speechSynthesis.addEventListener("voiceschanged", handler);
      setTimeout(() => resolve(window.speechSynthesis.getVoices()), 300);
    });
  }
  return vozesCarregadasPromise;
}

// Escolhe a melhor voz disponível: pt-BR exata primeiro, depois qualquer variante de
// português, e null se o dispositivo não tiver nenhuma (nesse caso o utterance.lang = "pt-BR"
// continua valendo, então o navegador ainda tenta ler como português com a voz padrão).
function escolherVozPtBR(vozes) {
  if (!vozes || !vozes.length) return null;
  return (
    vozes.find((v) => v.lang?.toLowerCase() === "pt-br") ||
    vozes.find((v) => v.lang?.toLowerCase().startsWith("pt")) ||
    null
  );
}

// ---------- Ícones (substituem os emojis usados antes; estilo linha, 2.75 de espessura) ----------
const ICONE_PATHS = {
  relogio: { circles: [[12, 12, 9]], path: "M12 7v5l3 2" },
  mensagem: { path: "M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3-.5L4 21l1.6-4A8.4 8.4 0 1 1 21 11.5z" },
  checkQuadro: { rects: [[3, 4, 18, 17, 4]], path: "M8 12l3 3 5-6" },
  livro: { path: "M5 4h14v17H7a2 2 0 0 1-2-2z|M9 8h6M9 12h6" },
  arquivo: { path: "M14 3v5h5|M6 3h8l5 5v13H6z|M9 14h6" },
  menu: { path: "M4 6h16M4 12h16M4 18h10" },
  mic: { rects: [[9, 3, 6, 11, 3]], path: "M5 11a7 7 0 0 0 14 0M12 18v3" },
  mais: { path: "M12 5v14M5 12h14" },
  seta: { path: "M5 12h13M13 6l6 6-6 6" },
  check: { path: "M5 13l4 4 10-11" },
  lua: { path: "M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" },
  sol: { circles: [[12, 12, 4.5]], path: "M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" },
  x: { path: "M18 6L6 18M6 6l12 12" },
  camera: { circles: [[12, 13, 4]], path: "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" },
  volumeOn: { path: "M11 5L6 9H2v6h4l5 4z|M15.5 8.5a5 5 0 0 1 0 7|M19 5a10 10 0 0 1 0 14" },
  volumeOff: { path: "M11 5L6 9H2v6h4l5 4z|M23 9l-6 6|M17 9l6 6" },
  upload: { path: "M12 3v12M7 8l5-5 5 5|M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" },
  busca: { circles: [[11, 11, 7]], path: "M21 21l-4.3-4.3" },
  setaBaixo: { path: "M6 9l6 6 6-6" },
  escudo: { path: "M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" },
};

function Icone({ nome, tamanho = 20, espessura = 2.75, cor = "currentColor", style }) {
  const def = ICONE_PATHS[nome];
  if (!def) return null;
  return (
    <svg
      width={tamanho}
      height={tamanho}
      viewBox="0 0 24 24"
      fill="none"
      stroke={cor}
      strokeWidth={espessura}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
    >
      {def.circles && def.circles.map((c, i) => <circle key={"c" + i} cx={c[0]} cy={c[1]} r={c[2]} />)}
      {def.rects && def.rects.map((r, i) => <rect key={"r" + i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={r[4]} />)}
      {def.path && def.path.split("|").map((d, i) => <path key={"p" + i} d={d} />)}
    </svg>
  );
}

// ---------- Tokens de cor por tema (vidro roxo/verde escuro, lilás/verde claro) ----------
function tokensTema(tema) {
  if (tema === "light") {
    return {
      fundoPagina: "radial-gradient(120% 80% at 80% 0%, #EDE4FF 0%, #F4F1FA 55%, #F7F5FB 100%)",
      cartao: "rgba(255,255,255,.80)",
      cartaoBorda: "rgba(109,40,217,.14)",
      cartaoSombra: "0 14px 34px rgba(76,29,149,.14)",
      subBlocoRoxo: "rgba(237,228,255,.85)",
      subBlocoRoxoBorda: "rgba(109,40,217,.12)",
      subBlocoVerde: "rgba(220,252,231,.85)",
      subBlocoVerdeBorda: "rgba(22,163,74,.20)",
      textoPrincipal: "#1E1035",
      textoSecundario: "#5B4780",
      textoNavInativo: "#4C3A6B",
      iconeInativo: "#6B5A88",
      roxo: "#6D28D9",
      roxoClaro: "#EDE4FF",
      verde: "#16A34A",
      verdeNumero: "#15803D",
      verdeTextoClaro: "#3F6B4A",
      textoSobreVerde: "#FFFFFF",
      amareloBg: "rgba(253,224,71,.35)",
      amareloTexto: "#92700C",
      navBg: "rgba(255,255,255,.88)",
      navSombra: "0 -4px 26px rgba(76,29,149,.12)",
      inputBg: "rgba(255,255,255,.9)",
      inputBorda: "rgba(109,40,217,.16)",
      placeholder: "#8A7AAE",
    };
  }
  return {
    fundoPagina: "radial-gradient(120% 80% at 80% 0%, #3B0A6B 0%, #1A0B2E 45%, #14002E 100%)",
    cartao: "rgba(255,255,255,.10)",
    cartaoBorda: "rgba(255,255,255,.20)",
    cartaoSombra: "0 12px 30px rgba(0,0,0,.30)",
    subBlocoRoxo: "rgba(167,139,250,.24)",
    subBlocoRoxoBorda: "rgba(255,255,255,.22)",
    subBlocoVerde: "rgba(20,0,46,.34)",
    subBlocoVerdeBorda: "rgba(255,255,255,.16)",
    textoPrincipal: "#FFFFFF",
    textoSecundario: "rgba(255,255,255,.75)",
    textoNavInativo: "rgba(255,255,255,.72)",
    iconeInativo: "rgba(255,255,255,.72)",
    roxo: "#A78BFA",
    roxoClaro: "rgba(167,139,250,.28)",
    verde: "#22C55E",
    verdeNumero: "#4ADE80",
    verdeTextoClaro: "#BBF7D0",
    textoSobreVerde: "#052E16",
    amareloBg: "rgba(253,224,71,.20)",
    amareloTexto: "#FEF3C7",
    navBg: "rgba(255,255,255,.12)",
    navSombra: "none",
    inputBg: "rgba(255,255,255,.10)",
    inputBorda: "rgba(255,255,255,.20)",
    placeholder: "rgba(255,255,255,.5)",
  };
}

function RotinaCard({ sec, cor, aberto, concluida, onToggleAberto, onToggleConcluida }) {
  return (
    <div style={{ borderRadius: 22, overflow: "hidden", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" }}>
        <button
          type="button"
          onClick={onToggleConcluida}
          aria-label={concluida ? "Marcar como não concluída" : "Marcar como concluída"}
          style={{
            flexShrink: 0,
            width: 24,
            height: 24,
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: concluida ? "#22C55E" : "transparent",
            border: concluida ? "none" : `1.5px solid ${cor.cartaoBorda}`,
          }}
        >
          {concluida && <Icone nome="check" tamanho={13} espessura={3} cor="#052E16" />}
        </button>
        <button
          type="button"
          onClick={onToggleAberto}
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}
        >
          <span style={{ fontSize: 19, lineHeight: 1 }}>{sec.icon}</span>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: cor.textoPrincipal, textDecoration: concluida ? "line-through" : "none", opacity: concluida ? 0.6 : 1 }}>
            {sec.titulo}
          </span>
          <Icone nome="setaBaixo" tamanho={14} cor={cor.textoSecundario} style={{ transform: aberto ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
        </button>
      </div>
      {aberto && (
        <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {sec.grupos.map((g, gi) => (
            <div key={gi}>
              {g.destaque && (
                <div style={{ borderRadius: 12, padding: "8px 12px", fontSize: 13, fontWeight: 600, background: "rgba(248,113,113,.15)", border: "1px solid rgba(248,113,113,.35)", color: "#FCA5A5" }}>
                  🔑 {g.destaque}
                </div>
              )}
              {g.sub && (
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: cor.textoSecundario, fontWeight: 700, marginBottom: 5 }}>
                  {g.sub}
                </p>
              )}
              {g.itens.length > 0 && (
                <ul style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {g.itens.map((it, ii) => (
                    <li key={ii} style={{ display: "flex", gap: 8, fontSize: 13, color: cor.textoSecundario, lineHeight: 1.4 }}>
                      <span style={{ color: cor.verdeNumero, flexShrink: 0 }}>•</span>
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Formulário de registro de ocorrência (botões de local + descrição + foto + registrar).
// Fica num componente à parte (nível de módulo, não dentro de App) porque é usado em dois
// lugares: no topo da tela inicial (Turno) e na aba Ocorrências — declarar de novo dentro de
// App a cada render trocaria a identidade do componente e faria o campo de texto perder o
// foco a cada letra digitada.
function FormularioOcorrencia({
  cor,
  tema,
  novoLocal,
  setNovoLocal,
  novoLocalCustom,
  setNovoLocalCustom,
  novaOc,
  setNovaOc,
  fotoOcorrenciaCameraRef,
  fotoOcorrenciaGaleriaRef,
  selecionarFotoOcorrenciaManual,
  fotoOcorrenciaManualPreview,
  limparFotoOcorrenciaManual,
  fotoOcorrenciaManualErro,
  registrarOcorrenciaManual,
  registrandoOcorrenciaManual,
}) {
  return (
    <div style={{ borderRadius: 26, padding: 16, background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
      <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario, marginBottom: 8 }}>Local</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {LOCAIS.map((l) => {
          const ativo = novoLocal === l.id;
          const bc = corBadgeLocal(l.id, tema);
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => setNovoLocal(l.id)}
              style={{
                fontSize: 12, padding: "7px 14px", borderRadius: 999, border: "1px solid transparent",
                background: ativo ? bc.bg : "transparent", color: ativo ? bc.texto : cor.textoSecundario,
                borderColor: ativo ? "transparent" : cor.cartaoBorda, fontWeight: ativo ? 700 : 400,
              }}
            >
              {l.label}
            </button>
          );
        })}
      </div>
      {novoLocal === "outros" && (
        <input
          type="text"
          value={novoLocalCustom}
          onChange={(e) => setNovoLocalCustom(e.target.value)}
          placeholder="Qual local? Ex.: Barrilete, apto 42..."
          style={{ width: "100%", marginTop: 8, background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 14, padding: "10px 14px", fontSize: 13, color: cor.textoPrincipal }}
        />
      )}

      <textarea
        value={novaOc}
        onChange={(e) => setNovaOc(e.target.value)}
        placeholder="Descreva a ocorrência..."
        rows={2}
        style={{ width: "100%", marginTop: 12, background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 14, padding: "10px 14px", fontSize: 14, color: cor.textoPrincipal, resize: "none" }}
      />

      <input
        ref={fotoOcorrenciaCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => selecionarFotoOcorrenciaManual(e.target.files?.[0])}
        className="hidden"
      />
      <input
        ref={fotoOcorrenciaGaleriaRef}
        type="file"
        accept="image/*"
        onChange={(e) => selecionarFotoOcorrenciaManual(e.target.files?.[0])}
        className="hidden"
      />
      {fotoOcorrenciaManualPreview ? (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, borderRadius: 14, border: `1px solid ${cor.inputBorda}`, background: cor.inputBg, padding: 8 }}>
          <img src={fotoOcorrenciaManualPreview} alt="Prévia da foto" style={{ height: 48, width: 48, borderRadius: 10, objectFit: "cover" }} />
          <span style={{ fontSize: 12, color: cor.textoSecundario, flex: 1 }}>Foto anexada</span>
          <button type="button" onClick={limparFotoOcorrenciaManual} style={{ color: cor.textoSecundario, display: "flex" }} title="Remover foto">
            <Icone nome="x" tamanho={15} />
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            type="button"
            onClick={() => fotoOcorrenciaCameraRef.current?.click()}
            style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, padding: "9px 0", borderRadius: 12, background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, color: cor.textoSecundario }}
          >
            <Icone nome="camera" tamanho={15} /> Tirar foto
          </button>
          <button
            type="button"
            onClick={() => fotoOcorrenciaGaleriaRef.current?.click()}
            style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, padding: "9px 0", borderRadius: 12, background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, color: cor.textoSecundario }}
          >
            <Icone nome="upload" tamanho={15} /> Galeria
          </button>
        </div>
      )}
      {fotoOcorrenciaManualErro && <p style={{ fontSize: 11, color: "#FCA5A5", marginTop: 6 }}>{fotoOcorrenciaManualErro}</p>}

      <button
        onClick={registrarOcorrenciaManual}
        disabled={!novaOc.trim() || registrandoOcorrenciaManual}
        style={{ width: "100%", marginTop: 12, background: "#22C55E", color: "#052E16", fontWeight: 700, fontSize: 14, borderRadius: 999, padding: "13px 0", opacity: novaOc.trim() && !registrandoOcorrenciaManual ? 1 : 0.4, boxShadow: novaOc.trim() ? "0 0 20px rgba(34,197,94,.35)" : "none" }}
      >
        {registrandoOcorrenciaManual ? "Registrando..." : "Registrar com horário atual"}
      </button>
    </div>
  );
}

export default function App() {
  const [aba, setAba] = useState("turno");
  const [tema, setTema] = useState("dark");
  const [rotinaAberta, setRotinaAberta] = useState(null);
  const [rotinasConcluidas, setRotinasConcluidas] = useState([]);
  const [turnoInicio, setTurnoInicio] = useState(null);
  const [regulamento, setRegulamento] = useState("");
  const [regulamentoTemp, setRegulamentoTemp] = useState("");
  const [regSalvo, setRegSalvo] = useState(false);
  const [buscaRegulamento, setBuscaRegulamento] = useState("");
  const resultadosBuscaRegulamento = useMemo(
    () => buscarNoRegulamento(regulamento, buscaRegulamento),
    [regulamento, buscaRegulamento]
  );
  const [lendoPDF, setLendoPDF] = useState(false);
  const [pdfNome, setPdfNome] = useState("");
  const [pdfErro, setPdfErro] = useState("");
  const [segLeituraPDF, setSegLeituraPDF] = useState(0);
  const fileRef = useRef(null);

  // Convenção do condomínio (documento separado do regulamento interno; usada
  // principalmente pra achar de quem é cada vaga de estacionamento).
  const [convencao, setConvencao] = useState("");
  const [convencaoTemp, setConvencaoTemp] = useState("");
  const [convSalvo, setConvSalvo] = useState(false);
  const [buscaConvencao, setBuscaConvencao] = useState("");
  const resultadosBuscaConvencao = useMemo(
    () => buscarNoRegulamento(convencao, buscaConvencao),
    [convencao, buscaConvencao]
  );
  const [lendoPDFConvencao, setLendoPDFConvencao] = useState(false);
  const [pdfNomeConvencao, setPdfNomeConvencao] = useState("");
  const [pdfErroConvencao, setPdfErroConvencao] = useState("");
  const [segLeituraConvencao, setSegLeituraConvencao] = useState(0);
  const fileRefConvencao = useRef(null);
  const [ocorrencias, setOcorrencias] = useState([]);
  const [carregado, setCarregado] = useState(false);

  // Chat
  const [chat, setChat] = useState([]);
  const [chamadasGroq, setChamadasGroq] = useState(() => Number(localStorage.getItem("lider_amigao_groq_chamadas") || 0));
  const [pergunta, setPergunta] = useState("");
  const [fotoChat, setFotoChat] = useState(null);
  const [fotoPreview, setFotoPreview] = useState("");
  const [fotoErro, setFotoErro] = useState("");
  const fotoRef = useRef(null);
  const [pensando, setPensando] = useState(false);
  const chatFim = useRef(null);
  const [gravando, setGravando] = useState(false);
  const [vozDisponivel, setVozDisponivel] = useState(false);
  const [erroVoz, setErroVoz] = useState("");
  const recognitionRef = useRef(null);

  // Viva-Voz e Áudio de Ronda
  const [audioAtivo, setAudioAtivo] = useState(true);
  const [modoVivaVoz, setModoVivaVoz] = useState(false);
  const [falando, setFalando] = useState(false);
  const [statusVoz, setStatusVoz] = useState("");
  const [toastOcorrencia, setToastOcorrencia] = useState(null);

  const modoVivaVozRef = useRef(false);
  const pensandoRef = useRef(false);
  const audioAtivoRef = useRef(true);

  useEffect(() => {
    modoVivaVozRef.current = modoVivaVoz;
  }, [modoVivaVoz]);

  useEffect(() => {
    pensandoRef.current = pensando;
  }, [pensando]);

  useEffect(() => {
    audioAtivoRef.current = audioAtivo;
  }, [audioAtivo]);

  useEffect(() => {
    const atualizar = (event) => setChamadasGroq(Number(event.detail || localStorage.getItem("lider_amigao_groq_chamadas") || 0));
    window.addEventListener("lider-amigao-groq-call", atualizar);
    return () => window.removeEventListener("lider-amigao-groq-call", atualizar);
  }, []);

  // Ocorrência
  const [novaOc, setNovaOc] = useState("");
  const [novaCat, setNovaCat] = useState("acesso");
  const [novoLocal, setNovoLocal] = useState("terreo");
  const [novoLocalCustom, setNovoLocalCustom] = useState("");
  const [fotoOcorrenciaManual, setFotoOcorrenciaManual] = useState(null);
  const [fotoOcorrenciaManualPreview, setFotoOcorrenciaManualPreview] = useState("");
  const [fotoOcorrenciaManualErro, setFotoOcorrenciaManualErro] = useState("");
  const [registrandoOcorrenciaManual, setRegistrandoOcorrenciaManual] = useState(false);
  const fotoOcorrenciaCameraRef = useRef(null);
  const fotoOcorrenciaGaleriaRef = useRef(null);

  // Turno / email
  const [nomeLider, setNomeLider] = useState("");
  const [posto, setPosto] = useState("");
  const [obsTurno, setObsTurno] = useState("");
  const [emailGerado, setEmailGerado] = useState("");
  const [gerandoEmail, setGerandoEmail] = useState(false);
  const [copiado, setCopiado] = useState(false);

  // Escalas e Feedbacks dos Colaboradores
  const [escala, setEscala] = useState({
    portaria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
    triagem: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
    ronda: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
    mensageria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
  });
  const [historicoEscalas, setHistoricoEscalas] = useState([]);

  // Tema: aplica a preferência salva, senão a do sistema, no primeiro carregamento.
  useEffect(() => {
    (async () => {
      const salvo = await store.get("tema", null);
      if (salvo === "dark" || salvo === "light") {
        setTema(salvo);
      } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
        setTema("light");
      }
    })();
  }, []);

  const alternarTema = async () => {
    const novo = tema === "dark" ? "light" : "dark";
    setTema(novo);
    await store.set("tema", novo);
  };

  // Aquece a lista de vozes do navegador assim que o app monta, pra primeira fala
  // (falarTexto) não precisar esperar o timeout de segurança de obterVozes().
  useEffect(() => {
    obterVozes();
  }, []);

  // Contador de segundos enquanto a IA lê um PDF (regulamento ou convenção): a extração
  // literal de documentos grandes pode legitimamente levar 1-3 minutos (não é streaming),
  // então mostramos o tempo passando pra não parecer que travou.
  useEffect(() => {
    if (!lendoPDF) {
      setSegLeituraPDF(0);
      return;
    }
    const id = setInterval(() => setSegLeituraPDF((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [lendoPDF]);

  useEffect(() => {
    if (!lendoPDFConvencao) {
      setSegLeituraConvencao(0);
      return;
    }
    const id = setInterval(() => setSegLeituraConvencao((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [lendoPDFConvencao]);

  // Carregar dados
  useEffect(() => {
    (async () => {
      const reg = await store.get("reg_interno", "");
      const conv = await store.get("convencao_texto", "");
      const ocs = await store.get("ocorrencias", []);
      const perfil = await store.get("perfil", { nome: "", posto: "" });
      const esc = await store.get("escala_atual", {
        portaria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
        triagem: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
        ronda: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
        mensageria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
      });
      const hist = await store.get("historico_escala", []);
      const audAtivo = await store.get("audio_ativo", true);
      const pdfSalvo = await obterPDF("regulamento").catch(() => null);
      const pdfConvSalvo = await obterPDF("convencao").catch(() => null);
      const rotConcluidasSalvas = await store.get("rotinas_concluidas", { data: "", ids: [] });
      const turnoInicioSalvo = await store.get("turno_inicio", { data: "", ts: null });
      const hoje = hojeISO();

      // Se ninguém fez upload manual ainda, a aba Regras começa preenchida com o RI que já vem
      // no app (src/data/regras.json), extraído uma vez dos PDFs — não precisa mais subir o PDF
      // pra o assistente conhecer o regulamento.
      const regInicial = reg || textoRegrasDefault("RI");
      const convInicial = conv || textoRegrasDefault("Convenção");
      setRegulamento(regInicial);
      setRegulamentoTemp(regInicial);
      if (pdfSalvo) setPdfNome(pdfSalvo.nome);
      setConvencao(convInicial);
      setConvencaoTemp(convInicial);
      if (pdfConvSalvo) setPdfNomeConvencao(pdfConvSalvo.nome);
      setOcorrencias(ocs);
      setNomeLider(perfil.nome || "");
      setPosto(perfil.posto || "");
      setEscala(esc);
      setHistoricoEscalas(hist);
      setAudioAtivo(audAtivo);
      // Rotinas concluídas e início do turno são por dia: se salvos de um dia
      // anterior, começa zerado hoje.
      setRotinasConcluidas(rotConcluidasSalvas.data === hoje ? rotConcluidasSalvas.ids : []);
      if (turnoInicioSalvo.data === hoje && turnoInicioSalvo.ts) {
        setTurnoInicio(turnoInicioSalvo.ts);
      } else {
        const agora = new Date().toISOString();
        setTurnoInicio(agora);
        await store.set("turno_inicio", { data: hoje, ts: agora });
      }
      setCarregado(true);
    })();
  }, []);

  useEffect(() => {
    if (chatFim.current) chatFim.current.scrollIntoView({ behavior: "smooth" });
  }, [chat, pensando]);

  // Função para a IA falar a resposta em viva-voz (Text-To-Speech)
  const falarTexto = async (texto) => {
    if (!audioAtivoRef.current || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const limpo = texto.replace(/[*_#`[\]()]/g, "").trim();
      if (!limpo) return;

      // Aplica o mapa de correções fonéticas (ex.: "Lider" -> "líder") antes de falar.
      const textoParaFalar = aplicarCorrecoesFoneticas(limpo);

      // Espera as vozes carregarem (se ainda não carregaram) e escolhe a melhor voz pt-BR.
      const vozes = await obterVozes();
      const vozPtBR = escolherVozPtBR(vozes);

      const utterance = new SpeechSynthesisUtterance(textoParaFalar);
      utterance.lang = "pt-BR"; // força pt-BR mesmo se nenhuma voz pt-BR específica for encontrada
      if (vozPtBR) utterance.voice = vozPtBR; // usa a voz pt-BR do dispositivo, se existir
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.onstart = () => {
        setFalando(true);
        setStatusVoz("Falando...");
      };
      utterance.onend = () => {
        setFalando(false);
        setStatusVoz("");
        if (modoVivaVozRef.current) {
          setTimeout(() => {
            iniciarGravacao();
          }, 600);
        }
      };
      utterance.onerror = () => {
        setFalando(false);
        setStatusVoz("");
      };
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.error("Erro síntese voz:", e);
      setFalando(false);
      setStatusVoz("");
    }
  };

  const alternarAudio = async () => {
    const novoVal = !audioAtivo;
    setAudioAtivo(novoVal);
    await store.set("audio_ativo", novoVal);
    if (!novoVal && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setFalando(false);
    }
  };

  // Reconhecimento de voz (fala vira texto e envia automaticamente)
  useEffect(() => {
    const seguro = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErroVoz(
        seguro
          ? "Este navegador não suporta reconhecimento de voz. Tenta no Chrome ou Edge."
          : "O microfone só funciona em conexão segura (https) ou localhost."
      );
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setGravando(true);
      setErroVoz("");
      setStatusVoz("Ouvindo... Pode falar!");
    };

    recognition.onresult = (event) => {
      setErroVoz("");
      let texto = "";
      for (let i = 0; i < event.results.length; i++) {
        texto += event.results[i][0].transcript;
      }
      setPergunta(texto);

      if (event.results[0] && event.results[0].isFinal) {
        const finalTexto = texto.trim();
        if (finalTexto) {
          setGravando(false);
          setStatusVoz("Enviando...");
          enviarPergunta(finalTexto);
        }
      }
    };

    recognition.onend = () => {
      setGravando(false);
    };

    recognition.onerror = (event) => {
      setGravando(false);
      setStatusVoz("");
      const mensagens = {
        "not-allowed": "Permissão do microfone negada no navegador.",
        "service-not-allowed": "Permissão do microfone negada.",
        "no-speech": "Não ouvi nada. Tente falar novamente.",
        "audio-capture": "Nenhum microfone encontrado neste dispositivo.",
        "network": "Erro de rede no reconhecimento de voz.",
        aborted: "",
      };
      const msg = mensagens[event.error];
      if (msg) setErroVoz(msg);
    };

    recognitionRef.current = recognition;
    setVozDisponivel(true);
  }, []);

  const iniciarGravacao = () => {
    if (!recognitionRef.current) {
      if (!erroVoz) setErroVoz("Reconhecimento de voz indisponível neste navegador.");
      return;
    }
    if (gravando || pensandoRef.current) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setFalando(false);
    setErroVoz("");
    setPergunta("");
    try {
      recognitionRef.current.start();
    } catch (e) {}
  };

  const pararGravacao = () => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch (e) {}
    setGravando(false);
  };

  const fileToBase64 = (file) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("Falha ao ler o arquivo"));
      r.readAsDataURL(file);
    });

  const lerPDF = async (file) => {
    if (!file) return;
    const ehPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!ehPDF) {
      setPdfErro("Envie um arquivo PDF.");
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setPdfErro("O PDF deve ter no máximo 32 MB.");
      return;
    }
    setPdfErro("");
    setLendoPDF(true);
    setPdfNome(file.name);
    try {
      const base64 = await fileToBase64(file);
      await salvarPDF(file, base64);
      const res = await fetch("/api/anthropic/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(180000),
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
                {
                  type: "text",
                  text:
                    "Este é o regulamento interno de um condomínio. Transcreva o TEXTO COMPLETO E LITERAL do documento, artigo por artigo, na íntegra. " +
                    "Mantenha a numeração original exatamente como aparece no documento (ex: 'Art. 25', 'Art. 35'), sem renumerar, resumir, reorganizar por tema ou omitir nenhum artigo, parágrafo ou cláusula, mesmo que pareça irrelevante para um porteiro. " +
                    "Preserve as palavras exatas do texto original (não substitua por sinônimos). Preserve a ordem em que os artigos aparecem no documento. " +
                    "Não junte o conteúdo de dois artigos na mesma linha. Não adicione introdução, comentários ou conclusões: responda apenas com o texto transcrito.",
                },
              ],
            },
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const mensagem = data?.error?.message || data?.message;
        if (res.status === 401) throw new Error(mensagem || "A chave da Anthropic não foi aceita.");
        if (res.status === 413) throw new Error("O PDF é grande demais para processar.");
        throw new Error(mensagem || `A API retornou erro ${res.status}.`);
      }
      if (!Array.isArray(data.content)) {
        throw new Error("A API não retornou texto para o PDF.");
      }
      const texto = data.content
        .filter((i) => i.type === "text")
        .map((i) => i.text)
        .join("\n");
      if (texto) {
        setRegulamentoTemp(texto);
        setRegulamento(texto);
        await store.set("reg_interno", texto);
        setRegSalvo(true);
        setTimeout(() => setRegSalvo(false), 2000);
        if (data.stop_reason === "max_tokens") {
          setPdfErro("Atenção: o regulamento é extenso e pode ter sido cortado no fim. Confira o texto e complete manualmente se faltar algum artigo.");
        }
      } else {
        setPdfErro("Não consegui extrair o texto. Tente colar manualmente.");
      }
    } catch (e) {
      console.error("Erro ao processar PDF:", e);
      const demorouDemais = e?.name === "AbortError" || e?.name === "TimeoutError";
      setPdfErro(
        demorouDemais
          ? "A leitura demorou demais (mais de 3 min) e foi cancelada. Tente de novo ou cole o texto manualmente."
          : e instanceof Error
          ? e.message
          : "Falhou ao processar o PDF. Tente de novo ou cole o texto."
      );
    } finally {
      setLendoPDF(false);
    }
  };

  const salvarRegulamento = async () => {
    setRegulamento(regulamentoTemp);
    await store.set("reg_interno", regulamentoTemp);
    setRegSalvo(true);
    setTimeout(() => setRegSalvo(false), 2000);
  };

  const lerPDFConvencao = async (file) => {
    if (!file) return;
    const ehPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!ehPDF) {
      setPdfErroConvencao("Envie um arquivo PDF.");
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setPdfErroConvencao("O PDF deve ter no máximo 32 MB.");
      return;
    }
    setPdfErroConvencao("");
    setLendoPDFConvencao(true);
    setPdfNomeConvencao(file.name);
    try {
      const base64 = await fileToBase64(file);
      await salvarPDF(file, base64, "convencao");
      const res = await fetch("/api/anthropic/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(180000),
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
                {
                  type: "text",
                  text:
                    "Esta é a convenção de condomínio. Transcreva o TEXTO COMPLETO E LITERAL do documento, na íntegra, mantendo a numeração/estrutura original. " +
                    "Dê atenção especial a qualquer tabela, anexo ou trecho que relacione unidades (apartamento/bloco/torre) às vagas de garagem/estacionamento (número da vaga, box, se é dupla, coberta, etc.): transcreva essas linhas de forma clara, uma unidade por linha, mesmo que no PDF estejam numa tabela ou imagem. " +
                    "Preserve as palavras exatas do texto original (não substitua por sinônimos), sem resumir, reorganizar ou omitir cláusulas. " +
                    "Não adicione introdução, comentários ou conclusões: responda apenas com o texto transcrito.",
                },
              ],
            },
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const mensagem = data?.error?.message || data?.message;
        if (res.status === 401) throw new Error(mensagem || "A chave da Anthropic não foi aceita.");
        if (res.status === 413) throw new Error("O PDF é grande demais para processar.");
        throw new Error(mensagem || `A API retornou erro ${res.status}.`);
      }
      if (!Array.isArray(data.content)) {
        throw new Error("A API não retornou texto para o PDF.");
      }
      const texto = data.content
        .filter((i) => i.type === "text")
        .map((i) => i.text)
        .join("\n");
      if (texto) {
        setConvencaoTemp(texto);
        setConvencao(texto);
        await store.set("convencao_texto", texto);
        setConvSalvo(true);
        setTimeout(() => setConvSalvo(false), 2000);
        if (data.stop_reason === "max_tokens") {
          setPdfErroConvencao("Atenção: a convenção é extensa e pode ter sido cortada no fim. Confira o texto e complete manualmente se faltar alguma vaga.");
        }
      } else {
        setPdfErroConvencao("Não consegui extrair o texto. Tente colar manualmente.");
      }
    } catch (e) {
      console.error("Erro ao processar PDF da convenção:", e);
      const demorouDemais = e?.name === "AbortError" || e?.name === "TimeoutError";
      setPdfErroConvencao(
        demorouDemais
          ? "A leitura demorou demais (mais de 3 min) e foi cancelada. Tente de novo ou cole o texto manualmente."
          : e instanceof Error
          ? e.message
          : "Falhou ao processar o PDF. Tente de novo ou cole o texto."
      );
    } finally {
      setLendoPDFConvencao(false);
    }
  };

  const salvarConvencao = async () => {
    setConvencao(convencaoTemp);
    await store.set("convencao_texto", convencaoTemp);
    setConvSalvo(true);
    setTimeout(() => setConvSalvo(false), 2000);
  };

  const salvarPerfil = async (nome, p) => {
    await store.set("perfil", { nome, posto: p });
  };

  const selecionarFoto = async (file) => {
    if (!file) return;
    setFotoErro("");
    if (!file.type.startsWith("image/")) {
      setFotoErro("Escolha uma imagem JPG, PNG ou WEBP.");
      return;
    }
    try {
      const dataUrl = await redimensionarImagem(file);
      setFotoChat(dataUrl);
      setFotoPreview(dataUrl);
    } catch (erro) {
      setFotoErro(erro.message);
    }
  };

  const limparFoto = () => {
    setFotoChat(null);
    setFotoPreview("");
    if (fotoRef.current) fotoRef.current.value = "";
  };

  const buscarReferenciaRegulamento = async (textoOcorrencia) => {
    const semRegulamento = !regulamento || !regulamento.trim();
    const trecho = semRegulamento ? null : encontrarTrechoRegulamento(regulamento, textoOcorrencia);
    const semReferencia = {
      artigo: "Não encontrado",
      resumo: "Nenhuma regra específica encontrada no regulamento.",
    };
    if (!trecho) return semReferencia;

    try {
      const resposta = await callChatWithFallback(
        "Você é um revisor de regulamento de condomínio. Use SOMENTE o trecho fornecido. " +
          "Não invente artigo, capítulo, seção ou regra. Se não houver numeração explícita, use o título literal da seção; " +
          "responda exclusivamente JSON com artigo e resumo, sendo o resumo de 1 ou 2 frases.",
        [{
          role: "user",
          content: `Ocorrência: ${textoOcorrencia}\n\nTrecho encontrado no regulamento:\n${trecho}`,
        }]
      );
      const json = extrairObjetoJSON(resposta.replace(/<think>[\s\S]*?<\/think>/gi, ""));
      const parsed = json ? JSON.parse(json) : null;
      const artigo = typeof parsed?.artigo === "string" ? parsed.artigo.trim() : "";
      const resumo = typeof parsed?.resumo === "string" ? parsed.resumo.trim() : "";
      const trechoNormalizado = normalizarTexto(trecho);
      const artigoValido = artigo && artigo !== "Não encontrado" &&
        normalizarTexto(artigo).split(/[^a-z0-9]+/).filter(Boolean).every((parte) => trechoNormalizado.includes(parte));
      return {
        artigo: artigoValido ? artigo : tituloDoTrecho(trecho),
        resumo: resumo || "Regra relacionada encontrada no trecho do regulamento.",
      };
    } catch (erro) {
      console.warn("Não foi possível resumir a referência do regulamento:", erro);
      return {
        artigo: tituloDoTrecho(trecho),
        resumo: "Trecho relacionado encontrado no regulamento, mas não foi possível resumir automaticamente.",
      };
    }
  };

  const enviarPergunta = async (textoOverride, fotoOverride = null) => {
    const q = (typeof textoOverride === "string" ? textoOverride : pergunta).trim();
    const foto = fotoOverride || fotoChat;
    if ((!q && !foto) || pensando) return;

    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setFalando(false);

    const novo = [...chat, { role: "user", content: q || "Analise esta foto." , imagem: foto || "" }];
    setChat(novo);
    setPergunta("");
    limparFoto();
    setPensando(true);
    setStatusVoz("IA processando...");

    try {
      // Não embutimos o documento inteiro no prompt: buscamos localmente (sem gastar token) só
      // os artigos mais relevantes pra esta mensagem, em src/data/regras.json (RI + Convenção já
      // extraídos dos PDFs e estruturados por capítulo/artigo), e mandamos só isso pra IA — com a
      // citação exata (fonte, capítulo, artigo) já pronta, pra IA não ter que adivinhar.
      const { contexto: contextoRegras } = montarContextoRegras(q, regrasCondominio, { limite: 6 });
      // Convenção ainda não estruturada (PDF escaneado, sem texto selecionável) cai aqui: se o
      // operador tiver colado/enviado manualmente o texto na aba Regras, ainda buscamos nele.
      const temConvencaoEstruturada = regrasCondominio.some((r) => r.fonte === "Convenção");
      const trechoRelevanteConvencao =
        !temConvencaoEstruturada && convencao ? encontrarTrechoRegulamento(convencao, q) : null;
      // Nome do operador (quem sempre faz a ronda), vindo do perfil cadastrado na aba Turno.
      // Sem isso, o assistente confunde "quem fala com você agora" com "quem faz a ronda" —
      // ex: se o operador diz "estou com o Fernando", o assistente não pode dizer que é o
      // Fernando quem está fazendo a ronda.
      const nomeOperador = nomeLider.trim() || "o líder de portaria";
      const system = montarSystemPrompt({
        nomeOperador,
        contextoRegras,
        trechoConvencao: trechoRelevanteConvencao,
        temConvencao: Boolean(convencao || temConvencaoEstruturada),
      });

      const messages = novo.map((m) => ({ role: m.role, content: m.content }));
      const respostaRaw = foto
        ? await callClaudeVision(
            system,
            foto,
            `${q || "Analise a imagem e identifique se há uma ocorrência de portaria."}\n` +
              "Descreva objetivamente o que aparece e gere o JSON da ocorrência."
          )
        : await callChatWithFallback(system, messages);

      let respostaVoz = "";
      let textoMensagemChat = "";
      let ocDetectada = null;

      try {
        const semPensamento = respostaRaw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        const json = extrairObjetoJSON(semPensamento);
        if (!json) throw new Error("JSON ausente");

        const parsed = JSON.parse(json);
        respostaVoz = typeof parsed.respostaVoz === "string" ? parsed.respostaVoz.trim() : "";
        if (!respostaVoz) throw new Error("Resposta vazia");
        textoMensagemChat = respostaVoz;
        if (parsed.ocorrencia && parsed.ocorrencia.detectada && parsed.ocorrencia.texto) {
          ocDetectada = parsed.ocorrencia;
        }
      } catch (eJson) {
        console.warn("Resposta da IA fora do formato esperado:", eJson);
        textoMensagemChat = "Não consegui entender a resposta. Tente de novo.";
      }

      if (ocDetectada) {
        const cat = ocDetectada.categoria || "outros";
        // Busca usando o texto BRUTO digitado + o resumo da IA, não só o resumo: o resumo às
        // vezes generaliza a descrição e perde palavras específicas (ex: "vaga", "circulação")
        // que são justamente o que a busca por palavra-chave no regulamento precisa.
        const regulamentoRef = await buscarReferenciaRegulamento(`${q}\n${ocDetectada.texto}`);
        const catObj = catInfo(cat);
        const textoComReferencia = `${ocDetectada.texto}\n\n${linhaReferenciaRegulamento(regulamentoRef)}`;
        textoMensagemChat = `${textoMensagemChat}\n\n📌 *Ocorrência pronta para confirmação em ${catObj.label}*\n${linhaReferenciaRegulamento(regulamentoRef)}`;

        setToastOcorrencia({
          texto: textoComReferencia,
          categoria: cat,
          regulamentoRef,
          imagem: foto || "",
          pendente: true,
        });
        setTimeout(() => setToastOcorrencia(null), 6000);
      }

      setChat([...novo, { role: "assistant", content: textoMensagemChat }]);
      setStatusVoz("");

      if (audioAtivoRef.current && respostaVoz) {
        falarTexto(respostaVoz);
      } else if (modoVivaVozRef.current) {
        setTimeout(() => iniciarGravacao(), 500);
      }
    } catch (e) {
      // Log técnico completo no console (F12) pro responsável pelo app diagnosticar; a
      // mensagem mostrada pro usuário no chat continua curta e amigável.
      console.error(
        `Lider Amigão: falha ao consultar IA no chat — Gemini: status ${e?.statusGemini ?? "?"} | ` +
          `Groq: status ${e?.statusGroq ?? "?"} | Cerebras (final): status ${e?.status ?? "?"} — ${e?.message || e}`,
        e
      );
      let mensagem;
      if (e?.status === 429 || e?.statusGroq === 429 || e?.statusGemini === 429) {
        mensagem = "A IA atingiu o limite temporário de requisições. Aguarde um pouco e tente novamente.";
      } else if (e?.status === 402 || e?.statusGroq === 402 || e?.statusGemini === 402) {
        mensagem = "Um dos provedores de IA está sem crédito configurado. Avise o responsável pelo app (isso não afeta o regulamento/convenção já salvos).";
      } else if (e?.status === "timeout" && e?.statusGroq === "timeout" && e?.statusGemini === "timeout") {
        mensagem = "A IA demorou demais pra responder em todas as tentativas. Tente de novo em instantes.";
      } else {
        mensagem = "Não consegui consultar a IA agora. Tente novamente.";
      }

      // Com as duas IAs fora do ar, ainda vale tentar responder perguntas de regra: a busca
      // local (mesma usada pra montar o contexto da IA) não depende de nenhum provedor.
      if (!foto) {
        const { artigos } = montarContextoRegras(q, regrasCondominio, { limite: 3 });
        if (artigos.length) {
          const trechos = artigos
            .map((a) => `📖 *${citacaoCurta(a)}*\n${a.texto}`)
            .join("\n\n");
          mensagem =
            `${mensagem}\n\nMas achei isto direto no regulamento (busca local, sem IA):\n\n${trechos}`;
        }
      }

      setChat([...novo, { role: "assistant", content: mensagem }]);
      setStatusVoz("");
    } finally {
      setPensando(false);
    }
  };

  const registrarDoChat = async (texto) => {
    await adicionarOcorrencia(texto, "outros");
    setAba("ocorrencias");
  };

  const confirmarOcorrencia = async () => {
    if (!toastOcorrencia?.pendente) return;
    await adicionarOcorrencia(toastOcorrencia.texto, toastOcorrencia.categoria, toastOcorrencia.regulamentoRef, toastOcorrencia.imagem, true);
    setToastOcorrencia({ ...toastOcorrencia, pendente: false });
    setTimeout(() => setToastOcorrencia(null), 6000);
  };

  const adicionarOcorrencia = async (texto, cat, referenciaInformada, imagem = "", textoJaEditado = false) => {
    const t = (texto ?? novaOc).trim();
    if (!t) return;
    const regulamentoRef = referenciaInformada || await buscarReferenciaRegulamento(t);
    const textoFinal = textoJaEditado || t.includes("📖 Referência:")
      ? t
      : `${t}\n\n${linhaReferenciaRegulamento(regulamentoRef)}`;
    const nova = {
      id: Date.now(),
      ts: new Date().toISOString(),
      data: hojeISO(),
      categoria: cat ?? novaCat,
      texto: textoFinal,
      regulamentoRef,
      imagem,
    };
    const lista = [nova, ...ocorrencias];
    setOcorrencias(lista);
    await store.set("ocorrencias", lista);
    if (texto == null) setNovaOc("");
  };

  const selecionarFotoOcorrenciaManual = async (file) => {
    if (!file) return;
    setFotoOcorrenciaManualErro("");
    if (!file.type.startsWith("image/")) {
      setFotoOcorrenciaManualErro("Escolha uma imagem JPG, PNG ou WEBP.");
      return;
    }
    try {
      const dataUrl = await redimensionarImagem(file);
      setFotoOcorrenciaManual(dataUrl);
      setFotoOcorrenciaManualPreview(dataUrl);
    } catch (erro) {
      setFotoOcorrenciaManualErro(erro.message);
    }
  };

  const limparFotoOcorrenciaManual = () => {
    setFotoOcorrenciaManual(null);
    setFotoOcorrenciaManualPreview("");
    if (fotoOcorrenciaCameraRef.current) fotoOcorrenciaCameraRef.current.value = "";
    if (fotoOcorrenciaGaleriaRef.current) fotoOcorrenciaGaleriaRef.current.value = "";
  };

  // Novo fluxo da aba Ocorrências: local (botão) + descrição livre -> monta o registro no
  // formato fixo (OCORRÊNCIA / Horário / Local / Descrição / Base). A citação do RI vem de
  // busca local (sem IA, sem custo); só a organização do texto usa uma chamada de IA pequena,
  // e cai pro texto original se as três IAs estiverem fora do ar.
  const registrarOcorrenciaManual = async () => {
    const descricaoBruta = novaOc.trim();
    if (!descricaoBruta || registrandoOcorrenciaManual) return;
    setRegistrandoOcorrenciaManual(true);
    try {
      const local = nomeDoLocal(novoLocal, novoLocalCustom);

      const candidatos = buscarArtigosRelevantes(`${local} ${descricaoBruta}`, regrasCondominio, { limite: 1 });
      const melhorArtigo = candidatos[0] || null;

      let tipo = "Ocorrência";
      let descricaoOrganizada = descricaoBruta;
      try {
        const system =
          "Você organiza notas rápidas de um porteiro em um registro formal, em português do Brasil. " +
          "A nota pode ter erro de digitação, abreviação ou frase incompleta: interprete a intenção mesmo assim. " +
          "Nunca use travessão (—); use vírgula, ponto, ou reescreva a frase. Não invente fatos que não estejam na nota. " +
          "Responda SOMENTE em JSON, sem markdown: " +
          '{"tipo": "uma ou duas palavras que resumem o tipo da ocorrência (ex.: Manutenção, Barulho, Vazamento, Segurança, Encomenda, Conflito)", ' +
          '"descricao": "a nota reescrita de forma clara, objetiva e profissional, preservando todos os fatos e detalhes concretos citados (o que aconteceu, quem, o quê, onde)"}';
        const resposta = await callChatWithFallback(system, [{ role: "user", content: descricaoBruta }], { json: true });
        const jsonTexto = extrairObjetoJSON(resposta.replace(/<think>[\s\S]*?<\/think>/gi, ""));
        const parsed = jsonTexto ? JSON.parse(jsonTexto) : null;
        if (parsed?.descricao) descricaoOrganizada = String(parsed.descricao).trim();
        if (parsed?.tipo) tipo = String(parsed.tipo).trim();
      } catch (erroIA) {
        console.warn("Lider Amigão: não consegui organizar a descrição da ocorrência pela IA, usando o texto original", erroIA);
      }

      const linhas = [
        `OCORRÊNCIA: ${tipo}`,
        `Horário: ${fmtHora(Date.now())}`,
        `Local: ${local}`,
        `Descrição: ${descricaoOrganizada}`,
      ];
      if (melhorArtigo) linhas.push(`Base: ${citacaoCurta(melhorArtigo)}`);

      const nova = {
        id: Date.now(),
        ts: new Date().toISOString(),
        data: hojeISO(),
        categoria: "outros",
        local,
        localId: novoLocal,
        texto: linhas.join("\n"),
        regulamentoRef: null,
        imagem: fotoOcorrenciaManual || "",
      };
      const lista = [nova, ...ocorrencias];
      setOcorrencias(lista);
      await store.set("ocorrencias", lista);
      setNovaOc("");
      setNovoLocalCustom("");
      limparFotoOcorrenciaManual();
    } finally {
      setRegistrandoOcorrenciaManual(false);
    }
  };

  const removerOcorrencia = async (id) => {
    const lista = ocorrencias.filter((o) => o.id !== id);
    setOcorrencias(lista);
    await store.set("ocorrencias", lista);
  };

  const ocorrenciasHoje = ocorrencias.filter((o) => o.data === hojeISO());

  const atualizarEscalaItem = async (postoKey, campo, valor) => {
    const novaEscala = {
      ...escala,
      [postoKey]: {
        ...escala[postoKey],
        [campo]: valor
      }
    };
    setEscala(novaEscala);
    await store.set("escala_atual", novaEscala);
  };

  const registrarOcorrenciaEscala = async (postoKey) => {
    const p = escala[postoKey];
    const postosNomes = {
      portaria: "Portaria",
      triagem: "Triagem",
      ronda: "Ronda",
      mensageria: "Mensageria"
    };
    const nomeP = postosNomes[postoKey];
    const periodoStr = p.periodo === "diurno" ? "Diurno" : "Noturno";
    
    let texto = "";
    if (p.status === "no_horario") {
      texto = `Colaborador(a) ${p.nome || "Não informado"} assumiu o posto de ${nomeP} (${periodoStr}) no horário regulamentar.`;
    } else if (p.status === "atrasado") {
      texto = `Colaborador(a) ${p.nome || "Não informado"} assumiu o posto de ${nomeP} (${periodoStr}) com atraso de ${p.atraso || 0} min.`;
      if (p.conversa) {
        texto += ` Feedback/Justificativa: ${p.conversa}`;
      }
    } else if (p.status === "falta") {
      texto = `Colaborador(a) ${p.nome || "Não informado"} escalado(a) para ${nomeP} (${periodoStr}) FALTOU ao plantão.`;
      if (p.conversa) {
        texto += ` Anotação: ${p.conversa}`;
      }
    } else {
      texto = `Registro de escala para ${nomeP} (${periodoStr}) com colaborador(a) ${p.nome || "Não informado"}.`;
    }

    await adicionarOcorrencia(texto, p.status === "falta" ? "seguranca" : "acesso");
  };

  const salvarEscalaDoDia = async () => {
    const novosItensHistorico = [];
    const dataHoje = hojeISO();
    const postosNomes = {
      portaria: "Portaria",
      triagem: "Triagem",
      ronda: "Ronda",
      mensageria: "Mensageria"
    };

    Object.keys(escala).forEach((key) => {
      const p = escala[key];
      if (p.nome || p.conversa || p.status !== "pendente") {
        novosItensHistorico.push({
          id: Date.now() + Math.random(),
          data: dataHoje,
          posto: postosNomes[key],
          nome: p.nome,
          periodo: p.periodo,
          status: p.status,
          atraso: p.atraso,
          conversa: p.conversa
        });
      }
    });

    if (novosItensHistorico.length > 0) {
      const novoHist = [...novosItensHistorico, ...historicoEscalas];
      setHistoricoEscalas(novoHist);
      await store.set("historico_escala", novoHist);
      return true;
    }
    return false;
  };

  const excluirItemHistoricoEscala = async (id) => {
    const novoHist = historicoEscalas.filter((h) => h.id !== id);
    setHistoricoEscalas(novoHist);
    await store.set("historico_escala", novoHist);
  };

  // Marca/desmarca uma rotina como concluída no dia de hoje (persistido, some à meia-noite).
  const alternarRotinaConcluida = async (id) => {
    const lista = rotinasConcluidas.includes(id)
      ? rotinasConcluidas.filter((x) => x !== id)
      : [...rotinasConcluidas, id];
    setRotinasConcluidas(lista);
    await store.set("rotinas_concluidas", { data: hojeISO(), ids: lista });
  };

  const gerarEmail = async () => {
    if (gerandoEmail) return;
    setGerandoEmail(true);
    setEmailGerado("");
    try {
      const lista = ocorrenciasHoje
        .slice()
        .reverse()
        .map((o) => `${fmtHora(o.ts)} [${catInfo(o.categoria).label}] ${o.texto}${o.imagem ? " [foto anexada]" : ""}\n  Regulamento: ${o.regulamentoRef?.artigo || "Não encontrado"} - ${o.regulamentoRef?.resumo || "Nenhuma regra específica encontrada no regulamento."}`)
        .join("\n");

      const postosNomes = {
        portaria: "Portaria",
        triagem: "Triagem",
        ronda: "Ronda",
        mensageria: "Mensageria"
      };

      const resumoEscala = Object.keys(escala)
        .map((key) => {
          const p = escala[key];
          const nomeP = postosNomes[key];
          const statusStr = p.status === "no_horario" ? "No Horário" :
                            p.status === "atrasado" ? `Atrasado (${p.atraso} min)` :
                            p.status === "falta" ? "Falta" : "Pendente";
          return `- ${nomeP} (${p.periodo === "diurno" ? "Diurno" : "Noturno"}): ${p.nome || "Não informado"} [Status: ${statusStr}]${p.conversa ? ` - Feedback: ${p.conversa}` : ""}`;
        })
        .join("\n");

      const system =
        "Você é o assistente de um líder de portaria. Gere um RELATÓRIO DE TURNO profissional em português do Brasil, " +
        "claro e objetivo, para registro e envio à administração ou supervisão. " +
        "Estruture assim: um cabeçalho com data, posto e responsável; a escala de colaboradores e o status das rendições do dia; " +
        "a lista de OCORRÊNCIAS em ordem de horário; " +
        "uma seção de OBSERVAÇÕES GERAIS; e a assinatura do responsável. " +
        "Se não houver ocorrências, registre 'Turno sem ocorrências relevantes'. " +
        "Não invente informação que não foi passada. Não use travessão, use vírgulas ou ponto.";
      const user =
        `Data do turno: ${fmtDataLonga(hojeISO())}.\n` +
        `Líder de portaria: ${nomeLider || "(não informado)"}.\n` +
        `Posto: ${posto || "(não informado)"}.\n\n` +
        `Escala de Colaboradores e Rendições:\n${resumoEscala}\n\n` +
        `Ocorrências registradas:\n${lista || "Nenhuma ocorrência registrada."}\n\n` +
        `Observações gerais do turno: ${obsTurno || "Sem observações adicionais."}\n\n` +
        `Gere o e-mail completo.`;
      const resp = await callChatWithFallback(system, [{ role: "user", content: user }], { json: false });
      const referenciasRelatorio = ocorrenciasHoje
        .slice()
        .reverse()
        .map((o) => `- ${linhaReferenciaRegulamento(o.regulamentoRef)}`)
        .join("\n");
      const relatorioComReferencias = resp
        ? `${resp}\n\nREFERÊNCIAS DO REGULAMENTO\n${referenciasRelatorio || "- 📖 Referência: Nenhuma regra específica encontrada no regulamento para este caso."}`
        : "Não consegui gerar o e-mail agora. Tenta de novo.";
      setEmailGerado(relatorioComReferencias);
      salvarPerfil(nomeLider, posto);
    } catch (e) {
      setEmailGerado("Falhou a conexão ao gerar o e-mail. Tenta de novo.");
    } finally {
      setGerandoEmail(false);
    }
  };

  const copiarEmail = async () => {
    try {
      await navigator.clipboard.writeText(emailGerado);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {}
  };

  const enviarWhatsApp = () => {
    if (!emailGerado.trim()) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(emailGerado)}`, "_blank", "noopener,noreferrer");
  };

  const fecharTurno = async () => {
    // Salva a escala atual no histórico antes de limpar
    await salvarEscalaDoDia();

    // arquiva: mantém histórico mas limpa observações, chat e escalas da tela
    setObsTurno("");
    setChat([]);
    setEmailGerado("");
    
    const escalaLimpa = {
      portaria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
      triagem: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
      ronda: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
      mensageria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
    };
    setEscala(escalaLimpa);
    await store.set("escala_atual", escalaLimpa);
  };


  const cor = tokensTema(tema);
  const rotinasFeitas = rotinasConcluidas.length;
  const rotinasTotal = ROTINAS.length;
  const progressoRotinas = rotinasTotal ? Math.round((rotinasFeitas / rotinasTotal) * 100) : 0;

  const NAV_ITENS = [
    { id: "turno", label: "Turno", icone: "relogio" },
    { id: "consultar", label: "Consultar", icone: "mensagem" },
    { id: "rotinas", label: "Rotinas", icone: "checkQuadro" },
    { id: "ocorrencias", label: "Ocorrências", icone: "livro", badge: ocorrenciasHoje.length },
    { id: "relatorio", label: "Relatório", icone: "arquivo" },
    { id: "regras", label: "Regras", icone: "menu" },
  ];

  if (!carregado) {
    return (
      <div style={{ minHeight: "100vh", background: tokensTema(tema).fundoPagina, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#4ADE80", fontSize: 13, letterSpacing: "0.05em" }}>Abrindo a guarita...</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: cor.fundoPagina, color: cor.textoPrincipal }}>
      <div className="md:flex md:items-start">
        {/* Menu lateral (desktop) */}
        <aside className="hidden md:flex md:shrink-0 md:w-[268px] md:sticky md:top-0 md:h-screen md:p-4">
          <div style={{ background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, boxShadow: cor.cartaoSombra, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 28, padding: "22px 18px", display: "flex", flexDirection: "column", gap: 20, width: "100%" }}>
            <div className="flex items-center gap-2.5">
              <div style={{ width: 38, height: 38, borderRadius: 999, background: "linear-gradient(140deg,#4ADE80,#7C3AED)", flexShrink: 0 }} />
              <span style={{ fontFamily: "'Caprasimo', cursive", fontSize: 18, lineHeight: 1.15 }}>Lider<br />Amigão</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {NAV_ITENS.map((item) => {
                const ativo = aba === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setAba(item.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 11, padding: "12px 14px", borderRadius: 18, textAlign: "left",
                      background: ativo ? "rgba(34,197,94,.16)" : "transparent",
                      border: ativo ? "1px solid rgba(74,222,128,.4)" : "1px solid transparent",
                    }}
                  >
                    <Icone nome={item.icone} tamanho={19} cor={ativo ? "#4ADE80" : cor.iconeInativo} />
                    <span style={{ fontSize: 14, fontWeight: ativo ? 700 : 500, flex: 1, color: ativo ? cor.textoPrincipal : cor.textoSecundario }}>{item.label}</span>
                    {item.badge > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 700, background: "#22C55E", color: "#052E16", borderRadius: 999, minWidth: 18, height: 18, padding: "0 5px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderRadius: 18, background: cor.subBlocoVerde, border: `1px solid ${cor.subBlocoVerdeBorda}` }}>
              <span style={{ fontSize: 13 }}>Tema</span>
              <button onClick={alternarTema} style={{ width: 28, height: 28, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icone nome={tema === "dark" ? "lua" : "sol"} tamanho={15} cor={tema === "dark" ? "#FDE68A" : cor.roxo} />
              </button>
            </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex justify-center">
          <div className="w-full md:max-w-[1200px] md:py-6 md:px-6" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative" }}>
            {/* Cabeçalho (só mobile — no desktop a saudação mora na tela de Turno) */}
            <header className="md:hidden flex items-center justify-between" style={{ padding: "20px 16px 12px" }}>
              <div className="flex items-center gap-2.5">
                <div style={{ width: 36, height: 36, borderRadius: 999, background: "linear-gradient(140deg,#4ADE80,#7C3AED)", flexShrink: 0 }} />
                <div>
                  <p style={{ fontFamily: "'Caprasimo', cursive", fontSize: 16, margin: 0 }}>Lider Amigão</p>
                  <p style={{ fontSize: 11, color: cor.textoSecundario, margin: "2px 0 0" }}>HV Serv · Chamadas IA: {chamadasGroq}</p>
                </div>
              </div>
              <button
                onClick={alternarTema}
                style={{ width: 40, height: 40, borderRadius: 999, background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <Icone nome={tema === "dark" ? "lua" : "sol"} tamanho={18} cor={tema === "dark" ? "#FDE68A" : cor.roxo} />
              </button>
            </header>

            {/* Navegação inferior (mobile) */}
            <nav
              className="md:hidden grid grid-cols-6"
              style={{
                position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 20,
                background: cor.navBg, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: cor.navSombra,
                borderTop: `1px solid ${cor.cartaoBorda}`, padding: "10px 2px",
              }}
            >
              {NAV_ITENS.map((item) => {
                const ativo = aba === item.id;
                return (
                  <button key={item.id} onClick={() => setAba(item.id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, position: "relative" }}>
                    <Icone nome={item.icone} tamanho={19} cor={ativo ? "#22C55E" : cor.iconeInativo} />
                    <span style={{ fontSize: 9, fontWeight: ativo ? 700 : 500, color: ativo ? cor.textoPrincipal : cor.textoNavInativo }}>{item.label}</span>
                    {item.badge > 0 && (
                      <span style={{ position: "absolute", top: -4, right: "50%", transform: "translateX(14px)", background: "#22C55E", color: "#052E16", fontSize: 9, fontWeight: 700, borderRadius: 999, minWidth: 15, height: 15, padding: "0 3px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            {/* Conteúdo */}
      <main className="flex-1 md:pb-10" style={{ paddingBottom: 108 }}>
        {aba === "turno" && (
          <div className="px-4 md:px-0 py-5 md:py-2" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontFamily: "'Caprasimo', cursive", fontSize: 27, lineHeight: 1.15 }}>
                Bom turno{nomeLider ? `, Líder ${nomeLider}` : ""}
              </div>
              <div style={{ fontSize: 13, color: cor.textoSecundario, marginTop: 3 }}>
                {posto || "Seu condomínio"} · {fmtDataLonga(hojeISO())}
              </div>
            </div>

            <FormularioOcorrencia
              cor={cor}
              tema={tema}
              novoLocal={novoLocal}
              setNovoLocal={setNovoLocal}
              novoLocalCustom={novoLocalCustom}
              setNovoLocalCustom={setNovoLocalCustom}
              novaOc={novaOc}
              setNovaOc={setNovaOc}
              fotoOcorrenciaCameraRef={fotoOcorrenciaCameraRef}
              fotoOcorrenciaGaleriaRef={fotoOcorrenciaGaleriaRef}
              selecionarFotoOcorrenciaManual={selecionarFotoOcorrenciaManual}
              fotoOcorrenciaManualPreview={fotoOcorrenciaManualPreview}
              limparFotoOcorrenciaManual={limparFotoOcorrenciaManual}
              fotoOcorrenciaManualErro={fotoOcorrenciaManualErro}
              registrarOcorrenciaManual={registrarOcorrenciaManual}
              registrandoOcorrenciaManual={registrandoOcorrenciaManual}
            />

            <div style={{ display: "flex", alignItems: "center", gap: 16, borderRadius: 18, padding: "10px 16px", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}` }}>
              <span style={{ fontSize: 13, color: cor.textoPrincipal }}>
                <strong style={{ fontFamily: "'Caprasimo', cursive", fontWeight: 400 }}>{ocorrenciasHoje.length}</strong> ocorrência{ocorrenciasHoje.length !== 1 ? "s" : ""}
              </span>
              <span style={{ width: 4, height: 4, borderRadius: 999, background: cor.textoSecundario, opacity: 0.5 }} />
              <span style={{ fontSize: 13, color: cor.textoPrincipal }}>
                <strong style={{ fontFamily: "'Caprasimo', cursive", fontWeight: 400 }}>{rotinasFeitas}/{rotinasTotal}</strong> rotinas feitas
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14, borderRadius: 26, padding: "16px 18px", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Assistente por voz</div>
                <div style={{ fontSize: 12, color: cor.textoSecundario, marginTop: 3 }}>Ouve e responde sem parar (Viva-Voz)</div>
              </div>
              <button
                type="button"
                onClick={() => setModoVivaVoz(!modoVivaVoz)}
                style={{
                  width: 54, height: 30, borderRadius: 999, display: "flex", alignItems: "center", padding: 3,
                  background: modoVivaVoz ? "#22C55E" : "rgba(140,130,165,.35)",
                  boxShadow: modoVivaVoz ? "0 0 18px rgba(34,197,94,.55)" : "none",
                  justifyContent: modoVivaVoz ? "flex-end" : "flex-start", transition: "background 180ms",
                }}
              >
                <span style={{ width: 24, height: 24, borderRadius: 999, background: "#fff", display: "block" }} />
              </button>
            </div>
          </div>
        )}

        {aba === "consultar" && (
          <div className="flex flex-col h-full">
            <div className="px-4 md:px-0 py-3 md:py-2 pb-8 md:max-w-2xl md:mx-auto" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {chat.length === 0 && (
                <div style={{ textAlign: "center", padding: "24px 16px 0" }}>
                  <div style={{ width: 44, height: 44, borderRadius: 999, background: "linear-gradient(140deg,#A78BFA,#22C55E)", margin: "0 auto 14px" }} />
                  <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Pergunte durante o turno</p>
                  <p style={{ fontSize: 12, color: cor.textoSecundario, lineHeight: 1.6, marginBottom: 14 }}>
                    "Pode entrar entregador de madrugada?" · "Qual o horário de silêncio?" · "Visitante sem morador autorizar, o que faço?"
                  </p>
                  {!regulamento && (
                    <div style={{ fontSize: 11, color: cor.verdeNumero, background: cor.subBlocoVerde, border: `1px solid ${cor.subBlocoVerdeBorda}`, borderRadius: 12, padding: "8px 12px", display: "inline-block" }}>
                      Cadastre o regulamento na aba Regras para respostas precisas.
                    </div>
                  )}
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div
                    style={
                      m.role === "user"
                        ? { maxWidth: "85%", background: "#fff", color: "#1E1035", borderRadius: "22px 22px 6px 22px", padding: "13px 16px", fontSize: 15, lineHeight: 1.45, fontWeight: 500, whiteSpace: "pre-wrap" }
                        : { maxWidth: "88%", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, color: cor.textoPrincipal, borderRadius: "22px 22px 22px 6px", padding: "14px 16px", fontSize: 15, lineHeight: 1.5, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", whiteSpace: "pre-wrap" }
                    }
                  >
                    {m.imagem && <img src={m.imagem} alt="Foto anexada à mensagem" style={{ maxHeight: 190, maxWidth: "100%", borderRadius: 12, marginBottom: 8, objectFit: "contain" }} />}
                    {m.content}
                    {m.role === "assistant" && (
                      <button onClick={() => registrarDoChat(m.content)} style={{ marginTop: 10, display: "block", fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 999, background: cor.subBlocoVerde, color: cor.verdeNumero, border: `1px solid ${cor.subBlocoVerdeBorda}` }}>
                        + registrar como ocorrência
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {pensando && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div style={{ background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, borderRadius: "22px 22px 22px 6px", padding: "14px 18px" }}>
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      <span className="animate-bounce" style={{ height: 6, width: 6, background: "#4ADE80", borderRadius: 999, animationDelay: "0ms" }} />
                      <span className="animate-bounce" style={{ height: 6, width: 6, background: "#4ADE80", borderRadius: 999, animationDelay: "150ms" }} />
                      <span className="animate-bounce" style={{ height: 6, width: 6, background: "#4ADE80", borderRadius: 999, animationDelay: "300ms" }} />
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatFim} />
            </div>
          </div>
        )}

        {aba === "ocorrencias" && (
          <div className="px-4 md:px-0 py-4 md:py-2" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>{fmtDataLonga(hojeISO())}</p>
              <h2 style={{ fontFamily: "'Caprasimo', cursive", fontSize: 24 }}>Ocorrências</h2>
              <p style={{ fontSize: 13, color: cor.textoSecundario, marginTop: 2 }}>{ocorrenciasHoje.length} registro{ocorrenciasHoje.length !== 1 ? "s" : ""} neste turno</p>
            </div>

            <FormularioOcorrencia
              cor={cor}
              tema={tema}
              novoLocal={novoLocal}
              setNovoLocal={setNovoLocal}
              novoLocalCustom={novoLocalCustom}
              setNovoLocalCustom={setNovoLocalCustom}
              novaOc={novaOc}
              setNovaOc={setNovaOc}
              fotoOcorrenciaCameraRef={fotoOcorrenciaCameraRef}
              fotoOcorrenciaGaleriaRef={fotoOcorrenciaGaleriaRef}
              selecionarFotoOcorrenciaManual={selecionarFotoOcorrenciaManual}
              fotoOcorrenciaManualPreview={fotoOcorrenciaManualPreview}
              limparFotoOcorrenciaManual={limparFotoOcorrenciaManual}
              fotoOcorrenciaManualErro={fotoOcorrenciaManualErro}
              registrarOcorrenciaManual={registrarOcorrenciaManual}
              registrandoOcorrenciaManual={registrandoOcorrenciaManual}
            />

            {ocorrenciasHoje.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", color: cor.textoSecundario, fontSize: 14 }}>Nenhuma ocorrência registrada hoje.</div>
            ) : (
              <div className="flex flex-col md:grid md:grid-cols-2 md:gap-3 lg:grid-cols-3" style={{ gap: 10 }}>
                {ocorrenciasHoje.map((o) => {
                  const rotuloLocal = o.local || catInfo(o.categoria).label;
                  const bc = corBadgeLocal(o.localId || "outros", tema);
                  return (
                    <div key={o.id} style={{ borderRadius: 22, padding: "14px 16px", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 999, background: bc.bg, color: bc.texto }}>{rotuloLocal.toUpperCase()}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontFamily: "'Caprasimo', cursive", fontSize: 15 }}>{fmtHora(o.ts)}</span>
                          <button onClick={() => removerOcorrencia(o.id)} style={{ color: cor.textoSecundario, display: "flex" }}>
                            <Icone nome="x" tamanho={14} />
                          </button>
                        </div>
                      </div>
                      <p style={{ fontSize: 14, marginTop: 10, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{o.texto}</p>
                      {o.imagem && <img src={o.imagem} alt="Foto da ocorrência" style={{ marginTop: 8, maxHeight: 160, maxWidth: "100%", borderRadius: 12, objectFit: "contain" }} />}
                      {o.regulamentoRef && (
                        <div style={{ marginTop: 10, borderLeft: "2px solid rgba(74,222,128,.5)", paddingLeft: 10, fontSize: 12, lineHeight: 1.4 }}>
                          <p style={{ color: cor.verdeNumero, fontWeight: 600, margin: 0 }}>{o.regulamentoRef.artigo}</p>
                          <p style={{ color: cor.textoSecundario, margin: "2px 0 0" }}>{o.regulamentoRef.resumo}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {aba === "relatorio" && (
          <div className="px-4 md:px-0 py-4 md:py-2" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>Fechamento de turno</p>
              <h2 style={{ fontFamily: "'Caprasimo', cursive", fontSize: 24 }}>Relatório do turno</h2>
              <p style={{ fontSize: 13, color: cor.textoSecundario, marginTop: 3, lineHeight: 1.5 }}>
                Gera o relatório com as ocorrências do dia, pronto pra registrar ou enviar por WhatsApp.
              </p>
            </div>

            <div className={"flex flex-col " + (emailGerado ? "md:grid md:grid-cols-2 md:gap-4 md:items-start" : "")} style={{ gap: 12 }}>
              <div style={{ borderRadius: 26, padding: 16, background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={nomeLider}
                    onChange={(e) => setNomeLider(e.target.value)}
                    placeholder="Seu nome"
                    style={{ background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 14, padding: "10px 14px", fontSize: 13, color: cor.textoPrincipal }}
                  />
                  <input
                    value={posto}
                    onChange={(e) => setPosto(e.target.value)}
                    placeholder="Posto / condomínio"
                    style={{ background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 14, padding: "10px 14px", fontSize: 13, color: cor.textoPrincipal }}
                  />
                </div>
                <textarea
                  value={obsTurno}
                  onChange={(e) => setObsTurno(e.target.value)}
                  placeholder="Observações gerais do turno (opcional)..."
                  rows={2}
                  style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 14, padding: "10px 14px", fontSize: 13, color: cor.textoPrincipal, resize: "none" }}
                />
                <div style={{ fontSize: 11, color: cor.textoSecundario }}>
                  {ocorrenciasHoje.length} ocorrência{ocorrenciasHoje.length !== 1 ? "s" : ""} de hoje ser{ocorrenciasHoje.length !== 1 ? "ão" : "á"} incluída{ocorrenciasHoje.length !== 1 ? "s" : ""}.
                </div>
                <button
                  onClick={gerarEmail}
                  disabled={gerandoEmail}
                  style={{ width: "100%", background: "#22C55E", color: "#052E16", fontWeight: 700, fontSize: 14, borderRadius: 999, padding: "13px 0", opacity: gerandoEmail ? 0.6 : 1, boxShadow: "0 0 20px rgba(34,197,94,.3)" }}
                >
                  {gerandoEmail ? "Montando o relatório..." : "Gerar relatório de turno"}
                </button>
              </div>

              {emailGerado && (
                <div style={{ borderRadius: 26, padding: 16, background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>Relatório pronto</span>
                    <button onClick={copiarEmail} style={{ fontSize: 12, color: cor.verdeNumero, fontWeight: 600 }}>
                      {copiado ? "Copiado ✓" : "Copiar"}
                    </button>
                  </div>
                  <textarea
                    value={emailGerado}
                    onChange={(e) => setEmailGerado(e.target.value)}
                    aria-label="Mensagem pronta para WhatsApp"
                    rows={12}
                    style={{ width: "100%", fontSize: 13, color: cor.textoPrincipal, whiteSpace: "pre-wrap", lineHeight: 1.6, background: cor.inputBg, borderRadius: 14, padding: 12, border: `1px solid ${cor.inputBorda}`, resize: "vertical" }}
                  />
                  <button
                    onClick={enviarWhatsApp}
                    disabled={!emailGerado.trim()}
                    style={{ width: "100%", marginTop: 12, background: "#fff", color: "#3b0764", fontWeight: 700, fontSize: 14, borderRadius: 999, padding: "13px 0", opacity: emailGerado.trim() ? 1 : 0.4 }}
                  >
                    Enviar por WhatsApp
                  </button>
                  <button onClick={fecharTurno} style={{ width: "100%", marginTop: 10, border: `1px solid ${cor.cartaoBorda}`, color: cor.textoSecundario, fontSize: 13, borderRadius: 999, padding: "10px 0" }}>
                    Limpar turno (fechar)
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {aba === "regras" && (
          <div className="px-4 md:px-0 py-4 md:py-2" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>Base de consulta</p>
              <h2 style={{ fontFamily: "'Caprasimo', cursive", fontSize: 24 }}>Regulamento interno</h2>
              <p style={{ fontSize: 13, color: cor.textoSecundario, marginTop: 3, lineHeight: 1.5 }}>
                O Regimento Interno (150 artigos) já vem carregado no app. Se ele mudar no futuro, suba o PDF atualizado abaixo — a IA lê o arquivo e extrai as normas de novo.
              </p>
            </div>

            {/* Upload de PDF */}
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => lerPDF(e.target.files && e.target.files[0])}
                className="hidden"
              />
              <button
                onClick={() => fileRef.current && fileRef.current.click()}
                disabled={lendoPDF}
                style={{
                  width: "100%",
                  borderRadius: 22,
                  padding: "26px 0",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  background: cor.subBlocoVerde,
                  border: `1.5px dashed ${cor.subBlocoVerdeBorda}`,
                  opacity: lendoPDF ? 0.6 : 1,
                }}
              >
                <Icone nome={lendoPDF ? "relogio" : "upload"} tamanho={26} cor={cor.verdeNumero} />
                <span style={{ fontSize: 14, fontWeight: 600, color: cor.textoPrincipal }}>
                  {lendoPDF ? `Lendo o regulamento... (${segLeituraPDF}s)` : "Subir PDF do regulamento"}
                </span>
                {lendoPDF && (
                  <span style={{ fontSize: 11, color: cor.textoSecundario, textAlign: "center", maxWidth: 260 }}>
                    Documentos grandes podem levar 1 a 3 minutos. Não feche esta aba.
                  </span>
                )}
                {pdfNome && !lendoPDF && <span style={{ fontSize: 11, color: cor.textoSecundario }}>{pdfNome}</span>}
                {!pdfNome && !lendoPDF && <span style={{ fontSize: 11, color: cor.textoSecundario }}>Toque para escolher o arquivo</span>}
              </button>
              {pdfErro && <p style={{ fontSize: 11, color: "#FCA5A5", marginTop: 8, textAlign: "center" }}>{pdfErro}</p>}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
              <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>ou cole o texto</span>
              <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
            </div>

            <div>
              <textarea
                value={regulamentoTemp}
                onChange={(e) => setRegulamentoTemp(e.target.value)}
                placeholder="Cole o regulamento interno aqui, ou edite o que a IA extraiu do PDF."
                rows={10}
                style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 18, padding: 12, fontSize: 13, color: cor.textoPrincipal, resize: "none", lineHeight: 1.5 }}
              />
              <button
                onClick={salvarRegulamento}
                style={{ width: "100%", marginTop: 10, background: "#22C55E", color: "#052E16", fontWeight: 700, fontSize: 14, borderRadius: 999, padding: "13px 0", boxShadow: "0 0 20px rgba(34,197,94,.3)" }}
              >
                {regSalvo ? "Salvo ✓" : "Salvar regulamento"}
              </button>
              {regulamento && (
                <p style={{ fontSize: 11, color: cor.verdeNumero, marginTop: 8, textAlign: "center" }}>
                  Regulamento carregado ({regulamento.length} caracteres).
                </p>
              )}
            </div>

            {regulamento && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
                  <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>buscar no regulamento</span>
                  <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
                </div>
                <input
                  type="search"
                  value={buscaRegulamento}
                  onChange={(e) => setBuscaRegulamento(e.target.value)}
                  placeholder="Ex.: estacionar, vaga, silêncio..."
                  style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 999, padding: "11px 16px", fontSize: 13, color: cor.textoPrincipal }}
                />
                {buscaRegulamento.trim() && (
                  <div className="flex flex-col md:grid md:grid-cols-2 md:gap-2" style={{ marginTop: 12, gap: 8 }}>
                    {resultadosBuscaRegulamento.length === 0 ? (
                      <p style={{ fontSize: 12, color: cor.textoSecundario, textAlign: "center", padding: "12px 0" }}>
                        Nenhum trecho encontrado para "{buscaRegulamento.trim()}". Tente outra palavra.
                      </p>
                    ) : (
                      <>
                        <p style={{ fontSize: 11, color: cor.textoSecundario }}>
                          🔎 {resultadosBuscaRegulamento.length} trecho(s) encontrado(s):
                        </p>
                        {resultadosBuscaRegulamento.slice(0, 15).map((r) => (
                          <div key={r.indice} style={{ borderRadius: 14, padding: "10px 12px", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}` }}>
                            <p style={{ fontSize: 13, color: cor.textoPrincipal, lineHeight: 1.5 }}>
                              {destacarTermos(r.linha, r.termosEncontrados)}
                            </p>
                          </div>
                        ))}
                        {resultadosBuscaRegulamento.length > 15 && (
                          <p style={{ fontSize: 11, color: cor.textoSecundario, textAlign: "center" }}>
                            ...e mais resultados. Afine a busca.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ height: 1, background: cor.cartaoBorda, marginTop: 6 }} />

            <div>
              <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>Base de consulta</p>
              <h2 style={{ fontFamily: "'Caprasimo', cursive", fontSize: 24 }}>Convenção · vagas de estacionamento</h2>
              <p style={{ fontSize: 13, color: cor.textoSecundario, marginTop: 3, lineHeight: 1.5 }}>
                Suba o PDF da convenção do condomínio. A IA extrai o texto, incluindo a relação de vagas por apartamento/bloco, pra você consultar rápido quem é dono de qual vaga.
              </p>
            </div>

            {/* Upload de PDF da convenção */}
            <div>
              <input
                ref={fileRefConvencao}
                type="file"
                accept="application/pdf"
                onChange={(e) => lerPDFConvencao(e.target.files && e.target.files[0])}
                className="hidden"
              />
              <button
                onClick={() => fileRefConvencao.current && fileRefConvencao.current.click()}
                disabled={lendoPDFConvencao}
                style={{
                  width: "100%",
                  borderRadius: 22,
                  padding: "26px 0",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  background: cor.subBlocoRoxo,
                  border: `1.5px dashed ${cor.subBlocoRoxoBorda}`,
                  opacity: lendoPDFConvencao ? 0.6 : 1,
                }}
              >
                <Icone nome={lendoPDFConvencao ? "relogio" : "upload"} tamanho={26} cor={cor.roxo} />
                <span style={{ fontSize: 14, fontWeight: 600, color: cor.textoPrincipal }}>
                  {lendoPDFConvencao ? `Lendo a convenção... (${segLeituraConvencao}s)` : "Subir PDF da convenção"}
                </span>
                {lendoPDFConvencao && (
                  <span style={{ fontSize: 11, color: cor.textoSecundario, textAlign: "center", maxWidth: 260 }}>
                    Documentos grandes podem levar 1 a 3 minutos. Não feche esta aba.
                  </span>
                )}
                {pdfNomeConvencao && !lendoPDFConvencao && <span style={{ fontSize: 11, color: cor.textoSecundario }}>{pdfNomeConvencao}</span>}
                {!pdfNomeConvencao && !lendoPDFConvencao && <span style={{ fontSize: 11, color: cor.textoSecundario }}>Toque para escolher o arquivo</span>}
              </button>
              {pdfErroConvencao && <p style={{ fontSize: 11, color: "#FCA5A5", marginTop: 8, textAlign: "center" }}>{pdfErroConvencao}</p>}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
              <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>ou cole o texto</span>
              <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
            </div>

            <div>
              <textarea
                value={convencaoTemp}
                onChange={(e) => setConvencaoTemp(e.target.value)}
                placeholder="Cole a convenção aqui, ou edite o que a IA extraiu do PDF (inclua a relação de vagas por apartamento)."
                rows={10}
                style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 18, padding: 12, fontSize: 13, color: cor.textoPrincipal, resize: "none", lineHeight: 1.5 }}
              />
              <button
                onClick={salvarConvencao}
                style={{ width: "100%", marginTop: 10, background: "#22C55E", color: "#052E16", fontWeight: 700, fontSize: 14, borderRadius: 999, padding: "13px 0", boxShadow: "0 0 20px rgba(34,197,94,.3)" }}
              >
                {convSalvo ? "Salvo ✓" : "Salvar convenção"}
              </button>
              {convencao && (
                <p style={{ fontSize: 11, color: cor.verdeNumero, marginTop: 8, textAlign: "center" }}>
                  Convenção carregada ({convencao.length} caracteres).
                </p>
              )}
            </div>

            {convencao && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
                  <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>buscar vaga / apartamento</span>
                  <div style={{ height: 1, background: cor.cartaoBorda, flex: 1 }} />
                </div>
                <input
                  type="search"
                  value={buscaConvencao}
                  onChange={(e) => setBuscaConvencao(e.target.value)}
                  placeholder="Ex.: apto 302, vaga 15, bloco B..."
                  style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 999, padding: "11px 16px", fontSize: 13, color: cor.textoPrincipal }}
                />
                {buscaConvencao.trim() && (
                  <div className="flex flex-col md:grid md:grid-cols-2 md:gap-2" style={{ marginTop: 12, gap: 8 }}>
                    {resultadosBuscaConvencao.length === 0 ? (
                      <p style={{ fontSize: 12, color: cor.textoSecundario, textAlign: "center", padding: "12px 0" }}>
                        Nenhum trecho encontrado para "{buscaConvencao.trim()}". Tente outra palavra.
                      </p>
                    ) : (
                      <>
                        <p style={{ fontSize: 11, color: cor.textoSecundario }}>
                          🔎 {resultadosBuscaConvencao.length} trecho(s) encontrado(s):
                        </p>
                        {resultadosBuscaConvencao.slice(0, 15).map((r) => (
                          <div key={r.indice} style={{ borderRadius: 14, padding: "10px 12px", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}` }}>
                            <p style={{ fontSize: 13, color: cor.textoPrincipal, lineHeight: 1.5 }}>
                              {destacarTermos(r.linha, r.termosEncontrados)}
                            </p>
                          </div>
                        ))}
                        {resultadosBuscaConvencao.length > 15 && (
                          <p style={{ fontSize: 11, color: cor.textoSecundario, textAlign: "center" }}>
                            ...e mais resultados. Afine a busca.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {aba === "rotinas" && (
          <div className="px-4 md:px-0 py-4 md:py-2" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario }}>Nativ Tatuapé Garden</p>
              <h2 style={{ fontFamily: "'Caprasimo', cursive", fontSize: 24 }}>Rotinas do condomínio</h2>
              <p style={{ fontSize: 13, color: cor.textoSecundario, marginTop: 3, lineHeight: 1.5 }}>
                Procedimentos da ronda diurna (07h–19h). Toque num bloco para abrir.
              </p>
            </div>

            {/* Progresso do turno */}
            <div style={{ borderRadius: 22, padding: 16, background: cor.subBlocoVerde, border: `1px solid ${cor.subBlocoVerdeBorda}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: cor.textoPrincipal }}>
                  {rotinasFeitas}/{rotinasTotal} rotinas concluídas
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: cor.verdeNumero }}>{progressoRotinas}%</span>
              </div>
              <div style={{ marginTop: 8, height: 8, borderRadius: 999, background: "rgba(255,255,255,.14)", overflow: "hidden" }}>
                <div style={{ width: `${progressoRotinas}%`, height: "100%", borderRadius: 999, background: "#22C55E", transition: "width .3s" }} />
              </div>
            </div>

            {/* Concluir por voz */}
            <button
              onClick={() => { if (!gravando) iniciarGravacao(); }}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", borderRadius: 999, padding: "13px 0", background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", color: cor.textoPrincipal, fontSize: 14, fontWeight: 600 }}
            >
              <Icone nome="mic" tamanho={18} cor={cor.verdeNumero} />
              Concluir tarefa por voz
            </button>

            {/* Horários-chave — sempre visível */}
            <div style={{ borderRadius: 22, padding: 14, background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
              <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <Icone nome="relogio" tamanho={13} cor={cor.textoSecundario} /> Horários-chave
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {ROTINAS_HORARIOS.map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, lineHeight: 1.4 }}>
                    <span style={{ color: cor.verdeNumero, fontWeight: 700, flexShrink: 0, width: 64 }}>{h.hora}</span>
                    <span style={{ color: cor.textoSecundario }}>{h.texto}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* AGORA */}
            {ROTINAS.filter((sec) => !rotinasConcluidas.includes(sec.id)).length > 0 && (
              <div>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario, fontWeight: 700, marginBottom: 8 }}>Agora</p>
                <div className="flex flex-col md:grid md:grid-cols-2 md:gap-3 lg:grid-cols-3" style={{ gap: 8 }}>
                  {ROTINAS.filter((sec) => !rotinasConcluidas.includes(sec.id)).map((sec) => (
                    <RotinaCard key={sec.id} sec={sec} cor={cor} aberto={rotinaAberta === sec.id} concluida={false}
                      onToggleAberto={() => setRotinaAberta(rotinaAberta === sec.id ? null : sec.id)}
                      onToggleConcluida={() => alternarRotinaConcluida(sec.id)} />
                  ))}
                </div>
              </div>
            )}

            {/* CONCLUÍDAS */}
            {rotinasFeitas > 0 && (
              <div>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: cor.textoSecundario, fontWeight: 700, marginBottom: 8 }}>Concluídas</p>
                <div className="flex flex-col md:grid md:grid-cols-2 md:gap-3 lg:grid-cols-3" style={{ gap: 8 }}>
                  {ROTINAS.filter((sec) => rotinasConcluidas.includes(sec.id)).map((sec) => (
                    <RotinaCard key={sec.id} sec={sec} cor={cor} aberto={rotinaAberta === sec.id} concluida={true}
                      onToggleAberto={() => setRotinaAberta(rotinaAberta === sec.id ? null : sec.id)}
                      onToggleConcluida={() => alternarRotinaConcluida(sec.id)} />
                  ))}
                </div>
              </div>
            )}

            <p style={{ fontSize: 10, color: cor.textoSecundario, textAlign: "center", marginTop: 6, lineHeight: 1.5 }}>
              Irregularidade? Foto + iButton → grupo Vigia (WhatsApp).
            </p>
          </div>
        )}
      </main>

      {/* Toast de Ocorrência Registrada por Voz */}
      {toastOcorrencia && (
        <div
          className="fixed top-16 inset-x-4 max-w-sm mx-auto z-50 rounded-2xl p-3.5 flex items-start gap-3 animate-fade-in"
          style={{ background: cor.cartao, border: `1px solid ${cor.subBlocoVerdeBorda}`, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", boxShadow: "0 20px 40px rgba(0,0,0,.35)" }}
        >
          <span className="shrink-0" style={{ display: "flex", paddingTop: 2 }}><Icone nome="livro" tamanho={20} cor={cor.verdeNumero} /></span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span style={{ fontSize: 11, fontWeight: 700, color: cor.verdeNumero }}>
                {toastOcorrencia.pendente ? "Confira antes de registrar" : "Ocorrência Registrada!"}
              </span>
              {(() => {
                const bc = corBadgeCategoria(toastOcorrencia.categoria, tema);
                return (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: bc.bg, color: bc.texto }}>
                    {catInfo(toastOcorrencia.categoria).label}
                  </span>
                );
              })()}
            </div>
            <textarea
              value={toastOcorrencia.texto}
              onChange={(e) => setToastOcorrencia({ ...toastOcorrencia, texto: e.target.value })}
              aria-label="Descrição editável da ocorrência"
              rows={3}
              style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 12, padding: "8px 10px", fontSize: 12.5, color: cor.textoPrincipal, fontWeight: 500, marginTop: 6, lineHeight: 1.45, resize: "vertical" }}
            />
            {toastOcorrencia.regulamentoRef && (
              <div style={{ marginTop: 8, borderLeft: `2px solid ${cor.verdeNumero}`, paddingLeft: 8, fontSize: 11, lineHeight: 1.4 }}>
                <p style={{ color: cor.verdeNumero, fontWeight: 600, margin: 0 }}>{toastOcorrencia.regulamentoRef.artigo}</p>
                <p style={{ color: cor.textoSecundario, marginTop: 2 }}>{toastOcorrencia.regulamentoRef.resumo}</p>
              </div>
            )}
            {toastOcorrencia.pendente && (
              <button
                onClick={confirmarOcorrencia}
                style={{ width: "100%", marginTop: 8, background: "#22C55E", color: "#052E16", fontWeight: 700, fontSize: 11, borderRadius: 999, padding: "7px 0" }}
              >
                Confirmar e salvar ocorrência
              </button>
            )}
          </div>
          <button onClick={() => setToastOcorrencia(null)} style={{ color: cor.textoSecundario, display: "flex", flexShrink: 0 }}>
            <Icone nome="x" tamanho={16} />
          </button>
        </div>
      )}

      {/* Barra Flutuante de Voz (Modo Ronda Viva-Voz) */}
      <div
        className="fixed bottom-14 md:bottom-0 inset-x-0 md:left-[268px] mx-auto max-w-md md:max-w-[1200px] z-20 px-3 md:px-8 py-2 md:py-3"
        style={{ background: cor.navBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderTop: `1px solid ${cor.cartaoBorda}`, boxShadow: cor.navSombra }}
      >
        {erroVoz && (
          <p style={{ fontSize: 11, color: "#FCA5A5", marginBottom: 6, textAlign: "center", lineHeight: 1.4 }}>{erroVoz}</p>
        )}

        {/* Indicador de Status da Voz */}
        {(statusVoz || gravando || falando || pensando) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 12, padding: "5px 10px", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className={gravando ? "animate-ping" : "animate-pulse"} style={{ height: 8, width: 8, borderRadius: 999, background: gravando ? "#F87171" : falando ? cor.verdeNumero : cor.roxo, flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, color: cor.textoPrincipal, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {statusVoz || (gravando ? "Ouvindo sua fala..." : falando ? "Assistente falando..." : "IA pensando...")}
              </span>
            </div>
            {pergunta && <span style={{ fontSize: 10, color: cor.textoSecundario, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>"{pergunta}"</span>}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Botão Principal de Microfone */}
          <button
            type="button"
            onClick={() => {
              if (gravando) {
                pararGravacao();
              } else {
                iniciarGravacao();
              }
            }}
            title={gravando ? "Ouvindo" : falando ? "Assistente falando" : "Falar por voz"}
            style={{
              flexShrink: 0,
              height: 44,
              width: aba === "consultar" ? 44 : undefined,
              padding: aba === "consultar" ? 0 : "0 14px",
              borderRadius: 999,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontWeight: 700,
              fontSize: 12,
              background: gravando ? "rgba(248,113,113,.18)" : falando ? cor.subBlocoVerde : "#22C55E",
              border: gravando ? "1px solid rgba(248,113,113,.5)" : falando ? `1px solid ${cor.subBlocoVerdeBorda}` : "none",
              color: gravando ? "#FCA5A5" : falando ? cor.verdeNumero : "#052E16",
              boxShadow: !gravando && !falando ? "0 0 20px rgba(34,197,94,.3)" : "none",
            }}
          >
            <Icone nome="mic" tamanho={17} espessura={2.75} cor={gravando ? "#FCA5A5" : falando ? cor.verdeNumero : "#052E16"} />
            {aba !== "consultar" && <span>{gravando ? "Ouvindo" : falando ? "Falando" : "Falar por Voz"}</span>}
          </button>

          {/* Alternar Modo Viva-Voz Contínuo */}
          <button
            type="button"
            onClick={() => setModoVivaVoz(!modoVivaVoz)}
            title={modoVivaVoz ? "Modo Viva-Voz ATIVADO (Ouve e responde sem parar)" : "Ativar Modo Viva-Voz"}
            style={{
              flexShrink: 0,
              height: 44,
              width: aba === "consultar" ? 44 : undefined,
              padding: aba === "consultar" ? 0 : "0 10px",
              borderRadius: 999,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 600,
              background: modoVivaVoz ? cor.subBlocoVerde : cor.inputBg,
              border: `1px solid ${modoVivaVoz ? cor.subBlocoVerdeBorda : cor.inputBorda}`,
              color: modoVivaVoz ? cor.verdeNumero : cor.textoSecundario,
            }}
          >
            {aba === "consultar" ? (
              <Icone nome="mensagem" tamanho={17} />
            ) : (
              <span>{modoVivaVoz ? "Viva-Voz ON" : "Viva-Voz OFF"}</span>
            )}
          </button>

          {/* Alternar Áudio/Som (TTS) */}
          <button
            type="button"
            onClick={alternarAudio}
            title={audioAtivo ? "Áudio da IA Ativado (Ouvir respostas)" : "Áudio da IA Desativado (Mudo)"}
            style={{ flexShrink: 0, height: 44, width: 44, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, color: audioAtivo ? cor.verdeNumero : cor.textoSecundario }}
          >
            <Icone nome={audioAtivo ? "volumeOn" : "volumeOff"} tamanho={18} />
          </button>

          {/* Campo de Texto (Visível no chat ou expansível) */}
          {aba === "consultar" ? (
            <div className="flex-1 flex items-center gap-1.5 min-w-0">
              <input
                ref={fotoRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => selecionarFoto(e.target.files?.[0])}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fotoRef.current?.click()}
                disabled={pensando}
                title="Anexar foto"
                style={{ flexShrink: 0, height: 44, width: 44, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, color: cor.textoSecundario, opacity: pensando ? 0.4 : 1 }}
              >
                <Icone nome="camera" tamanho={18} />
              </button>
              <input
                type="text"
                value={pergunta}
                onChange={(e) => setPergunta(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    enviarPergunta();
                  }
                }}
                placeholder={fotoPreview ? "Adicione detalhes da foto..." : "Ou digite..."}
                style={{ width: "100%", background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 999, padding: "0 14px", height: 44, fontSize: 13, color: cor.textoPrincipal }}
              />
              <button
                onClick={() => enviarPergunta()}
                disabled={(!pergunta.trim() && !fotoChat) || pensando}
                style={{ flexShrink: 0, height: 44, width: 44, borderRadius: 999, background: "#22C55E", color: "#052E16", fontWeight: 700, opacity: (!pergunta.trim() && !fotoChat) || pensando ? 0.4 : 1, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <Icone nome="seta" tamanho={17} cor="#052E16" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAba("consultar")}
              style={{ flex: 1, height: 44, background: cor.inputBg, border: `1px solid ${cor.inputBorda}`, borderRadius: 999, padding: "0 14px", fontSize: 11.5, color: cor.textoSecundario, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}
            >
              <Icone nome="mensagem" tamanho={15} cor={cor.textoSecundario} /> Ver conversa com a IA
            </button>
          )}
        </div>
        {aba === "consultar" && fotoPreview && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "flex-start", gap: 8, borderRadius: 14, border: `1px solid ${cor.inputBorda}`, background: cor.inputBg, padding: 8 }}>
            <img src={fotoPreview} alt="Prévia da foto" style={{ height: 48, width: 48, borderRadius: 10, objectFit: "cover" }} />
            <textarea
              value={pergunta}
              onChange={(e) => setPergunta(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  enviarPergunta();
                }
              }}
              placeholder="Escreva aqui os detalhes: apto, placa, evento..."
              aria-label="Contexto adicional da foto"
              rows={2}
              style={{ minWidth: 0, flex: 1, background: cor.cartao, border: `1px solid ${cor.cartaoBorda}`, borderRadius: 10, padding: "8px 10px", fontSize: 12, color: cor.textoPrincipal, resize: "none" }}
            />
            <button type="button" onClick={limparFoto} style={{ color: cor.textoSecundario, display: "flex" }} title="Remover foto">
              <Icone nome="x" tamanho={15} />
            </button>
          </div>
        )}
        {aba === "consultar" && fotoErro && <p style={{ marginTop: 4, fontSize: 11, color: "#FCA5A5", textAlign: "center" }}>{fotoErro}</p>}
      </div>
          </div>
        </div>
      </div>
    </div>
  );
}
