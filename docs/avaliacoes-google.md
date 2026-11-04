# Avaliações do Google

A partir da etapa 19c, a Zuri lê as avaliações do seu Perfil da Empresa no
Google, avisa a equipe das negativas e escreve rascunhos de resposta para você
aprovar. Nada é publicado sem a sua aprovação. A resposta automática das
avaliações positivas é a etapa 19d. O plano está em
`docs/planos/google-business-profile.md`.

## Para o dono

### Ligar

1. Conecte o Google Agenda primeiro (veja [Google Agenda](google-agenda.md)).
   As avaliações usam a mesma conta, que precisa gerenciar o perfil.
2. No cartão **Google Agenda e Contatos**, em **Avaliações do Google**, toque
   em **Ligar avaliações**. Se a última senha foi digitada há mais de 15
   minutos, a Zuri pede de novo.
3. O Google mostra a permissão nova, "gerenciar seu Perfil da Empresa". As
   permissões da agenda e dos contatos continuam como estavam.
4. De volta a Integrações, marque o perfil (até 3), escreva a assinatura,
   escolha o tom, confira os 3 a 5 modelos de agradecimento e toque em
   **Salvar avaliações**.

Ao salvar, a Zuri faz a primeira leitura na hora. O que já existe no perfil
vira **histórico**: não gera aviso nem rascunho. Só as avaliações que chegam
depois disso entram na fila.

### O que acontece com cada avaliação

A Zuri lê o perfil a cada 15 minutos, pelo mesmo alarme das rotinas, e só o
que mudou desde a leitura anterior. **Conferir agora** faz o mesmo na hora,
no máximo uma vez por minuto.

| Avaliação | O que a Zuri faz |
| --- | --- |
| 1 a 3 estrelas, ou sem nota | Avisa a equipe na hora, no tópico "Avaliações" do grupo do Telegram, mesmo com a IA fora do ar. Escreve um rascunho cuidadoso para você revisar, quando dá. Se ninguém resolver em 48 horas, avisa mais uma vez. |
| 4 ou 5 estrelas sem texto | Rascunho com um dos seus modelos, sem gastar IA. |
| 4 ou 5 estrelas com texto | O agente de avaliações lê o texto. Se for só elogio, escreve um rascunho; se achar queixa, assunto de saúde ou outro idioma, a avaliação vai para a equipe. |
| Texto que parece dar ordens, com link, telefone, e-mail ou marcação | Vai para a equipe como "Texto suspeito", e a IA nunca o lê. Você pode responder escrevendo a resposta. |
| Já respondida no Google | Fica como "Respondida no Google". A Zuri nunca responde por cima. |
| Escrita há mais de 14 dias | Histórico. |

As regras da nota são fixas: a IA só consegue deixar uma avaliação mais
cautelosa, nunca menos. Mais de 3 negativas numa leitura viram um aviso só, e
5 negativas ou 10 avaliações novas numa hora geram um alerta de pico.

### A aba Avaliações

Em **Contatos › Avaliações** (`/contatos/avaliacoes`) ficam três filtros:
**Precisa de você**, **Respondidas** e **Todas**, e o filtro por nota. Cada
avaliação mostra só o primeiro nome de quem avaliou, as estrelas, o texto
como texto puro e o que a Zuri fez.

Num rascunho você pode:

- editar o texto e tocar em **Aprovar e publicar**. A Zuri confere o texto de
  novo, lê a avaliação no Google e só então publica. Se a avaliação mudou, foi
  removida ou já tem resposta, nada sai e a tela diz o porquê;
- **Escrever de novo**, que conta na cota de IA do dia;
- **Descartar rascunho**;
- **Já resolvi fora da Zuri**, que tira a avaliação da fila sem mandar nada.

Uma aprovação vale para a versão da avaliação que você viu e por 72 horas.
Uma resposta publicada pela Zuri pode ser apagada pela tela, depois de ela
conferir no Google que a resposta ainda é a dela. A resposta de outra pessoa
nunca é apagada.

**Pausar respostas** (na aba, ou `/pausar_rotinas` no Telegram) segura as
publicações. A leitura e os avisos continuam. Retomar é só pelo app.

### A conferência de toda resposta

Rascunho da IA, modelo seu ou texto que você escreveu: toda resposta passa por
uma conferência fixa, sem IA, antes de ir para o Google. Ela recusa:

- menos de 40 ou mais de 600 caracteres;
- idioma diferente do da avaliação;
- números, links, e-mails, `@` ou `#`;
- formatação, marcação ou mais de um emoji;
- nomes de pessoas, fora o primeiro nome de quem avaliou;
- cinco palavras seguidas copiadas da avaliação;
- promessas, preços, descontos, reembolso, assunto jurídico, saúde, dieta,
  tratamento, exames, e palavras como "IA", "sistema" ou "prompt", além das
  palavras que você proibir;
- caracteres invisíveis;
- falta da assinatura no fim.

