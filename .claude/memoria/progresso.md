# Progresso das etapas

Passagem de bastão entre conversas. Cada etapa começa numa conversa nova e lê
este arquivo **em vez** do histórico das anteriores. Atualize no mesmo PR da
etapa, antes de mesclar. Mantenha curto (até ~80 linhas): só as 3 últimas
etapas ficam detalhadas; as mais antigas viram uma linha na tabela.

## Modo contínuo

- Situação: ligado
- Avanço: mescla sozinho na `develop`, sem pausa por fase (decisão do Pablo, 30/10/2026)
- Pausado por:

## Etapas

| Etapa | Situação | PR | Resumo em uma linha |
| --- | --- | --- | --- |
| 0 | mesclada (31/10/2026) | #1 | Monorepo, CI, CodeQL, rulesets, Dependabot |
| 1 | mesclada (31/10/2026) | #6 | Worker único, Durable Object `ZuriAgent` e os seis portões |
| 2 | mesclada (31/10/2026) | #7 | Migration 1, configurações (idioma e fuso), erros no idioma do dono, lint de i18n |
| 3 | mesclada (31/10/2026) | #8 | Login, sessões, CSRF, força bruta, Turnstile adaptativo, atividade de acesso |
| 4 | mesclada (31/10/2026) | #9 | 2FA TOTP, códigos de recuperação, desafio em cookie, passkeys reutilizáveis |
| 5 | mesclada (31/10/2026) | #10 | Casca da interface: login com 2FA, guarda de sessão, configurações, PWA (fecha a fase A) |
| 6 | mesclada (31/10/2026) | #12 | Tarefas, notas (Markdown, FTS5), projetos, lixeira de 30 dias, limites por tipo |
| 7 | mesclada (31/10/2026) | #21 | Memória com estados atual/incerta/passada, substituição sem ciclos, fila de revisão, recordação em `<data>` |
| 8 | mesclada (31/10/2026) | #25 | Provedor Workers AI e IA simulada, medição por passo, teto de 9.000 Neurons/dia, aba IA |
| 9 | mesclada (31/10/2026) | #28 | Conversa em SSE, 20 ferramentas com permissão e limite, aprovações e planos, voz, injeção de prompt testada |
| 10 | mesclada (02/11/2026) | #46 | Automações: lembretes, resumo das tarefas e rotinas com IA, alarme único, recuperação após reinício, aprovação das rotinas do chat |
| 11 | mesclada (02/11/2026) | #55, #56, #63, #64 | Central de avisos, Diagnóstico, notificação no aparelho, e-mail e recuperação de senha, prioridade que aprende |
| 12 | mesclada (02/11/2026) | #70 | Fundação do bot do Telegram: cliente da Bot API, webhook com travas, vínculo por código confirmado no app, cartão em Configurações › Avisos |
| 13 | mesclada (02/11/2026) | #73 | Avisos no Telegram: canal da central, discreto com "Texto completo", botões Feito/Adiar/Silenciar/Abrir, grupo opcional com tópicos |
| 14 | mesclada (02/11/2026) | #75 | Conversa e voz no Telegram: conversa do app pelo bot, HTML em blocos, voz até 5 min/5 MB, pergunta antes de baixar arquivo grande, terceiros como `<data>` |
| 15a | mesclada (02/11/2026) | #84 | Trava de leitura do bot com `/destravar` (passkey na página `/aprovar` ou código por e-mail), `/nova_conversa`, 60 comandos/hora |
| 15b | mesclada (02/11/2026) | #89 | Comandos rápidos sem IA (`/hoje`, `/tarefas`, `/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`, `/avisos`, `/uso`, `/status`, `/backup`), gramática de datas, fotos e documentos viram nota, botão Destravar |
| 16a | mesclada (02/11/2026) | #93 | Aprovações pelo bot: botão **Aprovar** com prévia do servidor, `/aprovar`, confirmação por passkey ou e-mail presa à proposta e ao hash, `TARGET_CHANGED`, alerta `telegram_approved` |
| 16b | mesclada (02/11/2026) | #96 | Comandos de segurança (`/acessos`, `/sessoes`, `/encerrar_sessoes`, `/tokens`, `/pausar_rotinas`, `/bloquear`), modo de bloqueio com a tela **Sair do bloqueio**, rebloqueio que suspende o vínculo, **Confirmar que vi** no app |
| 17 | mesclada (02/11/2026) | #99 | Busca por significado opcional: vetores `bge-m3` em `int8` no SQLite do objeto, fila por gatilhos, preparo no alarme único com tetos diários, busca híbrida na paleta, na recordação, na ferramenta `search` e no `/buscar` |
| 18a | mesclada (03/11/2026) | #105 | Servidores MCP remotos (sem login ou token fixo): fetch protegido contra SSRF, token cifrado, catálogo revisado pelo dono, triagem por turno com `find_tools`, cartão com os dados exatos, tela Configurações › Integrações |
| 18b | mesclada (03/11/2026) | #111 | Login OAuth nos servidores MCP (PKCE, registro dinâmico, botão **Entrar no serviço**), triagem das ferramentas pelo significado, aprovação de chamadas externas pelo bot e pela página `/aprovar` |
| 19 | mesclada (03/11/2026) | #136 | Google Agenda: OAuth próprio do dono, agendas fechada/só ler/ler e editar, 5 ferramentas (apagar e mudar evento com convidados são propostas), `/hoje` com agenda, modelos de rotina, tela **Agenda** (dia, semana, mês) em tempo real por push do Google |
| 19b | mesclada (03/11/2026) | #144 | Google Contatos: cópia só leitura das etiquetas escolhidas (até 5.000, de hora em hora com `syncToken`), tela **Contatos**, avisos de aniversário e datas especiais, `search_contacts` e `get_contact` |

