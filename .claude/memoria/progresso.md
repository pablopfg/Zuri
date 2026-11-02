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
| 15b | em revisão | — | Comandos rápidos sem IA (`/hoje`, `/tarefas`, `/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`, `/avisos`, `/uso`, `/status`, `/backup`), gramática de datas, fotos e documentos viram nota, botão Destravar |

## Últimas etapas (detalhe)

### Etapa 15b · Comandos rápidos no Telegram
- Entregou: `apps/agent/src/telegram/{commands,dates}.ts` (`TelegramCommands`, um método por comando; `parseWhen`/`extractWhen`, a gramática de datas), `CommandButtons` em `callbacks.ts` (linhas `target_type = 'command'` em `zur_telegram_callbacks`, validade por botão, uso único), roteamento em `service.ts` (comandos, botões, Corrigir por `force_reply`, fotos e documentos, botão Destravar em todo aviso de trava), menu v3 com 16 comandos. Plano: `docs/planos/etapa-15b-comandos-telegram.md`.
- Migrations: nenhuma (17 continua a última; a próxima é a 18). Chaves novas em `zur_settings`: `telegram_task_numbers`, `telegram_fix`.
- Decisões técnicas: respostas em texto puro com `disarm()`; fotos e documentos contam nos 60 comandos/h e pedem destravamento; Adiar = amanhã na mesma hora (09:00 sem prazo); lembrete do bot nasce com origem `app`; "semana que vem" sozinha = segunda seguinte; agenda, monitores, MCP, embeddings e idade do backup ficam para as etapas 17, 18, 19, 22 e 23.
- Para a 16: botões novos entram em `COMMAND_ACTIONS` (`callbacks.ts`) e passam por `TelegramCommands.tap`; `OPEN_COMMANDS` diz o que não pede destravamento (a 16 soma `/bloquear`, `/pausar_rotinas`, `/encerrar_sessoes`); o menu sobe para a versão 4.

### Etapa 15a · Destravar o bot do Telegram
- Entregou: `apps/agent/src/telegram/{read-lock,confirmations}.ts` (`ReadLock`; `TelegramConfirmations`: link de uso único, código por e-mail, 5 erros/15 min travam 1 h), rotas `POST /api/approvals/telegram/{options,verify}` (`api/approvals.ts`, sem sessão, CSRF + limitador do login), página `/aprovar` (`pages/ApprovePage.tsx`, textos em `pt-BR-approve.ts`), cota `confirmations` no `EmailSender` (10/dia), eventos `telegram_unlocked` (aviso sem insistir, `insist: false`) e `telegram_confirm_locked`, menu v2 (`/ajuda`, `/destravar`, `/nova_conversa`), hook `afterUpdate` que manda os alertas de segurança logo depois de cada atualização. Plano: `docs/planos/etapa-15a-destravamento-telegram.md`.
- Migrations: versão 17 (`zur_telegram_approvals`, com `reply_message_id` a mais que o contrato).
- Decisões técnicas: a etapa 15 virou 15a e 15b; a trava provisória (conversa desligada) saiu; só uso com a leitura liberada renova o prazo; token no fragmento e só HMAC no banco; código só vale como resposta (`force_reply`) e a mensagem é apagada; chaves novas em `zur_settings` (`bot_unlocked_until`, `telegram_command_window`, `telegram_confirm_*`, `email_confirm_window`).
- Para a 15b: o aviso de trava ainda é só texto com `/destravar`; a especificação prevê um botão nele (fazer com os comandos); comandos de consulta (`/hoje`, `/tarefas`, `/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`, `/avisos`, `/uso`, `/status`), fotos e documentos (N4) e `/backup`; todo comando de leitura passa por `#lock.locked()`; somar ao `MENU` sobe `TELEGRAM_MENU_VERSION` (hoje 2); o limite de 60/h já vale. Para a 16: `TelegramConfirmations` aceita outros propósitos (`TELEGRAM_CONFIRM_PURPOSES`), a página `/aprovar` já trata o resultado por propósito; trocar **Abrir no app** por Aprovar.

### Etapa 14 · Conversa e voz no Telegram
- Entregou: `apps/agent/src/telegram/{conversation,format}.ts` (`TelegramConversation`: turno, "digitando…", voz, pergunta de arquivo grande; Markdown → HTML do Telegram e divisão em 4.096), `TelegramClient.download`, `MeteredAI.reserveAudio` (reserva antes do download), `UsageMeter.room`, `TurnInput.source/quoted`, `ToolContext.source` (memória com `origin: telegram`). Tela: interruptor "Conversar com a Zuri por aqui" no `TelegramCard`, `components/Switch.tsx`, marca "pelo Telegram" e caixa de texto citado na conversa. Plano: `docs/planos/etapa-14-conversa-telegram.md`.
- Migrations: versão 16 (`zur_telegram_pending_files`, `zur_messages.quoted`).
- Decisões técnicas: uma conversa do Telegram por vez (`telegram_conversation` em `zur_settings`), recriada se apagada; texto do próprio dono é a mensagem do turno e o de terceiros (encaminhada, citação, resposta a outra pessoa, voz encaminhada) vai em `quoted` e no prompt como `<data source="telegram_forward">`; botões `v1:large_file|large_skip:<id>` apontam para a linha do arquivo (sem `zur_telegram_callbacks`); teto extra de 30 min por arquivo (o Whisper não publica limite); o turno corre fora da fila do bot (`Started`), então a fila lê a próxima atualização enquanto responde.
- Para a 15: trava de leitura, limite de 30 mensagens/hora e `/nova_conversa` (troca `telegram_conversation`); fotos e documentos hoje respondem "só texto e áudio". Para a 16: proposta no turno mostra **Abrir no app** (`/conversa/<id>`); trocar pelo botão Aprovar.

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

- Número e nome: 15b · Comandos administrativos, depois que a 15a mesclar
- Dependências mescladas: 6, 7, 10, 11, 12 (#70), 14 (#75); 15a em revisão
- Precisa de algo do Pablo antes: não (o bot no @BotFather só é preciso no deploy)
