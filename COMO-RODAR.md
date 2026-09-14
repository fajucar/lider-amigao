# Como rodar o BOTHV localmente

1. Renomeie `.env.example` para `.env` e cole sua chave da Anthropic.
2. No terminal, dentro da pasta:

   npm install
   npm run dev

3. Abra o endereço que o Vite mostrar (algo como http://localhost:5173).

## O que estava quebrado antes
- Faltava a pasta `src/` com o ponto de entrada. O `index.html` chamava
  `/src/main.jsx`, mas esse arquivo não existia → tela em branco / não abria.
- Faltava o CSS com as diretivas do Tailwind → sem estilo.
- As chamadas de IA iam direto pra api.anthropic.com sem chave (isso só
  funciona dentro do artefato do Claude). Agora passam pelo proxy do Vite,
  que injeta a chave no servidor (a chave NÃO vai pro navegador).

## Observação
`.env` nunca vai pro Git. A chave fica só na sua máquina.
