# Especificação do Zuri: assistente pessoal de IA na Cloudflare com bot no Telegram

Versão 1.0 · 30/10/2026 · dono do produto: Pablo

## Como usar este documento

Este documento é a ordem de serviço para um agente de IA construir, do zero e num repositório novo, um assistente pessoal de IA que roda inteiro na conta Cloudflare do dono. Ele herda todas as funções do Talorys (hoje Axis, repositório `pablopfg/talorys`) e acrescenta um **bot do Telegram dedicado ao administrador**, que funciona como um segundo painel de controle ao lado da interface web.

O novo sistema se chama **Zuri** (escolha do Pablo em 30/10/2026). O prefixo técnico para tabelas e tokens é `zur_`.

### Regras para o agente executor

1. **Uma etapa = um PR.** Siga as etapas da seção "Etapas de implementação" na ordem. Não comece uma etapa antes de a anterior estar mesclada na branch `develop`, salvo quando a etapa disser que é independente.
2. **Leia o Talorys como referência, não copie às cegas.** O Talorys é público: clone `https://github.com/pablopfg/talorys` (branch `develop`) só para leitura, fora do repositório do Zuri, e nunca envie nada para ele. Para cada etapa há a pasta ou o documento equivalente no Talorys. Leia, entenda a decisão de segurança por trás e reescreva limpo. A licença do Talorys é MIT, então reaproveitar trechos é permitido desde que o aviso de copyright seja mantido em `NOTICE.md`.
3. **pt-BR em tudo.** Interface, mensagens do servidor, erros da API, textos do bot, documentação, títulos de PR, commits (prefixo Conventional Commits em inglês, resto em pt-BR) e changelog. Nenhum texto visível ao usuário pode ficar fora do catálogo de traduções.
4. **Plano gratuito primeiro.** Tudo precisa funcionar no plano Free da Cloudflare. Qualquer recurso que gere cobrança (modelos pagos, Workers Paid, envio de e-mail para destinatário não verificado) fica desligado por padrão, atrás de um teto de gasto, e só entra com OK explícito do Pablo.
5. **Repositório público por padrão.** Nunca grave domínio real, ids do Telegram, e-mails, tokens ou chaves no repositório. Tudo isso vai para segredos ou variáveis do Worker ou do ambiente do GitHub. Na documentação, use `exemplo.com.br`.
6. **Segurança antes de recurso.** Ao fim de cada etapa: auditoria de segurança independente (skill `auditoria-seguranca` do repositório, subagentes `auditor-seguranca` e `revisor-cloudflare`, skills do plugin `cloudflare`), revisão de QA (skill `revisao-qa` e subagente `qa-senior`), correções, typecheck, lint, testes unitários e e2e. Só então o PR fica pronto.
7. **Conflitos de merge** com a branch de destino são resolvidos pelo agente, preservando os dois lados, com os testes rodando de novo. Só pergunte ao Pablo quando houver decisão de produto.
8. **Dúvida de produto vira pergunta, não suposição.** Se algo não estiver neste documento e mudar o comportamento para o usuário, pare e pergunte. Detalhe técnico interno, decida e registre no PR.

### Definição de pronto (vale para toda etapa)

- [ ] Typecheck (`tsc --noEmit`) e lint (Biome) sem erros.
- [ ] Testes unitários novos cobrindo o caminho feliz, os limites e as recusas de segurança.
- [ ] Teste e2e (Playwright) quando houver tela nova.
- [ ] Todas as strings novas nos catálogos de tradução; o teste de i18n passa.
- [ ] Documento da funcionalidade em `docs/` (pt-BR) e entrada no `CHANGELOG.md`.
- [ ] Migrations só de acréscimo (nunca `DROP`), com teste.
- [ ] Auditoria de segurança feita e achados corrigidos ou listados no corpo do PR.
- [ ] CI verde no PR.

## Nome e convenções

O nome é **Zuri** ("bonito", "bom" em suaíli), escolhido pelo Pablo em 30/10/2026. Disponibilidade de domínio, de usuário de bot no Telegram (ex. `@zuri_<algo>_bot`) e de marca não foi verificada; o agente confere antes da etapa 0 e relata.

Nomes técnicos: tabelas `zur_`, tokens `zur_pat_`, cookies `__Host-zuri_*`, variáveis `ZURI_*`, pacotes `@zuri/*`. O código novo nunca usa os nomes Talorys ou Axis, exceto em `NOTICE.md`.

## Visão do produto e escopo

O Zuri é um assistente pessoal de IA de **um único dono**, gratuito e de código aberto, que roda na conta Cloudflare desse dono. Não há cadastro, equipes nem servidor dos desenvolvedores. O dono usa por dois caminhos de igual importância: a **interface web** (PWA, celular e computador) e o **bot do Telegram do administrador**.

### Funções herdadas do Talorys

Cada linha é um requisito. A coluna da direita aponta onde o agente estuda a referência no repositório `pablopfg/talorys` (branch `develop`).

| Área | O que precisa existir | Referência no Talorys |
| --- | --- | --- |
| Chat | Respostas em streaming (SSE), Markdown, atividade das ferramentas, parar resposta, resumo automático do histórico longo, uso e limites por conversa | `agent/runner.ts`, `api/routes/chat.ts`, `ChatPage.tsx` |
| Voz | Microfone no chat (até 1 min), transcrição pelo Whisper do Workers AI, texto revisado antes de enviar, áudio nunca guardado, teto de 60 min/dia | `ai/transcription.ts`, `hooks/voice.ts` |
| Memória | Fatos duráveis visíveis, editáveis e apagáveis; só as relevantes vão ao modelo; orçamento de contexto | `agent/memory.ts`, `MemoryPage.tsx` |
| Histórico da memória | Fatos que mudam com o tempo (atual, incerto, passado), detecção de conflito por regras e opcionalmente por IA | `memory/`, `docs/memory-history.md` |
| Busca semântica (opcional) | Embeddings guardados no SQLite do Durable Object, busca por significado em memórias, tarefas, notas e automações | `semantic/`, `docs/semantic-recall.md` |
| Tarefas, notas, projetos | CRUD pela interface e pelo chat, FTS5, validação de datas, lixeira | `db/repositories/`, `tools/` |
| Planejamento com IA | Plano de tarefas em cartão editável; nada é criado antes da confirmação; confirmação atômica e única | `services/task-plans.ts`, `TaskPlanCard.tsx` |
| Automações | Lembretes únicos e recorrentes, resumo diário, rotinas de IA (só por proposta aprovada), sentinelas que só falam quando há algo, alarmes do Durable Object | `agent/scheduling.ts`, `AutomationsPage.tsx` |
| Central de avisos | Prioridade (baixa a crítica), categorias, limites por canal, deduplicação, insistência (15 min e 1 h), prioridade que aprende, vigias a cada 15 min, resumo das 07:30, histórico de entregas | `alerts/`, `docs/alerts.md` |
| Canais | Push (Web Push, máx. 3 aparelhos, remoção após 7 dias sem acesso), e-mail pelo Email Routing, Telegram | `push/`, `alerts/email.ts`, `telegram/` |
| Integrações | Servidores MCP remotos (sem auth, bearer, OAuth), ferramentas desligadas por padrão, aprovação para o que altera | `mcp/`, `docs/mcp.md` |
| Google Agenda | Leitura e escrita de eventos, rotinas do dia com a agenda | `calendar/`, `docs/google-calendar.md` |
| Acesso remoto | Tokens pessoais com escopo `read` ou `write`, 90 dias, só hash; eventos de entrada do n8n | `remote/`, `docs/remote-access.md` |
| Workflows | Monitor de sites com Cloudflare Workflows (passos duráveis e novas tentativas) | `workflows/` |
| Modelos de IA | Workers AI por padrão; Anthropic e OpenAI opcionais, com teto diário em US$ e fallback | `ai/`, `docs/modelos-de-ia.md` |
| Segurança de acesso | Senha forte (15+ caracteres, HIBP), e-mail do dono, 2FA TOTP, códigos de recuperação, passkeys, recuperação por e-mail, Turnstile em todo login, atividade de acesso, sessão com expiração por inatividade | `auth/`, `docs/security.md` |
| Dados | Backup e importação (importação nunca liga nada sozinha), limites de armazenamento, limpeza automática | `services/backup.ts`, `services/retention.ts` |
| Operação | Deploy pelo GitHub Actions só do navegador, guia de instalação passo a passo, Cloudflare Access opcional, domínio próprio | `docs/instalacao-cloudflare.md`, `.github/workflows/` |

Os caminhos da tabela são relativos a `apps/agent/src/` (servidor) e `apps/web/src/` (interface). Leituras obrigatórias além deles, por área:

| Área | Arquivos do Talorys |
| --- | --- |
| Portões e Worker | `apps/agent/wrangler.standalone.jsonc`, `apps/agent/src/{index.ts,env.ts,hosts.ts,web-headers.ts}`, `apps/web/public/_headers` |
| API e erros | `apps/agent/src/api/{app.ts,middleware.ts,errors.ts}`, `packages/shared/src/schemas.ts` |
| Banco | `apps/agent/src/db/{database.ts,migrations.ts}` |
| Autenticação | `apps/agent/src/auth/{auth-service.ts,mfa.ts,passkeys.ts,turnstile.ts,auth-log.ts}` |
| Telegram | `apps/agent/src/telegram/{client.ts,service.ts,routes.ts,format.ts}` |
| Avisos | `apps/agent/src/alerts/{service.ts,watchers.ts,email.ts,security.ts,learning.ts}` |
| Constantes e textos | `packages/shared/src/{constants.ts,storage.ts,plans.ts,crypto.ts,server-text.ts,recurrence.ts}` |
| Documentação | `docs/security.md`, `docs/alerts.md` (seções Segurança do Telegram, Insistência, E-mail), `docs/mcp.md`, `docs/remote-access.md`, `docs/google-calendar.md`, `docs/deploy-github-actions.md`, `docs/instalacao-cloudflare.md` |

### O que é novo: o bot do administrador

No Talorys o Telegram é um canal de avisos com conversa. No Zuri ele vira um **painel de administração completo**, com estas diferenças:

