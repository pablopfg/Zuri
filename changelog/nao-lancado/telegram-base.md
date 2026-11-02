### Adicionado

- Bot do Telegram, primeira parte: em Configurações > Avisos, o cartão
  Telegram conecta a sua conta com um código de uso único que vale 10 minutos.
  O vínculo só passa a valer depois que você confere o nome e o @ da conta e
  toca em Confirmar esta conta, com a senha. O cartão também envia uma mensagem
  de teste, reconecta e desvincula.
- O bot só atende a sua conta, só no chat privado. Quem não é você não recebe
  resposta e não deixa nada gravado; em grupos, o bot sai. Mensagens repetidas
  pelo Telegram são tratadas uma vez só, e dez códigos errados cancelam o código.
- Por enquanto o bot responde a `/ajuda` e diz que a conversa ainda é pelo app.
  Avisos, comandos e conversa chegam nas próximas etapas.

### Segurança

- Conectar, confirmar e desvincular o Telegram pedem a senha digitada há pouco
  e geram alerta de segurança. O token do bot fica só como segredo e nunca
  aparece em erro, log ou na tela.

### Atualização

- A migration 14 cria as tabelas do vínculo, do código e do registro do bot e
  roda sozinha na primeira requisição depois do deploy.
- Segredos novos e opcionais: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ADMIN_ID`
  (passo a passo em `docs/configuracao-cloudflare.md`). Sem eles, o cartão
  mostra que o bot não está configurado.
