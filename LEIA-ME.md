# BOTHV — Assistente de Portaria

Projeto de um assistente digital para líder de portaria, criado por Fábio Alves de Souza.
Nasceu da necessidade real do dia a dia na função de líder de portaria na HV Serv.

## O que o app faz

Um aplicativo mobile-first (funciona no navegador do celular) que ajuda o líder de portaria durante o turno:

1. **Regras (base de consulta)**
   Sobe o PDF do regulamento interno do condomínio. A IA lê o arquivo e extrai as normas (horários, acesso, encomendas, visitantes, áreas comuns). Também dá pra colar o texto manualmente.

2. **Consultar (chat com IA)**
   Durante o turno, o líder pergunta "pode ou não pode" e a IA responde com base no regulamento carregado. Ex: "pode entrar entregador de madrugada?", "qual o horário de silêncio?".

3. **Ocorrências (livro digital)**
   Registro rápido de ocorrências com horário automático e categoria (Acesso, Encomenda, Manutenção, Segurança, Outros). Fica salvo no aparelho.

4. **Relatório de turno**
   No fim do plantão, gera um relatório profissional com as ocorrências do dia organizadas por horário, observações gerais e assinatura, pronto pra registrar ou enviar por e-mail.

## Como usar

- Abra o arquivo `assistente_portaria.jsx` como artefato no Claude, ou rode num ambiente React.
- Primeiro passo: vá na aba Regras e suba o PDF do regulamento do condomínio.
- Use a aba Consultar durante o turno para tirar dúvidas.
- Registre ocorrências na aba Ocorrências.
- No fim, gere o relatório na aba Relatório.

## Tecnologia

- React (single file)
- IA via API da Anthropic (modelo Sonnet) para o chat, leitura de PDF e geração do relatório
- Persistência local no dispositivo (dados ficam salvos entre sessões)
- Tema escuro, mobile-first, botões grandes para uso com uma mão durante o plantão

## Status

Protótipo funcional (versão de validação). Feito para testar a ideia na prática antes de virar produto.

## Próximos passos (ao evoluir para produto)

- Backend real e sincronização na nuvem (dados fora do aparelho)
- Multiusuário: cada porteiro com login, líder consolida tudo
- App instalável (Play Store) ou incorporável no site da empresa
- Recursos extras: encomendas com foto, cadastro de moradores, placa de veículo, relatórios por período, envio direto por e-mail
- Adaptar o relatório ao modelo oficial usado pela HV Serv
