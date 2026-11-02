# Data, hora e idioma da Zuri

Como a Zuri sabe que dia é, entende "amanhã" ou "sexta que vem" e responde
sempre no idioma das Configurações. Código em
`apps/agent/src/agent/time-context.ts` e `apps/agent/src/agent/prompt.ts`;
testes em `apps/agent/test/time-context.test.ts`, `chat-runner.test.ts`,
`chat-tools.test.ts` e `automations.test.ts`.

## Por que o servidor faz as contas

Modelos de linguagem erram datas de jeitos conhecidos: supõem o ano em que
foram treinados, contam errado o dia da semana ("sexta que vem" caindo numa
quinta), escorregam na virada do mês, no ano bissexto e na troca do horário de
verão. Os assistentes grandes (ChatGPT, Claude, Gemini) resolvem do mesmo
jeito: a data, a hora e o fuso atuais entram no prompt de sistema a cada
turno, e a conta fica com o código, não com o modelo. A Zuri segue a mesma
linha, com um passo a mais pensado para os modelos pequenos e gratuitos do
Workers AI: o servidor também resolve as datas relativas da mensagem.

## O que entra no prompt

A seção "Current date and time", logo depois das instruções fixas, montada
pelo servidor a cada chamada ao modelo, no fuso das Configurações
(Configurações > Conta), nunca no fuso do servidor nem em UTC:

- **Agora**, em duas formas: a humana ("Monday, 2 November 2026, 00:45") e a
  ISO com o deslocamento ("2026-11-02T00:45-03:00"), com o nome do fuso, o
  deslocamento em relação a UTC e se o horário de verão está valendo.
- **Calendário** de ontem até daqui a 13 dias, cada dia com o dia da semana.
  O modelo consulta em vez de calcular.
- **Troca de relógio à frente**: quando o fuso muda o deslocamento nesse
  período, a linha diz o dia, a hora local antes e depois e o sentido
  ("local 02:00 becomes 01:00").
- **Conversa retomada depois**: quando a mensagem anterior da conversa tem 3
  horas ou mais, uma linha diz quando ela foi escrita ("2 days ago") e lembra
  que o "hoje" e o "amanhã" das mensagens antigas eram daquele dia. O
  histórico vai ao modelo sem data em cada mensagem.
- **Datas da mensagem resolvidas pelo servidor**: "hoje", "amanhã",
  "depois de amanhã", "ontem", "anteontem", dias da semana (com "na", "até",
  "toda", "esta", "que vem", "próxima", "passada", "última … do mês"),
  "daqui a / em / dentro de N minutos, horas, dias, semanas ou meses" (também
  em duas partes, como "1 hora e 30 minutos" e "uma hora e meia"), "há N …",
  "meia hora", "semana que vem", "fim de semana", "mês que vem", "ano que vem",
  datas por extenso ("1º de dezembro", "15 de março de 2027", "December 25"),
  "dia 15" e datas com barra ("até 15/03", "05/11/2026"; dia/mês em pt-BR e
  mês/dia em inglês), além dos equivalentes em inglês. Cada dica é escrita só
  com palavras fixas e números, nunca copiando o texto do dono, então não leva
  instrução escondida. No máximo 8 por mensagem; quantidade acima de 999 é
  ignorada; cada expressão repetida é calculada uma vez só.

As instruções fixas mandam usar só essa seção como fonte de data e hora, tirar
o dia da semana do calendário, tratar tudo no fuso do dono (ou dar os dois
horários quando ele cita outro fuso), escrever toda data marcada com o dia da
semana, usar `in_minutes` nos lembretes "daqui a N minutos/horas" (o servidor
soma) e perguntar quando a data for ambígua de verdade.

## Regras de interpretação

