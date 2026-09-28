// Busca local (sem IA) nas regras do condomínio (RI + Convenção), extraídas uma única vez
// dos PDFs e guardadas em src/data/regras.json. Objetivo: achar os 3-6 artigos mais
// relevantes pra pergunta do usuário, pra mandar pro Groq só esses trechos (nunca o
// documento inteiro) — economiza token e evita estourar o limite por minuto da API.

// Sem acento: são comparadas com o texto já normalizado (normalizarTexto tira os acentos).
const PALAVRAS_IGNORADAS = new Set([
  "para", "como", "qual", "quais", "quando", "onde", "pode", "podem", "posso", "deve", "devem",
  "isso", "essa", "esse", "este", "esta", "com", "sem", "uma", "uns", "umas", "que", "dos", "das",
  "nos", "nas", "por", "mais", "sobre", "durante", "tem", "ter", "vai", "foi", "sao", "estao",
  "ser", "num", "numa", "aqui", "ali", "voce", "voces", "ele", "ela", "eles", "elas", "meu",
  "minha", "seu", "sua", "gente", "entao", "tambem", "fala", "falar", "diz", "dizer", "sabe",
  "saber", "queria", "quero", "preciso", "tudo", "algum", "alguma", "regra", "regras", "amigona",
  "lider", "fale", "ajuda", "ajudar", "hoje", "agora", "favor", "obrigado", "obrigada", "ola", "oi",
]);

// Sinônimos comuns no dia a dia da portaria que não aparecem com essas palavras exatas no
// texto legal do RI/Convenção. Cada busca expande os termos digitados com os aliases abaixo.
const ALIASES = {
  barulho: ["silencio", "ruido", "sossego"],
  carro: ["veiculo", "estacionamento", "vaga", "garagem"],
  estacionado: ["estacionamento", "vaga", "garagem"],
  estacionar: ["estacionamento", "vaga", "garagem"],
  vaga: ["estacionamento", "veiculo", "garagem", "visitante", "visitantes"],
  visitante: ["visita", "visitantes", "vaga", "garagem"],
  visitantes: ["visitante", "visita", "vaga", "garagem"],
  morador: ["condômino", "condomino", "unidade", "proprietario", "locatario", "inquilino"],
  condômino: ["morador", "unidade", "proprietario", "locatario"],
  condomino: ["morador", "unidade", "proprietario", "locatario"],
  notificacao: ["sancao", "advertencia", "multa", "penalidade", "infracao"],
  entrega: ["encomenda", "entregador"],
  encomenda: ["entrega", "entregador"],
  cachorro: ["animal", "animais", "pet", "cao", "cães"],
  gato: ["animal", "animais", "pet"],
  animal: ["pet", "cachorro", "gato", "cao"],
  crianca: ["menor", "menores", "criancas"],
  festa: ["salao", "churrasqueira", "evento"],
  mudanca: ["mudancas"],
  multa: ["penalidade", "infracao", "advertencia", "sancao"],
  obra: ["reforma", "manutencao"],
  reforma: ["obra", "manutencao"],
  aluguel: ["locacao", "locatario"],
  piscina: ["natacao"],
  academia: ["ginastica", "musculacao"],
};

