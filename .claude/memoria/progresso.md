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
| 9 | em revisão (31/10/2026) | PR #28 | Conversa em SSE, 20 ferramentas com permissão e limite, aprovações e planos, voz, injeção de prompt testada |

## Últimas etapas (detalhe)

### Etapa 9 · Chat com ferramentas
- Entregou: `packages/shared/src/chat.ts` (schemas, limites, eventos do SSE), `apps/agent/src/agent/{prompt,context,runner}.ts`, `apps/agent/src/tools/` (registro, executor, 20 ferramentas), `apps/agent/src/chat/` (`conversations`, `actions`, `plans`, `local-due`), `apps/agent/src/ai/transcription.ts`, rotas em `api/chat.ts`, tela `/conversa` (`apps/web/src/pages/chat/`). Doc: `docs/chat.md`; segurança em `docs/seguranca.md` ("Ferramentas do agente e injeção de prompt").
- Migrations: versão 8 (`zur_conversations`, `zur_messages`, `zur_pending_actions`, `zur_task_plan_drafts`, contadores `conversations` e `messages`, coluna `author` em `zur_memories`).
- Decisões técnicas: proposta destrutiva com hash SHA-256 do alvo, reivindicada por `UPDATE … RETURNING` e conferida de novo na transação; plano é rascunho e a confirmação recusa tarefa nova; chamada que chega à ferramenta conta no turno mesmo se falhar, mas devolve a vaga do limite por ferramenta; repetição exata recusada; resultado de ferramenta em `<data source="tool">` cortado em 8.000 caracteres; orçamento de contexto = menor entre o do dono e a janela do modelo; resumo quando 8+ mensagens não cabem; textos pt-BR das Configurações viraram `pt-BR-settings.ts` sob demanda (JS inicial 139,0 kB).
- Ficou para depois: execução agendada usa só ferramentas `read` (`context: "scheduled"`, etapa 10); origem `telegram` das mensagens (etapa 14); sem atualização ao vivo entre duas abas abertas na mesma conversa.
- SEC-09-07 (pedido do Pablo): memória que a assistente guarda tem `author = 'agent'`, marca "Anotada pela assistente" e `saved_by="assistant"` no prompt; vira do dono quando ele edita ou repete. O Telegram (etapa 14) passa `origin: telegram` e `author: agent` em `remember`.
- Atenção para a próxima: a etapa 10 chama o runner com `context: "scheduled"` e sem dono presente (nada destrutivo, nenhum plano); toda IA continua por `agent.ai()`. O mock entende `call <ferramenta> {json}`.

### Etapa 8 · Provedor de IA e medição de uso
- Entregou: `packages/shared/src/{ai,ai-limits,time-zone}.ts` (modelos, preços datados de 31/10/2026, `usageReportSchema`), `apps/agent/src/ai/` (`provider`, `workers-ai`, `workers-ai-usage`, `mock`, `usage`, `metered`, `index`), `GET /api/usage`, aba `/configuracoes/ia` (`AiTab.tsx`, `hooks/usage.ts`), binding `AI` no `wrangler.jsonc`. Doc: `docs/ia.md`.
- Migrations: versão 7 (`zur_usage_daily`, `zur_model_usage_daily`, só contadores, 90 dias).
- Decisões técnicas: todo uso de IA passa por `MeteredAI` (reserva o máximo antes, acerta por passo com os tokens da Cloudflare, devolve o que não começou); dias UTC; `maxRetries: 0`; prazo de 120 s por vez; ao fim da vez o medidor fecha e nenhuma chamada nova começa; `enable_thinking: false` só em GLM e Qwen3; IA simulada quando `PUBLIC_URL` é loopback, e `wrangler dev --local` em dev e e2e.
- Ficou para depois: janela de contexto por modelo (Llama 3.3 70B tem 24 mil tokens); limitar o tamanho do resultado de ferramenta; transcrição e embeddings usam `reserveAudio`/`stepNeurons` quando chegarem (etapas da voz e da busca).
- Atenção para a próxima: a etapa 9 chama `agent.ai()` (sempre `MeteredAI`, nunca o provedor cru), passa `signal` do botão Parar e trata `AI_LIMIT_REACHED` e `SERVICE_UNAVAILABLE` (`error.ai*`) no SSE. Senha recente para trocar modelo só na etapa 21 (`aiModel` em `SESSION_FIELDS`).

### Etapa 7 · Memória e histórico
- Entregou: `packages/shared/src/memory.ts` (schemas e limites), `apps/agent/src/memory/` (`text`, `conflict`, `intent`, `dates`, `repository`, `lifecycle`, `service`, `recall`), `apps/agent/src/agent/data.ts` (`dataLine`, `neutralize`), rotas `/api/memories*`, tela `/memoria` com fila "Para revisar", chave `memoryConflictReview` nas configurações. Doc: `docs/memoria.md`.
- Migrations: versão 6 (`zur_memories` + FTS5, `zur_memory_reviews`, índices por estado e por estado+categoria, contadores em `zur_counts`).
- Decisões técnicas: conflito só por regras (sem IA/Clef); regras nunca aposentam memória, só abrem revisão (máx. 500 pendentes); apagar é definitivo (sem lixeira, sem log); fato que vira passado leva as revisões; editar/restaurar para texto de outra atual = 409; busca ranqueia nas 200 ocorrências mais novas (conflito: 50); `fold` só tira acentos latinos.
- Ficou para depois: verificação de conflito por IA; paginação além de 200 por filtro (o resto aparece na busca); importar backup usa `cleanImportedLinks` e precisa `rebuild` do FTS (etapa 23).
- Atenção para a próxima: etapa 9 liga `selectRelevantMemories` + `memoryPromptSection` (orçamento `memoryTokenBudget`) ao runner; `remember` → `create`, `update_memory` → `correct`; `update` sem histórico e revisão `replace`/`cancel` só como `destructive` (`.claude/rules/ferramentas.md`). Todo conteúdo guardado no prompt passa por `dataLine`.

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

## Próxima etapa

- Número e nome: 10 · Automações
- Dependências mescladas: depende da etapa 9 (este PR)
- Precisa de algo do Pablo antes: não
