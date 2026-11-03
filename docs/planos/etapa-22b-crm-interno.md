# Plano · Etapa 22b · CRM interno e eventos do n8n

Situação: aprovado em 03/11/2026 (o Pablo aceitou as três recomendações da seção 14)
Origem: etapa 22 da especificação, dividida pelo plano `docs/planos/workflows-n8n.md` (decisão do Pablo, 02/11/2026: "CRM interno, atendimento no n8n")
Dependências: 22a mesclada (PR #153), 19b mesclada (PR #144). A 20 (tokens remotos) não é necessária: a rota de eventos do CRM é própria, com assinatura HMAC.

## 1. Resumo

A Zuri ganha um **CRM interno**: clientes com etiquetas, etapa do funil,
anotações, histórico e retorno marcado. O n8n, que continua conversando com os
clientes, manda à Zuri eventos assinados (cliente novo ou mudado, mensagem
recebida ou enviada, consulta marcada, retorno), e a Zuri guarda, avisa o dono
dos retornos do dia, dos aniversários e dos clientes novos, e mostra o resumo do
funil. Na conversa, a Zuri consulta e atualiza o CRM e pode **sugerir um
fluxo**, que só existe depois que o dono revisa e salva na tela, desligado.

## 2. Contexto no sistema

- **Fluxos** (22a): `apps/agent/src/flows/service.ts` (`FlowService.create`,
  `list`), `packages/shared/src/flows-schemas.ts` (`flowDefinitionSchema`,
  `flowCreateSchema`), aba `apps/web/src/pages/automations/flows/`.
- **Webhooks sem sessão**: o do Telegram e o push do Google
  (`apps/agent/src/index.ts`, `gates/telegram.ts`, `gates/google-push.ts`):
  conferidos no Worker antes de custar uma requisição ao objeto, com exceção do
  Access só para quem prova o segredo.
- **Contatos do Google** (19b): `apps/agent/src/google/contacts.ts` (avisos de
  aniversário no fuso do dono, `dayKeys`, `planReminder`), tela
  `apps/web/src/pages/contacts/ContactsPage.tsx`.
- **Alarme único** (P8): `ZuriAgent.runAutomations` e `otherDue` em
  `apps/agent/src/agent/zuri-agent.ts`.
- **Ferramentas**: `apps/agent/src/tools/registry.ts` (`defineTool`,
  `permission`, `source`), `tools/contacts.ts`, `TOOL_NAMES` em
  `packages/shared/src/chat.ts`, `DATA_SOURCES` em `agent/data.ts`.
- **Tempo real**: `AREAS` em `packages/shared/src/areas.ts` e as `areaTriggers`
  das migrations.
- **Bloqueio**: `auth.lockdown.active()`; rotas fora de `WHILE_LOCKDOWN`.
- Decisões: 02/11/2026 "Fluxos do n8n na etapa 22"; plano da 22 (dados de saúde
  fora de log, "clientes", rota própria para os webhooks, mensagens a terceiros
  no n8n, DNS rebinding a reavaliar); 03/11/2026 teto do JS inicial 139,6 kB.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Clientes com nome, telefone, e-mail, aniversário, etapa do funil, até 20 etiquetas, anotações e um retorno (data e nota); criar, mudar e apagar pela tela; apagar leva o histórico junto | plano 22 |
| CA2 | Funil com 2 a 12 etapas editáveis (nome e ordem); etapa apagada passa os clientes dela para a primeira | plano 22 |
| CA3 | Histórico por cliente com os 100 registros mais novos (mudança de etapa, etiqueta, retorno, anotação, eventos do n8n) | plano 22 |
| CA4 | Rota `POST /api/crm/events/<chave>` com assinatura HMAC-SHA256 de `timestamp.corpo`, janela de 5 min, id de evento único (repetição devolve 200 sem gravar), corpo até 16 KB, tipos fechados; assinatura errada é recusada no Worker sem requisição ao objeto | plano 22 + prompt |
| CA5 | Limite próprio da rota: 300 eventos por hora e 1.000 por dia (429 com `Retry-After`); 5.000 clientes | plano 22 |
| CA6 | Ligar a rota e gerar ou trocar o segredo só pela tela, com senha recente e alerta de segurança; trocar invalida o segredo antigo; o segredo aparece uma vez | prompt (segurança) |
| CA7 | No bloqueio a rota responde 423 sem gravar nada, e as rotas do CRM também | modo de bloqueio |
| CA8 | Avisos: retorno vencido (um por cliente, até 10 por despertar, o resto num aviso só), aniversários do dia e cliente novo vindo do n8n (até 20 por dia), cada um com chave própria nas configurações do CRM | plano 22 |
| CA9 | Resumo do funil: contagem por etapa, retornos atrasados, de hoje e da semana, clientes novos em 7 dias; na tela, na ferramenta `crm_summary` e num modelo de rotina | plano 22 |
| CA10 | Ferramentas: `search_clients`, `get_client` e `crm_summary` (leitura, também em rotinas) e `add_client` e `update_client` (escrita, só na conversa); conteúdo do CRM ao modelo só em `<data source="crm">`; telefone e e-mail só quando pedidos | plano 22 + pergunta 3 |
| CA11 | `propose_flow`: a Zuri sugere um fluxo validado pelo mesmo schema; a sugestão fica em Automações › Fluxos até o dono revisar e salvar com senha (nasce desligado) ou descartar; nenhuma ferramenta cria, liga ou muda um fluxo | prompt da etapa |
| CA12 | Dados de clientes fora dos logs (nome, telefone, e-mail, texto); o evento recebido é dado | plano 22 |
| CA13 | Aba Clientes em Contatos com estados vazio, carregando e erro, teclado, leitor de tela, celular, claro e escuro, axe e e2e | padrão de qualidade |

## 4. Escopo

**Entra:** migration 25, `apps/agent/src/crm/`, rota de eventos, rotas do CRM,
5 ferramentas do CRM e `propose_flow`, avisos no alarme, aba Clientes, sugestões
na aba Fluxos, modelo de rotina "Resumo do funil", `docs/crm.md`, especificação.

**Fica fora:**

- Mensagens a clientes e atendimento por IA: continuam no n8n.
- Webhook do Chatwoot direto: o n8n fica no meio e assina os eventos.
- Gatilho de fluxo por evento do CRM e passos de CRM no motor: depois da 22c.
- Ligar cliente do CRM a contato do Google: 22c.
- Exportar CSV: fica para o backup (23), que leva o CRM inteiro.

## 5. Como funciona para o Pablo

### Fluxo 1 · Ligar os eventos do n8n

1. Contatos › aba **Clientes** › **Eventos do n8n** › **Ligar**.
2. Senha recente (`ReauthDialog`). Aparece uma vez o endereço e o segredo, com
   botões de copiar e o aviso "Guarde agora: o segredo não aparece de novo".
3. No n8n, o passo **Crypto** (HMAC SHA256) assina `timestamp.corpo` e o
   **HTTP Request** manda os cabeçalhos `X-Zuri-Timestamp` e
   `X-Zuri-Signature` (passo a passo em `docs/crm.md`).
4. O cartão mostra "Último evento às 14:20 · 37 hoje". **Trocar segredo** e
   **Desligar** (desligar não pede senha).

### Fluxo 2 · Trabalhar o funil

1. A aba mostra as etapas com a contagem ("Novo 4 · Em conversa 7 · …"),
   retornos atrasados em destaque, busca e filtro por etiqueta.
2. **Novo cliente** abre o formulário; clicar num cliente abre o detalhe com
   os campos, a etapa, as etiquetas, o retorno, as anotações e o histórico.
3. **Editar funil** muda nomes e ordem das etapas.

### Fluxo 3 · Sugestão de fluxo pela conversa

1. "Zuri, monta um fluxo que confere meu site de hora em hora."
2. A Zuri chama `propose_flow` e responde que deixou a sugestão em
   Automações › Fluxos.
3. A aba mostra **Sugestões da Zuri** com **Revisar** (abre o editor já
   preenchido; salvar pede a senha e cria desligado) e **Descartar**.

### Estados da tela

Carregando, erro com **Tentar de novo**, vazio ("Nenhum cliente ainda", com
Novo cliente e o atalho para ligar os eventos), lista, filtro sem resultado,
teto de 5.000 (botão desligado com o motivo), eventos desligados ou ligados.

### Textos visíveis

Catálogo `packages/shared/i18n/pt-BR-crm.ts` (`addMessages`) e `en.ts`; avisos
em `pt-BR-notices.ts`/`pt-BR-server.ts`. Passados pela `humanizer:humanizer`.

| Chave | pt-BR | en |
| --- | --- | --- |
| `web.contacts.tab.clients` | Clientes | Clients |
| `web.crm.empty.title` | Nenhum cliente ainda | No clients yet |
| `web.crm.events.secretOnce` | Guarde agora: o segredo não aparece de novo. | Save it now: the secret won't be shown again. |
| `notice.crm.followUp.title` | Retorno: {name} | Follow-up: {name} |
| `notice.crm.birthdays.title` | Aniversário de cliente hoje | A client's birthday today |
| `notice.crm.newClient.title` | Cliente novo: {name} | New client: {name} |

## 6. Regras de negócio e limites

| Limite | Valor | No limite |
| --- | --- | --- |
| Clientes | 5.000 | 507 `STORAGE_LIMIT_REACHED`; evento: 507 |
| Etiquetas por cliente | 20, até 40 caracteres | 400 |
| Etiquetas diferentes | 200 | 409 |
| Etapas do funil | 2 a 12, nome até 40 | 400 |
| Histórico por cliente | 100 registros, texto até 500 | os mais antigos saem |
| Anotações | 4.000 caracteres | 400 |
| Corpo do evento | 16 KB | 413 no Worker |
| Janela da assinatura | ±5 min | 401 |
| Eventos | 300 por hora e 1.000 por dia (UTC) | 429 com `Retry-After` |
| Ids de evento lembrados | 7 dias | repetição: 200 `{duplicate:true}` |
| Avisos de retorno por despertar | 10 | o resto vira um aviso com o número |
| Avisos de cliente novo | 20 por dia | os outros só aparecem na tela |
| Sugestões de fluxo | 5, valem 7 dias | a mais antiga sai |

## 7. Desenho técnico

### Arquivos

- `packages/shared/src/crm.ts` (tipos e `CRM_LIMITS`) e `crm-schemas.ts` (Zod).
- `apps/agent/src/crm/service.ts` (`CrmService`), `crm/events.ts`
  (`CrmEvents`: limites, deduplicação, aplicação), `gates/crm-events.ts`
  (chave, segredo derivado e assinatura).
- `apps/agent/src/api/crm.ts` (rotas), `tools/crm.ts`, `tools/flows.ts`.
- `apps/web/src/pages/contacts/` (abas) e `pages/contacts/crm/` (aba Clientes,
  sob demanda), `lib/crm.ts`, sugestões em `pages/automations/flows/`.

### Rotas e contratos

| Método e rota | Senha recente | Respostas |
| --- | --- | --- |
| POST `/api/crm/events/:chave` | — (assinatura) | 200 `{ok}`/`{ok,duplicate}`; 400; 401; 404 (desligado); 409; 413; 423; 429 |
| GET `/api/crm` | — | 200 `{stages, summary, settings, events}` |
| GET `/api/crm/clients?q=&stage=&tag=&followUp=&after=` | — | 200 `{clients, next}` |
| POST `/api/crm/clients` | — | 201 `{client}` |
| GET/PATCH/DELETE `/api/crm/clients/:id` | — | 200; 404 |
| POST `/api/crm/clients/:id/notes` | — | 201 |
| PATCH `/api/crm/stages` | — | 200 `{stages}` |
| PATCH `/api/crm/settings` | — | 200 (avisos) |
| POST `/api/crm/events-key` | sim | 200 `{url, secret}` + alerta |
| DELETE `/api/crm/events-key` | — | 200 (desliga) |
| DELETE `/api/flows/drafts/:id` | — | 200 |

O segredo é `HMAC-SHA256(SESSION_SECRET, "zuri:crm-events:v1:" + chave)`:
nada guardado além da chave (16 bytes, pública no endereço). O Worker deriva o
segredo pela chave do caminho e confere a assinatura antes de chamar o objeto;
o objeto confere de novo e exige que a chave seja a ligada.

### Banco

Migration 25 (`crm`), só acréscimo:

- `zur_crm_clients` (id, ref único opcional, name, search_name, phone,
  phone_digits, email, birthday, birthday_md, stage_id, notes, follow_up_at,
  follow_up_note, follow_up_noticed, source, last_activity_at, created_at,
  updated_at) e contador `crm_clients` em `zur_counts`.
- `zur_crm_tags` (client_id, tag) e `zur_crm_stages` (id, name, position).
- `zur_crm_history` (id, client_id, kind, text, at) com índice por cliente.
- `zur_crm_settings` (linha única: events_key, avisos, próximo aviso).
- `zur_crm_inbox` (id do evento, recebido em) e `zur_crm_event_counts`.
- `zur_flow_drafts` (id, name, definition, created_at).
- `zur_area_versions` ganha a coluna `crm`; os fluxos contam as sugestões.

### Ferramentas do agente

`search_clients`, `get_client`, `crm_summary` (read), `add_client`,
`update_client` e `propose_flow` (write, só na conversa). Nenhuma liga os
eventos, troca o segredo, apaga cliente nem mexe em fluxo salvo.

### Agendamentos, IA e integrações externas

`CrmService.tick()` no alarme depois dos contatos: retornos vencidos e o aviso
do dia (aniversários às 9 h do fuso do dono). `nextDue()` entra no `otherDue`.
Nenhuma chamada externa; nenhum uso de IA fora da conversa.

## 8. Custo e cotas do plano Free

| Cota | Típico (100 eventos/dia) | Pior caso (1.000 eventos/dia) |
| --- | --- | --- |
| Requisições ao objeto | 100 | 1.000 (1% de 100.000) |
| Linhas escritas | ~10 por evento = 1.000 | ~10.000 (10%) |
| Linhas lidas | poucas por evento | folga |
| Neurons | 0 | 0 |

Assinatura errada não chega ao objeto. Nada pago; nenhum binding novo.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Evento forjado | HMAC no Worker e no objeto, tempo constante, chave ligada | crm-events.test.ts |
| Repetição | janela de 5 min + id único por 7 dias | idem |
| Enxurrada | 16 KB, 300/h, 1.000/dia, 5.000 clientes, assinatura antes do objeto | idem + orçamento |
| Injeção de prompt pelo evento | evento é dado: só em `<data source="crm">` | crm-tools.test.ts |
| Segredo vazando | derivado, nunca guardado nem logado; mostrado uma vez com senha recente | crm-routes.test.ts |
| Sessão roubada | gerar segredo pede senha e alerta | idem |
| Ferramenta criando fluxo | `propose_flow` só grava sugestão; salvar é rota com senha | flows-drafts.test.ts |
| Dados de saúde em log | logs só com códigos; lint barra telefone | log test |
| Bloqueio | 423 na rota e nas telas | crm-events.test.ts |
| Access | a rota passa sem login no Access só com a assinatura válida | worker test |

Pentest pelo `docs/qa/pentest.md` (A1 entrada, A2 webhook, A3 sessão, A7
injeção) no fim.

## 10. Testes

| CA | Teste |
| --- | --- |
| CA1–CA3 | `apps/agent/test/crm-service.test.ts`, `packages/shared/test/crm.test.ts` |
| CA4, CA5, CA7 | `apps/agent/test/crm-events.test.ts`, `apps/agent/test/worker.test.ts` |
| CA6 | `apps/agent/test/crm-routes.test.ts` |
| CA8, CA9 | `apps/agent/test/crm-service.test.ts` |
| CA10, CA11 | `apps/agent/test/crm-tools.test.ts` |
| CA12 | teste do lint de logs |
| CA13 | `tests/e2e/clientes.spec.ts` com axe |
| Orçamento | `apps/agent/test/free-tier-budget.test.ts` |
| Migration | `apps/agent/test/migrations.test.ts` |

## 11. Entrega

Um PR para a `develop` com `changelog/nao-lancado/etapa-22b-crm.md`
(`<!-- versao: minor -->`), README, capturas da aba Clientes, `docs/crm.md`,
especificação e `progresso.md`.

## 12. Riscos

- **Assinatura no n8n**: o corpo assinado tem de ser o mesmo enviado; o
  `docs/crm.md` mostra o corpo em texto cru.
- **Escritas**: 1.000 eventos por dia somam 10% da cota; o teto protege.
- **JS inicial**: a aba fica num pedaço próprio; a rota ganha só `:aba?`.

## 13. Suposições

- Etapas padrão (no idioma do dono, criadas na primeira leitura): Novo, Em
  conversa, Agendado, Cliente, Inativo.
- `ref` é o id do cliente no sistema do n8n (por exemplo o id do contato no
  Chatwoot); sem `ref`, o cliente só existe pela tela.
- Evento de atividade para `ref` desconhecido cria o cliente quando traz nome;
  sem nome, 422.
- Etapa recebida pelo nome (sem diferença de maiúsculas); nome desconhecido é
  ignorado e o resto do evento vale.
- Aviso de aniversário às 9 h do fuso do dono.

## 14. Entrevista com o Pablo

Rodada 1 (03/11/2026, 20:10), na thread da etapa:

1. **Onde fica o CRM?** Recomendação: aba Clientes dentro de Contatos, sem
   custo no JS inicial. Alternativa: item Clientes no menu (+0,3 kB no teto).
2. **Tetos de volume?** Recomendação: 5.000 clientes, 1.000 eventos por dia
   (300 por hora), 100 registros de histórico por cliente.
3. **A Zuri mexe no CRM pela conversa?** Recomendação: sim, sem pedir (etapa,
   etiquetas, retorno e anotação); apagar só na tela. Alternativa: só consulta.

Resposta do Pablo (03/11/2026, 17:17 no horário de Brasília): "sim" para as três. Fica a aba
Clientes dentro de Contatos, os tetos de 5.000 clientes, 1.000 eventos por dia
(300 por hora) e 100 registros de histórico por cliente, e a Zuri muda etapa,
etiquetas, retorno e anotações pela conversa sem pedir; apagar cliente só na tela.

### Perguntas abertas

Nenhuma.
