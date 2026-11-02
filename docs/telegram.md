# Bot do Telegram

O bot é um segundo painel do dono, ao lado da interface web. Ele obedece a uma
conta só do Telegram, no chat privado, e passa pelos mesmos serviços, limites e
regras de aprovação do app. O comportamento completo está na seção "Bot do
Telegram do administrador" da [especificação](especificacao.md); esta página
diz o que já existe e como usar.

| Etapa | O que traz | Situação |
| :---: | --- | --- |
| 12 | Fundação: cliente da Bot API, webhook, vínculo da conta, cartão em Configurações › Avisos | pronta |
| 13 | Avisos no Telegram com botões | a fazer |
| 14 | Conversa por texto e voz | a fazer |
| 15 | Comandos de consulta e ação rápida, trava de leitura | a fazer |
| 16 | Aprovações com passkey ou e-mail e modo de bloqueio | a fazer |

## Criar o bot

Passo a passo em [configuracao-cloudflare.md](configuracao-cloudflare.md#bot-do-telegram-opcional):
criar o bot no @BotFather e gravar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ADMIN_ID`
como segredos do Worker. O token nunca vai ao repositório, ao GitHub Actions,
ao navegador ou ao log.

## Conectar a sua conta

1. Em **Configurações › Avisos**, no cartão **Telegram**, toque em
   **Conectar** (a Zuri pede a senha se você não a digitou nos últimos 15
   minutos).
2. Aparece um código de 8 caracteres, válido por 10 minutos, e o botão
   **Abrir o Telegram**, que abre o bot com o código. Também dá para mandar
   `/start CÓDIGO` ao bot.
3. O bot responde que recebeu o código. O cartão mostra o nome, o @ e os 4
   últimos dígitos do id da conta que mandou o código.
4. Confira se é a sua e toque em **Confirmar esta conta**. Se não for, toque em
   **Não é minha**. Confirmar gera um alerta de segurança, para você saber se
   alguém conectou outra conta.

Depois disso o cartão oferece **Enviar teste** (até 3 por hora),
**Reconectar** e **Desvincular**. Reconectar registra de novo o endereço no
Telegram e gera outro código; use quando trocar o token, o domínio ou o
`SESSION_SECRET`, ou quando o cartão disser que o bot não está recebendo
mensagens.

## Quem o bot ouve

- Só atualizações com o cabeçalho secreto certo, de até 64 KB, e só uma vez
  cada (o bot lembra os últimos 100 números de atualização).
- Só mensagens, toques em botões e mudanças do próprio bot num chat. Mensagens
  editadas e os outros tipos são ignorados.
- Só a conta do vínculo e, quando definido, a do `TELEGRAM_ADMIN_ID`, e só no
  chat privado. Qualquer outra conta não recebe resposta e não deixa nada
  gravado. Em grupos, o bot sai na primeira mensagem.
- Dez códigos errados em 10 minutos cancelam o código; gere outro no app.

## O que o bot responde hoje

Nesta etapa o bot confirma o vínculo, manda a mensagem de teste e responde a
`/ajuda`. Para o resto, ele diz que a conversa ainda é pelo app. Avisos,
comandos e conversa chegam nas etapas 13 a 15. Algumas ações nunca serão
feitas pelo bot (trocar senha ou e-mail, desligar o 2FA, desvincular o
próprio Telegram, entre outras): para essas o bot sempre manda abrir o app.

## Limites e custo

A Bot API é gratuita. Cada atualização é uma requisição ao Worker e uma ao
Durable Object, dentro do plano Free. Cada chamada à Bot API tem 10 segundos de
prazo, nunca segue redirecionamento e, com `429`, espera uma vez quando o
Telegram pede até 5 segundos. Um trabalho do bot para antes de 45 chamadas
externas (o limite do plano Free é 50). O registro do bot guarda só metadados
(comando, resultado e hora) por 90 dias.
