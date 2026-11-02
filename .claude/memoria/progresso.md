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
| 16b | em revisão | — | Comandos de segurança (`/acessos`, `/sessoes`, `/encerrar_sessoes`, `/tokens`, `/pausar_rotinas`, `/bloquear`), modo de bloqueio com a tela **Sair do bloqueio**, rebloqueio que suspende o vínculo, **Confirmar que vi** no app |

## Últimas etapas (detalhe)

### Etapa 16b · Comandos de segurança e modo de bloqueio
- Entregou: `apps/agent/src/telegram/security.ts` (`TelegramSecurity`, `maskAddress`), `apps/agent/src/auth/lockdown.ts` (`Lockdown`, `RemoteTokenHook`/`NO_REMOTE_TOKENS`), recusas no login (`LOCKDOWN_ACTIVE`), na API (lista `WHILE_LOCKDOWN` em `api/app.ts`) e no bot (`#duringLockdown`), `GET /api/lockdown`, `POST /api/lockdown/exit`, `POST /api/notices/:id/acknowledge` (`acknowledgeInApp`, `Notice.ackInApp`), executor com problema `lockdown`, tela `LockdownPage.tsx` (no chunk de `PasswordChangePage`), menu v5. Plano: `docs/planos/etapa-16b-modo-de-bloqueio.md`.
- Migrations: nenhuma (18 continua livre). Chaves em `zur_settings`: `lockdown_until` (fim da 1ª hora; ligado enquanto existir), `lockdown_source` (`telegram:<vínculo>[|relock]`, fica após a saída), `lockdown_exited_at`.
- Decisões técnicas: rotinas com IA são puladas (não pausadas) durante o bloqueio; login com código de recuperação sai a qualquer momento; sem 2FA, sair pede só a senha recente; toques em avisos do Telegram durante o bloqueio não agem; textos da tela em `pt-BR-setup.ts` (orçamento do JS inicial: 139.076 B).
- Para as próximas: a etapa 20 liga os tokens no `RemoteTokenHook` (`suspendAll`/`resumeAll`/`active`) e põe **Revogar** em `/tokens`; etapas 18 e 22 consultam `auth.lockdown.active()` para pausar MCP e workflows; rota nova que precise funcionar no bloqueio entra em `WHILE_LOCKDOWN`.

### Etapa 16a · Aprovações pelo bot
- Entregou: `apps/agent/src/telegram/approvals.ts` (`TelegramApprovals`: prévia a partir do `snapshot` atual, cartão com **Aprovar**, `turnCards` até 3 por resposta, `/aprovar` até 5, `run` por `runApprovedAction`; `BOT_APPROVABLE` lista fechada), `targetState` em `tools/registry.ts`, `TelegramConfirmations.open(purpose, target)` com `pending_action_id`/`target_hash` e reaproveitamento do pedido aberto, `CommandButtons` com ação `approve` que não se gasta, rotas da página devolvendo 409 `TARGET_CHANGED`/`CONFLICT`, página `/aprovar` com a prévia, evento `telegram_approved` (origem `bot`, sem insistir), menu v4 com `/aprovar`. Plano: `docs/planos/etapa-16-aprovacoes-telegram.md`.
- Migrations: nenhuma (18 continua livre).
- Decisões técnicas: a etapa 16 virou 16a e 16b; o título e o texto atual da prévia saem do primeiro e do segundo campo do `snapshot`; planos e rotinas propostos continuam com **Abrir no app**; o aviso da aprovação segue a regra do destravamento (uma vez, sem insistir); um pedido novo encerra o aberto.
- Para a 16b: bloco em `docs/agente/prompts-das-etapas.md`; durante o bloqueio, `#approve`, `/aprovar` e o código de aprovação devem recusar; `/bloquear`, `/pausar_rotinas` e `/encerrar_sessoes` entram em `OPEN_COMMANDS` (ou equivalente no serviço); menu sobe para a versão 5; tokens remotos só na etapa 20.

### Etapa 15b · Comandos rápidos no Telegram
- Entregou: `apps/agent/src/telegram/{commands,dates}.ts` (`TelegramCommands`, um método por comando; `parseWhen`/`extractWhen`, a gramática de datas), `CommandButtons` em `callbacks.ts` (linhas `target_type = 'command'` em `zur_telegram_callbacks`, validade por botão, uso único), roteamento em `service.ts` (comandos, botões, Corrigir por `force_reply`, fotos e documentos, botão Destravar em todo aviso de trava), menu v3 com 16 comandos. Plano: `docs/planos/etapa-15b-comandos-telegram.md`.
- Migrations: nenhuma (17 continua a última; a próxima é a 18). Chaves novas em `zur_settings`: `telegram_task_numbers`, `telegram_fix`.
- Decisões técnicas: respostas em texto puro com `disarm()`; fotos e documentos contam nos 60 comandos/h e pedem destravamento; Adiar = um dia adiante na mesma hora (vencida: amanhã; 09:00 sem prazo); lembrete do bot nasce com origem `app`; "semana que vem" sozinha = segunda seguinte; agenda, monitores, MCP, embeddings e idade do backup ficam para as etapas 17, 18, 19, 22 e 23.
- Para a 16: botões novos entram em `COMMAND_ACTIONS` (`callbacks.ts`) e passam por `TelegramCommands.tap`; `OPEN_COMMANDS` diz o que não pede destravamento (a 16 soma `/bloquear`, `/pausar_rotinas`, `/encerrar_sessoes`); o menu sobe para a versão 4.

### Notas que continuam valendo
- Um alarme só (P8): use `AutomationService.rearm()`/`otherDue`, nunca outro alarme. O runner aceita `context: "scheduled"` (só leitura, sem dono presente). Toda IA por `agent.ai()`.
- JS inicial em ~139,08 kB (teto 139,1): tela nova sob demanda, textos via `addMessages`; tela que trava o app vai no chunk de `PasswordChangePage`.

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

- Número e nome: 15b · Comandos administrativos, depois que a 15a mesclar
- Dependências mescladas: 6, 7, 10, 11, 12 (#70), 14 (#75); 15a em revisão
- Precisa de algo do Pablo antes: não (o bot no @BotFather só é preciso no deploy)
