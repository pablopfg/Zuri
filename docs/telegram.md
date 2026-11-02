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
| 14 | Conversa por texto e voz | pronta |
| 15a | Trava de leitura com `/destravar` (passkey ou código por e-mail), `/nova_conversa` | pronta |
| 15b | Comandos de consulta e ação rápida | pronta |
| 16a | Aprovar as propostas da Zuri com passkey ou código por e-mail, `/aprovar` | pronta |
| 16b | Comandos de segurança e modo de bloqueio | a fazer |

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

## Conversar com a Zuri pelo Telegram

A conversa nasce desligada. Em Configurações › Avisos, no cartão do Telegram,
ligue **Conversar com a Zuri por aqui**. Desligada, o bot responde como ligar
e não lê nada do que você manda, nem baixa áudio.

Ligada, tudo o que você escreve no chat privado com o bot vira uma conversa
comum do app, com as mesmas memórias, ferramentas e limites. A conversa
aparece na sua lista de conversas e cada mensagem dela leva a marca "pelo
Telegram". Se você apagar essa conversa no app, a próxima mensagem abre outra.

- Um turno por vez, com até 3 minutos. Mensagem que chega no meio recebe
  "Ainda estou respondendo a sua mensagem anterior". Se o tempo acabar, a Zuri
  avisa e o que ela já tinha escrito fica guardado no app.
- Enquanto pensa, o bot mostra "digitando…" (no primeiro minuto, até 12
  vezes).
- A resposta vem formatada (negrito, itálico, código), com todo texto escapado
  e links desarmados. Resposta longa chega em mais de uma mensagem, em blocos
  de até 4.096 caracteres que nunca cortam uma marcação no meio.
- Quando a Zuri propõe algo que precisa da sua aprovação (apagar uma tarefa,
  por exemplo), a proposta chega logo depois da resposta com o botão
  **Aprovar** (veja "Aprovar pelo bot"). Um plano de tarefas ou uma rotina
  proposta continua com **Abrir no app**.
- Mensagem encaminhada, trecho citado e resposta à mensagem de outra pessoa
  são texto de terceiros: a Zuri lê como dado, nunca como ordem sua, e um
  `/comando` encaminhado não roda. No app, esse texto aparece numa caixa
  separada ("Mensagem encaminhada", "Trecho citado").
- Memórias que a Zuri guarda numa conversa do Telegram ficam marcadas como
  vindas do Telegram na tela de Memória.
- Mensagem escrita por um bot inline (`@algum_bot texto`) também conta como
  texto de terceiros, e a conversa nunca ganha o título a partir dele.
- Até 30 mensagens por hora para a Zuri. Na 31ª o bot avisa uma vez e ignora
  o resto até a hora virar.