- **Comandos de consulta e ação rápida** sem passar pelo modelo de IA (agenda do dia, tarefas, lembrar, anotar, buscar, uso, saúde do sistema).
- **Aprovações no Telegram com confirmação forte**: o que hoje só se aprova no app pode ser aprovado no bot, confirmado por passkey (digital ou rosto) ou por código único enviado ao e-mail, com lista do que nunca sai do app.
- **Operação e segurança pelo bot**: ver acessos recentes, encerrar sessões, revogar tokens, pausar rotinas e um **modo de bloqueio** de emergência.
- **Entrada multimídia**: voz (já existe), fotos e documentos viram notas ou anexos, com limites.
- **Menu nativo** em pt-BR (`setMyCommands`), teclados inline e, como etapa opcional, um Mini App que abre telas da interface dentro do Telegram.

### Fora do escopo

- Mais de um usuário, equipes ou contas de clientes.
- WhatsApp, Chatwoot ou atendimento a terceiros (isso é outro projeto do Pablo).
- Ferramentas de shell, execução de código ou deploy acionadas pelo agente.
- Telemetria para os desenvolvedores.

## Arquitetura na Cloudflare

Tudo roda num **único Worker** que serve a interface e a API, com **um único Durable Object** guardando todos os dados no SQLite dele. É a mesma escolha do Talorys (build de um Worker só, `wrangler.standalone.jsonc`), porque cabe no plano Free, não exige D1, KV nem R2 e mantém um ponto só de autorização.

### Pilha técnica

| Camada | Escolha | Observação |
| --- | --- | --- |
| Monorepo | npm workspaces: `apps/agent`, `apps/web`, `packages/shared` | Node 24+, TypeScript `strict` |
| Worker e API | Hono sobre Workers, `compatibility_flags: ["nodejs_compat"]` | `run_worker_first: true` para a interface também passar pelos portões de segurança |
| Agente | Cloudflare Agents SDK (`Agent` sobre Durable Object), instância de nome fixo no servidor | Clientes não escolhem a instância |
| Dados | SQLite do Durable Object (`ctx.storage.sql`), migrations versionadas só de acréscimo, FTS5 | Prefixo de tabela do nome escolhido |
| IA | Workers AI (binding `AI`) por padrão; AI SDK; provedores pagos opcionais | Mock determinístico para testes e modo demo |
| Agendamento | Alarmes do Durable Object (`this.schedule`) + cron do Agents SDK (this.schedule("\*/15 \* \* \* \*")) para vigias, sem Cron Trigger do Worker | Idempotente |
| Tarefas longas | Cloudflare Workflows (monitor de sites, reprocessamentos) | Incluído no Free |
| Interface | React, Vite, Tailwind, TanStack Query, React Router, PWA com service worker | Servida pelo binding `ASSETS` |
| Validação | Zod nos dois lados, schemas em `packages/shared` | Um schema por payload |
| Telegram | Bot API por HTTPS, webhook em `POST /api/telegram/webhook` | Sem biblioteca de bot pesada; cliente fino próprio |
| Testes | Vitest com `@cloudflare/vitest-pool-workers`, Playwright | Chromium pré-instalado no CI |

### Portões de toda requisição, nesta ordem

1. Host permitido (só o domínio configurado; `workers.dev` e previews desligados quando há domínio próprio).
2. HTTP para HTTPS (301 em GET/HEAD anônimo, 403 com corpo ou credencial).
3. Cloudflare Access, quando ligado (com bypass só para o webhook do Telegram com o cabeçalho secreto e sem cookie).
4. Cabeçalhos de segurança (CSP estrita, HSTS, `frame-ancestors 'none'`, `Permissions-Policy`), espelhados em `_headers` e conferidos por teste.
5. Autenticação: sessão por cookie `__Host-` + CSRF, token pessoal (`Authorization: Bearer`) ou cabeçalho secreto do Telegram, cada um alcançando só as suas rotas.
6. Repasse ao Durable Object, que roda o app Hono ao lado do banco.

### Bindings, segredos e variáveis

| Nome | Tipo | Obrigatório | Para quê |
| --- | --- | --- | --- |
| `AI` | binding | sim | Workers AI (chat, Whisper, embeddings) |
| `AGENT` | Durable Object | sim | Instância única do agente |
| `ASSETS` | assets | sim | Interface web |
| `WORKFLOW` | Workflows | sim | Monitor de sites |
| `SEND_EMAIL` | send\_email | não | Alertas e recuperação por e-mail (Email Routing) |
| `SESSION_SECRET` | segredo | sim | Assinatura de sessões e derivação de HMACs (inclusive o segredo do webhook do Telegram) |
| `OWNER_PASSWORD_HASH` | segredo | sim | Senha do dono (PBKDF2 com pepper) |
| `OWNER_EMAIL` | segredo | sim | Login e recuperação |
| `PASSWORD_PEPPER` | segredo | sim | Pepper do hash de senha |
| `TELEGRAM_BOT_TOKEN` | segredo | não | Bot do administrador |
| `TELEGRAM_ADMIN_ID` | segredo | não | Id numérico da conta do dono no Telegram, trava extra além do vínculo por código |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | segredo | não | Web Push |
| `MCP_CREDENTIAL_KEY` | segredo | não | Cifra das credenciais MCP e Google |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | segredo | sim (fora do local) | Turnstile em todo login (decisão de 31/10/2026); sem elas o login responde `NOT_CONFIGURED` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | segredo | não | Modelos pagos (com teto) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | segredo | não | Google Agenda |
| `PUBLIC_URL`, `DEFAULT_TIMEZONE`, `AGENT_NAME` | var | sim | Endereço público, fuso (`America/Sao_Paulo`), nome exibido |

**Variáveis e configurações que completam a tabela:**

- Host permitido = host de `PUBLIC_URL` (sem variável extra).
- `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` (var, opcionais): ligam o portão 3 do Cloudflare Access.
- `ALERT_EMAIL_FROM` (var): remetente, num domínio com Email Routing. `ZURI_ALERT_EMAIL_TO` (variável do ambiente `production` do GitHub, nunca no repositório): destino verificado, usado para gerar o binding `SEND_EMAIL` com `destination_address`.
- `wrangler.jsonc`: `workers_dev: false` com domínio próprio, `preview_urls: false`, `run_worker_first: true`, `migrations` com `new_sqlite_classes` (tag `v1`), classe do Workflow `ZuriWorkflow`, `observability` ligado sem registrar corpos. O Worker é publicado como Custom Domain.
- `CLOUDFLARE_API_TOKEN` (permissões mínimas: Workers Scripts Edit, Workers Routes Edit, Account Settings Read, Email Routing Addresses Read) e `CLOUDFLARE_ACCOUNT_ID` só no ambiente `production` do GitHub.

&#91;embedded content: arquitetura · 3 entradas, 6 portões, 1 Durable Object\]

O bot do Telegram (em destaque) não tem caminho próprio: entra pelos mesmos portões da interface e chega ao mesmo agente, aos mesmos dados e aos mesmos limites.

## Modelo de dados e segurança transversal

O banco é o SQLite do Durable Object, com tabelas prefixadas com `zur_` e uma tabela de versão de schema. Cada migration roda numa transação junto com o aumento de versão, é só de acréscimo e tem teste que recusa `DROP`.

### Tabelas por domínio

| Domínio | Tabelas | Etapa |
| --- | --- | --- |
| Núcleo | `settings`, `schema_version`, `activity` | 2 |
| Acesso | `sessions`, `login_attempts`, `auth_events`, `mfa_secrets`, `recovery_codes`, `passkeys`, `devices` | 3 e 4 |
| Produtividade | `projects`, `tasks`, `notes` (+ FTS5), `trash` | 6 |
| Memória | `memories` (+ FTS5, `status`, `superseded_by`, `valid_from`, `valid_until`), `memory_reviews` | 7 |
| IA e uso | `usage_daily`, `model_usage_daily` | 8 |
| Chat | `conversations`, `messages` (`source`: app, telegram, importação), `pending_actions`, `task_plan_drafts` | 9 |
| Automações | `automations`, `automation_runs` | 10 |
| Avisos | `notifications`, `alert_deliveries`, `alert_learning`, `push_subscriptions` | 11 |
| Telegram | `telegram_links` (chat privado, grupo, tópicos), `telegram_updates` (últimos 100 ids), `telegram_callbacks` (ações pendentes dos botões), `telegram_audit` | 12 a 16 |
| Semântica | `semantic_vectors`, `semantic_queue` (só criadas ao ligar) | 17 |
| Integrações | `mcp_servers`, `mcp_tools`, `calendar_accounts`, `remote_tokens`, `remote_events`, `workflow_runs` | 18 a 22 |

### Regras de segurança que valem para todo código

1. **Dono único, instância fixa.** O nome da instância do Durable Object é constante no servidor. Nenhuma rota aceita id de instância.
2. **Conteúdo guardado é dado, nunca instrução.** Memórias, notas, resultados de ferramentas, respostas de MCP, mensagens importadas , texto de terceiros vindo do Telegram (encaminhado, citado, nomes de arquivo), eventos do Google Agenda (título, descrição, local, convidados), eventos remotos e status do monitor de sites entram no prompt dentro de blocos `<data>`, com as tags neutralizadas.
3. **Ação destrutiva = proposta + aprovação.** Apagar, reescrever, cancelar e ferramentas MCP que alteram algo nunca rodam no turno do agente. Viram uma proposta vinculada ao hash do alvo; a aprovação roda no máximo uma vez e falha se o alvo mudou.
4. **Rotinas de IA só por proposta.** O agente não agenda nada que rode sem o dono olhando; execuções agendadas têm só ferramentas de leitura e `notify_owner`. Frequência mínima de 1 hora e no máximo 50 automações ativas.
5. **Toda chamada de modelo é contada antes de ser feita**, com limites diários de pedidos, execuções agendadas, embeddings, áudio e US$.
6. **Links fora do app são desarmados.** No Telegram e no e-mail, `http` vira `hxxp`, pontos de host viram `[.]`; só os botões do próprio sistema são clicáveis.
7. **Passo extra para o sensível.** Trocar senha, ligar modelo pago, mudar nome do agente, mexer em tokens, Telegram e backups pede senha digitada nos últimos 15 minutos (ou TOTP), registra atividade e gera alerta fora da banda.
8. **Backup é entrada não confiável.** Importar nunca liga automação, MCP, modelo pago, nome do agente nem instruções; tem limite de 10 MB e de registros por tipo e é desfeito inteiro se passar de um limite.
9. **Limites de armazenamento por tipo** e teto total de 900 MB para o banco, abaixo do limite de 1 GB por Durable Object com SQLite no plano Free (FAQ de limites da Cloudflare; o agente confere o valor vigente antes da etapa 2). Aviso em 80% e recusa de escrita com STORAGE\_LIMIT\_REACHED em 100%, mesmo com token de escrita vazado.
10. **Nada sensível em log.** Nunca registrar senha, código, e-mail digitado errado, token, conteúdo de áudio ou texto completo de aviso.
11. **Cadeia de suprimentos.** Actions fixadas por SHA, `permissions` mínimas, `persist-credentials: false`, nada de segredo em execuções de PR, Dependabot com cooldown, `npm audit` bloqueando `high` no deploy.

