# Plano · Etapa 19: Google Agenda

Situação: aprovado (sem perguntas novas ao Pablo; ver seção 14). O cliente OAuth
real do Google é do Pablo e só é preciso no deploy; o desenvolvimento usa um
Google simulado.
Origem: etapa 19 da especificação ("Google Agenda") e o bloco da etapa em
`docs/agente/prompts-das-etapas.md`
Dependências: 9 (#28), 10 (#46), 15b (#89), 16a (#93), 18a (#105), 18b (#111),
autonomia MCP (#120), nova UI (#126, #130, #132)

## 1. Resumo

O Pablo conecta a conta Google em **Configurações › Integrações › Google
Agenda** e escolhe, agenda por agenda, o que a Zuri pode fazer: nada (padrão),
só ler, ou ler e escrever. Na conversa, a Zuri lista eventos, cria e muda
eventos direto nas agendas de escrita e propõe apagar (cartão de aprovação).
No bot, `/hoje` ganha o bloco "Agenda". Em Automações, dois modelos prontos de
rotina com IA: **Briefing da manhã** (todo dia, 07:00) e **Fechamento do dia**
(segunda a sexta, 19:00), no fuso do dono. Tudo grátis: Google Calendar API sem
custo e nenhum recurso novo da Cloudflare.

## 2. Contexto no sistema

- Ferramentas: `apps/agent/src/tools/registry.ts` (classes `read`, `write`,
  `destructive`; `ToolExecutor`; `runApprovedAction`, que hoje faz o `commit`
  dentro de uma transação síncrona) e `tools/index.ts` (`ALL_TOOLS` tem de
  bater com `TOOL_NAMES` de `packages/shared/src/chat.ts`).
- Cifra: `apps/agent/src/mcp/credentials.ts` (`McpCredentials`, AES-256-GCM
  com HKDF do `MCP_CREDENTIAL_KEY`, `info` fixo `credentials-v1`).
- OAuth do MCP (18b): volta em `/configuracoes/integracoes`
  (`OAUTH_CALLBACK_PATH` em `mcp/service.ts`), `useSignInCallback` em
  `apps/web/src/pages/settings/IntegrationsTab.tsx`, rota
  `POST /api/mcp/oauth/callback` com senha recente.
- Simulação local: `mcp/dev-mcp.ts`, `mcp/dev-oauth.ts`; o e2e responde a
  página de login externa com `page.route` (`tests/e2e/integracoes.spec.ts`).
- Bot: `/hoje` em `apps/agent/src/telegram/commands.ts`; aprovações em
  `telegram/approvals.ts` (`BOT_APPROVABLE`).
- Rotinas: `automations/executor.ts` (rotina com IA pelo `AgentRunner.scheduled`,
  só ferramentas `read`), formulário em `apps/web/src/pages/automations/AutomationsPage.tsx`.
- Bloqueio: `auth.lockdown.active()`; nada externo roda durante o bloqueio.
- Talorys (referência, só leitura): `apps/agent/src/calendar/service.ts`,
  `tools/calendar.ts`, `docs/google-calendar.md`.
- Decisões: OAuth próprio do Google com o cliente confidencial do dono, não o
  `ZuriOAuthProvider` (progresso da 18b); cifrar com `MCP_CREDENTIAL_KEY` com
  outro `info` (18a); app OAuth "Em produção" sem verificação
  (`docs/planos/google-contatos.md`, seção 4); conexão pronta para a 19b
  (autorização incremental).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Conectar usa OAuth com PKCE S256, `state` de uso único que vale 10 min, cliente confidencial do dono, senha recente e alerta de segurança | especificação / plano |
| CA2 | Refresh e access token cifrados (AES-256-GCM, `info` próprio no HKDF); nunca voltam à interface, ao log nem ao backup | especificação |
| CA3 | Escopos mínimos: `calendar.events` e `calendar.calendarlist.readonly`; concessão parcial não salva nada | plano |
| CA4 | Cada agenda fica oculta (padrão), só leitura ou leitura e escrita; escrita só onde o Google deixa (dono ou editor); agenda só leitura recusa escrita | especificação |
| CA5 | `list_calendar_events` (read) devolve eventos em `<data>`; janela até 62 dias, até 50 eventos | especificação |
| CA6 | `create_calendar_event` e `update_calendar_event` (write) rodam direto no chat, nunca em rotinas; sem convidados, `sendUpdates=none`; mudar usa `If-Match` | especificação |
| CA7 | `delete_calendar_event` é proposta; aprovar apaga com `If-Match`; evento mudado ou agenda fechada nesse meio-tempo = `TARGET_CHANGED` e nada é apagado | especificação |
| CA8 | `/hoje` inclui "Agenda" (até 5 eventos e "e mais N no app"); Google fora do ar = "Agenda indisponível agora." | especificação |
| CA9 | Modelos de rotina Briefing da manhã (07:00 todo dia) e Fechamento do dia (19:00, seg a sex), no fuso do dono | especificação |
| CA10 | Durante o bloqueio nenhuma chamada ao Google sai | decisões (16b) |
| CA11 | Desconectar apaga tokens e agendas daqui e revoga no Google | plano |
| CA12 | Acesso revogado ou vencido (`invalid_grant`) marca "Conectar de novo" e avisa uma vez (novo aviso só um dia depois do anterior) | plano (19b, seção 4) |
| CA13 | Chamadas só para os endereços fixos do Google, 10 s de prazo, sem seguir redirecionamento, até 1 MB; subrequisições contadas por turno | P9 |
| CA14 | Tela **Agenda** no menu lateral, com visões dia, semana e mês, filtro por agenda, estados vazio, carregando e erro, teclado, leitor de tela, claro/escuro e celular | pedido do Pablo (03/11) |
| CA15 | Na tela, criar, editar e apagar eventos só em agendas "Ler e editar"; agendas "Só ler" mostram sem botões; editar e apagar conferem a versão (`etag`/`If-Match`) | pedido do Pablo (03/11) |
| CA16 | Mudança feita no Google aparece na tela aberta sem recarregar: aviso de push do Google (`events.watch`) com token HMAC conferido no Worker → área `calendar` → canal ao vivo | pedido do Pablo (03/11) |
| CA17 | A tela não cria, renomeia nem apaga agendas: só eventos; escopos continuam os do CA3 | decisão do Pablo (03/11, "Só eventos") |

## 4. Escopo

**Entra:** serviço da agenda, migration 22, rotas `/api/google/*`, quatro
ferramentas, aprovação pelo app, pelo bot e pela página `/aprovar`, `/hoje`,
modelos de rotina, cartão Google Agenda em Integrações, simulação local do
Google, docs (`docs/google-agenda.md`, `docs/configuracao-cloudflare.md`,
`docs/seguranca.md`, `docs/arquitetura.md`), README e changelog.

**Fica fora (e onde vai parar):**

- Contatos (`contacts.readonly`) → etapa 19b, na mesma conexão.
- Aviso antes do primeiro evento e "só rodar em dias com eventos" (Talorys) →
  não pedido; pode virar ajuste depois.
- Eventos guardados no banco ou na busca → não: eventos são lidos na hora e
  não ficam aqui.
- Convidados, Meet, cores, lembretes do Google → fora; a Zuri não manda nada a
  terceiros.
- Nós da agenda nos workflows → etapa 22c.

## 5. Como funciona para o Pablo

### Fluxo 1 · Conectar

1. Integrações mostra o cartão **Google Agenda**. Sem os segredos: "A Google
   Agenda ainda não foi configurada nesta instalação" e o link do passo a
   passo. Com eles: botão **Conectar Google**.
2. Toque em Conectar: a Zuri pede a senha se a última foi há mais de 10 min
   (diálogo já existente), e o navegador vai para a página do Google. O Google
   mostra "o Google não verificou este app"; o Pablo escolhe **Avançado ›
   Acessar Zuri** e marca as duas permissões.
3. Volta para `/configuracoes/integracoes`: "Terminando a conexão…", depois
   aviso "Google Agenda conectada" e a lista de agendas, todas **Oculta para a
   Zuri**. Um alerta de segurança "Google Agenda conectada" entra na central.
4. Erros: permissões desmarcadas ("Marque as duas permissões na página do
   Google e conecte de novo"), link vencido ou usado, Google fora do ar.

### Fluxo 2 · Escolher o que a Zuri faz em cada agenda

Cada agenda tem um seletor: **Oculta para a Zuri**, **Só leitura**, **Ler e
escrever** (este só aparece onde o Google deixa editar). Abrir uma agenda
(leitura ou escrita) pede a senha recente; ocultar nunca pede. **Atualizar
lista** relê as agendas do Google. Estados: carregando, vazio (conta sem
agendas visíveis), erro com "Tentar de novo", "Conectar de novo" quando o
Google revogou.

### Fluxo 3 · Conversa

"O que tenho amanhã?" → `list_calendar_events`. "Marca dentista sexta às 15h"
→ `create_calendar_event` na agenda principal de escrita. "Apaga a reunião de
quinta" → cartão "Apagar o evento “Reunião” da agenda Trabalho (2026-11-05
14:00 – 15:00)" com **Aprovar**; também pelo bot e pela página `/aprovar`.

### Fluxo 4 · Bot e rotinas

`/hoje` mostra "Agenda (n)" com até 5 eventos ("• 09:00 Dentista", "• Dia
inteiro · Feriado"). Em **Automações › Nova › Rotina com IA**, botões de modelo
preenchem nome, instrução e horário do Briefing da manhã e do Fechamento do dia.

### Fluxo 5 · Desconectar

**Desconectar** com confirmação: apaga daqui, revoga no Google, e as
ferramentas somem da Zuri.

Acessibilidade: seletor nativo com rótulo, mensagens em `role="status"`,
foco visível, teclado, claro/escuro, celular (cartão em coluna).

### Textos visíveis

Todos em `packages/shared/i18n` (`pt-BR-settings-tabs.ts` para a tela,
`pt-BR-chat.ts` para os cartões, `pt-BR-server.ts` para o servidor e o bot,
`pt-BR-automations.ts` para os modelos), com `en.ts`, passados pelo humanizer.
Principais:

| Chave | pt-BR | en | Onde aparece |
| --- | --- | --- | --- |
| `web.google.title` | Google Agenda | Google Calendar | Integrações |
| `web.google.connect` | Conectar Google | Connect Google | Integrações |
| `web.google.mode.off` | Oculta para a Zuri | Hidden from Zuri | seletor |
| `web.google.mode.read` | Só leitura | Read only | seletor |
| `web.google.mode.write` | Ler e escrever | Read and write | seletor |
| `telegram.cmd.hoje.agenda` | Agenda ({n}) | Calendar ({n}) | `/hoje` |
| `telegram.cmd.hoje.agenda_indisponivel` | Agenda indisponível agora. | Calendar unavailable right now. | `/hoje` |
| `web.chat.approval.delete_calendar_event` | Apagar o evento “{target}”. | Delete the event “{target}”. | cartão |

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Contas Google | 1 | conectar outra substitui (agendas voltam a ocultas) | — |
| Agendas lidas da lista | 100 (5 páginas de 250) | o resto é ignorado | — |
| Janela de `list_calendar_events` | 62 dias | 63 recusa | ToolError |
| Eventos por listagem | 50 | "há mais eventos; diminua a janela" | — |
| Agendas por listagem | 10 | as 10 primeiras | — |
| Chamadas por turno | list 4; create 3; update 3; delete 3 | a seguinte recusa | ToolError |
| Título / local / descrição | 200 / 300 / 2.000 caracteres | 201 recusa | ToolError |
| Duração de evento com hora | 14 dias | mais recusa | ToolError |
| `state` do OAuth | 10 min, uso único | vencido ou repetido recusa | `VALIDATION_FAILED` |
| Prazo por chamada ao Google | 10 s | aborta | "Google fora do ar" |
| Resposta do Google | 1 MB | trata como inválida | idem |
| Subrequisições ao Google | 8 por turno no app, 6 no bot, 8 por despertar nas rotinas | a chamada seguinte recusa | ToolError |
| Proposta de apagar | 30 min (padrão do chat) | vence | `APPROVAL_EXPIRED` |
| Aviso de reconectar | 1 por dia | repetição some | — |

## 7. Desenho técnico

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `packages/shared/src/google.ts` | cria | constantes, tipos e schemas (Zod Mini) da conexão e das agendas |
| `apps/agent/src/google/service.ts` | cria | `GoogleCalendar`: OAuth, tokens cifrados, agendas, chamadas à API |
| `apps/agent/src/google/events.ts` | cria | datas locais ↔ instantes, apresentação dos eventos |
| `apps/agent/src/google/dev-google.ts` | cria | Google simulado (token, revogação, lista de agendas, eventos com etag) |
| `apps/agent/src/tools/calendar.ts` | cria | as quatro ferramentas |
| `apps/agent/src/tools/registry.ts` | muda | `target` pode ser assíncrono; `commitAsync` fora da transação; `calendar` no contexto |
| `apps/agent/src/api/google.ts` | cria | rotas da conexão |
| `apps/agent/src/mcp/credentials.ts` | muda | `info` do HKDF por uso |
| `apps/agent/src/telegram/commands.ts`, `approvals.ts` | muda | bloco Agenda no `/hoje`; aprovar apagar evento |
| `apps/agent/src/agent/zuri-agent.ts`, `runner.ts`, `automations/executor.ts` | muda | ligação do serviço e medidor de subrequisições |
| `apps/web/src/pages/settings/GoogleCalendarCard.tsx` | cria | cartão (no chunk de Integrações, sob demanda) |
| `apps/web/src/pages/settings/IntegrationsTab.tsx` | muda | cartão e volta do OAuth do Google |
| `apps/web/src/pages/automations/AutomationsPage.tsx` | muda | modelos de rotina |
| `apps/web/src/pages/chat/labels.ts`, `ApprovePage.tsx` | muda | rótulos das ferramentas e do cartão |

### Rotas e contratos

Todas sob sessão, CSRF e Origin do dono; nenhuma em `WHILE_LOCKDOWN`.

- `GET /api/google` → `{ configured, connected, status, problem, connectedAt, calendars[] }` (sem e-mail de terceiros, sem token).
- `POST /api/google/connect` (senha recente) → `{ url }`.
- `POST /api/google/callback` `{ state, code?, error?, scope? }` (senha recente; alerta `google_connected`).
- `POST /api/google/refresh` → status com a lista relida.
- `PATCH /api/google/calendars/:id` `{ mode }` (senha recente para `read`/`write`; alerta `google_calendar_write` ao liberar escrita).
- `DELETE /api/google` → desconecta e revoga.

Erros: `NOT_CONFIGURED` (422 de `VALIDATION_FAILED` com mensagem própria),
`NOT_FOUND`, `CONFLICT`, `SERVICE_UNAVAILABLE`, `REAUTH_REQUIRED` (senha).

### Banco

Migration 22 `google_calendar`, só acréscimo:

- `zur_google_account` (uma linha, `id = 1`): `email`, `refresh_token` e
  `access_token` cifrados, `access_expires_at`, `scopes` (os concedidos; a 19b
  soma o de contatos), `status` (`connected`/`error`), `problem`,
  `connected_at`, `checked_at`.
- `zur_google_calendars`: `id`, `name`, `access_role`, `time_zone`,
  `is_primary`, `mode` (`off`/`read`/`write`), `updated_at`.
- O `state` pendente fica em `zur_internal_state` (hash do state, verificador
  cifrado, vence em 10 min).
- Fora do backup (a etapa 23 precisa respeitar): tokens. Sem área nova em
  `zur_area_versions`: eventos não ficam aqui e a conexão só muda pela própria
  tela.

### Ferramentas do agente

| Nome | Classe | Limite | Observação |
| --- | --- | --- | --- |
| `list_calendar_events` | read | 4 por turno | também em rotinas; resultado em `<data source="calendar">` |
| `create_calendar_event` | write | 3 por turno | só agendas de escrita; sem convidados |
| `update_calendar_event` | write | 3 por turno | `If-Match` com o etag lido na hora |
| `delete_calendar_event` | destructive | 3 por turno | proposta; alvo = agenda + evento; etag no payload |
| `change_shared_calendar_event` | destructive | 3 por turno | proposta para mudar evento com convidados, de outro organizador ou de agenda alheia (decisão de 03/11/2026, auditoria); etag e campos no payload |

Só aparecem quando há agenda aberta (leitura) ou de escrita. Snapshot da
proposta: conta, agenda, modo e o evento (id); o etag vai ao Google no
`If-Match`, que recusa (412) se o evento mudou.

### Agendamentos, IA e integrações externas

Sem alarme novo (P8). Rotinas usam o mesmo `list_calendar_events` (classe
read). Chamadas ao Google com `fetch` direto para `accounts.google.com`
(navegador), `oauth2.googleapis.com` e `www.googleapis.com/calendar/v3`,
`redirect: "manual"`, `AbortSignal.timeout(10 s)`, corpo até 1 MB.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Google Calendar API | ~20 chamadas/dia | ~500/dia | cota grátis de 1.000.000/dia | console do Google, Quotas |
| Subrequisições | 1 a 3 por chamada de ferramenta | 8 por turno | 50 por invocação (P9) | `orcamento-free-tier.md` |
| Escritas no SQLite | 1 por renovação de token (~1/h de uso) | dezenas/dia | 100.000/dia | idem |
| IA | 2 rotinas/dia se o Pablo criar as duas | 2 das 6 execuções agendadas | teto do dono | `AUTOMATION_LIMITS` |

Nenhum recurso pago. ⚠️ nada.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Convite de estranho com instruções no título | eventos em `<data>`, texto limpo de controle/bidi, nunca nas instruções | `calendar-tools.test.ts` |
| Injeção leva a apagar eventos | apagar é proposta com dados do Google, não do modelo | idem |
| Injeção cria ou muda eventos | só agendas que o dono abriu para escrita, sem convidados, `sendUpdates=none`, 3 por turno | idem |
| CSRF/state forjado no OAuth | state de 32 bytes, hash guardado, uso único, 10 min; senha recente na volta | `google-routes.test.ts` |
| Roubo de código | PKCE S256 + segredo do cliente | `google-service.test.ts` |
| Vazamento de token | cifrado, nunca em resposta, log ou backup | idem |
| SSRF | só URLs fixas do Google; ids das agendas e eventos codificados no caminho | idem |
| Sessão roubada abre agenda | senha recente para conectar e abrir; alerta | `google-routes.test.ts` |
| Bloqueio | toda chamada consulta `lockdown()` antes | idem |
| Concessão parcial ou outra conta | nada salvo; outra conta zera as agendas | idem |

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1 | PKCE, state único e vencido, senha recente, alerta | integração | `apps/agent/test/google-routes.test.ts` |
| CA2 | token cifrado no banco, nunca na resposta; chave trocada pede reconectar | unitário | `google-service.test.ts` |
| CA3 | escopo faltando não salva e revoga | unitário | idem |
| CA4 | modo `write` recusado em agenda `reader`; ferramenta não acha agenda só leitura | integração | `google-routes.test.ts`, `calendar-tools.test.ts` |
| CA5 | 62/63 dias, 50 eventos, `<data>` | unitário | `calendar-tools.test.ts` |
| CA6 | criar/mudar sem convidados, `sendUpdates=none`, `If-Match`; indisponível em rotina | unitário | idem |
| CA7 | proposta, aprovação, 412 → `TARGET_CHANGED`, agenda fechada → `TARGET_CHANGED` | integração | idem, `telegram-approvals.test.ts` |
| CA8 | `/hoje` com agenda, mais de 5, indisponível | integração | `telegram-commands.test.ts` |
| CA9 | modelos preenchem 07:00 diário e 19:00 seg–sex; próxima execução no fuso | e2e + unitário | `tests/e2e/google-agenda.spec.ts`, `automations.test.ts` |
| CA10 | bloqueio: nenhuma chamada sai | integração | `google-service.test.ts` |
| CA11 | desconectar apaga e revoga | integração | `google-routes.test.ts` |
| CA12 | `invalid_grant` marca erro e avisa uma vez | unitário | `google-service.test.ts` |
| CA13 | redirecionamento recusado, resposta grande, prazo, medidor | unitário | idem |
| — | tela: conectar (Google respondido por `page.route`), modos, desconectar, axe | e2e / a11y | `tests/e2e/google-agenda.spec.ts` |

## 11. Entrega

- **Ordem:** um PR para a `develop`.
- **Capturas:** Integrações com a Google Agenda conectada (computador e
  celular, claro e escuro) em `docs/capturas/pr/etapa-19-google-agenda/`.
- **Docs:** `docs/google-agenda.md` (novo), `docs/configuracao-cloudflare.md`
  (passo a passo do Google), `docs/seguranca.md`, `docs/arquitetura.md`,
  README.
- **Changelog:** `changelog/nao-lancado/etapa-19-google-agenda.md` com `<!-- versao: minor -->`.
- **Instalação:** segredos `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` (já na
  especificação) e `MCP_CREDENTIAL_KEY`.
- **Portabilidade:** nenhum binding novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| App em "Teste" faz o token vencer em 7 dias | média | agenda para toda semana | passo a passo manda publicar; aviso de reconectar diz o porquê |
| JS inicial passar do teto | média | CI vermelha | cartão e textos no chunk de Integrações; medir |
| API real diferente da simulada | baixa | falha só no deploy | simulação segue a documentação oficial; o Pablo testa ao conectar |

## 13. Suposições

- Atualização (03/11/2026, pedido do dono): o Google volta em
  `/rest/oauth2-credential/callback`; o Worker repassa `state`, `code` e
  `error` para `/configuracoes/integracoes`, que termina a conexão como antes.
- Redirecionamento em `/configuracoes/integracoes` (a mesma página da 18b), em
  vez de `/settings/google-oauth` da especificação: as rotas da interface são
  em português e a decisão da 18b já usa essa página. O `state` do Google
  começa com `g.` para a tela saber para qual rota mandar.
- Escopo `calendar.calendarlist.readonly` em vez de `calendar.readonly` da
  especificação: faz o mesmo trabalho (listar agendas) e vê menos.
- Tabelas `zur_google_account`/`zur_google_calendars` em vez de
  `calendar_accounts`: a conta é compartilhada com a 19b.

## 14. Entrevista com o Pablo

Sem perguntas: tudo coberto pela especificação (etapa 19 e "Contratos"),
pelas decisões da 18b (OAuth próprio, cifra) e pelo plano da 19b (app "Em
produção"). O único item do Pablo é criar o cliente OAuth (pedido na thread
em 03/11/2026), que não bloqueia o código.

| Data | Pergunta | Resposta |
| --- | --- | --- |
| — | — | — |

### Perguntas abertas

Nenhuma.

## 15. Ajuste do Pablo (03/11/2026): tela Agenda em tempo real

Pedido: "um menu dentro da área ligada da Zuri com a visualização da agenda em
tempo real, com a possibilidade de edição, criação e atualização". Decisão no
cartão: **Só eventos** (a tela não mexe nas agendas em si).

- **Tela** `/agenda` (lazy, `apps/web/src/pages/agenda/AgendaPage.tsx`), item
  "Agenda" no menu lateral e na paleta (ir para a Agenda, "Novo evento").
  Visões dia, semana e mês (semana começa na segunda), filtro das agendas na
  tela, detalhes do evento num diálogo, formulário de criar e editar, apagar
  com confirmação no próprio diálogo. Datas no fuso do dono
  (`apps/web/src/lib/agenda.ts`).
- **Rotas**: `GET /api/google/events?from&to` (até 43 dias, 250 por agenda,
  500 no total), `POST`, `PATCH` (com `etag`) e `DELETE` (com `etag`)
  `/api/google/events`. Todas atrás da sessão, do CSRF e da origem; nenhuma
  em `WHILE_LOCKDOWN`.
- **Tempo real**: ao abrir uma agenda, a Zuri pede ao Google um canal de
  push (`events.watch`) para `/api/google/push`, com um token que é o HMAC do
  `SESSION_SECRET` sobre o id do canal. O Worker confere o token antes de
  acordar o objeto (a rota passa pelo Access só com token válido, como o
  webhook do Telegram) e responde sempre 200 vazio. Um aviso aceito sobe a
  coluna `changed` da agenda, que move a área `calendar`; o canal ao vivo
  avisa a tela, que lê a janela de novo. O alarme renova os canais um dia
  antes do fim (no máximo 4 por despertar), com o próximo prazo guardado em
  memória para não ler o banco a cada despertar; uma falha espera 1 hora.
  Sem `PUBLIC_URL` https (desenvolvimento) não há push: a tela relê ao voltar
  o foco.
- **Custo**: nenhum recurso novo. Push do Google é grátis; cada aviso custa uma
  requisição ao Worker e uma escrita.
- **Teto do JS inicial**: o item do menu (ícone e nome) custa cerca de 140 B
  na primeira carga; pedido ao Pablo subir o teto em 0,2 kB.
- **Testes**: `apps/web/test/agenda.test.ts` (datas, semanas, mês, formulário),
  `apps/agent/test/google-routes.test.ts` (rotas e push),
  `apps/agent/test/calendar-tools.test.ts` (canais renovados), e2e
  `tests/e2e/google-agenda.spec.ts` (computador e celular).

