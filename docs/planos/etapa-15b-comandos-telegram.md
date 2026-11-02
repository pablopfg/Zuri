# Plano · Etapa 15b, comandos de consulta e ação rápida no Telegram

Branch `feat/etapa-15b-comandos-telegram`, PR para a `develop`. Segunda metade
da etapa 15 da especificação ("Comandos administrativos"); a 15a (PR #84)
entregou a trava de leitura, `/destravar`, `/nova_conversa` e o limite de 60
comandos por hora.

## 1. Resumo

O bot passa a responder, sem gastar IA, aos comandos `/hoje`, `/tarefas`,
`/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`,
`/avisos`, `/uso`, `/status` e `/backup`. Foto ou documento com legenda vira
nota (o arquivo não é guardado). O aviso de leitura travada ganha o botão
**Destravar**.

## 2. Contexto no sistema

- `apps/agent/src/telegram/service.ts`: travas, comandos da 15a, botões dos
  avisos, trava de leitura (`ReadLock`) e limite por hora (`#rate`).
- `apps/agent/src/telegram/callbacks.ts`: `zur_telegram_callbacks`
  (`v1:<ação>:<id>`), hoje só para avisos (`target_type = 'notice'`).
- `apps/agent/src/telegram/channel.ts`: `disarm()` e `formatNotice`.
- Serviços que os comandos usam, os mesmos da API: `Productivity` (tarefas,
  notas, projetos), `MemoryService.create(..., "telegram")`,
  `AutomationService` (lembrete `once`, pausa), `AlertService.page()`,
  `UsageMeter.report()`, `DiagnosticsService.report()`, `APP_VERSION`.
- Especificação: "Comandos", "Gramática de datas do bot", "Trava de leitura do
  bot", "Foto ou documento" e "Botões e `callback_data`".

## 3. Objetivo e critérios de aceite

1. Cada comando da lista tem teste e nenhum gasta pedido de IA (teste confere
   o contador de uso e que o modelo não foi chamado).
2. `/nova` e `/lembrar` seguem a "Gramática de datas do bot", com pelo menos 20
   casos sobre uma data de referência fixa, e ecoam a data com **Corrigir**.
3. `/tarefas` numera até 10 tarefas abertas, com Feito e Adiar; os números
   valem 1 h; `/feito <nº>` conclui e mostra **Desfazer** por 5 min.
4. Comandos de conteúdo pedem destravamento; `/status`, `/ajuda`, `/uso` e
   `/backup` nunca pedem. `/avisos` travado mostra a lista sem o texto.
5. Foto ou documento: com legenda vira nota com a linha do anexo; sem legenda,
   o bot pede uma; nada é baixado.
6. O aviso de trava tem o botão **Destravar**, que faz o mesmo que `/destravar`.
7. O menu do bot (`setMyCommands`) lista os comandos novos (versão 3).

## 4. Escopo

Dentro: os 13 comandos, fotos e documentos (N4 e N5 nos padrões: nada
guardado, nada lido por visão), botões por `zur_telegram_callbacks`, botão
Destravar, menu, textos pt-BR e en, docs (`docs/telegram.md`), README,
changelog.

Fora: agenda em `/hoje` (etapa 19), monitores em `/status` (etapa 22), MCP em
`/status` (etapa 18), idade do backup em `/status` e `/backup` (etapa 23),
embeddings em `/uso` e `/buscar` (etapa 17), `/aprovar` e comandos de
segurança (etapa 16). A tabela de dependências da especificação já diz que
essas etapas estendem os comandos da 15.

## 5. Como funciona para o Pablo

### Fluxo 1 · Consulta rápida

`/hoje` responde "Hoje, seg., 2 de nov." com os blocos Atrasadas, Vencem hoje e
Lembretes, até 5 itens cada e "e mais N no app". Vazio: "Nada para hoje."
`/tarefas` (ou `/tarefas Casa`) lista até 10 tarefas abertas numeradas, cada
uma com Feito e Adiar.

### Fluxo 2 · Ação rápida

`/nova pagar a conta de luz amanhã 9h` cria a tarefa e responde com a data
entendida e o botão **Corrigir**. Corrigir pede a data certa numa resposta e
troca só a data. `/lembrar sexta 18h buscar o bolo` cria um lembrete único.
`/feito 2` conclui a tarefa 2 da última lista e oferece **Desfazer** por 5 min.

### Fluxo 3 · Foto ou documento

Foto com legenda vira nota com a linha "Anexo recebido pelo Telegram: foto,
1,2 MB (não guardado)". Sem legenda, a Zuri pede uma.

### Textos visíveis

Todos em `packages/shared/i18n/pt-BR-server.ts` e `en.ts`, chaves
`telegram.cmd.*`, `telegram.date.*`, `telegram.photo.*`, `telegram.menu.*`.
Respostas em texto puro, sem `parse_mode`, com o conteúdo do dono passado por
`disarm()`.

## 6. Regras de negócio e limites

- Comandos contam nos 60 por hora da 15a. Fotos e documentos também contam
  como comando (são ação rápida, não conversa).
- Datas: só a gramática pt-BR da especificação. Sem hora, 09:00. Ambíguo vira
  pergunta e nada é criado.
- Botões: listas valem 1 h (números de `/tarefas`, Feito, Adiar), Desfazer
  vale 5 min, Corrigir, Pausar e Destravar valem 24 h. Cada botão é de uso
  único; numa lista só o botão tocado sai.
- Adiar leva o prazo um dia adiante, na mesma hora; vencida ou sem data, vai para amanhã (09:00 sem data).
- Títulos e trechos: uma linha, até 100 caracteres em `/buscar`, até 80 nas
  listas.

## 7. Desenho técnico

### Arquivos

- `apps/agent/src/telegram/dates.ts` (novo): `parseWhen` e `extractWhen`, a
  gramática de datas, pura e testável.
- `apps/agent/src/telegram/commands.ts` (novo): `TelegramCommands`, um método
  por comando, botões e a correção de data.
- `apps/agent/src/telegram/callbacks.ts`: `createFor`/`take` genéricos para os
  botões dos comandos (alvo, validade, uso único).
- `apps/agent/src/telegram/service.ts`: roteia comandos, botões, fotos e
  documentos e a resposta a Corrigir; botão Destravar; menu v3.
- `apps/agent/src/agent/zuri-agent.ts`: injeta os serviços.

### Rotas e contratos

Nenhuma rota nova. `callback_data` continua `v1:<ação>:<16 caracteres>`.

### Banco

Nenhuma migration: os botões usam `zur_telegram_callbacks` (já tem
`target_type`/`target_id`), e os números da lista e a correção pendente ficam
em `zur_settings` (`telegram_task_numbers`, `telegram_fix`).

### Ferramentas do agente

Nenhuma muda.

### Agendamentos, IA e integrações externas

Nenhuma chamada de IA. Cada comando faz no máximo 2 chamadas à Bot API.

## 8. Custo e cotas do plano Free

Zero Neurons. Leituras limitadas (até 100 linhas por bloco em `/hoje`, 6 por
tipo em `/buscar`, 10 em `/tarefas` e `/rotinas`). Nada pago.

## 9. Segurança e privacidade

- Toda leitura de conteúdo passa por `ReadLock.locked()`; botões dos comandos
  também.
- Conteúdo do dono sai por `disarm()` (links, comandos, menções).
- Botão leva só id opaco; a ação real fica no banco.
- Legenda encaminhada vira nota como dado, nunca comando (o texto encaminhado
  já não é comando desde a 14).
- Tipo MIME do documento só aparece se tiver forma válida; nome do arquivo
  nunca aparece.
- Nada de conteúdo em log; a auditoria guarda só comando e resultado.

## 10. Testes

- `apps/agent/test/telegram-dates.test.ts`: mais de 20 casos da gramática com
  referência fixa (fuso de São Paulo), ambíguos e recusados.
- `apps/agent/test/telegram-commands.test.ts`: cada comando pelo webhook,
  estado vazio, argumento inválido, trava, botões (uso único, validade),
  Desfazer, Corrigir, Pausar, fotos e documentos, menu, e o contador de IA
  parado.

## 11. Entrega

Um PR com `<!-- versao: minor -->` no fragmento do changelog, README (mapa e
"O que já funciona"), `docs/telegram.md`, `progresso.md` (15a mesclada, 15b).
Sem mudança visível na interface web: "Sem mudança visível".

## 12. Riscos

- Gramática de datas com casos de borda (virada de ano, horário de verão):
  coberta por testes com referência fixa e `zonedTimeToUtc`.
- `service.ts` grande: os comandos vão para módulo próprio.

## 13. Suposições

- "Semana que vem" sozinha é a segunda-feira seguinte; "sexta que vem" ou
  "sexta da semana que vem" é a sexta da semana seguinte.
- Dia da semana igual a hoje com hora ainda por vir é hoje; com hora passada é
  a semana que vem.
- Data e hora já passadas (ex. "hoje 8h" às 10h) viram pergunta. Exceção:
  em `/nova`, "hoje" sem hora depois das 09:00 vence às 23:59 do dia.
- Palavra de data que sobra junto da frase ("amanhã madrugada ligar") faz a
  Zuri pedir a data de novo, em vez de cortar o texto. "9 e meia" vale 09:30;
  "12h da noite" é perguntado.
- O bot guarda as 5 últimas perguntas de Corrigir; responder a uma já usada
  avisa e não vai para a conversa.
- Lembrete do bot nasce com origem `app` (foi o dono quem pediu, sem IA).
- `/avisos` mostra os 10 mais novos e marca os que ainda insistem; travado,
  mostra categoria, prioridade e hora, sem título.
- Comandos ignoram o idioma das palavras de data: a gramática é pt-BR.

## 14. Entrevista com o Pablo

Nenhuma pergunta: as escolhas de produto seguem a especificação e os padrões
N4/N5; o resto é técnico e está em "Suposições".

### Perguntas abertas

Nenhuma.
