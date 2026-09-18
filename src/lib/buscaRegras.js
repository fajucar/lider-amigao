// Busca local (sem IA) nas regras do condomínio (RI + Convenção), extraídas uma única vez
// dos PDFs e guardadas em src/data/regras.json. Objetivo: achar os 3-6 artigos mais
// relevantes pra pergunta do usuário, pra mandar pro Groq só esses trechos (nunca o
// documento inteiro) — economiza token e evita estourar o limite por minuto da API.

const PALAVRAS_IGNORADAS = new Set([
  "para", "como", "qual", "quando", "onde", "pode", "podem", "deve", "devem", "isso", "essa",
  "este", "esta", "com", "sem", "uma", "que", "dos", "das", "nos", "nas", "por", "mais",
  "sobre", "durante", "tem", "ter", "vai", "foi", "são", "está", "estão", "ser", "num", "numa",
]);

// Sinônimos comuns no dia a dia da portaria que não aparecem com essas palavras exatas no
// texto legal do RI/Convenção. Cada busca expande os termos digitados com os aliases abaixo.
const ALIASES = {
  barulho: ["silencio", "ruido", "sossego"],
  carro: ["veiculo", "estacionamento", "vaga", "garagem"],
  estacionado: ["estacionamento", "vaga", "garagem"],
  estacionar: ["estacionamento", "vaga", "garagem"],
  vaga: ["estacionamento", "veiculo", "garagem"],
  visitante: ["visita", "visitantes", "acesso", "convidado"],
  visita: ["visitante", "visitantes", "acesso", "convidado"],
  entrega: ["encomenda", "entregador"],
  encomenda: ["entrega", "entregador"],
  cachorro: ["animal", "animais", "pet", "cao", "cães"],
  gato: ["animal", "animais", "pet"],
  animal: ["pet", "cachorro", "gato", "cao"],
  crianca: ["menor", "menores", "criancas"],
  festa: ["salao", "churrasqueira", "evento"],
  mudanca: ["mudancas"],
  multa: ["penalidade", "infracao", "advertencia"],
  obra: ["reforma", "manutencao"],
  reforma: ["obra", "manutencao"],
  aluguel: ["locacao", "locatario"],
  piscina: ["natacao"],
  academia: ["ginastica", "musculacao"],
};

function normalizarTexto(texto) {
  return (texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Agrupa a pergunta em "conceitos": uma palavra digitada + seus aliases (sinônimos).
// Cada conceito conta como UM ponto de cobertura na busca, não importa se bateu pela
// palavra original ou por um alias — evita que "vaga" e seu alias "estacionamento"
// contem como dois acertos separados pro mesmo assunto.
function extrairConceitos(consulta) {
  const brutos = normalizarTexto(consulta)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !PALAVRAS_IGNORADAS.has(t));
  const vistos = new Set();
  const conceitos = [];
  brutos.forEach((palavra) => {
    if (vistos.has(palavra)) return;
    const termos = [...new Set([palavra, ...(ALIASES[palavra] || [])])];
    termos.forEach((t) => vistos.add(t));
    conceitos.push({ chave: palavra, termos });
  });
  return conceitos;
}

// Casa o radical da palavra buscada com variações de plural/conjugação (ex.: "vaga" -> "vagas").
function termoNoTexto(textoNormalizado, termo) {
  const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}])${escapado}[\\p{L}]{0,3}($|[^\\p{L}])`, "u");
  return re.test(textoNormalizado);
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

  const textosNormalizados = regras.map((r) => normalizarTexto(`${r.capitulo?.titulo || ""} ${r.texto}`));

  const candidatos = regras
    .map((regra, i) => {
      const conceitosBatidos = conceitos.filter((c) => c.termos.some((t) => termoNoTexto(textosNormalizados[i], t)));
      if (!conceitosBatidos.length) return null;
      return { ...regra, conceitosBatidos };
    })
    .filter(Boolean);
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

  candidatos
    .filter((r) => r.conceitosBatidos.length > 1)
    .sort((a, b) => b.conceitosBatidos.length - a.conceitosBatidos.length)
    .forEach((r) => {
      if (selecionados.length < limite) adicionar(r);
    });

  let progrediu = true;
  while (selecionados.length < limite && progrediu) {
    progrediu = false;
    for (const conceito of conceitos) {
      if (selecionados.length >= limite) break;
      const candidato = candidatos.find(
        (r) => !jaEntrou.has(chaveRegra(r)) && r.conceitosBatidos.some((c) => c.chave === conceito.chave)
      );
      if (candidato && adicionar(candidato)) progrediu = true;
    }
  }

  return selecionados.slice(0, limite).map((r) => ({
    ...r,
    termosEncontrados: r.conceitosBatidos.map((c) => c.chave),
  }));
}

// Referência curta pra citar a fonte, ex.: "RI, Capítulo IV, Art. 37º".
export function citacaoCurta(regra) {
  const nomeFonte = regra.fonte === "Convenção" ? "Convenção" : "RI";
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
