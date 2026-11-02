# Bot do Telegram

O bot é um segundo painel do dono, ao lado da interface web. Ele obedece a uma
conta só do Telegram, no chat privado, e passa pelos mesmos serviços, limites e
regras de aprovação do app. O comportamento completo está na seção "Bot do
Telegram do administrador" da [especificação](especificacao.md); esta página
diz o que já existe e como usar.

| Etapa | O que traz | Situação |
| :---: | --- | --- |
| 12 | Fundação: cliente da Bot API, webhook, vínculo da conta, cartão em Configurações › Avisos | pronta |
| 13 | Avisos no Telegram com botões, grupo de avisos opcional | pronta |
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
  gravado.
- Em grupos, só o grupo de avisos vinculado (veja abaixo). Nele, só os toques
  da sua conta nos botões dos avisos contam; outra pessoa recebe "Só o dono
  pode usar estes botões." e nada é gravado. De qualquer outro grupo o bot sai
  na primeira mensagem.
- Dez códigos errados em 10 minutos cancelam o código; gere outro no app.

## Avisos no Telegram

O Telegram é um canal da central de avisos, como a notificação no aparelho e o
e-mail. A tabela **O que vai para cada canal**, em Configurações › Avisos,
decide quais tipos de aviso vão para ele, e os limites por canal valem igual.
Prioridade baixa fica só no app; avisos críticos e alertas de segurança vão
sempre.

- **Discreto por padrão.** A mensagem traz o título, o tipo e a prioridade; o
  texto fica no app ("Abra a Zuri para ler."). Ligue **Texto completo** na
  categoria para ler o texto no Telegram.
- **Texto puro.** Nada de formatação, e todo endereço que vem no aviso chega
  desarmado (`hxxps://exemplo[.]com`), para um texto de rotina ou de fora não
  virar um link clicável que parece da Zuri. O único link é o botão **Abrir**,
  que leva ao app.
- **Som** só em prioridade alta e crítica; as outras chegam em silêncio.
- **Botões.** Todo aviso tem **Feito** (marca como lido) e **Abrir**. Os altos
  e críticos têm também **Adiar 1 h** (marca como lido e o aviso volta daqui a
  uma hora) e **Silenciar** (para de insistir sem marcar como lido). Depois do
  toque, os botões saem da mensagem; um toque num botão velho responde "Este
  aviso já foi tratado.". Os botões valem 24 horas e não carregam dado nenhum
  do aviso, só um número aleatório.
- **Insistência.** Aviso alto ou crítico sem resposta chega de novo depois de
  15 minutos e de 1 hora, com "Tentativa 2 de 3" no rodapé. A terceira
  tentativa vai sempre ao chat privado.
- **Alertas de segurança** vão sempre ao chat privado, nunca ao grupo. Um
  alerta causado no app (login, senha, verificação em duas etapas) para de
  insistir com Feito, Adiar ou Silenciar no Telegram. Um alerta causado pelo
  próprio bot (como vincular um grupo) só se resolve no app, e por isso chega
  sem esses botões.

### Grupo de avisos (opcional)

Sem grupo, os avisos chegam no chat com o bot. Para mandar para um grupo:

1. No cartão do Telegram, toque em **Adicionar grupo** (a Zuri pede a senha se
   você não a digitou nos últimos 15 minutos). O link vale 10 minutos.
2. Toque em **Escolher o grupo**, escolha o grupo e adicione o bot. Só vale se
   for a sua conta do Telegram que adicionou; o bot responde "Este grupo agora
   recebe os avisos da Zuri." e a Zuri gera um alerta de segurança.
3. Para um tópico por tipo de aviso, ligue os tópicos no grupo e dê ao bot a
   permissão de gerenciar tópicos. O tópico é criado no primeiro aviso de cada
   tipo; se você apagar um, o aviso vai para o tópico geral e o tópico volta no
   próximo.

Quem está no grupo lê o que chegar nele, por isso o grupo também recebe só o
título, a não ser que você ligue Texto completo. **Remover grupo** faz o bot
sair do grupo e os avisos voltarem ao chat; desvincular a conta tira o grupo
junto, e tirar o bot do grupo pelo Telegram também desfaz o vínculo.

## O que o bot responde hoje

Além dos avisos, o bot confirma o vínculo, manda a mensagem de teste e
responde a `/ajuda`. Para o resto, ele diz que a conversa ainda é pelo app.
Comandos e conversa chegam nas etapas 14 e 15. Algumas ações nunca serão
feitas pelo bot (trocar senha ou e-mail, desligar o 2FA, desvincular o
próprio Telegram, entre outras): para essas o bot sempre manda abrir o app.

## Quando algo falha por dentro

O webhook responde 200 a toda atualização aceita, e o trabalho roda depois, na
fila do Durable Object. Só quando o próprio objeto responde com erro (por
exemplo, o banco fora do ar) o Worker devolve 500, para o Telegram entregar a
atualização de novo mais tarde; como o número da atualização só é guardado
quando ela é tratada, a repetição não faz nada duas vezes.

## Limites e custo

A Bot API é gratuita. Cada atualização é uma requisição ao Worker e uma ao
Durable Object, dentro do plano Free. Cada chamada à Bot API tem 10 segundos de
prazo, nunca segue redirecionamento e, com `429`, espera uma vez quando o
Telegram pede até 5 segundos. Um trabalho do bot para antes de 45 chamadas
externas (o limite do plano Free é 50). O registro do bot guarda só metadados
(comando, resultado e hora) por 90 dias.

Cada aviso é uma chamada à Bot API, dentro do limite por canal (6 por hora e 30
por dia, por padrão); o tópico custa uma chamada a mais na primeira vez. Os
toques nos botões chegam pelo mesmo webhook. Nada disso usa IA.