## Contratos, constantes e referências

Esta seção fixa o que o agente executor não deve adivinhar: rotas, erros, colunas, números e formatos. Onde ela e uma etapa divergirem, vale esta seção.

### Contrato da API (rotas principais)

Todas as rotas ficam sob `/api`, recebem e devolvem JSON validado por Zod (`packages/shared`), e as de sessão exigem cookie + cabeçalho CSRF. Para as rotas não listadas (tarefas, notas, memórias, automações, MCP, agenda, remoto, backup), siga as de `apps/agent/src/api/routes/` do Talorys, com o mesmo formato.

| Etapa | Método e rota | Credencial | Corpo | Respostas |
| --- | --- | --- | --- | --- |
| 1 | GET `/api/health` | nenhuma | — | 200 `{ok:true}`; 503 `NOT_CONFIGURED` sem segredos obrigatórios |
| 3 | POST `/api/auth/login` | CSRF + Turnstile em toda tentativa | `{email, password, turnstileToken?}` | 200 sessão; 200 `{mfaRequired:true}`; 401 `INVALID_CREDENTIALS`; 429 `RATE_LIMITED` + `Retry-After`; 400 `TURNSTILE_REQUIRED`; 503 `SERVICE_UNAVAILABLE` (Turnstile sem resposta) |
| 3 | GET `/api/auth/login-options` (respondido pelo Worker, sem o Durable Object) | CSRF | — | 200 `{turnstileSiteKey}`; `null` só no local sem chaves |
| 3 | GET `/api/auth/activity?days=1\|7\|30\|90&group=success\|failure\|blocked\|robot\|account&ip=<começo>&before=<cursor>` | sessão + CSRF | — | 200 `{events, nextCursor}` (50 por página, IP, país, ASN, navegador); 400 `VALIDATION_FAILED` |
| 3 | POST `/api/auth/logout`, POST `/api/auth/heartbeat` (`{active}`), GET `/api/auth/session` | sessão + CSRF | — | 204 ou 200 |
| 3 | POST `/api/auth/confirm` (senha recente) | sessão + CSRF | `{password}` ou `{totp}` | 204; 401 |
| 3 | POST `/api/auth/password` | sessão + CSRF + senha atual | `{currentPassword, newPassword}` | 200 sessão nova; 400 `VALIDATION_FAILED`; 401 `INVALID_CREDENTIALS`; 503 `SERVICE_UNAVAILABLE` (HIBP sem resposta) |
| 4 | POST `/api/auth/mfa`, POST `/api/auth/mfa/passkey/options`, POST `/api/auth/mfa/passkey` | CSRF + cookie MFA (`__Host-zuri_mfa`, 5 min) | `{code}` / — / `{response}` | 200 sessão; 401 `INVALID_CREDENTIALS` com `details.attemptsLeft`; 401 `UNAUTHORIZED` com `details.mfa: "expired"` (cookie apagado); 429 `RATE_LIMITED`; 404 sem passkey deste host |
| 4 | GET `/api/auth/mfa`; POST `/api/auth/mfa/{setup,enable,disable,recovery-codes}` | sessão + CSRF + senha recente (menos o GET) | — / `{code}` | 200 `{enabled, enabledAt, recoveryCodesLeft}`; 200 `{secret, otpauthUri, expiresAt}`; 200 `{recoveryCodes}`; 204; 409 `CONFLICT` |
| 4 | GET `/api/auth/passkeys`; POST `/api/auth/passkeys/options`, POST `/api/auth/passkeys`; PATCH e DELETE `/api/auth/passkeys/:id` | sessão + CSRF + senha recente (menos o GET) | — / `{name, response}` / `{name}` | 200 `{passkeys}` com `usableHere`; 201 `{passkey}`; 204; 404; 409 `CONFLICT` |
| 8 | GET `/api/usage` | sessão + CSRF | — | 200 uso de hoje contra os limites, por modelo, e os últimos 7 dias (`usageReportSchema`) |
| 9 | POST `/api/chat` (SSE), POST `/api/chat/cancel`, POST `/api/actions/:id/approve`, POST `/api/actions/:id/cancel` | sessão + CSRF | `{conversationId?, message}` | eventos SSE `text`, `tool`, `approval`, `done`, `error` |
| 11 | POST `/api/auth/recover/request`, POST `/api/auth/recover/confirm` | nenhuma + limitador | `{email}` / `{token, password, totp?}` | 202 sempre no pedido; 204; 410 `RECOVERY_EXPIRED` |
| 12 | POST `/api/telegram/webhook` | cabeçalho secreto | atualização (máx. 64 KB) | 200 sempre; 403 sem cabeçalho; 413 acima de 64 KB |
| 12 | GET, PATCH e DELETE `/api/telegram`; POST `/api/telegram/{connect,confirm,test}` | sessão + CSRF (+ senha recente em connect, confirm e DELETE) | PATCH `{conversation:boolean, readLockHours:number}` | — |
| 16 | POST `/api/approvals/telegram/options`, POST `/api/approvals/telegram/verify` | token de aprovação no corpo | `{token}` / `{token, credential}` | 200; 410 `APPROVAL_EXPIRED`; 409 `TARGET_CHANGED`; 423 `APPROVALS_LOCKED` |
| 16 | GET `/api/lockdown`, POST `/api/lockdown/exit` | sessão + CSRF + senha recente | `{totp}` ou `{recoveryCode}` | 204; 423 `LOCKDOWN_ACTIVE` |

Tokens remotos nunca alcançam `/api/auth*`, `/api/telegram*`, `/api/approvals*`, `/api/lockdown*`, aprovações nem planos. Um teste percorre todas as rotas registradas e confere isso.

### Códigos de erro

Formato único: `{ "code": "...", "message": "<texto do catálogo>", "details"?: {...} }`. Códigos estáveis em inglês, `SCREAMING_SNAKE`:

| Código | HTTP | Código | HTTP |
| --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | `RATE_LIMITED` | 429 |
| `INVALID_CREDENTIALS` | 401 | `AI_LIMIT_REACHED` | 429 |
| `FORBIDDEN` | 403 | `TURNSTILE_REQUIRED` | 400 |
| `CSRF_FAILED` | 403 | `VALIDATION_FAILED` | 400 |
| `HOST_NOT_ALLOWED` | 403 | `NOT_FOUND` | 404 |
| `RECENT_AUTH_REQUIRED` | 403 | `CONFLICT` | 409 |
| `TARGET_CHANGED` | 409 | `APPROVAL_EXPIRED` | 410 |
| `RECOVERY_EXPIRED` | 410 | `LOCKDOWN_ACTIVE` | 423 |
| `APPROVALS_LOCKED` | 423 | `STORAGE_LIMIT_REACHED` | 507 |
| `NOT_CONFIGURED` | 503 | `SERVICE_UNAVAILABLE` | 503 |
| `PASSWORD_CHANGE_REQUIRED` | 403 |  |  |

### Tabelas do Telegram (colunas)

```sql
zur_telegram_links(id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('private','group')), user_id INTEGER, chat_id INTEGER, username TEXT, status TEXT CHECK(status IN ('pending','active','suspended')), topic_ids TEXT /* JSON categoria -> message_thread_id */, conversation_enabled INTEGER NOT NULL DEFAULT 0, linked_at TEXT, confirmed_at TEXT, last_used_at TEXT)
zur_telegram_link_codes(code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0)
zur_telegram_callbacks(id TEXT PRIMARY KEY /* 12 bytes base64url */, action TEXT NOT NULL, target_type TEXT, target_id TEXT, message_id INTEGER, expires_at TEXT NOT NULL, used_at TEXT)
zur_telegram_approvals(id TEXT PRIMARY KEY, purpose TEXT CHECK(purpose IN ('approval','unlock')), pending_action_id TEXT, target_hash TEXT, message_id INTEGER, method TEXT CHECK(method IN ('passkey','email')), page_token_hmac TEXT, webauthn_challenge BLOB, email_code_hash TEXT, email_sends INTEGER NOT NULL DEFAULT 0, last_email_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, status TEXT CHECK(status IN ('open','confirmed','failed','expired')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL)
zur_telegram_task_lists(chat_id INTEGER PRIMARY KEY, items TEXT /* JSON nº -> task_id */, expires_at TEXT NOT NULL)
zur_telegram_audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT /* command|callback|approval|unlock|lockdown */, name TEXT, result TEXT)
```

Em `settings`: `telegram_seen_update_ids` (JSON, 100), `bot_unlocked_until`, `bot_read_lock_hours`, `lockdown_until`, `lockdown_source`, `lockdown_exited_at`, `telegram_menu_version`. A coluna `origin` (`app`, `telegram`, `import`) entra em `zur_memories`.

### Constantes padrão

Valores conferidos em `packages/shared/src/constants.ts` e `storage.ts` do Talorys. Faixas = o que o dono pode configurar.

| Constante | Padrão | Faixa |
| --- | --- | --- |
| Neurons do Workers AI por dia (teto único de chat, voz e embeddings) | 9.000 | 1.000 a 9.000 |
| Pedidos de IA por dia | 200 | até 2.000 |
| Execuções de IA agendadas por dia | 6 | até 48 |
| Chamadas de ferramenta por turno | 6 | até 20 |
| Iterações do agente por turno | 4 | até 10 |
| Tokens de contexto | 6.000 | até 32.000 |
| Tokens de saída | 1.024 | até 4.096 |
| IA paga por dia (US$) | 2 | até 50 |
| Voz no app | 60 s e 2 MB por clipe | — |
| Voz no bot | 5 min e 5 MB por mensagem | — |
| Áudio por dia (app + bot) | 3.600 s | — |
| Sessão: inatividade / sem aba / máximo | 30 min / 5 min / 6 h | 5–60 min / 3–15 min / 1–24 h |
| Memórias / tarefas / notas / projetos | 10.000 / 20.000 / 5.000 / 1.000 | — |
| Conversas / mensagens / automações (ativas) | 5.000 / 200.000 / 500 (50) | — |
| Lixeira | 30 dias | — |
| Teto do banco | 900 MB | — |
| Trava de leitura do bot | 12 h | 1–72 h |
| Comandos / mensagens ao agente pelo bot por hora | 60 / 30 | — |
| E-mails de avisos / de aprovação por dia | 10 (4 reservados para segurança) / 10 | — |

