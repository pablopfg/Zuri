# Glossário

| Termo | Significado |
| --- | --- |
| Dono | O único usuário do Zuri (o Pablo). Não existe outro papel. |
| Etapa | Uma entrega da especificação, que vira um PR para `develop`. |
| Proposta | Ação `destructive` que o agente sugere e só executa depois da aprovação do dono, presa ao hash do alvo. |
| Aprovação pelo bot | Botão no Telegram que leva à página `/aprovar` (passkey) ou pede o código de 6 dígitos por e-mail. Nunca TOTP. |
| Trava de leitura | Depois de 12 h sem uso, o bot só lê até o dono se confirmar de novo. |
| Bloqueio (`/bloquear`) | Modo de emergência: encerra sessões, suspende o vínculo do bot e exige código de recuperação para voltar. |
| Bloco `<data>` | Envelope em que conteúdo guardado ou externo entra no prompt, com `‹ ›` no lugar de `< >`, para nunca virar instrução. |
| Reconhecimento cruzado | Alerta de segurança reconhecido num canal (web ou bot) some do outro. |
| Talorys / Axis | Projeto de referência (`pablopfg/talorys`), só para leitura. |
| `TELEGRAM_ADMIN_ID` | Id numérico do dono no Telegram; segredo do Worker, nunca no repositório. |
| Plano Free | Plano gratuito da Cloudflare; o Zuri precisa caber nele. |
| Rede (limite de login) | Unidade do limite de força bruta: o endereço IPv4 ou o /64 do IPv6 de quem tenta entrar. |
| Senha recente | Senha (ou, na etapa 4, TOTP) digitada nos últimos 15 minutos nesta sessão; exigida por ações sensíveis. |
| Presença | Sinal de que há uma aba aberta (qualquer requisição ou o heartbeat). Sem ele por 5 min, a sessão acaba. |
| Impressão digital dos segredos | HMAC dos segredos de senha e do pepper; muda quando o dono redefine a senha pelo painel. |
