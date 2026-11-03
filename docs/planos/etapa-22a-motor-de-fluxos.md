# Plano · Etapa 22a · Motor de fluxos, conexões e monitor de sites

Situação: aprovado em 03/11/2026 (o Pablo aceitou as duas recomendações da seção 14)
Origem: etapa 22 da especificação, dividida pelo plano `docs/planos/workflows-n8n.md` (decisão do Pablo, 02/11/2026)
Dependências: 9, 10, 11 e 18 mescladas (`develop` em 19f1b6b). A 20 (tokens remotos) não é necessária: webhooks de entrada ficam para a 22b.

## 1. Resumo

A Zuri ganha um motor de **fluxos**: um gatilho (agenda ou manual) e até 20
passos de um catálogo fechado, montados num formulário na tela, sem código e
sem HTTP livre. Cada chamada para fora vai a uma **conexão** cadastrada com
senha recente (origem fixa, métodos e caminhos permitidos, credencial cifrada).
O **monitor de sites** da especificação vira o primeiro modelo de fluxo:
confere até 10 endereços de 15 em 15 minutos, tenta 3 vezes antes de dizer que
caiu e avisa quando cai e quando volta. Tudo roda no alarme único do Durable
Object, dentro do plano grátis.

## 2. Contexto no sistema

- **Alarme único** (P8): `apps/agent/src/automations/service.ts`
  (`AutomationService.rearm`, `otherDue`) e `ZuriAgent.runAutomations` em
  `apps/agent/src/agent/zuri-agent.ts`. O motor entra como mais um passo depois
  de `automations.wake`, como `contacts.tick()`.
- **Agenda**: `Schedule`, `nextRun` e `scheduleSchema` de
  `packages/shared/src/schedule.ts` e `automations.ts` (reaproveitados no gatilho).
- **Fetch protegido** (18): `apps/agent/src/mcp/url.ts` (`endpointUrl`,
  `assertPublicHost`, `dohResolver`, `isPrivateHost`) e `mcp/guarded-fetch.ts`
  (`limitBody`, `McpConnectionError`). `SubrequestMeter` em `mcp/session.ts`.
- **Cifra**: `McpCredentials(MCP_CREDENTIAL_KEY, info)` em `mcp/credentials.ts`;
  os fluxos usam `info = "flows-v1"` e o id da conexão como dado associado.
- **IA**: `MeteredAI.generate` em `apps/agent/src/ai/metered.ts` (teto de 9.000
  Neurons), blocos `<data>` em `apps/agent/src/agent/data.ts`.
- **Avisos**: `AlertService.raise` em `apps/agent/src/alerts/service.ts`;
  `DiagnosticsService.record`.
- **Bloqueio** (16b): `auth.lockdown.active()`; rotas fora de `WHILE_LOCKDOWN`
  (`apps/agent/src/api/app.ts`) já são recusadas no bloqueio.
- **Tempo real**: `zur_area_versions` (migration 21) e `AREAS` em
  `packages/shared/src/areas.ts`.
- **Tela**: `apps/web/src/pages/automations/AutomationsPage.tsx` (rota
  `/automacoes`, sob demanda), `ReauthDialog`, `ui.tsx`.
