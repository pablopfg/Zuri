---
paths:
  - "apps/agent/src/telegram/**"
---

# Bot do Telegram

Releia a seção "Bot do Telegram do administrador" da especificação antes de qualquer mudança.

- Ordem das travas: cabeçalho secreto em tempo constante → 64 KB → `update_id` novo → tipo em `allowed_updates` → conta do vínculo ativo e `TELEGRAM_ADMIN_ID` → chat privado. Conta estranha não grava nada nem recebe resposta.
- O webhook responde 200 e repassa ao Durable Object; o trabalho roda com `keepAliveWhile`, contando subrequisições (para antes de 45).
- Comandos sem IA. Trava de leitura depois de 12 h sem uso. Confirmação forte (passkey ou e-mail) só pelo fluxo de `zur_telegram_approvals`.
- A lista "nunca pelo bot" não muda sem decisão do dono.
- `callback_data` = `v1:<ação>:<id opaco>`; nunca dado do dono.
- Saída em HTML do Telegram com escape e links desarmados; blocos de 4.096 caracteres.
- Alertas causados pelo bot só se reconhecem no app.
- O token do bot nunca vai ao GitHub nem a log.