- Depois do tempo da trava de leitura sem usar o bot (12 horas por padrão,
  de 1 a 72 h em Configurações › Avisos), o bot trava a leitura e pede
  `/destravar`. Veja [Trava de leitura](#trava-de-leitura).
- `/nova_conversa` começa outra conversa. A anterior continua no app.
- Se a resposta for longa demais para o limite de chamadas de um despertar, a
  última mensagem avisa e mostra **Abrir no app**, onde está o resto.

### Voz e arquivos de áudio

Mande uma mensagem de voz ou um arquivo de áudio. Até 5 minutos e 5 MB, a Zuri
transcreve na hora, mostra "🎙️ o que entendeu" e responde. O áudio passa pelo
mesmo serviço e pela mesma cota do app (uma hora por dia, app e bot juntos) e
nunca é guardado. Só a sua nota de voz conta como fala sua: áudio encaminhado
e arquivo de áudio (uma gravação salva, um podcast) entram como dado, como um
texto encaminhado. O eco "🎙️" e a mensagem guardada são cortados com "…" se a
transcrição passar do tamanho de uma mensagem.

Acima de 5 minutos ou de 5 MB, nada é baixado antes de você decidir. A Zuri
diz o tamanho, a duração, quantos Neurons a transcrição deve gastar e quantos
sobram no dia, e pergunta com **Processar mesmo assim** e **Deixar pra lá**.
O botão vale 10 minutos e um toque só; um arquivo novo acima do limite
substitui a pergunta anterior. Se a cota do dia acabar entre a pergunta e o
toque, a Zuri explica em vez de processar.

Alguns arquivos não dá para processar nem com confirmação, e a Zuri só explica
o motivo:

| Teto | Por quê |
| --- | --- |
| 20 MB | O maior arquivo que o Telegram deixa um bot baixar (`getFile`) |
| 30 minutos | A documentação do Whisper no Workers AI não publica limite por chamada; 30 min cabem com folga nos 3 minutos do turno. Revisar com a primeira medição real |
| O áudio e os Neurons que sobram no dia | A cota de 3.600 s de áudio e o teto de 9.000 Neurons, que zeram às 00:00 UTC |

O download confere o tamanho de novo e para no meio se o arquivo vier maior do
que o Telegram tinha dito. Quando a mensagem não diz o tamanho, o bot pergunta
o `getFile` e, acima de 5 MB, faz a mesma pergunta antes de baixar. A duração
que o remetente declara não basta para o custo: depois do download a Zuri
estima a duração pelos bytes (128 kbit/s, que nunca passa da real) e reserva o
maior dos dois; a duração que o Whisper devolve acerta a conta no fim.

## Trava de leitura

Quem pega o seu celular desbloqueado não deve conseguir ler a sua vida pelo
bot. Por isso, depois do tempo da trava sem usar o bot, a conversa,
`/nova_conversa` e o botão de arquivo grande respondem "A leitura pelo bot
está travada" até você destravar. Avisos continuam chegando normalmente.
Mensagem enviada com a leitura travada não conta como uso, então insistir não
destrava nada.

Mande `/destravar`. O bot oferece dois caminhos:

- **Confirmar com passkey**: abre a página `/aprovar` do app, que pede a
  passkey deste endereço com digital, rosto ou PIN. Não precisa estar logado.
  Se a digital não aparecer dentro do Telegram, abra o link no navegador do
  celular.
- **Receber código por e-mail**: manda um código de 6 dígitos para o e-mail do
  dono. Responda à pergunta do bot com o código. A mensagem com o código é
  apagada na hora.

Confirmado, a leitura fica liberada por 12 horas e o bot diz até que horas.
Cada destravamento aparece em Acessos e gera um aviso de segurança, uma vez.

| Regra | Valor |
| --- | --- |
| Validade do link e do código | 5 minutos, uso único; cada código novo vale 5 minutos a partir do e-mail e encerra o pedido junto |
| Reenvio do código | depois de 1 minuto (mesmo com um `/destravar` novo), até 3 por hora |
| E-mails de confirmação | 10 por dia, numa cota separada da dos avisos |
| Confirmações erradas | 5 em 15 minutos travam as confirmações pelo bot por 1 hora, com alerta de segurança (1 por dia) |
| Comandos | 60 por hora |

O botão de passkey só aparece se houver passkey cadastrada; o de e-mail, só
se o envio de e-mail estiver configurado. Sem nenhum dos dois, o bot explica
como cadastrar uma passkey no app.

## Aprovar pelo bot

Quando a Zuri propõe apagar ou reescrever algo (apagar uma tarefa ou nota,
trocar o texto de uma nota ou a descrição de uma tarefa, esquecer uma
memória, cancelar uma automação), a proposta chega como um cartão:

```text
Proposta da Zuri: apagar a tarefa
Item: comprar pão
Vale até 15:30.
```

O cartão é montado pelo servidor com o que está guardado agora (o título do
item, e nas reescritas o texto atual e o novo), nunca com as palavras da
Zuri. Se o item mudou depois da proposta, o bot não deixa aprovar e diz por
quê.

Tocar em **Aprovar** não basta: o bot pede a mesma confirmação do
`/destravar`, presa àquela proposta.

- **Confirmar com passkey** abre `/aprovar` com a prévia da proposta num
  cartão. Confirmado, a proposta é feita na hora e o bot troca a pergunta por
  "Feito: apagar a tarefa «comprar pão»."
- **Receber código por e-mail** manda o código junto com a prévia e o aviso
  "Se não foi você que tocou em Aprovar no Telegram, não digite este código".
  Responda à pergunta do bot com os 6 dígitos.

O link e o código valem 5 minutos, uma vez só, e só para aquela proposta.
Tocar em **Aprovar** de novo reaproveita o pedido aberto, com um link novo.
A proposta roda pelo mesmo caminho do botão Aprovar do app, no máximo uma
vez: se o item mudou nesse meio tempo, nada é feito. As mesmas 5 confirmações
erradas em 15 minutos travam as aprovações pelo bot por 1 hora.

Cada aprovação pelo bot aparece em Acessos e gera um aviso de segurança, uma
vez, que só se reconhece no app. Sem o id da conta do Telegram na instalação,
ou sem passkey e sem e-mail, o cartão traz **Abrir no app** no lugar de
**Aprovar**. `/aprovar` mostra as propostas que ainda esperam por você (até 5)
e pede a leitura destravada.

## Comandos

Nenhum comando usa IA: eles leem e escrevem pelos mesmos serviços do app e
respondem em texto puro, com links, comandos e menções desarmados no que você
guardou. Todos contam nos 60 comandos por hora.

| Comando | O que faz | Pede destravamento? |
| --- | --- | --- |
| `/hoje` | Atrasadas, vencem hoje e lembretes do dia, até 5 por bloco e "e mais N no app" | sim |
| `/tarefas [projeto]` | Até 10 tarefas abertas numeradas, com **Feito** e **Adiar** (um dia adiante, na mesma hora; vencida, para amanhã); os números e os botões valem 1 hora | sim |
| `/nova <texto>` | Cria uma tarefa; a data no fim (ou no começo) do texto vira o prazo, com o botão **Corrigir data** | sim |
| `/feito <nº>` | Conclui a tarefa de número tal da última lista, com **Desfazer** por 5 minutos | sim |
| `/lembrar <quando> <texto>` | Cria um lembrete único, com **Corrigir data** | sim |
| `/nota <texto>` | Guarda uma nota; a primeira linha é o título | sim |
| `/buscar <termo>` | Até 5 tarefas, notas e memórias, com trechos de 100 caracteres | sim |
| `/memoria <fato>` | Guarda uma memória marcada como vinda do Telegram | sim |
| `/rotinas` | Automações ativas e a próxima execução, com **Pausar** | sim |
| `/avisos` | Os 10 avisos mais novos, marcando os que esperam você | só para o texto |
| `/uso` | Pedidos de IA, Neurons, áudio e custo de tabela de hoje | não |
| `/status` | Versão, saúde, falhas em 24 h e se a IA está disponível | não |
| `/backup` | Situação do backup e **Abrir no app** | não |
| `/nova_conversa` | Começa outra conversa com a Zuri | sim |
| `/aprovar` | Propostas da Zuri esperando aprovação, com **Aprovar** | sim |
| `/destravar` | Libera a leitura por 12 horas | não |
| `/ajuda` | Lista os comandos | não |

Com a leitura travada, a resposta traz o botão **Destravar**, que faz o mesmo
que `/destravar`. Os botões dos comandos valem uma vez só; numa lista, só o
botão tocado some. A agenda entra no `/hoje` com o Google Agenda, os monitores
e o MCP no `/status` com as etapas deles, e a idade do backup com o backup
automático.

### Datas em `/nova` e `/lembrar`

Valem "hoje", "amanhã", "depois de amanhã", dias da semana com ou sem
"-feira", "dia 5", "5/11", "5/11/2026", "9h", "9h30", "9:30", "às 21h",
"daqui a N minutos/horas/dias" e "semana que vem" (a segunda-feira seguinte;
"sexta que vem" é a sexta da semana seguinte). Sem hora, vale 09:00. A Zuri
pergunta em vez de adivinhar quando o dia da semana é hoje e não tem hora,
quando "5/11" já passou neste ano ("Quis dizer 05/11/2027?"), quando aparece
"meio-dia", "tarde" ou "noite" sem hora, quando sobra uma palavra de data
que ela não entendeu e quando a data já passou. Em `/nova`, "hoje" sem hora
depois das 09:00 vence às 23:59.

### Fotos e documentos

Foto ou documento com legenda vira uma nota com a linha "Anexo recebido pelo
Telegram: foto, 1,2 MB (não guardado)". Sem legenda, a Zuri pede uma. O
arquivo nunca é baixado nem guardado, e o nome dele não é lido. Figurinhas,
vídeos e o resto recebem "por enquanto eu entendo texto, áudio e fotos ou
documentos com legenda".

### O que nunca é feito pelo bot

Trocar senha ou e-mail, desligar o 2FA, criar token remoto, ligar modelo pago
ou subir o teto em US$, conectar um MCP ou trocar a URL dele, importar
backup, sair do modo de bloqueio e desvincular o próprio Telegram: para essas
o bot sempre manda abrir o app, mesmo com passkey ou código por e-mail. Só as
propostas da lista do bot (as seis acima) aceitam **Aprovar**; uma ação
destrutiva nova nasce só no app.

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

Na conversa, cada turno usa as mesmas cotas de IA do app. Um turno faz no
máximo 12 "digitando…", a resposta em blocos e, com áudio, duas chamadas a
mais (`getFile` e o download), sempre abaixo das 45 chamadas externas. A
transcrição custa cerca de 46,6 Neurons por minuto de áudio. O registro guarda
só o tipo da mensagem (texto, voz, áudio) e o resultado; pergunta, confirmação,
recusa e expiração de arquivo grande ficam com `kind = large_file`, sem o
identificador nem o nome do arquivo.