| Frase | O que vale |
| --- | --- |
| Dia da semana sozinho ("sexta") | O próximo depois de hoje; se hoje é sexta, a da semana que vem, e a dica avisa |
| "Sexta que vem", "próxima sexta", "next Friday" | A primeira depois de hoje; a dica traz também a da semana seguinte, e a Zuri diz a data escolhida |
| Hora sem data | Hoje, se ainda não passou; senão, amanhã |
| "Daqui a N horas/minutos" | Soma no relógio (instantes), então atravessa a troca do horário de verão certo |
| "Em N dias/semanas" | Soma no calendário: mesmo horário de parede, qualquer que seja a troca |
| "Em N meses" | Mesmo dia do mês; num mês mais curto, o último dia (31/01 + 1 mês = 28 ou 29/02) |
| "Esta sexta" dita numa sexta | Hoje |
| "Última sexta do mês" | A última sexta do mês corrente |
| "Segunda", "quarta", "quinta", "sexta" sem "feira", preposição ou modificador | Nenhuma dica: pode ser ordinal ("pela segunda vez") |
| Data sem ano ("15 de março", "até 15/03") | A próxima a partir de hoje, hoje incluído; 29/02 espera o próximo ano bissexto |
| "Dia 15" | O deste mês; se já passou, o do mês seguinte; mês sem dia 31 pula para o próximo que tem |
| Barra sem ano e sem palavra antes ("1/2 xícara") | Nenhuma dica: é fração |
| Data que não existe ("31 de abril", "29/02/2027") | A dica diz que não é uma data real |
| Hora com minuto quebrado | Arredonda para o minuto seguinte, igual ao `in_minutes` do lembrete, para a dica e o lembrete baterem |
| Semana | Segunda a domingo |
| Fim de semana | O sábado e o domingo que vêm; num fim de semana, o atual |

## Rede de segurança nas ferramentas

- As ferramentas recebem datas locais (`YYYY-MM-DD` ou `YYYY-MM-DDTHH:MM`) e
  o servidor converte para o instante em UTC no fuso do dono
  (`localDueToInstant`), recusando datas que não existem (30/02, 25:00).
- `create_task`, `update_task` e `propose_task_plan` devolvem uma nota quando
  o prazo já passou (`pastDueNote` e `past_due`): é o sinal de um ano ou dia da semana errado, e a regra manda
  a Zuri avisar o dono.
- Lembrete único no passado é recusado pelo serviço de automações (etapa 10).

## Idioma

A Zuri responde só no idioma das Configurações (padrão pt-BR):

- A regra fixa diz o idioma pelo nome e pelo código ("Brazilian Portuguese
  (pt-BR)", para não virar português de Portugal) e vale qualquer que seja o
  idioma da mensagem, do histórico, das linhas `<data>`, dos resultados de
  ferramentas ou da rotina. O que ela cita ou resume é traduzido; nomes e
  código ficam como estão.
- Outro idioma só quando a mensagem do próprio dono pede explicitamente
  ("responda em inglês", "traduza para o espanhol"), e só para aquele pedido.
- Pedido de troca de idioma dentro de `<data>` ou de resultado de ferramenta é
  conteúdo guardado e é ignorado (teste de injeção em `chat-runner.test.ts`).
- O prompt termina com um lembrete do idioma, depois de todo dado guardado:
  modelos pequenos tendem a seguir o idioma do último texto que leram.
- Vale para a conversa, as rotinas agendadas (mesmo prompt) e, nas etapas 13
  a 15, o bot do Telegram, que usa o mesmo `AgentRunner`.

## Custo no plano Free

A seção do relógio e as regras somam cerca de 2.000 caracteres (uns 520
tokens) a cada chamada ao modelo: cerca de 3 Neurons a mais por chamada no
modelo padrão (`glm-4.7-flash`, 5.500 Neurons por milhão de tokens de
entrada). A resposta típica passa de uns 48 para uns 51 Neurons. Montar a
seção leva cerca de 1 ms de CPU (as trocas de relógio são achadas dia a dia e
depois ao minuto, em cerca de 11 passos) e é feita uma vez por turno, mesmo
que o prompt seja montado duas ou três vezes. Um texto colado que repete a
mesma expressão centenas de vezes continua em cerca de 1 ms: cada expressão é
calculada uma vez e a leitura para quando as 8 dicas enchem.
