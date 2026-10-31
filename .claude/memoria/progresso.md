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

## Últimas etapas (detalhe)

### Etapa 6 · Tarefas, notas e projetos
- Entregou: `packages/shared/src/{dates,productivity}.ts` (datas checadas campo a campo, `zonedTimeToUtc`, schemas estritos), `apps/agent/src/productivity/` (`TaskRepository`, `NoteRepository`, `ProjectRepository`, `Trash`, `StorageGuard`, `search.ts`), rotas `/api/tasks`, `/api/notes`, `/api/projects`, `/api/trash`; telas `/tarefas`, `/notas/:id?`, lixeira na aba Dados; `components/Markdown.tsx`. Doc: `docs/produtividade.md`.
- Migrations: versão 4 (`zur_projects`, `zur_tasks`, `zur_notes` + `zur_notes_fts`, `zur_trash`, `zur_counts` com gatilhos).
- Decisões técnicas: busca de tarefas por `instr(lower(col), ?)` e não `LIKE` (o DO recusa padrão de LIKE acima de 50 bytes; CF-6-01); limite por tipo lido de `zur_counts`; edição que cresce em bytes respeita o teto de 900 MB; lixeira guarda cópia JSON e restaura por lista fixa de colunas; prazo só com dia vale 23:59 no fuso do dono; Markdown com react-markdown 10.1.0 + remark-gfm 4.0.1, sem HTML, links só http/https/mailto.
- Ficou para depois: a busca de tarefas ainda varre a tabela (Todas e Próximas ganharam índice na migration 5, PR de performance).
- Atenção para a próxima: as ferramentas da etapa 9 chamam os repositórios (que validam de novo com Zod); conteúdo de notas e tarefas entra no prompt em `<data>`; memória (etapa 7) pode reusar `search.ts` (`ftsQuery`, `asciiLower`) e o padrão de `zur_counts`.

### Etapa 5 · Casca da interface
- Entregou: `apps/web` em React (rotas `/entrar`, `/`, `/configuracoes/:tab` com 6 abas, 404), `lib/{api,activity,deadlines,next,i18n,theme}.ts`, `hooks/session.tsx`, `SessionGuard` (aviso 2 min antes, heartbeat único por Web Locks, saída em todas as abas), telas de 2FA, passkeys, limites de sessão e atividade. API: `GET`/`PATCH /api/settings`, `GET /api/auth/activity`. PWA sem cache no service worker. Docs: `docs/interface.md`.
- Migrations: nenhuma.
- Decisões técnicas: `x-zuri-activity` só em POST/PATCH/DELETE até 10 s após toque ou tecla; CSP do Turnstile em todas as páginas quando ligado (SPA; documentado em `seguranca.md`); identidade "Brisa" (opção A) aplicada enquanto o Pablo não escolhe; orçamento de duração do DO em `arquitetura.md` (6 h de uso ≈ 21% da cota diária).
- Ficou para depois: resolvido em 31/10/2026 pela revisão de QA (Lighthouse na CI e `session-background.spec.ts`).
- Atenção para a próxima: todo texto pelo catálogo com chave literal (`lint-i18n`); e2e roda contra `wrangler dev` com estado novo por execução (`.wrangler/e2e`); login tem limite de 3 falhas por rede em 15 min, então e2e não deve errar senha à toa; telas novas entram no `a11y.spec.ts`.

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

- Não travam: teto diário único de Neurons (os padrões de IA e áudio passam da cota de 10.000; afeta a etapa 8) e busca de tarefas por FTS5. Ver `docs/arquitetura/orcamento-free-tier.md`, "Para o Pablo".
- Toda etapa segue `.claude/rules/performance.md` (P1 a P14) e preenche "Custo no plano Free" no PR.

- ⚠️ Antes do próximo deploy: criar o widget do Turnstile e gravar `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` (docs/configuracao-cloudflare.md); sem eles o login fica fechado.
- Não travam: perguntas abertas da etapa 4 (senha digitada de novo para ligar 2FA/passkey; repetir alerta de ataque lento ao TOTP), da etapa 3 (acerto não zera falhas).
- Rulesets da `develop` e da `main` conferidos ativos pela API em 31/10/2026.

## Próxima etapa

- Número e nome: 7 · Memória e histórico (paralela com 8; uma de cada vez no modo contínuo)
- Dependências mescladas: sim (etapa 6, #12)
- Precisa de algo do Pablo antes: não
