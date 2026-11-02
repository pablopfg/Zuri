# Automações

A etapa 10 trouxe três tipos de automação, todos no fuso do dono (Configurações › Conta):

| Tipo | O que faz | Usa IA? |
| --- | --- | --- |
| Lembrete | Entrega o texto que o dono escreveu. | Não |
| Resumo das tarefas | Lista as tarefas atrasadas e as de hoje, no máximo 10 por grupo. | Não |
| Rotina da Zuri | A Zuri responde ao pedido usando só ferramentas de leitura (tarefas, notas, memórias) e `notify_owner`. | Sim |

Os horários possíveis são: uma vez, todo dia, dias da semana, um dia do mês e a cada N horas (de 1 a 744).

## Onde fica o código

- `packages/shared/src/schedule.ts`: `nextRun` e `upcomingRuns`, sem Zod, porque a tela usa os dois na prévia.
- `packages/shared/src/automations.ts`: schemas, limites (`AUTOMATION_LIMITS`), estados e tipos.
- `apps/agent/src/automations/service.ts`: cria, muda, aprova, apaga, reivindica horários, guarda o alarme e reconcilia depois de um reinício.
- `apps/agent/src/automations/executor.ts`: roda cada tipo.
- `apps/agent/src/tools/automations.ts`: as ferramentas do chat.
- `apps/agent/src/api/automations.ts`: as rotas `/api/automations*`.
- `apps/web/src/pages/automations/`: a tela `/automacoes`, carregada sob demanda.
- Migration 9: `zur_automations` e `zur_automation_runs`.

## Como o horário funciona

- **Um alarme só.** O Durable Object guarda um único agendamento do SDK (`runAutomations`), sempre para a próxima automação que vence (regra P8). A chave `automation_alarm` do estado interno guarda `"<UTC>|<id do agendamento>"`. Depois de qualquer mudança, `rearm()` confere esse alarme e o troca se precisar.
- **Nunca roda duas vezes.** Antes de rodar, uma transação grava a execução com o horário previsto (`slot`) e já avança a próxima. Um índice único em `(automation_id, slot)` impede que outra chamada pegue o mesmo horário.
- **Atrasos.** Se o objeto acorda até 24 h depois do horário, a automação roda uma vez e o histórico marca "Recuperada". Com 24 h ou mais de atraso, esse horário não roda e o histórico mostra "Pulada", com o motivo; se a regra teve outro horário nas últimas 24 h, esse mais recente ainda roda uma vez como "Recuperada". Vários horários perdidos de uma repetição viram uma execução só.
- **Uma de cada vez.** Uma automação nunca roda duas vezes ao mesmo tempo: o horário que chega enquanto uma execução manual dela ainda roda é pulado ("ocupada"). Uma linha "rodando" deixada por um reinício não segura nada; a reconciliação a fecha.
- **Rotinas com IA por despertar.** Cada despertar do alarme roda no máximo 2 rotinas com IA, cada uma com prazo de 5 min. As outras rodam logo em seguida, porque o alarme é marcado de novo para o mesmo instante. Isso mantém o despertar longe do limite de 15 min do alarme.
- **Reinício.** No `onStart`, execuções que ficaram "rodando" viram "Falhou · interrompida" e não são repetidas, para não avisar duas vezes. Depois disso o alarme é rearmado. Rodar a reconciliação de novo não muda nada.
- **Horário de verão e meses curtos.** Um horário que não existe no fuso (o relógio pulou) anda para frente o tamanho do pulo. Um horário que se repete usa a primeira passagem. Dia 29, 30 ou 31 cai no último dia dos meses mais curtos.
- **Troca de fuso.** Quando o dono muda o fuso, cada automação ativa recalcula a próxima execução no relógio de parede do fuso novo.

## Limites

| Limite | Valor |
| --- | --- |
| Automações no total | 500 |
| Ativas ao mesmo tempo | 50 |
| Rotinas esperando aprovação | 10 |
| Repetição mínima | 1 hora |
| Execuções no histórico | 2.000; passando de 2.050, as 50 mais antigas saem de uma vez (as de IA do dia ficam, porque o teto conta com elas) |
| Rotinas com IA por dia | 6 por padrão, de 0 a 48 (Configurações › IA), contadas desde 00:00 UTC |

Cada execução com IA passa por `agent.ai()` e conta no teto diário de 9.000 Neurons. O limite de rotinas por dia conta toda execução com IA, inclusive o "Executar agora", porque o que ele protege é a cota de Neurons. Quando o limite de rotinas ou o teto chega, a execução é pulada e o motivo aparece no histórico.

## O chat e as aprovações

- `create_reminder` e `create_automation` criam direto o lembrete e o resumo, que não usam IA.
- `propose_ai_routine` guarda a rotina com o estado "esperando aprovação". O serviço garante isso para qualquer rotina com IA que venha do chat, mesmo que quem chama não peça. Nada é agendado antes de o dono aprovar na tela, onde ele lê o nome, o pedido exato e o horário. A conversa mostra o link "Revisar em Automações".
- A aprovação leva a versão que o dono viu (`updatedAt`). Se a rotina mudou depois disso, a aprovação é recusada com `TARGET_CHANGED` e a tela mostra a versão nova.
- Nome e pedido recusam caracteres invisíveis (espaços de largura zero, marcas de direção do texto, tags Unicode), que poderiam esconder parte do texto na hora da revisão.
- `cancel_automation` é destrutiva: vira um cartão de aprovação, e o alvo é conferido de novo no momento da aprovação.
- Numa execução agendada, a Zuri só vê ferramentas de leitura e `notify_owner`. Nome e pedido entram no prompt como dados (`<data>`), nunca como instruções.
- No modo "Só me avise quando houver algo", a resposta `NADA` vira uma execução "Nada a avisar".

## Logs

Falhas usam o módulo único de log (`apps/agent/src/log.ts`). Os eventos são `automation_failed` (com o tipo e o nome do erro), `automation_interrupted` (com a quantidade) e `automation_reconcile_failed`. Nome, texto e resultado nunca entram no log.

## O que ainda falta

Por enquanto o resultado de cada execução aparece só no histórico da tela.

Limitações conhecidas: trocar o fuso, ou o horário de uma automação, entre o vencimento e o alarme descarta esse horário vencido sem linha no histórico (a automação segue a regra nova). A etapa 11 leva os resultados para a central de avisos, com push e e-mail, e cria a aba Diagnóstico com as falhas.