### Modelos do Workers AI

Chat: `@cf/zai-org/glm-4.7-flash`. Transcrição: `@cf/openai/whisper-large-v3-turbo`. Embeddings: `@cf/baai/bge-m3`. São os padrões do Talorys em 30/10/2026; o agente confere os ids e os preços em Neurons no catálogo atual da Cloudflare antes da etapa 8 e grava a tabela de preços com a data. O plano Free dá 10.000 Neurons por dia. Decisão do Pablo (31/10/2026): um teto único de 9.000 Neurons por dia vale para chat, voz e embeddings juntos. Cada chamada estima os Neurons antes e é recusada, com aviso claro, se passar do teto; os limites por recurso (pedidos, áudio, embeddings) continuam valendo abaixo dele. O teto zera às 00:00 UTC, junto com a cota da Cloudflare.

### Prompt de sistema

Ordem: nome do agente (uma linha) → instruções fixas → instruções do dono → memórias → resumo → histórico. Todo conteúdo guardado entra como `<data source="memory|note|task|tool|mcp|telegram_forward|calendar|remote_event" id="...">…</data>`, um item por linha; dentro do bloco, `<` e `>` viram `‹` e `›`. Referência: `apps/agent/src/agent/{runner.ts,prompt.ts}`. Cada cenário da seção "Prompt injection e segurança das ferramentas" de `docs/security.md` vira um teste com o mock.

### Classes de ferramentas

| Classe | Ferramentas | Comportamento |
| --- | --- | --- |
| `read` | `list_tasks`, `list_projects`, `read_note`, `search_notes`, `search_memories`, `search`, `list_automations`, `list_calendar_events` | Roda direto; única classe em execuções agendadas (mais `notify_owner`) |
| `write` | `create_task`, `update_task`, `complete_task` (máx. 3 por turno), `create_project`, `create_note`, `update_note` (só renomeia ou acrescenta), `remember`, `update_memory`, `create_reminder`, `create_automation`, `create_calendar_event`, `update_calendar_event`, `propose_task_plan` (1 por turno), `propose_ai_routine` | Roda direto no chat; nunca em execuções agendadas |
| `destructive` | `delete_task`, `delete_note`, `replace_task_description`, `replace_note_content`, `forget_memory`, `cancel_automation`, `delete_calendar_event` e ferramentas MCP que alteram algo | Vira proposta; só roda com aprovação |

### Avisos, MCP, agenda, remoto e backup

- **Avisos:** copie de `docs/alerts.md` do Talorys a tabela de categorias, as prioridades, os limites padrão por canal (por hora e por dia), a chave de deduplicação e a tabela de vigias com prioridade e repetição.
- **MCP:** limites de servidores, ferramentas e tamanho de resposta iguais aos de `docs/mcp.md`; nenhuma ferramenta MCP roda em execuções agendadas; callback OAuth em `/settings/mcp-oauth` → `POST /api/mcp/oauth/callback`.
- **Google Agenda:** escopos `https://www.googleapis.com/auth/calendar.events` (leitura e escrita) e `calendar.readonly` (só leitura), refresh token cifrado com `MCP_CREDENTIAL_KEY`, `redirect_uri` = `PUBLIC_URL` + `/settings/google-oauth`.
- **Eventos remotos:** schema de `docs/alerts.md` (título até 120 caracteres, corpo até 1.000, `priority`, `category`, `dedupeKey`) e rotas por escopo de `docs/remote-access.md`.
- **Backup:** `{ format: "zuri-backup", version: 1, exportedAt, data: {...} }` com tarefas, notas, projetos, memórias, conversas, automações (chegam pausadas) e configurações não sensíveis. Nunca inclui segredos TOTP, passkeys, sessões, tokens, vínculo do Telegram, credenciais MCP e Google. A importação mescla com ids novos e segue as regras de backup das Regras de segurança.

### Gramática de datas do bot

Aceito: "hoje", "amanhã", "depois de amanhã", dias da semana com ou sem "-feira", "dia 5", "5/11", "5/11/2026", "9h", "9h30", "9:30", "às 21h", "daqui a N minutos/horas/dias", "semana que vem". Recusado como ambíguo, com pergunta: dia da semana igual a hoje sem hora; "5/11" já passado neste ano ("Quis dizer 05/11/2027?"); "meio-dia", "tarde" e "noite" sem hora. Sem hora, o padrão é 09:00. O teste usa uma data de referência fixa e no mínimo 20 casos.

### Dependências entre etapas

| Etapa | Depende de |
| --- | --- |
| 1 a 5 | a anterior |
| 6, 7, 8 | 5 |
| 9 | 6, 7, 8 |
| 10 | 9 |
| 11 | 10 (entrega também os alertas pendentes das etapas 3 e 4 e a recuperação por e-mail) |
| 12 | 11 |
| 13 | 11, 12 |
| 14 | 9, 12 |
| 15 | 6, 7, 10, 11, 12 |
| 16 | 4, 9, 11, 12 |
| 17 a 22 | 9 e 11; independentes entre si. 19, 22 e 23 estendem comandos da etapa 15 |
| 23 | 15 |
| 24 | pode começar após a 5 e é atualizada a cada etapa que cria variável ou segredo |
| 25 | todas |

### Critérios de aceite adicionais

| Etapa | Aceite |
| --- | --- |
| 5 | Guarda de sessão redireciona ao login com `?next=`; PWA instala no Chromium; respostas de `/api/*` com `Cache-Control: no-store` |
| 10 | Recorrência correta na virada de horário de verão (fuso de teste) e no dia 31; reconciliação roda uma vez só |
| 13 | Insistência +15/+60 com relógio falso; o grupo nunca recebe sozinho um alerta de segurança |
| 17 | A busca híbrida acha "carro" na memória "automóvel" com o mock de embeddings |
| 20 | Token `read` recebe 403 em toda rota de escrita; nenhum token alcança as rotas proibidas (teste que percorre todas) |
| 23 | Backup malicioso (automação ligada, MCP, 11 MB, 10.001 memórias) é recusado inteiro |
| 24 | O deploy falha com `workers_dev` ou `preview_urls` ligados e domínio próprio |

### Telas e estados

- **Cartão do Telegram:** não configurado (sem token), pronto para conectar, aguardando `/start`, aguardando confirmação no app, vinculado, webhook com erro (último erro de `getWebhookInfo`), suspenso.
- **Página `/aprovar`:** estados listados na seção do bot.
- **Sair do bloqueio:** origem do bloqueio, hora, botão Sair (2FA ou código de recuperação), botão Não fui eu: desvincular o Telegram.
- **Configurações:** Conta (nome, e-mail, senha, idioma, fuso), Segurança (2FA, passkeys, sessões, acessos, acesso remoto, bloqueio), IA (modelos, limites, busca semântica, memória), Avisos (push, Telegram, e-mail, categorias, prioridades), Integrações (MCP, Google Agenda), Dados (backup, armazenamento, lixeira).

Cada estado tem chave de i18n e teste e2e.

## Decisões em aberto para o Pablo

O agente executor pode começar a fase A sem nenhuma destas respostas; cada linha diz a etapa que fica esperando. A coluna "Padrão" é o que o agente faz se não houver resposta até lá.

| Nº | Decisão | Padrão recomendado | Bloqueia |
| --- | --- | --- | --- |
| N1 | Nome do sistema | Decidido: Zuri (30/10/2026) | Etapa 0 |
| N2 | Repositório público ou privado | Público (mantém as regras de nada sensível no repo) | Etapa 0 |
| N3 | Aprovações pelo Telegram e como confirmá-las | Decidido pelo Pablo em 30/10/2026: aprovar pelo bot, confirmando por passkey (principal) ou código por e-mail (reserva), com a lista "nunca pelo bot" | Etapa 16 |
| N4 | Guardar fotos e documentos enviados ao bot (exige R2, grátis até 10 GB) | Não guardar; só a legenda vira nota | Etapa 15 |
| N5 | Ler imagens com modelo de visão (Workers AI) | Desligado | Etapa 15 |
| N6 | Mini App do Telegram | Não fazer agora | Depois da 25 |
| N7 | Modelos pagos (Anthropic, OpenAI) | Não implementar sem OK | Etapa 21 |
| N8 | Idiomas além do pt-BR | Só pt-BR e en | Etapa 2 |
| N9 | Grupo de avisos no Telegram além do chat privado | Opcional, como no Talorys | Etapa 13 |
| N10 | Trava de leitura do bot (destravar por passkey ou e-mail depois de um período sem uso) | Ligada, 12 h | Etapa 15 |
| N11 | TELEGRAM\_ADMIN\_ID obrigatório para comandos de segurança e aprovações | Sim | Etapa 12 |
| N12 | Teto do banco | 900 MB (confirmar o limite vigente do plano Free) | Etapa 2 |
| N13 | Cadastro inicial do dono por uma tela de primeiro acesso | Decidido pelo Pablo em 31/10/2026: código de instalação como segredo, uso único, 1 h de validade, 2FA ou passkey obrigatórios (`docs/planos/cadastro-inicial-do-dono.md`) | Trabalho paralelo, antes da etapa 24 |

## Etapas de implementação

São 26 etapas em 5 fases, cada uma um PR para `develop`. As fases A e B entregam um assistente utilizável pela web; a fase C entrega o bot do administrador; as fases D e E completam a paridade com o Talorys e a operação. As etapas de uma mesma fase marcadas como *independente* podem rodar em paralelo.

### Fase A — Fundação

**Etapa 0 · Repositório e esteira** (`chore: prepara o repositório e a integração contínua`)

