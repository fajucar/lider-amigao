import React, { useState, useEffect, useRef, useMemo } from "react";

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

async function salvarPDF(file, base64) {
  const db = await abrirBancoPDF();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(PDF_STORE_NAME, "readwrite");
    transaction.objectStore(PDF_STORE_NAME).put({
      id: "regulamento",
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

async function obterPDF() {
  const db = await abrirBancoPDF();
  const arquivo = await new Promise((resolve, reject) => {
    const request = db.transaction(PDF_STORE_NAME, "readonly").objectStore(PDF_STORE_NAME).get("regulamento");
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

// ---------- Chamada à IA (chat e relatório de turno via Groq) ----------
const GROQ_MODEL = "qwen/qwen3.6-27b";
const CEREBRAS_MODEL = "qwen-3.8-27b";

function registrarChamadaGroq() {
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
      <mark key={i} className="bg-amber-400/30 text-amber-200 rounded px-0.5">
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

function linhaReferenciaRegulamento(referencia) {
  if (!referencia || referencia.artigo === "Não encontrado") {
    return "📖 Referência: Nenhuma regra específica encontrada no regulamento para este caso.";
  }
  return `📖 Referência: ${referencia.artigo} — ${referencia.resumo}`;
}

async function callGroq(system, messages, options = {}) {
  registrarChamadaGroq();
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
    if (!res.ok) throw new Error(data.error?.message || `A API Cerebras retornou erro ${res.status}.`);
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

async function callChatWithFallback(system, messages) {
  try {
    const resposta = await callGroq(system, messages, { json: true });
    console.log("Lider Amigão: resposta do provedor Groq");
    return resposta;
  } catch (erroGroq) {
    console.warn("Lider Amigão: Groq falhou, usando Cerebras", erroGroq);
    try {
      return await callCerebras(system, messages, { json: true });
    } catch (erroCerebras) {
      console.error("Lider Amigão: Groq e Cerebras falharam", erroCerebras);
      const erro = new Error("Não foi possível consultar a IA.");
      erro.status = erroCerebras.name === "AbortError" ? "timeout" : erroCerebras.status;
      throw erro;
    }
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

// ---------- Equipe: postos, horários e tipos de registro ----------
const POSTOS_EQUIPE = [
  { id: "portaria", label: "Portaria", horario: "07h–07h" },
  { id: "triagem", label: "Triagem", horario: "07h–07h" },
  { id: "mensageria", label: "Mensageria", horario: "09h–09h" },
  { id: "ronda", label: "Ronda", horario: "07h–07h" },
];

const TIPOS_REGISTRO = [
  { id: "atraso", label: "Atraso", icon: "⏰", cor: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  { id: "falta", label: "Falta", icon: "🚫", cor: "bg-red-500/20 text-red-300 border-red-500/30" },
  { id: "conversa", label: "Conversa", icon: "💬", cor: "bg-sky-500/20 text-sky-300 border-sky-500/30" },
  { id: "advertencia", label: "Advertência", icon: "📋", cor: "bg-orange-500/20 text-orange-300 border-orange-500/30" },
  { id: "elogio", label: "Elogio", icon: "⭐", cor: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  { id: "observacao", label: "Observação", icon: "📝", cor: "bg-slate-500/20 text-slate-300 border-slate-500/30" },
];

function postoEquipeInfo(id) {
  return POSTOS_EQUIPE.find((p) => p.id === id);
}

function tipoRegistroInfo(id) {
  return TIPOS_REGISTRO.find((t) => t.id === id) || TIPOS_REGISTRO[5];
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

export default function App() {
  const [aba, setAba] = useState("rotinas");
  const [rotinaAberta, setRotinaAberta] = useState(null);
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
  const fileRef = useRef(null);
  const [ocorrencias, setOcorrencias] = useState([]);
  const [carregado, setCarregado] = useState(false);
  const [relogio, setRelogio] = useState(new Date());

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

  // Equipe: Colaboradores e Acompanhamento
  const [colaboradores, setColaboradores] = useState([]);
  const [registrosEquipe, setRegistrosEquipe] = useState([]);
  const [subAbaEquipe, setSubAbaEquipe] = useState("colaboradores");
  const [novoColabNome, setNovoColabNome] = useState("");
  const [novoColabPosto, setNovoColabPosto] = useState("portaria");
  const [novoColabTurno, setNovoColabTurno] = useState("diurno");
  const [colabFiltro, setColabFiltro] = useState("");
  const [novoRegColab, setNovoRegColab] = useState("");
  const [novoRegTipo, setNovoRegTipo] = useState("atraso");
  const [novoRegData, setNovoRegData] = useState(hojeISO());
  const [novoRegMinutos, setNovoRegMinutos] = useState("");
  const [novoRegNota, setNovoRegNota] = useState("");

  // Aquece a lista de vozes do navegador assim que o app monta, pra primeira fala
  // (falarTexto) não precisar esperar o timeout de segurança de obterVozes().
  useEffect(() => {
    obterVozes();
  }, []);

  // Carregar dados
  useEffect(() => {
    (async () => {
      const reg = await store.get("reg_interno", "");
      const ocs = await store.get("ocorrencias", []);
      const perfil = await store.get("perfil", { nome: "", posto: "" });
      const esc = await store.get("escala_atual", {
        portaria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
        triagem: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
        ronda: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
        mensageria: { nome: "", periodo: "diurno", status: "pendente", atraso: "", conversa: "" },
      });
      const hist = await store.get("historico_escala", []);
      const colabs = await store.get("colaboradores", []);
      const regsEquipe = await store.get("registros_equipe", []);
      const audAtivo = await store.get("audio_ativo", true);
      const pdfSalvo = await obterPDF().catch(() => null);

      setRegulamento(reg);
      setRegulamentoTemp(reg);
      if (pdfSalvo) setPdfNome(pdfSalvo.nome);
      setOcorrencias(ocs);
      setNomeLider(perfil.nome || "");
      setPosto(perfil.posto || "");
      setEscala(esc);
      setHistoricoEscalas(hist);
      setColaboradores(colabs);
      setRegistrosEquipe(regsEquipe);
      setAudioAtivo(audAtivo);
      setCarregado(true);
    })();
  }, []);

  // Relógio
  useEffect(() => {
    const t = setInterval(() => setRelogio(new Date()), 1000 * 20);
    return () => clearInterval(t);
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
      setPdfErro(e instanceof Error ? e.message : "Falhou ao processar o PDF. Tente de novo ou cole o texto.");
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
      // Não embutimos mais o regulamento inteiro no prompt: com a extração literal completa
      // ele pode passar de 10 mil tokens e estourava o limite de tokens por minuto do Groq em
      // toda mensagem. Buscamos localmente só o trecho relevante pra esta mensagem (mesma lógica
      // usada para citar o regulamento nas ocorrências) e mandamos só isso pra IA.
      const trechoRelevanteChat = regulamento ? encontrarTrechoRegulamento(regulamento, q) : null;
      // Nome do operador (quem sempre faz a ronda), vindo do perfil cadastrado na aba Turno.
      // Sem isso, o assistente confunde "quem fala com você agora" com "quem faz a ronda" —
      // ex: se o operador diz "estou com o Fernando", o assistente não pode dizer que é o
      // Fernando quem está fazendo a ronda.
      const nomeOperador = nomeLider.trim() || "o líder de portaria";
      const system =
        "Você é o assistente inteligente de portaria e ronda de um condomínio (Lider Amigão).\n" +
        `O operador fixo do app é ${nomeOperador}: é sempre ${nomeOperador} quem faz a ronda e opera o aplicativo, não importa quem esteja perto dele ou falando com você no momento.\n` +
        `Quem fala com você (o interlocutor) pode variar durante o plantão: às vezes é o próprio ${nomeOperador}, às vezes é outra pessoa que está com ele (síndico, gerente, morador, prestador de serviço).\n` +
        "DISTINÇÃO DE PAPÉIS (importante):\n" +
        `- Se a mensagem não indicar outra pessoa presente, trate o interlocutor como ${nomeOperador} normalmente, na 2ª pessoa ("você").\n` +
        `- Se a mensagem indicar que ${nomeOperador} está acompanhado ou que outra pessoa está falando (ex: "estou com o Fernando", "aqui é o síndico", "o morador tal perguntou..."), NUNCA chame essa outra pessoa de "você" fazendo a ronda. Refira-se a quem faz a ronda sempre na 3ª pessoa, pelo nome, usando as contrações naturais do português ("do ${nomeOperador}", "pelo ${nomeOperador}", não "de ${nomeOperador}"), e pode cumprimentar/se dirigir à outra pessoa pelo nome dela.\n\n` +
        "SUAS REGRAS DE RESPOSTA:\n" +
        "1. OCORRÊNCIAS: Se o usuário citar qualquer fato, ocorrência, lâmpada queimada, barulho, infração, manutenção, encomenda, problemas de acesso ou qualquer nota para registrar/anotar, VOCÊ DEVE REGISTRAR A OCORRÊNCIA.\n" +
        "2. REGULAMENTO E DÚVIDAS: Se for pergunta de regras ou rotina, responda de forma direta e curta.\n" +
        "3. FORMATO OBRIGATÓRIO EM JSON: Responda EXCLUSIVAMENTE em formato JSON (sem markdown nem textos fora do JSON):\n" +
        "Não use aspas duplas dentro dos valores das propriedades; se precisar destacar uma expressão, use aspas simples. Não mostre raciocínio.\n" +
        "{\n" +
        '  "respostaVoz": "Resposta curta e clara em português (1 a 2 frases) para ser lida em viva-voz no celular",\n' +
        '  "ocorrencia": {\n' +
        '    "detectada": true ou false,\n' +
        '    "texto": "Resumo limpo e profissional da ocorrência para salvar no sistema, preservando os detalhes concretos citados (o que aconteceu, onde, com o quê)",\n' +
        '    "categoria": "acesso" ou "encomenda" ou "manutencao" ou "seguranca" ou "outros"\n' +
        "  }\n" +
        "}\n\n" +
        "TRECHO DO REGULAMENTO INTERNO RELACIONADO A ESTA MENSAGEM (pode não existir; não invente regra fora daqui):\n" +
        (trechoRelevanteChat || (regulamento ? "(Nenhum trecho específico do regulamento bate com esta mensagem. Use boas práticas de portaria.)" : "(Nenhum regulamento cadastrado. Use boas práticas de portaria.)"));

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
      const mensagem = e?.status === 429
        ? "A IA atingiu o limite temporário de requisições. Aguarde um pouco e tente novamente."
        : "Não consegui consultar a IA agora. Tente novamente.";
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

  // ---------- Equipe: Colaboradores ----------
  const adicionarColaborador = async () => {
    const nome = novoColabNome.trim();
    if (!nome) return;
    const novo = { id: Date.now(), nome, posto: novoColabPosto, turno: novoColabTurno };
    const lista = [...colaboradores, novo];
    setColaboradores(lista);
    await store.set("colaboradores", lista);
    setNovoColabNome("");
  };

  const removerColaborador = async (id) => {
    const lista = colaboradores.filter((c) => c.id !== id);
    setColaboradores(lista);
    await store.set("colaboradores", lista);
  };

  // ---------- Equipe: Acompanhamento ----------
  const adicionarRegistroEquipe = async () => {
    if (!novoRegColab) return;
    const novo = {
      id: Date.now(),
      colaboradorId: novoRegColab,
      tipo: novoRegTipo,
      data: novoRegData || hojeISO(),
      minutos: novoRegTipo === "atraso" ? novoRegMinutos : "",
      nota: novoRegNota.trim(),
      ts: new Date().toISOString(),
    };
    const lista = [novo, ...registrosEquipe];
    setRegistrosEquipe(lista);
    await store.set("registros_equipe", lista);
    setNovoRegNota("");
    setNovoRegMinutos("");
  };

  const removerRegistroEquipe = async (id) => {
    const lista = registrosEquipe.filter((r) => r.id !== id);
    setRegistrosEquipe(lista);
    await store.set("registros_equipe", lista);
  };

  const registrosEquipeFiltrados = colabFiltro
    ? registrosEquipe.filter((r) => String(r.colaboradorId) === String(colabFiltro))
    : registrosEquipe;

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
      const resp = await callGroq(system, [{ role: "user", content: user }]);
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


  if (!carregado) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-amber-400 text-sm tracking-wide animate-pulse">Abrindo a guarita...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex justify-center">
    <div className="w-full max-w-md min-h-screen bg-slate-950 text-slate-100 flex flex-col relative sm:border-x sm:border-slate-800" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {/* Cabeçalho */}
      <header className="px-4 pt-5 pb-4 border-b border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-amber-400/15 border border-amber-400/30 flex items-center justify-center">
              <span className="text-amber-400 text-lg">🛡️</span>
            </div>
            <div>
              <h1 className="text-[15px] font-semibold leading-tight tracking-tight">Lider Amigão</h1>
              <p className="text-[11px] text-slate-400 leading-tight">HV Serv · Líder de turno · Groq: {chamadasGroq}</p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-amber-400 font-semibold text-lg leading-none tabular-nums">
              {relogio.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              {relogio.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
            </div>
          </div>
        </div>
      </header>

      {/* Conteúdo */}
      <main className="flex-1 overflow-y-auto pb-24">
        {aba === "consultar" && (
          <div className="flex flex-col h-full">
            <div className="px-4 py-3 pb-8 space-y-3">
              {chat.length === 0 && (
                <div className="mt-6 text-center px-4">
                  <div className="text-4xl mb-3">💬</div>
                  <p className="text-sm text-slate-300 font-medium mb-1">Pergunte durante o turno</p>
                  <p className="text-xs text-slate-500 leading-relaxed mb-4">
                    "Pode entrar entregador de madrugada?" · "Qual o horário de silêncio?" · "Visitante sem morador autorizar, o que faço?"
                  </p>
                  {!regulamento && (
                    <div className="text-[11px] text-amber-400/90 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
                      Cadastre o regulamento na aba <b>Regras</b> para respostas precisas.
                    </div>
                  )}
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap " +
                      (m.role === "user"
                        ? "bg-amber-400 text-slate-900 rounded-br-sm font-medium"
                        : "bg-slate-800 text-slate-100 rounded-bl-sm border border-slate-700")
                    }
                  >
                    {m.imagem && <img src={m.imagem} alt="Foto anexada à mensagem" className="max-h-48 max-w-full rounded-lg mb-2 object-contain" />}
                    {m.content}
                    {m.role === "assistant" && (
                      <button
                        onClick={() => registrarDoChat(m.content)}
                        className="mt-2 block text-[11px] text-amber-400 hover:text-amber-300"
                      >
                        + registrar como ocorrência
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {pensando && (
                <div className="flex justify-start">
                  <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-bl-sm px-4 py-3">
                    <span className="inline-flex gap-1">
                      <span className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatFim} />
            </div>
          </div>
        )}

        {aba === "ocorrencias" && (
          <div className="px-4 py-4">
            <div className="mb-4">
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">{fmtDataLonga(hojeISO())}</p>
              <h2 className="text-base font-semibold">Ocorrências do turno</h2>
            </div>

            {/* Nova ocorrência */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 mb-4">
              <textarea
                value={novaOc}
                onChange={(e) => setNovaOc(e.target.value)}
                placeholder="Descreva a ocorrência..."
                rows={2}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13.5px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50 resize-none"
              />
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {CATEGORIAS.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setNovaCat(c.id)}
                    className={
                      "text-[11px] px-2.5 py-1 rounded-full border transition " +
                      (novaCat === c.id ? c.cor : "bg-transparent text-slate-500 border-slate-700")
                    }
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => adicionarOcorrencia()}
                disabled={!novaOc.trim()}
                className="w-full mt-3 bg-amber-400 text-slate-900 font-semibold text-sm rounded-lg py-2.5 disabled:opacity-40 active:scale-[0.98] transition"
              >
                Registrar com horário atual
              </button>
            </div>

            {/* Lista */}
            {ocorrenciasHoje.length === 0 ? (
              <div className="text-center py-10 text-slate-600 text-sm">Nenhuma ocorrência registrada hoje.</div>
            ) : (
              <div className="space-y-2">
                {ocorrenciasHoje.map((o) => {
                  const c = catInfo(o.categoria);
                  return (
                    <div key={o.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex gap-3">
                      <div className="text-amber-400 font-semibold text-sm tabular-nums pt-0.5 w-12 shrink-0">{fmtHora(o.ts)}</div>
                      <div className="flex-1 min-w-0">
                        <span className={"text-[10px] px-2 py-0.5 rounded-full border " + c.cor}>{c.label}</span>
                        <p className="text-[13.5px] text-slate-200 mt-1.5 leading-snug break-words">{o.texto}</p>
                        {o.imagem && <img src={o.imagem} alt="Foto da ocorrência" className="mt-2 max-h-40 max-w-full rounded-lg object-contain" />}
                        {o.regulamentoRef && (
                          <div className="mt-2 border-l-2 border-amber-400/50 pl-2 text-[11px] leading-snug">
                            <p className="text-amber-300 font-medium">📖 {o.regulamentoRef.artigo}</p>
                            <p className="text-slate-400 mt-0.5">{o.regulamentoRef.resumo}</p>
                          </div>
                        )}
                      </div>
                      <button onClick={() => removerOcorrencia(o.id)} className="text-slate-600 hover:text-red-400 text-lg leading-none shrink-0">
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {aba === "turno" && (
          <div className="px-4 py-4">
            <div className="mb-4">
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Fim de turno</p>
              <h2 className="text-base font-semibold">Relatório de turno</h2>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Gera o relatório com as ocorrências do dia, pronto pra registrar ou enviar por e-mail.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 mb-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={nomeLider}
                  onChange={(e) => setNomeLider(e.target.value)}
                  placeholder="Seu nome"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50"
                />
                <input
                  value={posto}
                  onChange={(e) => setPosto(e.target.value)}
                  placeholder="Posto / condomínio"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50"
                />
              </div>
              <textarea
                value={obsTurno}
                onChange={(e) => setObsTurno(e.target.value)}
                placeholder="Observações gerais do turno (opcional)..."
                rows={2}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50 resize-none"
              />
              <div className="text-[11px] text-slate-500">
                {ocorrenciasHoje.length} ocorrência{ocorrenciasHoje.length !== 1 ? "s" : ""} de hoje será{ocorrenciasHoje.length !== 1 ? "ão" : ""} incluída{ocorrenciasHoje.length !== 1 ? "s" : ""}.
              </div>
              <button
                onClick={gerarEmail}
                disabled={gerandoEmail}
                className="w-full bg-amber-400 text-slate-900 font-semibold text-sm rounded-lg py-2.5 disabled:opacity-50 active:scale-[0.98] transition"
              >
                {gerandoEmail ? "Montando o relatório..." : "Gerar relatório de turno"}
              </button>
            </div>

            {emailGerado && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] uppercase tracking-wider text-slate-500">Relatório pronto</span>
                  <button onClick={copiarEmail} className="text-[12px] text-amber-400 hover:text-amber-300 font-medium">
                    {copiado ? "Copiado ✓" : "Copiar"}
                  </button>
                </div>
                <textarea
                  value={emailGerado}
                  onChange={(e) => setEmailGerado(e.target.value)}
                  aria-label="Mensagem pronta para WhatsApp"
                  rows={12}
                  className="w-full text-[13px] text-slate-200 whitespace-pre-wrap leading-relaxed bg-slate-950 rounded-lg p-3 border border-slate-800 focus:outline-none focus:border-amber-400/50 resize-y"
                />
                <button
                  onClick={enviarWhatsApp}
                  disabled={!emailGerado.trim()}
                  className="w-full mt-3 bg-emerald-500 text-slate-950 font-semibold text-sm rounded-lg py-2.5 disabled:opacity-40 active:scale-[0.98] transition"
                >
                  Enviar por WhatsApp
                </button>
                <button onClick={fecharTurno} className="w-full mt-3 border border-slate-700 text-slate-400 text-[13px] rounded-lg py-2 hover:bg-slate-800 transition">
                  Limpar turno (fechar)
                </button>
              </div>
            )}
          </div>
        )}

        {aba === "regras" && (
          <div className="px-4 py-4">
            <div className="mb-4">
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Base de consulta</p>
              <h2 className="text-base font-semibold">Regulamento interno</h2>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Suba o PDF do regulamento do condomínio. A IA lê o arquivo e extrai as normas. O assistente usa isso para responder o que pode ou não pode.
              </p>
            </div>

            {/* Upload de PDF */}
            <div className="mb-4">
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
                className="w-full border-2 border-dashed border-amber-400/40 bg-amber-400/5 rounded-xl py-6 flex flex-col items-center gap-2 active:scale-[0.99] transition disabled:opacity-60"
              >
                <span className="text-3xl">{lendoPDF ? "⏳" : "📄"}</span>
                <span className="text-sm font-medium text-amber-300">
                  {lendoPDF ? "Lendo o regulamento..." : "Subir PDF do regulamento"}
                </span>
                {pdfNome && !lendoPDF && <span className="text-[11px] text-slate-400">{pdfNome}</span>}
                {!pdfNome && !lendoPDF && <span className="text-[11px] text-slate-500">Toque para escolher o arquivo</span>}
              </button>
              {pdfErro && <p className="text-[11px] text-red-400 mt-2 text-center">{pdfErro}</p>}
            </div>

            <div className="flex items-center gap-3 mb-3">
              <div className="h-px bg-slate-800 flex-1" />
              <span className="text-[10px] uppercase tracking-wider text-slate-600">ou cole o texto</span>
              <div className="h-px bg-slate-800 flex-1" />
            </div>

            <textarea
              value={regulamentoTemp}
              onChange={(e) => setRegulamentoTemp(e.target.value)}
              placeholder="Cole o regulamento interno aqui, ou edite o que a IA extraiu do PDF."
              rows={10}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50 resize-none leading-relaxed"
            />
            <button
              onClick={salvarRegulamento}
              className="w-full mt-3 bg-amber-400 text-slate-900 font-semibold text-sm rounded-lg py-2.5 active:scale-[0.98] transition"
            >
              {regSalvo ? "Salvo ✓" : "Salvar regulamento"}
            </button>
            {regulamento && (
              <p className="text-[11px] text-emerald-400/80 mt-2 text-center">
                Regulamento carregado ({regulamento.length} caracteres).
              </p>
            )}

            {regulamento && (
              <div className="mt-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-px bg-slate-800 flex-1" />
                  <span className="text-[10px] uppercase tracking-wider text-slate-600">buscar no regulamento</span>
                  <div className="h-px bg-slate-800 flex-1" />
                </div>
                <input
                  type="search"
                  value={buscaRegulamento}
                  onChange={(e) => setBuscaRegulamento(e.target.value)}
                  placeholder="Ex.: estacionar, vaga, silêncio..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50"
                />
                {buscaRegulamento.trim() && (
                  <div className="mt-3 space-y-2">
                    {resultadosBuscaRegulamento.length === 0 ? (
                      <p className="text-[12px] text-slate-500 text-center py-3">
                        Nenhum trecho encontrado para "{buscaRegulamento.trim()}". Tente outra palavra.
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] text-slate-500">
                          🔎 {resultadosBuscaRegulamento.length} trecho(s) encontrado(s):
                        </p>
                        {resultadosBuscaRegulamento.slice(0, 15).map((r) => (
                          <div key={r.indice} className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                            <p className="text-[13px] text-slate-200 leading-relaxed">
                              {destacarTermos(r.linha, r.termosEncontrados)}
                            </p>
                          </div>
                        ))}
                        {resultadosBuscaRegulamento.length > 15 && (
                          <p className="text-[11px] text-slate-500 text-center">
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
          <div className="px-4 py-4">
            <div className="mb-4">
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Nativ Tatuapé Garden</p>
              <h2 className="text-base font-semibold">Rotinas do condomínio</h2>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Procedimentos da ronda diurna (07h–19h). Toque num bloco para abrir.
              </p>
            </div>

            {/* Horários-chave — sempre visível */}
            <div className="bg-amber-400/5 border border-amber-400/20 rounded-xl p-3 mb-4">
              <p className="text-[10px] uppercase tracking-wider text-amber-300/80 font-semibold mb-2">⏰ Horários-chave</p>
              <div className="space-y-1.5">
                {ROTINAS_HORARIOS.map((h, i) => (
                  <div key={i} className="flex gap-2.5 text-[13px] leading-snug">
                    <span className="text-amber-300 font-semibold shrink-0 w-16">{h.hora}</span>
                    <span className="text-slate-300">{h.texto}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Blocos de procedimentos (accordion) */}
            <div className="space-y-2">
              {ROTINAS.map((sec) => {
                const aberto = rotinaAberta === sec.id;
                return (
                  <div key={sec.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setRotinaAberta(aberto ? null : sec.id)}
                      className="w-full flex items-center gap-3 px-3.5 py-3 active:bg-slate-800/50 transition"
                    >
                      <span className="text-xl leading-none">{sec.icon}</span>
                      <span className="text-sm font-semibold text-left flex-1">{sec.titulo}</span>
                      <span className={"text-slate-500 text-xs transition-transform " + (aberto ? "rotate-180" : "")}>▼</span>
                    </button>
                    {aberto && (
                      <div className="px-3.5 pb-3.5 pt-0.5 space-y-3">
                        {sec.grupos.map((g, gi) => (
                          <div key={gi}>
                            {g.destaque && (
                              <div className="bg-red-500/15 border border-red-500/30 rounded-lg px-3 py-2 text-[13px] font-semibold text-red-300">
                                🔑 {g.destaque}
                              </div>
                            )}
                            {g.sub && (
                              <p className="text-[11px] uppercase tracking-wider text-amber-300/80 font-semibold mb-1.5">
                                {g.sub}
                              </p>
                            )}
                            {g.itens.length > 0 && (
                              <ul className="space-y-1.5">
                                {g.itens.map((it, ii) => (
                                  <li key={ii} className="flex gap-2 text-[13px] text-slate-300 leading-snug">
                                    <span className="text-amber-400/60 shrink-0">•</span>
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
              })}
            </div>

            <p className="text-[10px] text-slate-600 text-center mt-4 leading-relaxed">
              Irregularidade? Foto + iButton → grupo Vigia (WhatsApp).
            </p>
          </div>
        )}

        {aba === "equipe" && (
          <div className="px-4 py-4">
            <div className="mb-4">
              <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Plantões e rendições</p>
              <h2 className="text-base font-semibold">Equipe</h2>
            </div>

            {/* Postos e horários — sempre visível */}
            <div className="bg-amber-400/5 border border-amber-400/20 rounded-xl p-3 mb-4">
              <p className="text-[10px] uppercase tracking-wider text-amber-300/80 font-semibold mb-2">⏰ Postos e horários</p>
              <div className="grid grid-cols-2 gap-2">
                {POSTOS_EQUIPE.map((p) => (
                  <div key={p.id} className="text-[12.5px]">
                    <span className="text-slate-300 font-medium">{p.label}</span>
                    <span className="text-amber-300 ml-1.5 tabular-nums">{p.horario}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Sub-abas */}
            <div className="flex gap-1.5 mb-4 bg-slate-900 border border-slate-800 rounded-xl p-1">
              <button
                onClick={() => setSubAbaEquipe("colaboradores")}
                className={
                  "flex-1 text-[12.5px] font-medium py-2 rounded-lg transition " +
                  (subAbaEquipe === "colaboradores" ? "bg-amber-400 text-slate-900" : "text-slate-400")
                }
              >
                👥 Colaboradores
              </button>
              <button
                onClick={() => setSubAbaEquipe("acompanhamento")}
                className={
                  "flex-1 text-[12.5px] font-medium py-2 rounded-lg transition " +
                  (subAbaEquipe === "acompanhamento" ? "bg-amber-400 text-slate-900" : "text-slate-400")
                }
              >
                📋 Acompanhamento
              </button>
            </div>

            {subAbaEquipe === "colaboradores" && (
              <div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 mb-4 space-y-2.5">
                  <input
                    value={novoColabNome}
                    onChange={(e) => setNovoColabNome(e.target.value)}
                    placeholder="Nome do colaborador"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={novoColabPosto}
                      onChange={(e) => setNovoColabPosto(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 focus:outline-none focus:border-amber-400/50"
                    >
                      {POSTOS_EQUIPE.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                    <select
                      value={novoColabTurno}
                      onChange={(e) => setNovoColabTurno(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 focus:outline-none focus:border-amber-400/50"
                    >
                      <option value="diurno">Diurno</option>
                      <option value="noturno">Noturno</option>
                    </select>
                  </div>
                  <button
                    onClick={adicionarColaborador}
                    disabled={!novoColabNome.trim()}
                    className="w-full bg-amber-400 text-slate-900 font-semibold text-sm rounded-lg py-2.5 disabled:opacity-40 active:scale-[0.98] transition"
                  >
                    Adicionar colaborador
                  </button>
                </div>

                {colaboradores.length === 0 ? (
                  <div className="text-center py-10 text-slate-600 text-sm">Nenhum colaborador cadastrado.</div>
                ) : (
                  <div className="space-y-2">
                    {colaboradores.map((c) => {
                      const p = postoEquipeInfo(c.posto);
                      const nAtrasos = registrosEquipe.filter(
                        (r) => String(r.colaboradorId) === String(c.id) && r.tipo === "atraso"
                      ).length;
                      return (
                        <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-[13.5px] font-medium text-slate-100 truncate">{c.nome}</p>
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              <span className="text-[10px] px-2 py-0.5 rounded-full border bg-slate-800 text-slate-300 border-slate-700">
                                {p ? p.label : c.posto}
                              </span>
                              <span className="text-[10px] text-slate-500">{c.turno === "diurno" ? "Diurno" : "Noturno"}</span>
                              {nAtrasos > 0 && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/20 text-amber-300 border-amber-500/30">
                                  ⏰ {nAtrasos}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => removerColaborador(c.id)}
                            className="text-slate-600 hover:text-red-400 text-lg leading-none shrink-0"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {subAbaEquipe === "acompanhamento" && (
              <div>
                {colaboradores.length === 0 ? (
                  <div className="text-center py-10 text-slate-600 text-sm px-4">
                    Cadastre colaboradores na aba <b>Colaboradores</b> antes de registrar acompanhamento.
                  </div>
                ) : (
                  <>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 mb-4 space-y-2.5">
                      <select
                        value={novoRegColab}
                        onChange={(e) => setNovoRegColab(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 focus:outline-none focus:border-amber-400/50"
                      >
                        <option value="">Selecione o colaborador</option>
                        {colaboradores.map((c) => (
                          <option key={c.id} value={c.id}>{c.nome}</option>
                        ))}
                      </select>

                      <div className="flex flex-wrap gap-1.5">
                        {TIPOS_REGISTRO.map((t) => (
                          <button
                            key={t.id}
                            onClick={() => setNovoRegTipo(t.id)}
                            className={
                              "text-[11px] px-2.5 py-1 rounded-full border transition " +
                              (novoRegTipo === t.id ? t.cor : "bg-transparent text-slate-500 border-slate-700")
                            }
                          >
                            {t.icon} {t.label}
                          </button>
                        ))}
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="date"
                          value={novoRegData}
                          onChange={(e) => setNovoRegData(e.target.value)}
                          className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 focus:outline-none focus:border-amber-400/50"
                        />
                        {novoRegTipo === "atraso" && (
                          <input
                            type="number"
                            min="0"
                            value={novoRegMinutos}
                            onChange={(e) => setNovoRegMinutos(e.target.value)}
                            placeholder="Minutos"
                            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50"
                          />
                        )}
                      </div>

                      <textarea
                        value={novoRegNota}
                        onChange={(e) => setNovoRegNota(e.target.value)}
                        placeholder="O que aconteceu ou o que foi conversado..."
                        rows={2}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50 resize-none"
                      />

                      <button
                        onClick={adicionarRegistroEquipe}
                        disabled={!novoRegColab}
                        className="w-full bg-amber-400 text-slate-900 font-semibold text-sm rounded-lg py-2.5 disabled:opacity-40 active:scale-[0.98] transition"
                      >
                        Registrar
                      </button>
                    </div>

                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-[11px] text-slate-500 shrink-0">Filtrar:</span>
                      <select
                        value={colabFiltro}
                        onChange={(e) => setColabFiltro(e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-[12.5px] text-slate-100 focus:outline-none focus:border-amber-400/50"
                      >
                        <option value="">Todos os colaboradores</option>
                        {colaboradores.map((c) => (
                          <option key={c.id} value={c.id}>{c.nome}</option>
                        ))}
                      </select>
                    </div>

                    {registrosEquipeFiltrados.length === 0 ? (
                      <div className="text-center py-10 text-slate-600 text-sm">Nenhum registro ainda.</div>
                    ) : (
                      <div className="space-y-2">
                        {registrosEquipeFiltrados.map((r) => {
                          const t = tipoRegistroInfo(r.tipo);
                          const colab = colaboradores.find((c) => String(c.id) === String(r.colaboradorId));
                          return (
                            <div key={r.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className={"text-[10px] px-2 py-0.5 rounded-full border " + t.cor}>
                                    {t.icon} {t.label}
                                  </span>
                                  <span className="text-[11px] text-slate-400 font-medium">
                                    {colab ? colab.nome : "Colaborador removido"}
                                  </span>
                                  {r.tipo === "atraso" && r.minutos && (
                                    <span className="text-[11px] text-amber-300">{r.minutos} min</span>
                                  )}
                                </div>
                                <p className="text-[11px] text-slate-500 mt-1">{fmtDataLonga(r.data)}</p>
                                {r.nota && <p className="text-[13px] text-slate-200 mt-1.5 leading-snug break-words">{r.nota}</p>}
                              </div>
                              <button
                                onClick={() => removerRegistroEquipe(r.id)}
                                className="text-slate-600 hover:text-red-400 text-lg leading-none shrink-0"
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Toast de Ocorrência Registrada por Voz */}
      {toastOcorrencia && (
        <div className="fixed top-16 inset-x-4 max-w-sm mx-auto z-50 bg-slate-900/95 border border-emerald-500/50 backdrop-blur rounded-2xl p-3.5 shadow-2xl flex items-start gap-3 animate-fade-in">
          <span className="text-2xl shrink-0">📌</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-bold text-emerald-400">
                {toastOcorrencia.pendente ? "Confira antes de registrar" : "Ocorrência Registrada!"}
              </span>
              <span className={"text-[10px] px-2 py-0.5 rounded-full border " + catInfo(toastOcorrencia.categoria).cor}>
                {catInfo(toastOcorrencia.categoria).label}
              </span>
            </div>
            <textarea
              value={toastOcorrencia.texto}
              onChange={(e) => setToastOcorrencia({ ...toastOcorrencia, texto: e.target.value })}
              aria-label="Descrição editável da ocorrência"
              rows={3}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[12.5px] text-slate-100 font-medium mt-1 leading-snug focus:outline-none focus:border-amber-400/50 resize-y"
            />
            {toastOcorrencia.regulamentoRef && (
              <div className="mt-2 border-l-2 border-amber-400/50 pl-2 text-[11px] leading-snug">
                <p className="text-amber-300 font-medium">📖 {toastOcorrencia.regulamentoRef.artigo}</p>
                <p className="text-slate-400 mt-0.5">{toastOcorrencia.regulamentoRef.resumo}</p>
              </div>
            )}
            {toastOcorrencia.pendente && (
              <button
                onClick={confirmarOcorrencia}
                className="w-full mt-2 bg-amber-400 text-slate-900 font-semibold text-[11px] rounded-lg py-1.5"
              >
                Confirmar e salvar ocorrência
              </button>
            )}
          </div>
          <button onClick={() => setToastOcorrencia(null)} className="text-slate-500 hover:text-white text-base">×</button>
        </div>
      )}

      {/* Barra Flutuante de Voz (Modo Ronda Viva-Voz) */}
      <div className="fixed bottom-14 inset-x-0 mx-auto max-w-md sm:border-x sm:border-slate-800 z-20 bg-slate-900/95 backdrop-blur border-t border-slate-800 px-3 py-2">
        {erroVoz && (
          <p className="text-[11px] text-red-400 mb-1.5 text-center leading-snug">{erroVoz}</p>
        )}

        {/* Indicador de Status da Voz */}
        {(statusVoz || gravando || falando || pensando) && (
          <div className="flex items-center justify-between bg-slate-950/80 border border-slate-800 rounded-lg px-2.5 py-1 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={"h-2 w-2 rounded-full " + (gravando ? "bg-red-500 animate-ping" : falando ? "bg-emerald-400 animate-pulse" : "bg-amber-400 animate-pulse")} />
              <span className="text-[11.5px] text-slate-300 font-medium truncate">
                {statusVoz || (gravando ? "Ouvindo sua fala..." : falando ? "Assistente falando..." : "IA pensando...")}
              </span>
            </div>
            {pergunta && <span className="text-[10px] text-slate-500 truncate max-w-[120px]">"{pergunta}"</span>}
          </div>
        )}

        <div className="flex items-center gap-2">
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
            className={
              "shrink-0 h-[44px] px-3 rounded-xl border flex items-center gap-2 transition select-none font-semibold text-xs " +
              (gravando
                ? "bg-red-500/20 border-red-500/50 text-red-400 animate-pulse scale-105 shadow-lg shadow-red-500/10"
                : falando
                ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                : "bg-amber-400/10 border-amber-400/40 text-amber-300 active:scale-95")
            }
          >
            <span className="text-base">{gravando ? "🔴" : falando ? "🔊" : "🎤"}</span>
            <span>{gravando ? "Ouvindo" : falando ? "Falando" : "Falar por Voz"}</span>
          </button>

          {/* Alternar Modo Viva-Voz Contínuo */}
          <button
            type="button"
            onClick={() => setModoVivaVoz(!modoVivaVoz)}
            className={
              "shrink-0 h-[44px] px-2.5 rounded-xl border flex items-center gap-1.5 text-[11px] font-medium transition " +
              (modoVivaVoz
                ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-sm"
                : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200")
            }
            title={modoVivaVoz ? "Modo Viva-Voz ATIVADO (Ouve e responde sem parar)" : "Ativar Modo Viva-Voz"}
          >
            <span>{modoVivaVoz ? "🔄" : "🖐️"}</span>
            <span>{modoVivaVoz ? "Viva-Voz ON" : "Viva-Voz OFF"}</span>
          </button>

          {/* Alternar Áudio/Som (TTS) */}
          <button
            type="button"
            onClick={alternarAudio}
            className={
              "shrink-0 h-[44px] w-[44px] rounded-xl border flex items-center justify-center text-sm transition " +
              (audioAtivo
                ? "bg-slate-950 border-slate-800 text-emerald-400"
                : "bg-slate-950 border-slate-800 text-slate-600 line-through")
            }
            title={audioAtivo ? "Áudio da IA Ativado (Ouvir respostas)" : "Áudio da IA Desativado (Mudo)"}
          >
            {audioAtivo ? "🔊" : "🔇"}
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
                className="shrink-0 h-[44px] w-[44px] rounded-xl border border-slate-800 bg-slate-950 text-amber-300 text-lg disabled:opacity-40"
              >
                📷
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
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 h-[44px] text-[13px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400/50"
              />
              <button
                onClick={() => enviarPergunta()}
                disabled={(!pergunta.trim() && !fotoChat) || pensando}
                className="shrink-0 h-[44px] w-[44px] rounded-xl bg-amber-400 text-slate-900 font-bold disabled:opacity-40 active:scale-95 transition flex items-center justify-center text-sm"
              >
                ➤
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAba("consultar")}
              className="flex-1 h-[44px] bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl px-3 text-[11.5px] text-slate-400 truncate text-left"
            >
              💬 Ver conversa com a IA
            </button>
          )}
        </div>
        {aba === "consultar" && fotoPreview && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-slate-950 p-2">
            <img src={fotoPreview} alt="Prévia da foto" className="h-12 w-12 rounded object-cover" />
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
              className="min-w-0 flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-2 text-[12px] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-400/50 resize-none"
            />
            <button type="button" onClick={limparFoto} className="text-slate-500 hover:text-white" title="Remover foto">×</button>
          </div>
        )}
        {aba === "consultar" && fotoErro && <p className="mt-1 text-[11px] text-red-400 text-center">{fotoErro}</p>}
      </div>

      {/* Navegação inferior */}
      <nav className="fixed bottom-0 inset-x-0 mx-auto max-w-md sm:border-x sm:border-slate-800 bg-slate-900/95 backdrop-blur border-t border-slate-800 grid grid-cols-6 z-10">
        {[
          { id: "rotinas", label: "Rotinas", icon: "🏨" },
          { id: "consultar", label: "Consultar", icon: "💬" },
          { id: "ocorrencias", label: "Ocorrências", icon: "📋", badge: ocorrenciasHoje.length },
          { id: "equipe", label: "Equipe", icon: "👥" },
          { id: "turno", label: "Relatório", icon: "📝" },
          { id: "regras", label: "Regras", icon: "📖" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setAba(t.id)}
            className={"flex flex-col items-center py-2.5 gap-0.5 relative " + (aba === t.id ? "text-amber-400" : "text-slate-500")}
          >
            <span className="text-base leading-none">{t.icon}</span>
            <span className="text-[9px] font-medium leading-tight">{t.label}</span>
            {t.badge > 0 && (
              <span className="absolute top-1.5 right-1/2 translate-x-4 bg-amber-400 text-slate-900 text-[9px] font-bold rounded-full h-4 min-w-4 px-1 flex items-center justify-center">
                {t.badge}
              </span>
            )}
            {aba === t.id && <span className="absolute top-0 h-0.5 w-8 bg-amber-400 rounded-full" />}
          </button>
        ))}
      </nav>
    </div>
    </div>
  );
}