O rascunho da IA ainda passa por uma segunda leitura, que vê só a resposta
(nunca a avaliação) e recusa tom irônico, defensivo ou estranho. Um rascunho
que falha volta como um dos seus modelos, se a avaliação for positiva, ou fica
sem rascunho, se for negativa.

### Desligar

- **Desligar avaliações** apaga a cópia das avaliações, os rascunhos, o
  histórico e os avisos feitos a partir delas, e para a leitura. A conexão do
  Google continua.
- **Desconectar** o Google também apaga tudo isso.

No Google nada muda: as avaliações e as respostas publicadas continuam lá.

## Para quem instala

Antes do deploy, o dono confere no projeto do Google Cloud do cliente OAuth:

1. Em **APIs e serviços › Biblioteca**, ligue as três APIs do Perfil da
   Empresa (de graça): **My Business Account Management API**, **My Business
   Business Information API** e **Google My Business API**.
2. Peça o **Basic API Access** do Perfil da Empresa no formulário do Google
   (o projeto começa com cota zero). Enquanto o Google não aprovar, a tela
   mostra "O Google ainda não liberou o acesso" e a Zuri tenta de novo a cada
   6 horas, sem gastar nada.
3. Na tela de consentimento OAuth, acrescente o escopo
   `https://www.googleapis.com/auth/business.manage`.
4. A conta do Google conectada precisa ser proprietária ou administradora do
   perfil.

Os mesmos secrets da agenda servem (`GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `MCP_CREDENTIAL_KEY`). Nenhum recurso novo da
Cloudflare. O aviso de avaliação nova por Pub/Sub exigiria faturamento no
Google Cloud, então a Zuri lê de 15 em 15 minutos.

## Como funciona

- Código em `apps/agent/src/reviews/`: `triage.ts` (regras da nota e do
  texto), `guard.ts` (a conferência fixa), `responder.ts` (o agente de
  avaliações), `service.ts` (leitura, rascunhos, publicação) e `store.ts`
  (o que se apaga ao desligar). Rotas em `apps/agent/src/api/reviews.ts`.
- Conexão: a mesma de `GoogleCalendar` (`apps/agent/src/google/service.ts`),
  com `include_granted_scopes`. `business()` só chama as três APIs do Perfil
  da Empresa.
- Migration 26 (`google_reviews`): `zur_review_settings`, `zur_review_locations`,
  `zur_reviews` e `zur_review_events` (auditoria de 180 dias, só ações e códigos
  da conferência, nunca o texto).
- Leitura: `orderBy=updateTime desc`, páginas de 50, até 3 páginas por
  leitura (o resto continua no despertar seguinte). Uma marca d'água guarda a
  hora da avaliação mais nova lida, e a leitura olha uma hora para trás dela,
  porque o Google pode listar uma avaliação um pouco depois.
- O agente de avaliações não tem ferramentas, histórico nem memórias. A
  avaliação entra num bloco `<data source="review">` neutralizado e o estilo
  do dono em `<data source="settings">`. A resposta dele é JSON validado por
  Zod; qualquer outra coisa conta como rascunho falho.
- Publicação: a avaliação fica em `sending` numa única instrução (duas abas
  não publicam duas vezes), é lida de novo no Google e só então vai o
  `PUT …/reply`. Sem resposta do Google, ela fica `uncertain` e a próxima
  leitura confere antes de tudo. Um hash da resposta diz o que é da Zuri.
- Avisos: categoria "system", sem prioridade que aprende. No Telegram, os
  tipos `reviews.*` vão para o tópico "Avaliações" do grupo; rascunho pronto,
  pico e problema de acesso vão só ao chat privado. O título nunca leva o
  nome nem o texto; o corpo leva o primeiro nome e o texto, que passam pelo
  `disarm()` do bot.
- No bloqueio nada lê o Google nem publica. Nada da avaliação (nome, texto,
  ids do Google) vai para o log: só contagens e nomes de erro.

## Limites e custo

| O quê | Limite |
| --- | --- |
| Perfis lidos | até 3 (até 20 listados) |
| Leitura | a cada 15 minutos; "Conferir agora" 1 por minuto |
| Chamadas ao Google por leitura | até 14 |
| Rascunhos com IA | 30 por dia e 1.000 Neurons por dia (dentro dos 9.000 do dono); 3 por despertar |
| Avisos por leitura | 3 avulsos, o resto num aviso só |
| Aprovação | 72 horas, presa à versão vista |
| Resposta | 40 a 600 caracteres |
| Auditoria | 180 dias |

Medido no teste de orçamento (`apps/agent/test/free-tier-budget.test.ts`),
num perfil com 1.000 avaliações: uma leitura sem novidade faz 1 chamada ao
Google, lê cerca de 170 linhas e grava 5; uma leitura com 5 avaliações novas
grava cerca de 60 linhas. Nenhuma mudança no JavaScript da primeira tela: a
aba e a seção de Integrações carregam sob demanda.