- Monorepo com npm workspaces, TypeScript `strict`, Biome, Vitest, Playwright, `.editorconfig`, `LICENSE` (MIT), `NOTICE.md` com crédito ao Talorys, `SECURITY.md`, `CONTRIBUTING.md` em pt-BR.
- CI só em `pull_request`: typecheck, lint, testes, teste de i18n, `npm audit`. Actions fixadas por SHA, `permissions: contents: read`.
- Branches `main` e `develop`, rulesets (PR obrigatório; checks exigidos typecheck, lint, test, i18n, build, e2e e audit; sem force-push; main só recebe PR vindo de develop), Node fixado por .nvmrc, npm audit --audit-level=high também no CI de PR, Dependabot (npm e Actions, alvo `develop`, cooldown), CodeQL e secret scanning.
- Aceite: um PR vazio de teste passa por todos os jobs; nenhum job de PR tem acesso a segredo.

**Etapa 1 · Worker, Durable Object e portões** (`feat: cria o Worker com os portões de segurança`)

- `wrangler.jsonc` de um Worker só, `preview_urls: false`, `run_worker_first: true`, binding `ASSETS`, classe do agente com `new_sqlite_classes`.
- Os seis portões da seção de arquitetura, `GET /api/health` sem dados, recusa de WebSocket.
- Aceite: testes para host proibido (403), HTTP para HTTPS, cabeçalhos iguais ao `_headers`, instância fixa.

**Etapa 2 · Banco, configurações e i18n** (`feat: adiciona migrations, configurações e traduções`)

- `db/database.ts`, `db/migrations.ts` com teste anti-`DROP`, repositório de `settings` com valores padrão (fuso `America/Sao_Paulo`, idioma `pt-BR`).
- Catálogo de mensagens compartilhado em `packages/shared/i18n` (pt-BR padrão, en opcional) usado pela interface, pela API e pelo bot. Erros da API saem com `code` estável e `message` traduzida.
- Teste que falha se alguma chave existir só num idioma ou se houver string literal visível fora do catálogo nos componentes e nas rotas: um lint próprio procura literais com letras em texto JSX, title, aria-label, placeholder e new AppError(...), com exceções listadas em i18n-ignore.json.
- Aceite: migration 1 aplicada sob demanda; mudar idioma muda erros da API.

**Etapa 3 · Login e sessões** (`feat: adiciona login com e-mail e senha e sessões seguras`)

- Login com `OWNER_EMAIL` (comparado por HMAC) e senha (PBKDF2-SHA256 com 100.000 iterações, o máximo aceito pelo WebCrypto dos Workers, mais pepper; formato pbkdf2$100000$salt$hash para poder mudar). Instalação sem instalador: sem OWNER\_PASSWORD\_HASH, o Worker aceita o segredo OWNER\_PASSWORD (20+ caracteres) e, no primeiro login, exige a troca, grava o hash em settings e pede para apagar o segredo no painel. PASSWORD\_PEPPER e SESSION\_SECRET têm 48+ caracteres aleatórios; sem eles, o health check falha com mensagem clara. Política: 15+ caracteres, partes previsíveis não contam, HIBP por k-anonimato com falha fechada, senha fraca atual força troca.
- Cookie `__Host-zuri_session` (HttpOnly, Secure, SameSite=Strict), CSRF por cabeçalho, sessão expira com 30 min de inatividade, 5 min sem aba aberta e 6 h no máximo.
- Força bruta: 3 falhas por rede em 15 min; Turnstile em toda tentativa (decisão de 31/10/2026; antes era adaptativo); verificação antes do PBKDF2; falha fechada, inclusive sem as chaves fora do local.
- Atividade de acesso (`auth_events`) com 90 dias detalhados e agregados de 1 ano; cookie de aparelho que nunca dispensa 2FA; os eventos que geram alerta (rede nova e outros) ficam gravados com a marca alert\_pending e são entregues quando a etapa 11 subir.
- Aceite: testes para cada limite, cookie, expiração e recusa de CSRF.

**Etapa 4 · 2FA e passkeys** (`feat: adiciona verificação em duas etapas e passkeys`)

- TOTP com códigos de recuperação (só hash), desafio de 5 min em cookie `__Host-`, 10 códigos errados em 15 min pausam redes desconhecidas; 30 em 24 h suspendem o segundo passo para elas até a janela passar, com alerta (decisão de 31/10/2026).
- Passkeys (WebAuthn) em qualquer endereço HTTPS; elas pertencem ao host onde foram criadas, então a lista marca as de outro endereço.
- A recuperação de senha por e-mail fica na etapa 11, porque depende do SEND\_EMAIL.
- Aceite: 2FA opcional no código, ligado no deploy do Pablo; testes de reuso de código e de link.

**Etapa 5 · Casca da interface** (`feat: cria a casca da interface web`)

- React + Vite + Tailwind, layout responsivo, tema claro e escuro, login, guarda de sessão, central de notificações vazia, página de Configurações com abas (Conta, Segurança, IA, Avisos, Integrações, Dados).
- PWA instalável, sem cache de respostas da API.
- Identidade visual do nome escolhido (logo, favicon, cores) definida aqui.
- Aceite: e2e de login, logout e expiração; Lighthouse de acessibilidade ≥ 90.

### Fase B — Assistente na web

**Etapa 6 · Tarefas, notas e projetos** (`feat: adiciona tarefas, notas e projetos`)

- API REST com Zod, repositórios, FTS5 em notas, `LIKE` com escape em tarefas, lixeira com restauração e limpeza automática, limites por tipo.
- Telas de Tarefas (filtros, prazo, projeto, conclusão) e Notas (editor Markdown).
- Aceite: datas impossíveis recusadas (inclusive com fuso explícito); e2e de criar, editar, concluir e restaurar.

**Etapa 7 · Memória e histórico** (`feat: adiciona memória com histórico de fatos`)

- Memórias com FTS5, até 2.000 caracteres, status atual / incerto / passado, substituição com prevenção de ciclos, revisão de conflitos, detecção de perguntas sobre o passado.
- Tela de Memória com edição, exclusão completa e fila de revisão.
- Aceite: os casos de `docs/memory-history.md` do Talorys viram testes.

**Etapa 8 · Provedor de IA e medição de uso** (`feat: adiciona o provedor de IA com medição de uso`)

- Interface `AIProvider` (`generate`, `stream`, `generateWithTools`), implementação Workers AI (modelo padrão configurável, raciocínio desligado), `MockAIProvider` determinístico.
- Medição por passo (inclusive falhas e abortos), estimativa de Neurons e US$ por tabela de preços datada, limites diários contados antes da chamada, novas tentativas do SDK desligadas.
- Aceite: chamada abortada no meio do stream ainda é contada; limite diário não estoura com requisições simultâneas.

**Etapa 9 · Chat com ferramentas** (`feat: adiciona o chat com ferramentas e aprovações`)

- `runner.ts`: prompt de sistema (nome do agente na primeira linha), memórias relevantes em `<data>`, resumo corrente, histórico dentro do orçamento, SSE ponta a ponta, botão Parar.
- Registro de ferramentas com permissão `read` / `write` / `destructive`, limite por turno, detecção de laço. Ferramentas: `create_task`, `list_tasks`, `update_task`, `complete_task`, `delete_task`, `replace_task_description`, `create_project`, `list_projects`, `create_note`, `read_note`, `update_note`, `replace_note_content`, `delete_note`, `search_notes`, `remember`, `search_memories`, `update_memory`, `forget_memory`, `search`, `propose_task_plan`.
- Cartões de aprovação e de plano de tarefas, confirmação atômica.
- Entrada por voz no chat (`POST /api/transcribe`, 60 s por clipe, 60 min por dia, um por vez).
- Aceite: os cenários de prompt injection de `docs/security.md` do Talorys viram testes com o mock.

**Etapa 10 · Automações** (`feat: adiciona lembretes, resumos e rotinas de IA`)

- Um agendamento pendente por automação, recálculo no fuso do dono, reconciliação no `onStart` (perdida há menos de 24 h roda uma vez), execuções registradas.
- Ferramentas `create_reminder`, `create_automation`, `list_automations`, `cancel_automation`, `propose_ai_routine`, `notify_owner` (só em execuções agendadas). Sentinelas: o modelo responde `NADA` para ficar quieto.
- Tela de Automações com histórico de execuções.
- Aceite: mínimo de 1 hora, máximo de 50 ativas, rotina criada pelo chat nasce pendente de aprovação.

**Etapa 11 · Central de avisos, push e e-mail** (`feat: adiciona a central de avisos com push e e-mail`)

- `AlertService.raise()` único: deduplicação, prioridade, categoria, limites por canal por hora e por dia, insistência (+15 min, +60 min, não reconhecido em +75), prioridade que aprende (no máximo um nível por semana), vigias a cada 15 min, resumo às 07:30, histórico de entregas com motivo.
- Web Push com VAPID e criptografia ECE, máximo de 3 aparelhos, remoção após 7 dias sem acesso, novo aparelho pede passo extra.
- E-mail pelo binding `SEND_EMAIL` (só destinatário verificado), 10 por dia com 4 reservados para segurança.
- A interface `AlertChannel` já nasce pronta para o Telegram plugar na etapa 13. A etapa também entrega a recuperação de senha por e-mail (link no fragmento da URL, 30 min, 3 por rede em 15 min, exige 2FA quando ligado) e os alertas pendentes gravados desde a etapa 3. O binding SEND\_EMAIL é gerado no deploy com destination\_address igual à variável ZURI\_ALERT\_EMAIL\_TO do ambiente, e o código chama send() sem destinatário.
- Aceite: alertas de segurança saem por todos os canais mesmo com categoria desligada.

### Fase C — Bot do administrador no Telegram

O comportamento completo está na seção "Bot do Telegram do administrador"; aqui ficam o recorte de cada PR e o aceite.

**Etapa 12 · Fundação do bot** (`feat(telegram): conecta o bot do administrador`)

