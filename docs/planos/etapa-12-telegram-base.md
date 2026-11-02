# Plano da etapa 12 · Fundação do bot do Telegram

Situação: em execução (02/11/2026). Fonte: `docs/especificacao.md`, etapa 12 e
seção "Bot do Telegram do administrador"; `.claude/rules/telegram.md`.

## 1. Objetivo

Conectar o bot do administrador à Zuri com segurança: cliente fino da Bot API,
webhook que só aceita o Telegram e só a conta do dono, vínculo por código de uso
único confirmado no app e o cartão do Telegram em Configurações › Avisos.
Comandos (15), avisos (13), conversa e voz (14) e aprovações (16) ficam para as
próximas etapas; esta deixa a base que elas usam.

## 2. Fora do escopo

Avisos pelo Telegram e botões (13), conversa e áudio (14), comandos de consulta,
trava de leitura e limite de 60 comandos por hora (15), aprovações e bloqueio
(16), grupo de avisos (13). As tabelas dessas etapas (`zur_telegram_callbacks`,
`zur_telegram_approvals`, `zur_telegram_pending_files`, `zur_telegram_task_lists`)
nascem nas migrations delas.

## 3. O que o Pablo fornece

Criar o bot no @BotFather e gravar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ADMIN_ID`
como segredos do Worker no deploy. Nada disso bloqueia o código: os testes usam
uma Bot API simulada e nenhum teste chama o Telegram.

## 4. Arquivos

| Onde | O quê |
| --- | --- |
| `packages/shared/src/telegram.ts` | Limites (`TELEGRAM_LIMITS`), estados do cartão, schemas de `GET/PATCH /api/telegram` e de `connect` |
| `apps/agent/src/telegram/client.ts` | Cliente fino: 13 métodos, 10 s de tempo máximo, `redirect: "manual"`, `429 retry_after`, contador de subrequisições (para antes de 45), token nunca em erro ou log |
| `apps/agent/src/telegram/links.ts` | Vínculo e códigos (só HMAC), auditoria de 90 dias |
| `apps/agent/src/telegram/service.ts` | Travas na ordem da regra, deduplicação dos últimos 100 `update_id`, `/start`, registro do webhook e do menu, mensagem de teste, estado do cartão |
| `apps/agent/src/api/telegram.ts` | `GET/PATCH/DELETE /api/telegram`, `POST /api/telegram/{connect,confirm,test}` e o webhook (antes do CSRF, com o cabeçalho secreto) |
| `apps/agent/src/index.ts` | Portão do webhook no Worker: cabeçalho em tempo constante (403), 64 KB (413), repasse só do corpo e do cabeçalho, 200 sempre |
| `apps/agent/src/db/migrations.ts` | Migration 14 `telegram_base` |
| `apps/web/src/pages/settings/TelegramCard.tsx` | Cartão com os estados da especificação, sob demanda dentro da aba Avisos |

## 5. Rotas (contrato)

- `POST /api/telegram/webhook`: cabeçalho secreto; 200 sempre; 403 sem cabeçalho; 413 acima de 64 KB.
- `GET /api/telegram`: estado do cartão.
- `POST /api/telegram/connect` (senha recente): registra webhook e menu quando preciso e devolve código, link `t.me/<bot>?start=<código>` e validade.
- `POST /api/telegram/confirm` (senha recente): vínculo pendente vira ativo.
- `DELETE /api/telegram` (senha recente): desvincula.
- `PATCH /api/telegram` `{conversation, readLockHours}` (senha recente, pela regra de segurança 7): guarda as preferências que a 14 e a 15 usam.
- `POST /api/telegram/test`: mensagem de teste, 3 por hora.

## 6. Dados

Migration 14: `zur_telegram_links` (contrato + `display_name`, o nome que o
cartão mostra), `zur_telegram_link_codes`, `zur_telegram_audit` (índice por
`at`). Estado interno em `zur_settings`: `telegram_seen_update_ids`,
`telegram_menu_version`, `telegram_webhook`, `telegram_bot`,
`telegram_test_window`, `bot_read_lock_hours`.

## 7. Travas do webhook (ordem)

1. Worker: método POST, bot configurado, cabeçalho em tempo constante, corpo até 64 KB. O Durable Object confere o cabeçalho de novo.
2. JSON válido com `update_id` inteiro; `update_id` já visto é ignorado.
3. Tipo em `allowed_updates` (`message`, `callback_query`, `my_chat_member`).
4. Conta: `TELEGRAM_ADMIN_ID` (quando definido) e vínculo ativo ou pendente; chat privado.
5. Conta estranha: nada gravado (nem o `update_id`), nenhuma resposta. Grupo não vinculado: o bot sai (`leaveChat`), sem gravar nada.

O `update_id` só é gravado quando a atualização vai ser tratada, assim a
deduplicação não abre uma porta de escrita para estranhos. O trabalho roda no
Durable Object com `keepAliveWhile`, uma atualização por vez.

## 8. Vínculo

Código de 8 caracteres (alfabeto sem 0/O/1/I), 10 min, guardado só como HMAC do
`SESSION_SECRET`; um código por vez. `/start <código>` certo cria o vínculo
pendente (nome, @ e id) e responde "Confirme o vínculo no app". Código errado
soma num contador em memória; 10 erros em 10 min apagam o código vigente e o
cartão mostra "Gere um novo código". Confirmar no app ativa o vínculo, gera
alerta de segurança `telegram_linked` e manda "Conta conectada" ao chat.
Desvincular gera `telegram_unlinked`.

## 9. Interface

Cartão Telegram na aba Avisos: não configurado, pronto para conectar,
aguardando `/start` (código, link, validade, copiar), aguardando confirmação
(nome, @, 4 últimos dígitos, Confirmar esta conta), vinculado (Enviar teste,
Reconectar, Desvincular), webhook com erro, código invalidado. Estados de
carregando e erro, teclado, leitor de tela, claro e escuro, celular.

## 10. Testes

- Unitários: cliente (timeout, redirecionamento recusado, 429 com `retry_after`, 400 "message is not modified", 403 "bot was blocked", token fora das mensagens de erro, teto de subrequisições), códigos (formato, validade, HMAC).
- Integração pelo Worker: sem cabeçalho = 403, cabeçalho errado = 403, 64 KB + 1 = 413, `update_id` repetido ignorado, conta estranha não grava nada (contagem de linhas antes e depois), grupo estranho só recebe `leaveChat`, `edited_message` ignorado, código errado 10 vezes invalida, vínculo pendente → confirmar com senha recente → ativo, desvincular, teste com limite, `TELEGRAM_ADMIN_ID` diferente barra até o código certo.
- Fixtures em `apps/agent/test/fixtures/telegram/`.
- e2e e axe do cartão com o bot não configurado (o e2e não tem token).

## 11. Segurança

Token só em segredo; nunca no navegador, em log, em erro ou no GitHub Actions.
O segredo do webhook é HMAC do `SESSION_SECRET`. Nada do dono em `callback_data`
(nenhum botão nesta etapa). Textos do Telegram enviados sem `parse_mode`.
Nome e @ da conta são texto de terceiro: só aparecem escapados na interface.

## 12. Performance

Webhook: 1 requisição ao Worker e 1 ao Durable Object por atualização; estranho
não escreve. `GET /api/telegram` lê o `getWebhookInfo` no máximo a cada 5 min
(memória). O cartão entra no pedaço da aba Avisos: o JS inicial não cresce.

## 13. Riscos

Teto de 139 kB do JS inicial (cartão sob demanda). Contador de códigos errados
em memória zera quando o objeto dorme (aceito pela especificação).

## 14. Para a etapa 13

A interface `AlertChannel` ganha o canal Telegram usando `TelegramService.send`;
o vínculo ativo dá o `chat_id`. Os alertas `telegram_linked`/`telegram_unlinked`
já existem.