export function normalizarTexto(texto) {
  return (texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// As chaves/valores dos aliases também passam pela normalização (ex.: "condômino" -> "condomino"),
// senão nunca batem com a palavra digitada, que chega aqui sem acento.
const ALIASES_NORMALIZADOS = Object.fromEntries(
  Object.entries(ALIASES).map(([chave, lista]) => [normalizarTexto(chave), lista.map(normalizarTexto)])
);

// Radical simplificado (stemmer "caseiro" pro português): tira plural e terminações comuns de
// verbo/substantivo, pra "horários" achar "horário", "estacionar" achar "estacionamento",
// "animais" achar "animal", "proibidos" achar "proibido/proibição" etc.
const SUFIXOS = [
  "amentos", "imentos", "amento", "imento", "acoes", "icoes", "acao", "icao", "mente",
  "ados", "adas", "idos", "idas", "ado", "ada", "ido", "ida", "ando", "endo", "indo",
  "ais", "eis", "oes", "aes", "ar", "er", "ir", "es", "s", "a", "o", "e",
];
export function radical(palavra) {
  const p = normalizarTexto(palavra);
  for (const sufixo of SUFIXOS) {
    if (p.endsWith(sufixo) && p.length - sufixo.length >= 4) return p.slice(0, -sufixo.length);
  }
  return p;
}

function palavrasDoTexto(textoNormalizado) {
  return textoNormalizado.split(/[^a-z0-9]+/).filter(Boolean);
}

// Agrupa a pergunta em "conceitos": uma palavra digitada + seus aliases (sinônimos).
// Cada conceito conta como UM ponto de cobertura na busca, não importa se bateu pela
// palavra original ou por um alias — evita que "vaga" e seu alias "estacionamento"
// contem como dois acertos separados pro mesmo assunto.
function extrairConceitos(consulta) {
  const brutos = palavrasDoTexto(normalizarTexto(consulta)).filter(
    (t) => (t.length >= 3 || /^\d+$/.test(t)) && !PALAVRAS_IGNORADAS.has(t)
  );
  const vistos = new Set();
  const conceitos = [];
  brutos.forEach((palavra) => {
    if (vistos.has(palavra)) return;
    const termos = [...new Set([palavra, ...(ALIASES_NORMALIZADOS[palavra] || ALIASES_NORMALIZADOS[radical(palavra)] || [])])];
    termos.forEach((t) => vistos.add(t));
    conceitos.push({ chave: palavra, termos, radicais: termos.map(radical) });
  });
  return conceitos;
}

// Uma palavra do texto bate com o termo buscado se tiver o mesmo radical, ou se começar com
// o radical buscado (radicais curtos exigem casamento exato, pra "som" não achar "sombra").
function palavraBate(palavraTexto, radicalPalavraTexto, radicalTermo) {
  if (radicalPalavraTexto === radicalTermo) return true;
  return radicalTermo.length >= 5 && palavraTexto.startsWith(radicalTermo);
}

// Índice por lista de regras (calculado uma vez): palavras e radicais de cada artigo e do
// título do capítulo, pra não refazer isso a cada pergunta.
const cacheIndice = new WeakMap();
function indiceDasRegras(regras) {
  if (cacheIndice.has(regras)) return cacheIndice.get(regras);
  const montar = (texto) => {
    const palavras = [...new Set(palavrasDoTexto(normalizarTexto(texto)))];
    return palavras.map((p) => [p, radical(p)]);
  };
  const indice = regras.map((r) => ({ corpo: montar(r.texto), titulo: montar(r.capitulo?.titulo || "") }));
  cacheIndice.set(regras, indice);
  return indice;
}

function conceitoNoTexto(conceito, palavras) {
  return palavras.some(([p, rp]) => conceito.radicais.some((rt) => palavraBate(p, rp, rt)));
}

const chaveRegra = (r) => `${r.fonte}|${r.artigo}`;

/**
 * Busca os artigos mais relevantes pra uma pergunta, dentro de uma lista de regras
 * (formato de src/data/regras.json: { fonte, capitulo: {numero, titulo}, artigo, texto }).
 *
 * Estratégia: 1) artigos que cobrem MAIS de um conceito da pergunta entram primeiro (são
 * fortes candidatos: tocam em vários assuntos citados). 2) o resto das vagas é preenchido
 * em rodízio, um artigo por conceito por vez — assim um conceito "raro" no documento (que
 * naturalmente pesaria mais numa pontuação por frequência) não toma o lugar de um conceito
 * "comum" mas que é justamente o assunto principal da pergunta (ex.: perguntar sobre
 * "horário da piscina" não pode deixar de trazer o capítulo da piscina só porque a palavra
 * "piscina" aparece em vários artigos daquele capítulo).
 */
export function buscarArtigosRelevantes(pergunta, regras, { limite = 6 } = {}) {
  const conceitos = extrairConceitos(pergunta);
  if (!conceitos.length || !Array.isArray(regras) || !regras.length) return [];

  const indice = indiceDasRegras(regras);
  const batidas = regras.map((_, i) =>
    conceitos.map((c) => ({
      noTitulo: conceitoNoTexto(c, indice[i].titulo),
      noCorpo: conceitoNoTexto(c, indice[i].corpo),
    }))
  );

  // Peso de cada conceito: raro no documento pesa mais (IDF). Conceito que aparece em quase
  // todo artigo (ex.: "condominio") quase não ajuda a escolher.
  const total = regras.length;
  const pesos = conceitos.map((_, ci) => {
    const df = batidas.filter((b) => b[ci].noTitulo || b[ci].noCorpo).length;
    return df ? Math.log(1 + total / df) : 0;
  });

  const candidatos = regras
    .map((regra, i) => {
      const conceitosBatidos = conceitos.filter((_, ci) => batidas[i][ci].noTitulo || batidas[i][ci].noCorpo);
      if (!conceitosBatidos.length) return null;
      // Bater no TÍTULO do capítulo (ex.: "DA PISCINA") é sinal forte de que o artigo é sobre o assunto.
      const pontos = conceitos.reduce((soma, _, ci) => {
        const b = batidas[i][ci];
        return soma + (b.noCorpo ? pesos[ci] : 0) + (b.noTitulo ? pesos[ci] * 1.5 : 0);
      }, 0);
      return { ...regra, conceitosBatidos, pontos };
    })
    .filter(Boolean)
    .sort((a, b) => b.pontos - a.pontos);
  if (!candidatos.length) return [];

  const selecionados = [];
  const jaEntrou = new Set();
  const adicionar = (r) => {
    const chave = chaveRegra(r);
    if (jaEntrou.has(chave)) return false;
    jaEntrou.add(chave);
    selecionados.push(r);
    return true;
  };

  // candidatos já vêm ordenados por pontos: os de vários conceitos com mais peso entram primeiro.
  candidatos
    .filter((r) => r.conceitosBatidos.length > 1)
    .forEach((r) => {
      if (selecionados.length < limite) adicionar(r);
    });

  // Rodízio começando pelos conceitos mais específicos (maior peso): "piscina" antes de "horario".
  const conceitosPorPeso = conceitos
    .map((c, ci) => ({ c, peso: pesos[ci] }))
    .sort((a, b) => b.peso - a.peso)
    .map((x) => x.c);
  let progrediu = true;
  while (selecionados.length < limite && progrediu) {
    progrediu = false;
    for (const conceito of conceitosPorPeso) {
      if (selecionados.length >= limite) break;
      const candidato = candidatos.find(
        (r) => !jaEntrou.has(chaveRegra(r)) && r.conceitosBatidos.some((c) => c.chave === conceito.chave)
      );
      if (candidato && adicionar(candidato)) progrediu = true;
    }
  }

  return selecionados.slice(0, limite).sort((a, b) => b.pontos - a.pontos).map((r) => ({
    ...r,
    termosEncontrados: r.conceitosBatidos.map((c) => c.chave),
  }));
}

// Referência curta pra citar a fonte, ex.: "Regulamento Interno, Capítulo IV, Art. 37º".
export function citacaoCurta(regra) {
  const nomeFonte = regra.fonte === "Convenção" ? "Convenção" : "Regulamento Interno";
  const cap = regra.capitulo?.numero ? `Capítulo ${regra.capitulo.numero}` : null;
  return [nomeFonte, cap, `Art. ${regra.artigo}º`].filter(Boolean).join(", ");
}

/**
 * Monta o bloco de texto pra injetar no prompt do Groq: só os artigos relevantes,
 * cada um com sua citação completa (fonte, capítulo, artigo), nunca o documento inteiro.
 */
export function montarContextoRegras(pergunta, regras, opts) {
  const artigos = buscarArtigosRelevantes(pergunta, regras, opts);
  if (!artigos.length) return { contexto: null, artigos: [] };

  const contexto = artigos
    .map((a) => {
      const fonteLabel = a.fonte === "Convenção" ? "Convenção" : "Regimento Interno (RI)";
      const capLabel = a.capitulo?.titulo ? ` – ${a.capitulo.titulo}` : "";
      return `[${citacaoCurta(a)} — ${fonteLabel}${capLabel}]\n${a.texto}`;
    })
    .join("\n\n");

  return { contexto, artigos };
}