- Cliente fino da Bot API (`sendMessage`, `editMessageText`, `answerCallbackQuery`, `setWebhook`, `deleteWebhook`, `setMyCommands`, `getFile`, `leaveChat`, sendChatAction, deleteMessage, editMessageReplyMarkup, getMe, getWebhookInfo), com tempo máximo, sem seguir redirecionamentos e tratamento de `429 retry_after`.
- Webhook com cabeçalho secreto (HMAC do `SESSION_SECRET`), 64 KB, `allowed_updates` restrito, resposta 200 imediata e trabalho no Durable Object com `keepAliveWhile` (nunca em `ctx.waitUntil`, que só dá 30 s), deduplicação dos últimos 100 `update_id`.
- Vínculo: código de 8 caracteres válido por 10 min (só hash), deep link `t.me/<bot>?start=<código>`, vínculo pendente até **Confirmar esta conta** no app (senha recente), conferido contra `TELEGRAM_ADMIN_ID`; 10 códigos errados em 10 min invalidam o código.
- Cartão Telegram em Configurações → Avisos (Conectar, Reconectar, Desvincular, Enviar teste), conectar pede senha recente. O próprio Worker registra o webhook (setWebhook com secret\_token, allowed\_updates, drop\_pending\_updates e max\_connections 1) e o menu (setMyCommands); no onStart, o Durable Object reaplica o menu quando a versão do código mudou. O GitHub Actions nunca recebe o token do bot.
- Aceite: atualização sem cabeçalho = 403; conta estranha não grava nada no banco; replays ignorados.

**Etapa 13 · Avisos no Telegram** (`feat(telegram): envia avisos com botões`)

- Canal Telegram da central de avisos: grupo opcional com um tópico por categoria, chat privado como padrão, modo discreto com "Texto completo" por categoria, som só para alta e crítica.
- Botões Abrir, Feito, Adiar 1 h, Silenciar; segundo toque responde "Este aviso já foi tratado".
- Aceite: link desarmado em todo texto; só o dono aciona botões no grupo.

**Etapa 14 · Conversa e voz** (`feat(telegram): conversa com o agente por texto e voz`)

- Chat privado vira conversa do app (`source: telegram`), um turno por vez, 3 min de limite, "digitando…", formatação em HTML do Telegram com escape, divisão em blocos de 4.096 caracteres.
- Voz e arquivos de áudio até 5 min e 5 MB, mesmo teto diário do app, áudio nunca guardado.
- Aceite: conversa aparece na lista do app; desligar a conversa faz o bot nem baixar o áudio.

**Etapa 15 · Comandos administrativos** (`feat(telegram): adiciona comandos de consulta e ação rápida`)

- Comandos sem IA: `/hoje`, `/tarefas`, `/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`, `/avisos`, `/uso`, `/status`, `/ajuda`, `/nova_conversa`. Menu registrado por `setMyCommands` em pt-BR.
- Fotos e documentos: comportamento da seção do bot (a legenda vira nota com a linha do anexo; sem legenda, o bot pede uma); anexos só são guardados com R2 aprovado (N4). Inclui também a trava de leitura, /destravar e /backup.
- Aceite: cada comando com teste; comandos não gastam pedido de IA.

**Etapa 16 · Aprovações seguras e modo de bloqueio** (`feat(telegram): aprova ações com 2FA e adiciona o modo de bloqueio`)

- Aprovações no bot confirmadas por passkey (página /aprovar com token de uso único) ou por código de 6 dígitos enviado ao e-mail (não basta tocar no botão), validade de 5 min, vinculadas ao mesmo hash da proposta do app. Depende das etapas 4 (passkeys) e 11 (e-mail). Ações que nunca saem do app ficam listadas na seção do bot.
- Comandos de segurança: `/acessos`, `/sessoes`, `/encerrar_sessoes`, `/tokens`, `/pausar_rotinas`, `/bloquear`.
- Modo de bloqueio conforme a seção do bot (tokens suspensos e não revogados, login só com código de recuperação na primeira hora, tela Sair do bloqueio, rebloqueio em 24 h suspende o vínculo) e reconhecimento cruzado dos alertas de segurança.
- Aceite: 5 falhas de confirmação travam aprovações pelo bot por 1 h e geram alerta; token da página /aprovar e código por e-mail não servem duas vezes nem para outra proposta; `/bloquear` funciona mesmo com a IA fora do ar; login durante o bloqueio é recusado com 2FA e aceito com código de recuperação; rebloqueio em 24 h suspende o vínculo; tokens suspensos voltam ao sair; alerta causado pelo bot não se reconhece pelo bot; a prévia de aprovação vem do banco, nunca do texto do modelo.

### Fase D — Paridade com o Talorys (etapas independentes entre si)

**Etapa 17 · Busca semântica** (`feat: adiciona busca semântica opcional`) — desligada por padrão; ligar cria as tabelas; embeddings do Workers AI em lotes de 50 com teto diário; vetores no SQLite do Durable Object; busca híbrida palavra-chave + significado em memórias, tarefas, notas e automações; reindexar. Aceite: desligada, o comportamento é idêntico ao sem o módulo.

**Etapa 18 · Servidores MCP remotos** (`feat: adiciona servidores MCP remotos`) — Streamable HTTP com o cliente MCP oficial, sem auth / bearer / OAuth, credenciais cifradas com `MCP_CREDENTIAL_KEY`, `fetch` protegido (trava de origem, DNS conferido, sem redirecionamento, limites de tamanho, 35 s), ferramentas desligadas por padrão com prefixo `mcp_`, troca de URL zera confiança e credencial. Aceite: os testes de `docs/mcp.md` do Talorys.

**Etapa 19 · Google Agenda** (`feat: integra o Google Agenda`) — OAuth com cliente do próprio dono, agendas só leitura ou leitura e escrita, ferramentas `list_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` (esta como proposta), rotinas de briefing às 07:00 e fechamento às 19:00. No bot, `/hoje` passa a incluir a agenda.

**Etapa 20 · Acesso remoto e eventos** (`feat: adiciona tokens de acesso remoto e eventos de entrada`) — tokens `zur_pat_` com escopo, 90 dias, só hash, lista de rotas permitidas; `POST /api/remote/events` para n8n e outros (60 por hora, 100 por dia, metade dos limites de canal). Tokens nunca alcançam `/api/telegram`, aprovações nem planos.

**Etapa 21 · Modelos pagos** (`feat: adiciona Anthropic e OpenAI com teto de gasto`) — só modelos com preço conhecido, fallback quando o principal falha antes de responder, teto diário em US$ (padrão 2, máximo 50), escolher pago pede senha recente. **Só implementar com OK do Pablo** (gera cobrança).

**Etapa 22 · Workflows** (`feat: adiciona o monitor de sites com Cloudflare Workflows`) — os endereços só são cadastrados na tela Workflows, com senha recente: até 10, só https, sem credenciais na URL, sem IP literal, sem o host do próprio Zuri, só porta 443, query de até 200 caracteres; nenhuma ferramenta do agente, comando do bot ou token remoto altera a lista. As requisições usam o fetch protegido do MCP (sem redirecionamento, 10 s, no máximo 64 KB lidos; nada do corpo vai ao modelo, só status e tempo), com intervalo mínimo de 15 min. Cada endereço é um passo durável com 3 tentativas, resultado entregue ao agente, que guarda o estado e dispara o aviso. No bot, `/status` mostra os monitores.

### Fase E — Dados, operação e fechamento

**Etapa 23 · Backup, importação e retenção** (`feat: adiciona backup, importação e limites de armazenamento`) — exportação JSON versionada, importação com as regras de entrada não confiável, limites por tipo, lixeira e limpeza automática. O bot avisa quando o último backup tem mais de 30 dias e responde `/backup` com o link para a tela (nunca envia o arquivo pelo Telegram).

**Etapa 24 · Deploy e guia de instalação** (`ci: adiciona o deploy pelo GitHub Actions`) — workflow de deploy em push para `main`, ambiente `production` só para `main`, token e conta da Cloudflare como segredos do ambiente, conferência via API de que `workers.dev` e previews estão desligados com domínio próprio, `npm audit` bloqueando `high`. `docs/instalacao-cloudflare.md` com o passo a passo só pelo navegador, incluindo criar o bot no @BotFather e a regra de Bypass do Access para o webhook. Release por tag com changelog em pt-BR.

**Etapa 25 · Auditoria final e testes de ponta a ponta** (`test: cobre o sistema de ponta a ponta e fecha a auditoria`) — auditoria completa com as duas skills, e2e de todas as telas e um teste do webhook do Telegram com atualizações reais gravadas (sem token real), relatório de achados no PR.

## Bot do Telegram do administrador

O bot é um segundo painel do dono: consulta, ação rápida, conversa com o agente, avisos e segurança. Ele obedece a **uma única conta do Telegram**, só no **chat privado** (o grupo, quando existe, serve para registrar avisos). Tudo que ele faz passa pelos mesmos serviços, limites e regras de aprovação da interface web; o bot nunca tem um atalho próprio para os dados.

### Quem o bot ouve

Uma atualização só é processada quando passa por todas estas travas, nesta ordem:

1. Cabeçalho `X-Telegram-Bot-Api-Secret-Token` correto (HMAC hex do `SESSION_SECRET`, só `[A-Za-z0-9_-]`), comparado em tempo constante; corpo até 64 KB; `update_id` ainda não visto (últimos 100, guardados em `settings`).
2. Tipo de atualização permitido: o `setWebhook` usa `allowed_updates: ["message", "callback_query", "my_chat_member"]`. Edições (`edited_message`), `business_message`, `inline_query` e os demais tipos são ignorados mesmo se chegarem.
3. `from.id` igual ao id do vínculo **ativo** (e a `TELEGRAM_ADMIN_ID`, quando definido) e `chat.type = private` para comandos e conversa.
4. Em grupo: só o grupo vinculado; de qualquer outro o bot sai na primeira mensagem. No grupo vinculado, só botões de aviso tocados pelo dono são aceitos.
5. Conta ou chat estranho: nada é gravado e nenhuma resposta é enviada (o @ do bot já é público, então responder não protege nada).

### Vínculo da conta

- O app gera um código de 8 caracteres válido por 10 min (só hash) e o deep link `t.me/<bot>?start=<código>`.
- `/start <código>` cria um vínculo **pendente**. O cartão do Telegram no app mostra nome, @ e os 4 últimos dígitos do id da conta, e o vínculo só fica ativo com **Confirmar esta conta** (senha recente). Enquanto isso, o bot só responde "Confirme o vínculo no app".
- `/start` com código errado soma num contador global em memória do Durable Object; 10 erros em 10 min invalidam o código vigente e o app mostra "Gere um novo código".
- Comandos de segurança e aprovações exigem `TELEGRAM_ADMIN_ID` definido (decisão N11).

### Trava de leitura do bot