## Últimas etapas (detalhe)

### Etapa 19b · Google Contatos
- Entregou: `apps/agent/src/google/contacts.ts` (`GoogleContacts`: etiquetas, sincronização com trava no banco e `mine(stamp)`, páginas de 1.000 até 10 por despertar, `syncToken` com recomeço único quando vence, teto 5.000, backoff 30 min → 6 h, avisos de aniversário/datas/entrada em etiqueta, busca por nome, pedaço do telefone e e-mail), `contacts-store.ts` (`forgetContacts`), `GoogleCalendar.begin(session, "contacts")` com `include_granted_scopes`, `people()` e erros `expired`/`api_disabled`/`contacts_scope`, People API simulada em `dev-google.ts`, rotas `/api/google/contacts*` e `/api/contacts*` em `api/google.ts`, `tools/contacts.ts` (2 ferramentas `read`, `<data source="contact">`), `ContactsSection.tsx` no cartão do Google, tela `pages/contacts/ContactsPage.tsx` (textos em `pt-BR-contacts.ts`), área `contacts` em `zur_area_versions`. Doc: `docs/google-contatos.md`. Plano: `docs/planos/google-contatos.md`.
- Migrations: 23 (`google_contacts`). A próxima livre é a 24.
- Decisões técnicas: os avisos de aniversário e datas moram no módulo dos contatos (o `CHECK` de `zur_automations.kind` não aceita tipo novo sem recriar a tabela); desligar os contatos apaga a cópia sem revogar (o revoke do Google derruba a agenda junto), desconectar o Google revoga e apaga; 29/02 avisa em 28/02 nos anos comuns; exportar CSV ficou fora.
- Para as próximas: o backup (23) deixa de fora `zur_contact_*` (a cópia se refaz do Google); a 22c usa `GoogleContacts.search` para os nós de contatos.