- **Bot**: `/status` em `apps/agent/src/telegram/`.
- Decisões: 02/11/2026 "Fluxos do n8n na etapa 22" (CRM interno, atendimento no
  n8n); 03/11/2026 autonomia MCP (#120); teto do JS inicial 139,6 kB
  (03/11/2026, etapa 19b); regras P1 a P14 (`.claude/rules/performance.md`).
- Talorys: não tem motor de fluxos; nada a aproveitar além do monitor que a
  especificação já descreve.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Endereços do monitor só pela tela, com senha recente: até 10 no total, só https, sem credenciais na URL, sem IP literal, sem o host do próprio Zuri, só porta 443, query de até 200 caracteres | especificação |
| CA2 | Nenhuma ferramenta do agente, comando do bot ou token remoto cria, liga ou altera um fluxo, uma conexão ou um endereço (teste por caminho) | especificação + prompt da etapa |
| CA3 | Monitor usa o fetch protegido: sem redirecionamento, 10 s, no máximo 64 KB lidos; nada do corpo vai ao modelo, só status e tempo | especificação |
| CA4 | Intervalo mínimo de 15 min (1 h se o fluxo tem passo de IA) | especificação + plano |
| CA5 | Cada endereço tem 3 tentativas duráveis (1 min e 5 min depois) antes de contar como fora do ar; o aviso sai na queda e na volta, uma vez por mudança | especificação |
| CA6 | `/status` no bot mostra os monitores e os fluxos com falha | especificação |
| CA7 | Fluxo: um gatilho (agenda ou manual) e de 1 a 20 passos do catálogo (requisição, filtro, campos, espera, aviso, IA, monitor); definição validada por Zod com versão do formato | plano |
| CA8 | Conexões: nome, origem https pública, métodos (GET, POST, PUT, PATCH) e até 10 prefixos de caminho; credencial nenhuma, Bearer ou cabeçalho próprio; cifrada, nunca devolvida, logada ou enviada ao modelo; trocar a origem apaga a credencial; criar e mudar pedem senha recente e geram alerta | plano |
| CA9 | Toda requisição de fluxo sai só para a origem da conexão, com método e caminho permitidos, pelo fetch protegido (DNS conferido, sem redirecionamento, 10 s, até 256 KB) | plano |
| CA10 | Tetos: 20 fluxos, 20 passos, 40 chamadas e 200 itens por execução, 500 execuções e 3.000 Neurons por dia somando os fluxos; 20 subrequisições por despertar (o resto continua no despertar seguinte) | plano |
| CA11 | Fluxo nasce desligado; ligar, criar e mudar pedem senha recente | prompt da etapa |
| CA12 | No bloqueio nenhum fluxo roda (execução `skipped`, problema `lockdown`) e as rotas de fluxos respondem 423 | especificação (modo de bloqueio) |
| CA13 | Tudo o que entra (resposta de conexão, campos) vai ao modelo só em `<data source="flow">` neutralizado e nunca muda a definição | prompt da etapa |
| CA14 | Falha temporária de requisição tenta de novo em 1, 5 e 15 min (3 tentativas); erro 4xx encerra; a execução guarda o ponto de retomada e um reinício nunca roda o mesmo passo duas vezes | plano |
| CA15 | Histórico das últimas 2.000 execuções com estado, problema, chamadas, itens e Neurons; falha vai ao Diagnóstico | plano (novo) |
| CA16 | Dados de contato fora dos logs: o lint de logs passa a barrar telefone | prompt da etapa |
| CA17 | Tela Fluxos com estados vazio, carregando e erro, teclado, leitor de tela, celular, claro e escuro, axe e e2e; ação "Novo fluxo" na paleta | padrão de qualidade (31/10/2026) |

## 4. Escopo

**Entra:** motor no Durable Object, catálogo de 7 passos, conexões, monitor de
sites como modelo, aba Fluxos em Automações, histórico, `/status`, migration 24,
especificação atualizada.

**Fica fora:**

- Rota de eventos do n8n com HMAC, CRM, contatos com funil: 22b.
- Passos da Google Agenda e do Google Contatos: 22c.
- Proposta de fluxo pela conversa: 22b (nesta etapa o chat não tem nenhuma
  ferramenta de fluxo, o que já cumpre "o chat só propõe").
- Envio a terceiros (WhatsApp, Chatwoot, e-mail para outra pessoa): fica no n8n
  (decisão de 02/11/2026).
- Cloudflare Workflows (binding `WORKFLOW`): nenhum fluxo desta etapa passa de
  15 min; continua opção para fluxo longo, recebendo só ids.
- DELETE em conexão: proibido nesta etapa (pergunta 2).
- Editor de arrastar nós: o editor é um formulário passo a passo.

## 5. Como funciona para o Pablo

### Fluxo 1 · Criar o monitor de sites

1. Automações › aba **Fluxos** › **Monitor de sites**.
2. Diálogo: nome (padrão "Monitor de sites") e até 10 endereços, um por linha.
   Erro por linha ("Use um endereço https sem senha, sem IP e na porta 443").
3. Salvar pede a senha se ela não foi digitada há pouco (`ReauthDialog`). O
   fluxo nasce desligado, com o botão **Ligar**.
4. Ligado, a lista mostra "A cada 15 min · próxima às 14:30" e, depois da
   primeira execução, cada site com "No ar · 120 ms" ou "Fora do ar desde 14:15".
5. Caiu (3 tentativas): aviso "exemplo.com.br está fora do ar" (prioridade
   alta). Voltou: "exemplo.com.br voltou".

### Fluxo 2 · Cadastrar uma conexão

1. Aba Fluxos › seção **Conexões** › **Nova conexão**.
2. Nome, endereço base (https), métodos permitidos (GET marcado; POST, PUT e
   PATCH desmarcados), caminhos permitidos (padrão `/`), credencial (nenhuma,
   Bearer, cabeçalho próprio com nome e valor). O valor nunca volta à tela:
   "Credencial guardada" e o botão **Trocar**.
3. Salvar pede senha recente e gera o alerta de segurança "Conexão de fluxo
   adicionada".

### Fluxo 3 · Montar um fluxo

1. **Novo fluxo** (botão ou paleta Ctrl/⌘K).
2. Nome, gatilho (Manual ou Agendado, com os mesmos campos das rotinas).
3. **Adicionar passo**: Requisição, Filtro, Campos, Espera, Aviso, IA, Monitor.
   Cada passo é um cartão com o formulário dele, botões subir, descer e remover.
4. Salvar valida no servidor; erro aparece no passo certo.
5. **Executar agora** roda na hora e mostra o resultado no histórico.

### Estados da tela

Carregando (esqueleto), erro com **Tentar de novo**, vazio ("Nenhum fluxo
ainda" com os botões Monitor de sites e Novo fluxo), lista, fluxo com falha
(selo vermelho com o motivo), teto de 20 atingido (botões desligados com o
motivo), chave de cifra ausente (credencial indisponível, conexões sem
credencial seguem funcionando).

### Textos visíveis

Catálogo novo `packages/shared/i18n/pt-BR-flows.ts` (`addMessages`) com as
traduções em `en.ts`; avisos do servidor em `pt-BR-server.ts`. Passados pela
`humanizer:humanizer`. Exemplos:

| Chave | pt-BR | en |
| --- | --- | --- |
| `web.flows.tab` | Fluxos | Flows |
| `web.flows.empty.title` | Nenhum fluxo ainda | No flows yet |
| `web.flows.monitor.new` | Monitor de sites | Site monitor |
| `notice.flow.siteDown.title` | {host} está fora do ar | {host} is down |
| `notice.flow.siteUp.title` | {host} voltou | {host} is back up |
| `notice.flow.failed.title` | O fluxo {name} falhou | The flow {name} failed |

## 6. Regras de negócio e limites

| Limite | Valor | No limite |
| --- | --- | --- |
| Fluxos guardados | 20 | 409 `CONFLICT` `error.flowLimit` |
| Passos por fluxo | 20 | 400 `VALIDATION_FAILED` |
| Conexões | 20 | 409 `CONFLICT` |
| Sites do monitor, somando todos os fluxos | 10 | 400 `VALIDATION_FAILED` `error.flowSitesLimit` |
| Query de um site | 200 caracteres | 400 |
| Intervalo mínimo | 15 min; 60 min com passo de IA | 400 |
| Chamadas por execução | 40 | execução `error`, problema `calls_limit` |
| Subrequisições dos fluxos por despertar | 20 (DNS incluído) | a execução espera 1 min e continua |
| Itens por execução | 200 | `error`, `items_limit` |
| Estado guardado de uma execução | 256 KB | `error`, `too_large` |
| Resposta lida | 256 KB (monitor: 64 KB) | `error`, `too_large` (monitor: lê 64 KB e para, sem erro) |
| Tempo de uma requisição | 10 s | tentativa nova |
| Tentativas | 3 (1, 5, 15 min) | `error` com o problema da última |
| Execuções por dia (UTC) | 500 | `skipped`, `runs_limit` |
| Neurons por dia dos fluxos | 3.000 (dentro dos 9.000) | `skipped`, `ai_limit` |
| Espera | 1 min a 30 dias | 400 |
| Avisos por execução | 10 | o resto é contado num aviso só |
| Histórico | 2.000 execuções | as mais antigas saem em lote |
| Falhas seguidas | 5 | o fluxo desliga sozinho e avisa |

- Um horário perdido roda uma vez quando o objeto acorda (até 24 h), como nas
  automações; um fluxo nunca tem duas execuções ao mesmo tempo.
- Apagar uma conexão usada por um fluxo: 409 `CONFLICT` com o nome do fluxo.
- Mudar a definição de um fluxo ligado recalcula a próxima execução; uma
  execução esperando continua com a definição que tinha (a definição vai no
  estado).

## 7. Desenho técnico

### Arquivos

- `packages/shared/src/flows.ts`: tipos, `FLOW_LIMITS`, sem Zod (a tela usa).
- `packages/shared/src/flows-schemas.ts`: `flowDefinitionSchema`,
  `flowCreateSchema`, `flowUpdateSchema`, `flowConnectionCreateSchema`,
  `flowConnectionUpdateSchema`, `flowRunsQuerySchema`, `monitorSiteUrl`.
- `apps/agent/src/flows/service.ts`: `FlowService` (CRUD, ligar, alarme,
  execuções, histórico, tetos).
- `apps/agent/src/flows/engine.ts`: executor dos passos com o ponto de
  retomada.
- `apps/agent/src/flows/paths.ts`: leitura de caminhos (`a.b.0`) e
  substituição `{{campo}}`, sem `__proto__`, `constructor` e `prototype`.
- `apps/agent/src/flows/connections.ts`: `FlowConnections` (cifra, conferência
  de método e caminho, requisição protegida).
- `apps/agent/src/flows/monitor.ts`: conferência de sites e o estado de cada um.
- `apps/agent/src/api/flows.ts`: rotas.
- `apps/web/src/pages/automations/FlowsPanel.tsx` (+ `FlowEditor.tsx`,
  `ConnectionsSection.tsx`), carregados sob demanda dentro de Automações.
- `apps/web/src/lib/flows.ts`, `packages/shared/i18n/pt-BR-flows.ts`.

### Rotas e contratos

Todas com sessão + CSRF; nenhuma em `WHILE_LOCKDOWN`.

| Método e rota | Senha recente | Respostas |
| --- | --- | --- |
| GET `/api/flows` | — | 200 `{flows, connections, counts, sites}` |
| POST `/api/flows` | sim | 201 `{flow}` (desligado); 400; 409 |
| PATCH `/api/flows/:id` | sim (definição, nome ou ligar) | 200 `{flow}`; 404; 409 |
| DELETE `/api/flows/:id` | — | 200 `{deleted:true}` |
| POST `/api/flows/:id/run` | — | 200 `{run}`; 409 (já rodando) |
| GET `/api/flows/runs?flow=&before=` | — | 200 `{runs, nextCursor}` |
| POST `/api/flows/connections` | sim | 201 `{connection}` + alerta |
| PATCH `/api/flows/connections/:id` | sim | 200 `{connection}` + alerta |
| DELETE `/api/flows/connections/:id` | — | 200; 409 em uso |

### Banco

Migration 24 (`flows`), só acréscimo:

- `zur_flows` (id, name, definition JSON, enabled, uses_ai, next_run,
  last_run_at, last_run_status, failures, created_at, updated_at).
- `zur_flow_connections` (id, name, origin, methods JSON, paths JSON, auth,
  header_name, credential, created_at, updated_at).
- `zur_flow_runs` (id, flow_id, flow_name, trigger, slot, status, problem,
  node, attempt, resume_at, state, calls, items, neurons, detail, started_at,
  finished_at; único por `flow_id, slot`; índices por início e por retomada).
- `zur_flow_sites` (flow_id, url, state, status, ms, since, checked_at).
- `zur_area_versions` ganha a coluna `flows`.

### Ferramentas do agente

Nenhuma. O registro de ferramentas e o contexto delas não recebem o
`FlowService` (teste).

### Agendamentos, IA e integrações externas

- `FlowService.tick()` roda no alarme depois de `automations.wake`; `nextDue()`
  entra no `otherDue` (próximo horário ou retomada).
- Até 3 execuções por despertar, 20 subrequisições e 60 s no total; o que
  sobra espera 1 min.
- Passo de IA: `agent.ai().generate` com instrução do dono como sistema e os
  itens em `<data source="flow">`, 512 tokens de saída; Neurons contados por
  uma nova opção `onNeurons` do `MeteredRequest` e recusados antes se a
  estimativa passar do que sobra dos 3.000.

## 8. Custo e cotas do plano Free

Fontes: `docs/arquitetura/orcamento-free-tier.md` e
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

| Cota | Típico (monitor de 5 sites a cada 15 min) | Pior caso (500 execuções) |
| --- | --- | --- |
| Requisições ao DO | ~96 alarmes/dia (já compartilhados) | ~500 |
| Linhas escritas | ~96 × 8 = ~800 | 500 × 20 = 10.000 (10%) |
| Subrequisições | 5 + 2 DNS por despertar | 20 por despertar |
| Neurons | 0 | 3.000 (um terço do teto) |

Nada pago; nenhum binding novo.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| SSRF por endereço de site ou conexão | `endpointUrl` + `assertPublicHost` em toda requisição, sem redirecionamento, sem IP literal, sem o host do Zuri | flows-security.test.ts |
| Caminho fora do permitido (`/../`, `%2e%2e`, `//outro.host`) | URL montada sobre a origem e conferida depois de normalizada; prefixo por segmento | idem |
| Valor de item mudando o caminho | `{{campo}}` passa por `encodeURIComponent` | idem |
| Cabeçalho de credencial perigoso (`cookie`, `host`) | nome do cabeçalho de uma lista recusada, regex de token HTTP | schema test |
| Prototype pollution por caminho | segmentos proibidos e objetos sem protótipo | paths test |
| Injeção de prompt pela resposta | `<data source="flow">` neutralizado; o modelo não tem ferramentas | engine test |
| Agente, bot ou token mudando fluxo | sem ferramenta; rotas só com sessão; bot só lê no `/status` | CA2 |
| Credencial vazando | cifrada com AD = id; nunca em resposta, log, prompt ou estado da execução | routes test |
| Sessão roubada criando saída de dados | senha recente + alerta de segurança | routes test |
| Bloqueio | 423 nas rotas; execução `skipped` | service test |
| DNS rebinding | o fetch do Workers resolve de novo depois da nossa conferência; risco aceito: a rede da Cloudflare não alcança endereços privados do dono, e a conferência barra o caso comum. Reavaliar se a Zuri for para uma VPS | — |
| Dados de contato em log | lint barra telefone; logs só com códigos | log test |

Pentest da funcionalidade pelo `docs/qa/pentest.md` (A1 entrada, A3 sessão,
A6 SSRF, A7 injeção) no fim.

## 10. Testes

| CA | Teste |
| --- | --- |
| CA1 | `packages/shared/test/flows.test.ts` (URLs n−1, n, n+1 da query; 10 e 11 sites) e `apps/agent/test/flows-routes.test.ts` |
| CA2 | `apps/agent/test/flows-routes.test.ts` (ferramentas, comandos do bot, rotas) |
| CA3, CA5 | `apps/agent/test/flows-monitor.test.ts` |
| CA4, CA7, CA10 | `packages/shared/test/flows.test.ts`, `apps/agent/test/flows-engine.test.ts` |
| CA6 | `apps/agent/test/telegram-commands.test.ts` |
| CA8, CA9, CA13 | `apps/agent/test/flows-security.test.ts` |
| CA11, CA12 | `apps/agent/test/flows-routes.test.ts`, `flows-service.test.ts` |
| CA14, CA15 | `apps/agent/test/flows-service.test.ts` |
| CA16 | teste do lint de logs |
| CA17 | `tests/e2e/fluxos.spec.ts` com axe |
| Orçamento | `apps/agent/test/free-tier-budget.test.ts` (rotas e uma execução) |
| Migration | `apps/agent/test/migrations.test.ts` |

## 11. Entrega

Um PR para a `develop` com fragmento `changelog/nao-lancado/etapa-22a-fluxos.md`
(`<!-- versao: minor -->`), README ("O que já funciona"), capturas da aba
Fluxos (computador e celular, claro e escuro), `docs/fluxos.md`, especificação
atualizada (tabelas `flows`, `flow_connections`, `flow_runs`, `flow_sites`) e
`progresso.md`.

## 12. Riscos

- **Tamanho da tela**: o editor é o maior pedaço; fica num pedaço próprio,
  carregado só ao abrir.
- **Subrequisições do despertar**: o alarme já faz outras chamadas; os 20 dos
  fluxos deixam margem dentro dos 50.
- **Neurons**: um fluxo de IA de hora em hora gasta ~380 por dia; o teto de
  3.000 protege o chat.

## 13. Suposições

- O passo "laço" do plano geral é o modo **um por item** do passo Requisição
  (com o teto de 40 chamadas); não há passo de laço separado.
- Filtro só deixa passar itens (sem ramo "senão"); ramos ficam para depois.
- Resposta 3xx do monitor conta como "no ar" (o site respondeu), sem seguir.
- O primeiro estado de um site não gera aviso ("no ar" ao ligar não avisa;
  "fora do ar" na primeira conferência avisa).
- Fluxo desligado sozinho depois de 5 falhas seguidas.

## 14. Entrevista com o Pablo

Rodada 1 (03/11/2026), enviada na thread da etapa:

1. **Onde fica a tela?** Recomendação: aba Fluxos dentro de Automações (sem
   custo no JS inicial). Alternativa: item no menu, com o teto subindo para
   ~139,8 kB.
2. **Escrita sem pedir a cada execução?** Recomendação: sim, só com os métodos
   marcados na conexão (POST, PUT, PATCH), cadastrada com senha; DELETE
   proibido. Alternativa: toda escrita vira proposta.

Resposta do Pablo (03/11/2026, 14:49): "Sim, para as duas perguntas". Fica a
aba Fluxos dentro de Automações, sem subir o teto do JS inicial, e a escrita
sem pedir a cada execução, só com os métodos marcados na conexão, sem DELETE.

### Perguntas abertas

Nenhuma.