Quem tomar a conta do Telegram (troca de chip, sessão do Telegram Desktop roubada, aparelho destravado) não pode sair lendo tudo. Por isso:

- Depois de 12 h sem uso do bot (configurável de 1 a 72 h, decisão N10), os comandos que mostram conteúdo do dono e a conversa com o agente pedem destravamento.
- O destravamento usa o mesmo fluxo das aprovações (passkey na página `/aprovar` ou código por e-mail) e vale por 12 h. Pode ser pedido com `/destravar` ou pelo botão que aparece quando um comando bloqueado é usado.
- `/status`, `/ajuda`, `/uso`, `/backup`, `/bloquear`, `/pausar_rotinas` e `/encerrar_sessoes` nunca pedem destravamento.
- Memórias criadas pelo Telegram (`/memoria` ou a ferramenta `remember` num turno `source: telegram`) nascem com `origin: telegram` e aparecem marcadas na tela de Memória.
- Limite de 60 comandos e 30 mensagens ao agente por hora; passou disso, o bot responde uma vez e ignora até a janela virar.

### Comandos

Todos os textos em pt-BR, do catálogo de i18n. Comandos não gastam pedido de IA. Respostas curtas, com teclado inline quando há ação seguinte.

| Comando | O que faz | Grava algo? | Confirmação | Pede destravamento? |
| --- | --- | --- | --- | --- |
| `/start <código>` | Inicia o vínculo, que fica pendente até a confirmação no app | sim | nenhuma | não |
| `/ajuda` | Lista os comandos e o que nunca é feito pelo bot | não | nenhuma | não |
| `/hoje` | Atrasadas, vencem hoje, lembretes do dia e agenda (máx. 5 por bloco) | não | nenhuma | sim |
| `/tarefas [projeto]` | Até 10 tarefas abertas numeradas, com botões Feito e Adiar; os números valem 1 h | não | nenhuma | sim |
| `/nova <texto>` | Cria tarefa; ecoa a data interpretada com o botão **Corrigir** | sim | nenhuma | sim |
| `/feito <nº>` | Conclui a tarefa nº da última lista (válida 1 h); botão **Desfazer** por 5 min | sim | nenhuma | sim |
| `/lembrar <quando> <texto>` | Cria lembrete único; ecoa a data com **Corrigir** | sim | nenhuma | sim |
| `/nota <texto>` | Cria nota | sim | nenhuma | sim |
| `/buscar <termo>` | Até 5 resultados por tipo, trecho de 100 caracteres; com busca semântica ligada conta 1 embedding | não | nenhuma | sim |
| `/memoria <fato>` | Guarda uma memória com `origin: telegram` | sim | nenhuma | sim |
| `/rotinas` | Automações ativas e próximas execuções; botão Pausar | sim (pausar) | nenhuma | sim |
| `/avisos` | Últimos 10 avisos e os pendentes de reconhecimento | não | nenhuma | sim, para o texto completo |
| `/uso` | Pedidos de IA, áudio, embeddings e US$ de hoje contra os limites | não | nenhuma | não |
| `/status` | Versão, saúde do Worker, IA disponível, monitores de sites, MCP sem login, idade do backup | não | nenhuma | não |
| `/backup` | Idade do último backup e botão **Abrir no app** (o arquivo nunca vai pelo Telegram) | não | nenhuma | não |
| `/nova_conversa` | Começa outra conversa com o agente | sim | nenhuma | sim |
| `/aprovar` | Propostas pendentes com o botão Aprovar | depois da confirmação | passkey ou e-mail | sim |
| `/destravar` | Destrava a leitura por 12 h | sim | passkey ou e-mail | não |
| `/acessos` | Últimos 10 eventos de acesso (rede resumida, sem IP completo) | não | nenhuma | sim |
| `/sessoes` | Sessões abertas, com botão Encerrar | sim (encerrar) | botão | sim |
| `/encerrar_sessoes` | Encerra todas as sessões web | sim | botão | não |
| `/tokens` | Tokens remotos ativos, com botão Revogar | sim (revogar) | botão | sim |
| `/pausar_rotinas` | Pausa todas as rotinas de IA e sentinelas | sim | botão | não |
| `/bloquear` | Modo de bloqueio de emergência (abaixo) | sim | botão | não |

Comandos não gastam pedido de chat (só `/buscar` com busca semântica conta 1 embedding). Cada comando tem resposta, estado vazio e erro definidos no catálogo de i18n. Exemplo para o agente seguir em todos: `/hoje` → `telegram.cmd.hoje.titulo` "Hoje, {data}", blocos "Atrasadas ({n})", "Vencem hoje ({n})", "Lembretes", "Agenda", no máximo 5 itens por bloco e "e mais {n} no app"; vazio: `telegram.cmd.hoje.vazio` "Nada para hoje."; agenda fora do ar: `telegram.cmd.hoje.agenda_indisponivel` "Agenda indisponível agora."; argumento inválido (qualquer comando): `telegram.erro.argumento` "Não entendi. Exemplo: {exemplo}".

Listar sessões e tokens não pede confirmação forte (só a trava de leitura). Encerrar sessões, revogar tokens, pausar rotinas e bloquear rodam com confirmação por botão, sem passkey nem e-mail, de propósito: são ações que só reduzem o acesso e precisam funcionar quando o dono está com pressa. Cada uma gera alerta de segurança que só se reconhece no app (veja Avisos), e desfazê-las só é possível no app.

### Conversa com o agente

- Texto livre no chat privado vai para o agente, numa conversa comum do app (`source: telegram`), com as mesmas memórias, ferramentas, instruções e limites. Pede destravamento depois de 12 h sem uso.
- **Onde o trabalho roda.** O webhook valida cabeçalho e tamanho no Worker, repassa a atualização ao Durable Object e responde 200. O processamento roda dentro do Durable Object com `keepAliveWhile` do Agents SDK, nunca em `ctx.waitUntil` do Worker (limitado a 30 s depois da resposta). Referência: `apps/agent/src/telegram/service.ts` do Talorys.
- **Subrequisições.** O plano Free permite 50 subrequisições externas por invocação. Cada turno conta as suas e para com aviso antes de 45. O "digitando…" (`sendChatAction`) é reenviado a cada 5 s no primeiro minuto, no máximo 12 vezes por turno.
- Um turno por vez; 3 min de limite; resposta em HTML do Telegram com escape de `<`, `>` e `&`, links desarmados, divisão em 4.096 caracteres sem quebrar tags.
- **Conteúdo de terceiros.** Mensagens encaminhadas (`forward_origin`), citações (`quote`, `external_reply`), respostas a mensagens de outra pessoa, nomes de arquivo e legendas de mensagens encaminhadas entram no prompt como `<data source="telegram_forward">`, nunca como instrução, e nunca executam comandos.
- Voz e arquivo de áudio: até 5 min e 5 MB, recusa antes do download quando a duração informada passa, corte no meio do download aos 5 MB, transcrição pelo mesmo serviço do app, eco "🎙️ \<texto>" antes da resposta.
- **Foto ou documento.** Com legenda: a legenda vira uma nota com a linha "Anexo recebido pelo Telegram: \<tipo>, \<tamanho> (não guardado)"; para conversar sobre ela, o dono envia texto em seguida. Sem legenda: o bot responde "Envie uma legenda para eu guardar como nota". A imagem só é lida por um modelo de visão se o Pablo aprovar (N5) e só é guardada com R2 aprovado (N4).
- Quando o agente propõe algo que pede aprovação, o bot mostra a prévia montada pelo servidor e o botão **Aprovar**.

### Aprovação pelo bot

Toda aprovação pelo bot é confirmada fora do Telegram, para que quem tomar a conta do Telegram não consiga aprovar nada. Há dois caminhos; a passkey é o principal e o e-mail é a reserva.

1. O dono toca em **Aprovar**. O bot cria um desafio de 5 min ligado à proposta (`pending_actions`), ao hash do alvo e ao `message_id`, e mostra dois botões: **Confirmar com passkey** e **Receber código por e-mail**. Tocar em Aprovar de novo numa proposta com desafio aberto reaproveita o desafio.
2. **Prévia confiável.** A prévia na página, no bot e no e-mail é montada pelo servidor a partir da proposta estruturada (ferramenta, id do alvo, título atual do alvo lido do banco, campos que mudam com antes e depois), nunca a partir do texto do modelo. O texto do modelo, quando aparece, fica num bloco separado com o rótulo "Explicação do assistente (não verificada)". O hash do alvo é conferido na exibição e de novo na execução.
3. **Passkey (principal).** O botão é um botão `url` que abre `https://<domínio>/aprovar#<token>`. O token de aprovação tem 32 bytes aleatórios, é guardado só como HMAC, tem uso único e vale 5 min. A página lê o fragmento, o remove com `history.replaceState` antes de qualquer requisição e nunca o grava. O token só alcança `POST /api/approvals/telegram/options` e `POST /api/approvals/telegram/verify` (token no corpo JSON, mesma origem conferida, mesmo limitador do login). O desafio do WebAuthn tem 32 bytes aleatórios, fica guardado no servidor na linha do desafio de aprovação e é consumido na primeira resposta, certa ou errada. A verificação confere origem, `rpId`, `userVerification: "required"`, contador e a ligação desafio → proposta → hash. A página não abre sessão nem dá acesso a mais nada. Com o Cloudflare Access ligado, `/aprovar` continua atrás do Access (sem bypass). Se o navegador interno do Telegram não oferecer a passkey, a página explica "Se a digital não aparecer, abra no navegador do celular".
4. **Código por e-mail (reserva).** Código de 6 dígitos enviado pelo binding `SEND_EMAIL` ao e-mail verificado do dono, com a prévia do item 2 (links desarmados) e o aviso: "Se não foi você que tocou em Aprovar no Telegram, não digite este código: alguém pode estar usando a sua conta do Telegram. Entre no app e use **Desvincular o Telegram**." O código vale 5 min, é guardado só como hash, vale para um único desafio e pode ser reenviado depois de 60 s, no máximo 3 vezes por hora. O dono digita o código no bot em resposta ao `force_reply`, e a mensagem é apagada logo depois de lida (`deleteMessage`). Mensagens de código fora de um `force_reply` válido são ignoradas e apagadas.
5. **Cota de e-mail.** E-mails de aprovação têm cota própria de 10 por dia, contada à parte dos 10 diários de avisos (total máximo de 20). O rodapé de todos os e-mails passa a ser: "O Zuri nunca pede sua senha. Códigos de aprovação só servem no bot, e só se foi você quem tocou em Aprovar."
6. Confirmação certa: a proposta roda pelo mesmo caminho do app (no máximo uma vez, falha com `TARGET_CHANGED` se o alvo mudou) e o bot edita a mensagem com o resultado.
7. 5 falhas em 15 min (passkey recusada ou código errado) travam aprovações pelo bot por 1 h e geram alerta crítico em todos os canais, deduplicado em no máximo 1 por dia.