### Etapa 19 · Google Agenda
- Entregou: `apps/agent/src/google/` (`service.ts` `GoogleCalendar`: OAuth PKCE com cliente confidencial, tokens cifrados com `McpCredentials(MCP_CREDENTIAL_KEY, "google-v1")`, agendas, eventos com `If-Match`, canais de push `events.watch` renovados no alarme com prazo em memória; `events.ts`; `errors.ts`; `dev-google.ts` Google simulado no local), `gates/google-push.ts` (token HMAC do `SESSION_SECRET`, exceção do Access), rotas em `api/google.ts`, `tools/calendar.ts` (5 ferramentas, `change_shared_calendar_event` destrutiva; `commitAsync` e `TargetGone` no registry; `offered(ctx)`), `/hoje` com agenda, modelos de rotina em `AutomationsPage.tsx`, tela `pages/agenda/AgendaPage.tsx` e `lib/agenda.ts`, cartão `pages/settings/GoogleCard.tsx`. Doc: `docs/google-agenda.md`. Plano: `docs/planos/etapa-19-google-agenda.md` (seção 15: tela Agenda, pedido do Pablo).
- Migrations: 22 (`zur_google_account`, `zur_google_calendars`, coluna `calendar` em `zur_area_versions`). A próxima livre é a 23.
- Decisões: tela Agenda só mexe em eventos, nunca em agendas ("Só eventos", 03/11/2026); escopos `calendar.events` + `calendar.calendarlist.readonly`; o Google volta em `/rest/oauth2-credential/callback` (sem hífen), que o Worker repassa para `/configuracoes/integracoes`, com `state` prefixado `g.`; teto do JS inicial 139,4 kB; eventos nunca guardados no banco.
- Para as próximas: a 19b pede `contacts.readonly` na mesma conexão (`include_granted_scopes`; `scopes` guarda o que o Google deu); a 22c usa `GoogleCalendar` para os nós da agenda.

### Ajuste da 18 · Autonomia por ferramenta MCP (#120, 03/11/2026)
- Entregou: três níveis por ferramenta (`approve`, `auto`, `routines`; no banco `policy` + coluna `routines`, lidos por `levelOf`); `mcp/classify.ts` (a Zuri classifica cada ferramenta em `read`/`write`/`destructive` por palavras no nome, descrição e campos, sem IA; na dúvida `write`; a marcação do servidor só deixa mais cauteloso; o dono confirma na coluna `kind`); ferramentas externas nas rotinas com IA (`AgentRunner.scheduled` com `turnTools(automationId)`), liberação por rotina (`zur_automation_mcp_tools`, até 10, nunca destrutiva), propostas de rotina na conversa "Rotina: <nome>" com validade de 24 h (`MCP_LIMITS.routineProposalTtlMs`), até 3 por execução, 12 subrequisições externas por despertar (`ROUTINE_MCP_BUDGET`). Senha recente para subir nível, baixar a cautela do tipo, liberar para rotina e criar/mudar/aprovar rotina com IA enquanto algo roda sozinho em rotinas. Plano: `docs/planos/autonomia-mcp.md`.
- Migrations: 20 (`mcp_autonomy`). A próxima livre é a 21. Coluna acrescentada por `ALTER` não leva `CHECK` (ver `armadilhas.md`).
- Para as próximas: a 22 (workflows) reaproveita a liberação por automação; ferramenta nova da Zuri que escreve continua fora das rotinas.

### Etapa 18b · Login OAuth, triagem por significado e aprovação pelo bot
- Entregou: `mcp/oauth.ts` (`ZuriOAuthProvider` sobre o `OAuthClientProvider` do SDK, cliente público, não interativo fora de ações do dono), `mcp/meaning.ts` (`McpMeaning`: vetor int8 por ferramenta ligada, feito no alarme depois de `semantic.tick`, chave FNV de modelo+texto), `mcp/dev-oauth.ts` (servidor de login simulado em `entrar.exemplo.com.br`, código `dev.<challenge>` no local), `POST /api/mcp/oauth/callback` (senha recente, `state` 10 min uso único), `SemanticSearch.known()`, `mcp_call` em `telegram/approvals.ts` (`BOT_MCP_BUDGET = 12`, resposta citada até 600) e na página `/aprovar`, linha no `/status`. Plano: `docs/planos/etapa-18b-mcp-oauth.md`.
- Migrations: 19 (`authorize_url`, `authorize_expires`, `signed_in_at` em `zur_mcp_servers`; `embedding`, `embedding_scale`, `embedding_key` em `zur_mcp_tools`). A próxima livre é a 20.
- Decisões técnicas: volta do login em `/configuracoes/integracoes` (rota em português, nada no JS inicial); problema `signin` nunca pausa o servidor; hash de aprovação de servidor OAuth usa `signed_in_at` (renovar token não anula proposta); fora da origem cadastrada só o servidor de login, sem `Authorization`; `find_tools` segue por palavras.
- Para as próximas: a 19 tem OAuth próprio do Google (cliente do dono, confidencial), não o `ZuriOAuthProvider`; pode cifrar com `MCP_CREDENTIAL_KEY` usando outro `info` no HKDF ou chave própria.

