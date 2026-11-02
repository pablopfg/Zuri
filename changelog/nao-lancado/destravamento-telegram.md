<!-- versao: minor -->

### Adicionado

- `/destravar` no bot do Telegram. Quando a leitura está travada, o bot
  oferece **Confirmar com passkey**, que abre a página nova `/aprovar`, e
  **Receber código por e-mail**, com um código de 6 dígitos que você responde
  no próprio chat. Confirmado, a leitura fica liberada por 12 horas e o bot
  avisa até que horas.
- `/nova_conversa` começa outra conversa com a Zuri pelo Telegram. A anterior
  continua no app.
- O menu do bot mostra `/ajuda`, `/destravar` e `/nova_conversa`, e o `/ajuda`
  explica a trava.

### Alterado

- A trava provisória da conversa pelo Telegram saiu. Antes, depois de 12 horas
  sem uso, a conversa se desligava e só voltava pelo app. Agora a conversa
  continua ligada, e a leitura pede `/destravar`. Ligar a conversa no app não
  destrava mais a leitura.

### Segurança

- Trava de leitura do bot: depois das horas sem uso escolhidas no app (12 por
  padrão), a conversa, `/nova_conversa` e o botão de arquivo grande pedem
  destravamento. Mensagem enviada com a leitura travada não conta como uso.
- O link de `/aprovar` vale 5 minutos e uma vez só, fica guardado só como
  HMAC e sai da barra de endereço antes de qualquer pedido. A passkey precisa
  confirmar quem você é (digital, rosto ou PIN).
- O código por e-mail vale 5 minutos, só como resposta à pergunta do bot, e a
  mensagem com ele é apagada na hora. Reenvio depois de 1 minuto, até 3 por
  hora, com uma cota própria de 10 e-mails por dia que não gasta a dos avisos.
- Cinco confirmações erradas em 15 minutos travam as confirmações pelo bot por
  1 hora e geram um alerta de segurança (no máximo 1 por dia).
- Cada destravamento aparece em Acessos e gera um aviso de segurança, uma vez,
  sem insistir.
- Limite de 60 comandos por hora no bot, além das 30 mensagens por hora, que
  agora contam também as mensagens enviadas com a leitura travada.
- O rodapé dos e-mails avisa que códigos de confirmação só servem no bot.

### Atualização

- Migration 17: tabela `zur_telegram_approvals` (confirmações pelo bot).