Estados do desafio: `open` → (passkey certa ou código certo) → `confirmed` → execução (`approved` ou `failed` com `TARGET_CHANGED`); `open` → 5 min → `expired`; 5 falhas → `failed` e trava de 1 h. Textos: `telegram.aprovar.{escolha,codigo_enviado,codigo_errado,expirou,travado,feito,alvo_mudou}`. A página `/aprovar` tem os estados carregando, token inválido ou expirado, já usado, alvo mudou, passkey indisponível neste navegador e sucesso ("Pode voltar ao Telegram"), cada um com chave de i18n e teste e2e (autenticador virtual do Chromium).

**Pré-requisitos:** passkeys funcionam em qualquer endereço HTTPS, mas pertencem ao host onde foram criadas: uma passkey criada no `workers.dev` não vale no domínio próprio, e a lista as marca como "Outro endereço". O código por e-mail exige um domínio na Cloudflare com Email Routing e o destino verificado. Sem domínio, o bot aprova só por passkey; sem passkey cadastrada e sem e-mail, as aprovações ficam só no app e o bot mostra **Abrir no app**.

**Nunca aprovado pelo bot**, mesmo com passkey ou código por e-mail: trocar senha ou e-mail, desligar 2FA, criar token remoto, ligar modelo pago ou subir o teto em US$, conectar MCP ou trocar a URL de um, importar backup, desfazer o modo de bloqueio, desvincular o próprio Telegram. Para esses, o bot responde com o botão **Abrir no app**.

### Modo de bloqueio

`/bloquear` pede confirmação por botão (sem passkey nem e-mail) e então, em uma transação:

- encerra todas as sessões web;
- suspende os tokens remotos (não revoga: eles voltam ao sair do bloqueio);
- pausa rotinas de IA, sentinelas, workflows e chamadas MCP;
- recusa aprovações pelo bot e conversa com o agente; o bot responde só a `/status`, `/avisos` e `/ajuda`;
- mantém lembretes, vigias sem IA e alertas de segurança;
- envia alerta crítico por e-mail e push.

**Login durante o bloqueio.** Na primeira hora, só se entra com senha + código de recuperação, e esse login já sai do bloqueio. Passada 1 h, entra-se com senha + 2FA, e o app abre direto na tela **Sair do bloqueio**. Essa tela mostra de onde veio o bloqueio e o botão **Não fui eu: desvincular o Telegram**.

**Rebloqueio.** Um novo `/bloquear` vindo do mesmo vínculo nas 24 h seguintes à saída ainda bloqueia, mas também suspende o vínculo do Telegram até o dono reconfirmar no app. Assim, quem tomou o Telegram não mantém o dono fora indefinidamente.

Estado em `settings`: `lockdown_until`, `lockdown_source`, `lockdown_exited_at`.

### Avisos

Igual ao Talorys: grupo opcional com tópicos por categoria, discreto por padrão, "Texto completo" por categoria, som só em alta e crítica, botões Abrir, Feito, Adiar 1 h e Silenciar. Os alertas de segurança sempre vão ao **chat privado** (nunca só ao grupo).

**Reconhecimento cruzado dos alertas de segurança.** Um alerta de segurança só é reconhecido num canal diferente daquele que o causou:

- Alertas causados por ações na web (login novo, senha, 2FA, tokens, MCP, backup, push) só param de insistir quando reconhecidos no Telegram.
- Alertas causados pelo bot (vínculo, `/bloquear`, `/encerrar_sessoes`, revogação de token, falhas de confirmação, aprovação feita pelo bot, destravamento) só param quando reconhecidos no app, com senha digitada nos últimos 15 minutos.
- Ler, rebaixar, silenciar ou apagar no canal de origem nunca interrompe a insistência. As notificações push desses alertas não têm botões.

### Botões e `callback_data`

O `callback_data` tem no máximo 64 bytes. Use o formato `v1:<ação>:<id curto>`, em que o id curto (12 bytes aleatórios em base64url) aponta para uma linha de `telegram_callbacks` com a ação completa, o alvo, a validade (24 h) e se já foi usada. Nunca coloque dado do dono nem id previsível no `callback_data`. Todo toque responde com `answerCallbackQuery` em até 10 s. Num aviso, todos os botões saem depois do toque; numa lista (ex. `/tarefas`), só o botão tratado sai (`editMessageReplyMarkup`).

### Mini App (opcional, depois da etapa 25)

Um Mini App do Telegram pode abrir telas da interface (Tarefas e Notas) dentro do Telegram. Isso é uma decisão em aberto (N6). Se for feito:

- Validação do `initData`: `secret_key = HMAC_SHA256(chave "WebAppData", mensagem = token do bot)`; `hash = hex(HMAC_SHA256(secret_key, data_check_string))`, com os pares `chave=valor` ordenados por chave, separados por `\n` e sem `hash`; comparação em tempo constante; `auth_date` com menos de 5 min; cada `hash` aceito uma única vez; só o id do dono.
- Sessão curta de 15 min, sem acesso às ações da lista "nunca pelo bot". Aprovações no Mini App seguem o mesmo fluxo de passkey ou e-mail do bot.
- A CSP do caminho `/mini/*` permite `frame-ancestors https://web.telegram.org`; o resto continua `'none'`.

### Limites e custo

- Envio respeita os limites da Bot API (cerca de 1 mensagem por segundo por chat, 20 por minuto em grupo) com fila no Durable Object e respeito a `retry_after`.
- Entrada: 60 comandos e 30 mensagens ao agente por hora (trava de leitura).
- A Bot API é gratuita; cada atualização é uma requisição ao Worker, dentro das 100 mil requisições diárias do plano Free. O Worker é publicado como Custom Domain, nunca como rota com *fail open*.
- `telegram_audit` guarda só metadados (comando, resultado, hora), 90 dias.

## i18n, testes, CI/CD e documentação

### i18n

- Catálogo único em `packages/shared/i18n`, chave por texto (`telegram.cmd.hoje.vazio`), pt-BR como idioma padrão e de fallback; en como segundo idioma opcional. Arquivos packages/shared/i18n/{pt-BR,en}.ts, interpolação {nome}, plural com Intl.PluralRules e chaves .one e .other.
- O servidor nunca devolve texto solto: erros da API saem como `{ code, message }` com `message` no idioma das Configurações; avisos, e-mails e mensagens do bot também saem do catálogo.
- Datas e números com `Intl` em `pt-BR` e no fuso do dono (`America/Sao_Paulo` padrão): "30/10/2026 às 15:16", "US$ 1,25".
- O parser de datas dos comandos do bot entende pt-BR ("amanhã", "sexta 9h", "daqui a 2 horas", "dia 5") e recusa o que for ambíguo em vez de adivinhar.
- Teste de CI que falha com chave faltando em algum idioma, chave não usada ou string visível fora do catálogo.

### Testes

| Tipo | Ferramenta | O que cobre |
| --- | --- | --- |
| Unitário e integração | Vitest + `@cloudflare/vitest-pool-workers` | Serviços, repositórios, migrations, portões, ferramentas, limites |
| Agente | Vitest + `MockAIProvider` | Laço de ferramentas, aprovações, prompt injection, contagem de uso |
| Telegram | Vitest com atualizações JSON gravadas e cliente da Bot API falso | Travas de quem o bot ouve, comandos, botões, confirmação por passkey e por e-mail, bloqueio, divisão de mensagens |
| Ponta a ponta | Playwright (Chromium) contra `wrangler dev` | Todas as telas, login com 2FA, chat, aprovações |
| Segurança | Testes dedicados + auditoria por etapa | CSRF, cabeçalhos, hosts, tokens, backups maliciosos |

Nenhum teste chama a Cloudflare, o Telegram ou provedores de IA de verdade. Um *smoke test* com conta real só roda por `workflow_dispatch` manual, atrás de um ambiente protegido.

**Fixtures obrigatórias do Telegram** (JSON gravados em `apps/agent/test/fixtures/telegram/`): texto do dono; comando com `@bot`; `/start` com código certo e errado; conta estranha; grupo estranho; `callback_query` do dono e de outro membro do grupo; voz com `duration` 301; documento de 6 MB; foto com e sem legenda; mensagem encaminhada; `edited_message`; `my_chat_member` (bot adicionado e removido). O cliente falso da Bot API simula `ok:false` 429 com `retry_after`, 400 "message is not modified" e 403 "bot was blocked by the user".

### CI/CD

- `ci.yml` em `pull_request`: instalar com `npm ci`, typecheck, lint, testes, i18n, build, e2e, `npm audit`.
- `deploy.yml` em push para `main`: mesmos testes, depois `wrangler deploy` do Worker único com o ambiente `production` (só `main`, com aprovação) e geração do binding `SEND_EMAIL` com `destination_address` a partir da variável `ZURI_ALERT_EMAIL_TO` do ambiente. O webhook e o menu do bot são registrados pelo próprio Worker (etapa 12), nunca pelo Actions. O deploy falha se `workers_dev` ou `preview_urls` estiverem ligados com domínio próprio.
- `release.yml` por tag `vX.Y.Z` (SemVer): o CHANGELOG.md é escrito à mão em cada PR e o release copia a seção "Não lançado" para a versão.
- Segredos do Worker são gravados pelo dono no painel da Cloudflare, nunca no GitHub.

### Documentação (toda em pt-BR)

`README.md`, `docs/instalacao-cloudflare.md` (passo a passo só pelo navegador), `docs/arquitetura.md`, `docs/seguranca.md`, `docs/telegram.md` (criação do bot, vínculo, comandos, aprovações, bloqueio), `docs/avisos.md`, `docs/mcp.md`, `docs/google-agenda.md`, `docs/acesso-remoto.md`, `docs/modelos-de-ia.md`, `docs/backup.md`, `docs/solucao-de-problemas.md`, `CHANGELOG.md`.