### Notas que continuam valendo
- Um alarme só (P8): use `AutomationService.rearm()`/`otherDue`, nunca outro alarme. O runner aceita `context: "scheduled"` (ferramentas da Zuri só leem; externas só as liberadas para rotinas, o resto vira proposta de 24 h). Toda IA por `agent.ai()`.
- Bloqueio (16b): a etapa 20 liga os tokens no `RemoteTokenHook` (`suspendAll`/`resumeAll`/`active`) e põe **Revogar** em `/tokens`; IA, MCP e workflows em segundo plano consultam `auth.lockdown.active()`; rota que precise funcionar no bloqueio entra em `WHILE_LOCKDOWN`.
- Busca por significado (17): item novo com texto pesquisável ganha entrada em `KIND_SOURCES` e migration nova em `SEMANTIC_MIGRATIONS`.
- JS inicial em ~138,2 kB (teto 139,4): tela nova sob demanda, textos via `addMessages`; tela que trava o app vai no chunk de `PasswordChangePage`.

<!-- Modelo, até 10 linhas por etapa:
### Etapa NN · <nome>
- Entregou: arquivos/rotas/tabelas principais.
- Migrations: versão N (o quê).
- Decisões técnicas tomadas: ...
- Ficou para depois: ...
- Riscos ou dívidas: ...
- Atenção para a próxima: ...
-->

### Trabalho paralelo · Login seguro, Turnstile e Acessos (31/10/2026)
- Entregou: Turnstile em todo login, obrigatório fora do local (`signInTurnstile` em `zuri-agent.ts`, chaves de teste só no local), `GET /api/auth/login-options` no Worker, `GET /api/auth/activity` com filtros e cursor (`AuthEvents.page`), página `/acessos` (`pages/security/AccessLogPage.tsx`). Relatório `docs/qa/revisao-de-login.md`; passo a passo `docs/configuracao-cloudflare.md`.
- Migrations: nenhuma (o registro com IP já existia em `zur_auth_events`).
- Atenção: testes de rota precisam de `turnstileToken: HUMAN_TOKEN` (vitest com chaves inventadas e `test/setup-turnstile.ts`); e2e importa `test` de `tests/e2e/fixtures.ts`. Antes do deploy o Pablo grava `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`.

## Exigências de QA (desde 31/10/2026)

- Toda etapa cumpre os "Portões obrigatórios" e as "Exigências por área" de `docs/qa/estrategia-de-testes.md`. A CI tem pisos de cobertura (`npm run test:coverage`) e o check `lighthouse`.

## Esperando o Pablo

<!-- Itens "▶ Antes, você fornece" das próximas etapas e perguntas abertas. -->

- Feito na etapa 8: teto único de 9.000 Neurons/dia. Não trava: busca de tarefas por FTS5. Ver `docs/arquitetura/orcamento-free-tier.md`, "Para o Pablo".
- Toda etapa segue `.claude/rules/performance.md` (P1 a P14) e preenche "Custo no plano Free" no PR.

- ⚠️ Antes do próximo deploy: criar o widget do Turnstile e gravar `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` (docs/configuracao-cloudflare.md); sem eles o login fica fechado.
- Não travam: perguntas abertas da etapa 4 (senha digitada de novo para ligar 2FA/passkey; resolvido: alerta repetido e teto de 30 erros em 24 h), da etapa 3 (acerto não zera falhas).
- Rulesets da `develop` e da `main` conferidos ativos pela API em 31/10/2026.
- Etapas 19c e 19d (avaliações do Google, depois da 19b): plano aprovado em 03/11/2026 (`docs/planos/google-business-profile.md`); antes da 19c o Pablo liga as APIs do Business Profile e pede o "Basic API Access" ao Google (aprovação pode levar dias).

## Próxima etapa

- Número e nome: 19c · Avaliações do Google Business Profile
- Dependências mescladas: 19 (Google Agenda), 19b (Google Contatos)
- Precisa de algo do Pablo antes: as respostas às perguntas do plano `docs/planos/google-business-profile.md` (PR #138) e o pedido de acesso à Business Profile API no Google.
