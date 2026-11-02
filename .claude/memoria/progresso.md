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
| 14 | em revisão | — | Conversa e voz no Telegram: conversa do app pelo bot, HTML em blocos, voz até 5 min/5 MB, pergunta antes de baixar arquivo grande, terceiros como `<data>` |

## Últimas etapas (detalhe)

### Etapa 14 · Conversa e voz no Telegram
- Entregou: `apps/agent/src/telegram/{conversation,format}.ts` (`TelegramConversation`: turno, "digitando…", voz, pergunta de arquivo grande; Markdown → HTML do Telegram e divisão em 4.096), `TelegramClient.download`, `MeteredAI.reserveAudio` (reserva antes do download), `UsageMeter.room`, `TurnInput.source/quoted`, `ToolContext.source` (memória com `origin: telegram`). Tela: interruptor "Conversar com a Zuri por aqui" no `TelegramCard`, `components/Switch.tsx`, marca "pelo Telegram" e caixa de texto citado na conversa. Plano: `docs/planos/etapa-14-conversa-telegram.md`.
- Migrations: versão 16 (`zur_telegram_pending_files`, `zur_messages.quoted`).
- Decisões técnicas: uma conversa do Telegram por vez (`telegram_conversation` em `zur_settings`), recriada se apagada; texto do próprio dono é a mensagem do turno e o de terceiros (encaminhada, citação, resposta a outra pessoa, voz encaminhada) vai em `quoted` e no prompt como `<data source="telegram_forward">`; botões `v1:large_file|large_skip:<id>` apontam para a linha do arquivo (sem `zur_telegram_callbacks`); teto extra de 30 min por arquivo (o Whisper não publica limite); o turno corre fora da fila do bot (`Started`), então a fila lê a próxima atualização enquanto responde.
- Para a 15: trava de leitura, limite de 30 mensagens/hora e `/nova_conversa` (troca `telegram_conversation`); fotos e documentos hoje respondem "só texto e áudio". Para a 16: proposta no turno mostra **Abrir no app** (`/conversa/<id>`); trocar pelo botão Aprovar.

### Etapa 13 · Avisos no Telegram
- Entregou: `apps/agent/src/telegram/{channel,callbacks}.ts` (canal `TelegramChannel`, botões `v1:<ação>:<id>`), grupo em `TelegramLinks` (`group`, `saveGroup`, `moveGroup`, `setTopics`), toques e grupo em `TelegramService` (`groupCode`, `unlinkGroup`), `AlertService.respondOutOfBand` e `snoozed_until` (volta como cópia em `escalate`), rotas `POST/DELETE /api/telegram/group`, configuração `alertFullText`, evento `telegram_group_linked` (origem `bot` em `alerts/security.ts`). Tela: seção do grupo no `TelegramCard`, coluna "Texto completo" no `RoutesCard`. Plano: `docs/planos/etapa-13-avisos-telegram.md`.
- Migrations: versão 15 (`zur_telegram_callbacks`, `zur_notices.snoozed_until`).
- Decisões técnicas: texto puro com `disarmLinks`; segurança e 3ª tentativa sempre no chat privado; Feito em todo aviso, Adiar/Silenciar só em alta e crítica; alerta de segurança com origem `bot` sai sem botões e o bot recusa; código do grupo em `zur_settings` (`telegram_group_code`, HMAC com propósito próprio).
- Para a 16: reconhecimento no app, com senha recente, dos alertas causados pelo bot (hoje eles insistem e viram "não confirmado"). Para a 15: `/avisos` pode reaproveitar `formatNotice`. Sem fila por chat ainda (limite por canal segura o volume).

### Etapa 12 · Fundação do bot
- Entregou: `packages/shared/src/telegram.ts` (limites, estados do cartão, schema do PATCH), `apps/agent/src/telegram/{client,links,service}.ts`, `apps/agent/src/api/telegram.ts` (webhook antes do CSRF + `GET/PATCH/DELETE /api/telegram`, `POST /api/telegram/{connect,confirm,test}`), portão do webhook em `src/index.ts` (403 sem cabeçalho, 413 acima de 64 KB), `TelegramCard` na aba Avisos, eventos `telegram_linked`/`telegram_unlinked` (alerta). Docs: `docs/telegram.md`, `docs/configuracao-cloudflare.md`, `docs/seguranca.md`. Plano: `docs/planos/etapa-12-telegram-base.md`.
- Migrations: versão 14 (`zur_telegram_links` com `display_name` a mais que o contrato, `zur_telegram_link_codes`, `zur_telegram_audit`). As tabelas de callbacks, aprovações, arquivos pendentes e listas nascem nas etapas 13 a 16.
- Decisões técnicas: segredo do webhook = HMAC **hex** do `SESSION_SECRET` (antes base64url); o `update_id` só é gravado quando a atualização vai ser tratada (conta estranha não grava nada); fila serial no objeto com `keepAliveWhile`; códigos errados em memória, 10 em 10 min apagam o código e gravam `telegram_code_invalidated`; `getWebhookInfo` em cache de 5 min; menu com versão `TELEGRAM_MENU_VERSION:idioma`, reenviado no `onStart`; só `/ajuda` no menu por enquanto; mensagens em texto puro sem prévia de link.
- Para a 13: canal `AlertChannel` do Telegram usa `TelegramService.client()` e o `chatId` do vínculo ativo; somar comandos ao `MENU` sobe `TELEGRAM_MENU_VERSION`. Para a 15: `bot_read_lock_hours` e `last_used_at` já existem; limite de 60 comandos/30 mensagens por hora ainda não. Para a 14: `conversation_enabled` já é gravado pelo PATCH.

### Notas que continuam valendo
- Um alarme só (P8): use `AutomationService.rearm()`/`otherDue`, nunca outro alarme. O runner aceita `context: "scheduled"` (só leitura, sem dono presente). Toda IA por `agent.ai()`.
- JS inicial em ~138,9 kB (teto 139): tela nova sob demanda, textos via `addMessages`.

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

- Número e nome: 14 · Conversa e voz, depois que a 13 mesclar
- Dependências mescladas: 9 (#28), 12 (#70); 13 em revisão
- Precisa de algo do Pablo antes: não (o bot no @BotFather só é preciso no deploy)
