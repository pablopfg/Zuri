# Orçamento do plano Free da Cloudflare

O Zuri precisa caber, com folga, nas cotas gratuitas da Cloudflare. Este
documento diz quanto cada cota permite, quanto o dono usa num dia cheio, quanto
sobra e quais regras toda etapa segue para não comer essa margem. As regras
curtas para agentes estão em `.claude/rules/performance.md`.

Limites conferidos na documentação oficial em 31/10/2026. Todas as cotas
diárias zeram às 00:00 UTC (21:00 em Brasília). Passou de uma cota, a operação
daquele tipo falha até a virada; no plano Free nada é cobrado, mas o Zuri para
de responder naquilo.

## Limites vigentes

| Recurso | Limite no Free | Fonte |
| --- | --- | --- |
| Requisições ao Worker | 100.000 por dia | [Workers: limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU do Worker | 10 ms por requisição HTTP | idem |
| Subrequisições | 50 por invocação; 6 conexões abertas ao mesmo tempo | idem |
| Memória | 128 MB por isolate | idem |
| Tamanho do Worker | 64 MiB sem compressão; partida em até 1 s | idem |
| Arquivos estáticos | 20.000 por versão, 25 MiB cada | idem |
| Requisições ao Durable Object | 100.000 por dia (HTTP, RPC e alarmes) | [Durable Objects: pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Duração do Durable Object | 13.000 GB-s por dia, a 128 MB por objeto | idem |
| Linhas lidas no SQLite | 5 milhões por dia | idem |
| Linhas escritas no SQLite | 100.000 por dia (cada `setAlarm` conta uma) | idem |
| Armazenamento | 5 GB na conta; 1 GB por objeto (a página de limites também cita 10 GB; vale o menor) | [Durable Objects: limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| SQL | 100 KB por comando, 100 parâmetros, 2 MB por linha, `LIKE` até 50 bytes | idem |
| CPU do Durable Object | 30 s por requisição | idem |
| Workers AI | 10.000 Neurons por dia | [Workers AI: pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Workflows | 10 ms de CPU por passo, 100 instâncias ao mesmo tempo, conta junto das 100.000 requisições | [Workflows: limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Workers Logs | 200.000 eventos por dia, 3 dias de retenção | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |

Preço em Neurons dos modelos padrão: `@cf/zai-org/glm-4.7-flash` custa 5.500
por milhão de tokens de entrada e 36.400 por milhão de saída;
`@cf/openai/whisper-large-v3-turbo`, 46,63 por minuto de áudio;
`@cf/baai/bge-m3`, 1.075 por milhão de tokens.

## Quanto cada rota custa hoje

Medido dentro do workerd por `apps/agent/test/free-tier-budget.test.ts`, com
2.000 tarefas e 500 notas no banco. O teste falha se uma rota passar do teto.

| Rota | Linhas lidas | Linhas escritas |
| --- | --- | --- |
| `POST /api/auth/heartbeat` | 2 | até 2 |
| `GET /api/auth/session`, `GET /api/settings` | 1 | 0 |
| `GET /api/tasks?view=all` | 201 (antes: 4.001) | 0 |
| `GET /api/tasks?view=upcoming` | 711 (antes: 2.491) | 0 |
| `GET /api/tasks?view=completed` | 201 | 0 |
| `GET /api/notes` | 402 (índice e linha de cada uma das 200) | 0 |
| `GET /api/notes?q=…` (FTS5) | 34 | 0 |
| `POST /api/tasks` | 5 | 8 (a linha, os índices e o contador) |
| Acordar o objeto (migrations já aplicadas) | 1 (antes: 91) | 0 |

As vistas "Hoje" e "Atrasadas" leem as tarefas que mostram (o índice parcial de
tarefas abertas vai direto a elas) e a busca de tarefas ainda varre a tabela:
duas linhas por tarefa guardada. Com 1.000 tarefas, uma busca lê 2.000 linhas;
no teto de 20.000, 40.000.

## Uso estimado do dono

"Dia cheio": app aberto 12 h, 300 ações na interface, 100 listas abertas, 30
buscas, 60 turnos de chat (dois chamados ao modelo cada), 10 min de voz e 50
mensagens no Telegram. "Pior caso": sessão de 24 h e os limites padrão da
especificação usados até o fim.

| Cota | Dia cheio | % | Pior caso | % | Margem no dia cheio |
| --- | --- | --- | --- | --- | --- |
| Requisições ao Worker | ~1.300 | 1,3% | ~4.000 | 4% | folgada |
| Requisições ao DO | ~1.300 (+96 vigias) | 1,4% | ~4.000 | 4% | folgada |
| Duração do DO, com hibernação | ~160 GB-s | 1,2% | ~600 GB-s | 5% | folgada |
| Duração do DO, se algo impedir a hibernação | 5.400 GB-s | 42% | 10.800 GB-s | 83% | apertada |
| Linhas lidas | ~110.000 | 2,2% | ~1,5 milhão | 30% | folgada |
| Linhas escritas | ~4.000 | 4% | ~25.000 | 25% | boa |
| Neurons do Workers AI | ~6.500 | 65% | ~16.800 | 168% | **apertada** |
| Eventos de log | ~3.000 | 1,5% | ~8.000 | 4% | folgada |
| Armazenamento | cresce devagar | — | teto próprio de 900 MB | 90% do objeto | boa |

Como cheguei nos números:

- **Requisições.** O heartbeat é uma batida por minuto de uma aba só (720 em
  12 h). Cada chamada da API é uma requisição ao Worker e uma ao DO; os
  arquivos com hash ficam no cache do navegador por um ano, então uma visita
  nova custa umas quatro requisições (HTML, service worker, ícone, manifesto).
- **Duração.** Segundo a documentação, um objeto parado entra em hibernação
  depois de 10 s sem requisição e, hibernável, não é cobrado. Ele só não
  hiberna com `setTimeout`/`setInterval` pendente, `fetch` ou `waitUntil` sem
  terminar ou WebSocket padrão. O Zuri não usa nenhum dos três, então a conta
  é o tempo de trabalho: uns 50 ms por requisição comum e uns 20 s por turno
  de chat em streaming. A linha "se algo impedir" é a conta antiga deste
  repositório (objeto na memória o tempo todo) e mostra por que a regra P5 é
  inviolável. Confira o gráfico de duração no painel depois do primeiro deploy.
- **Linhas.** 100 listas a ~400 linhas, 30 buscas em 1.000 tarefas, o
  heartbeat e o histórico do chat. O pior caso põe 20.000 tarefas e 30 buscas.
- **Neurons.** Um chamado ao modelo com 6.000 tokens de contexto custa uns 33
  Neurons de entrada; 400 tokens de resposta, uns 15. Um turno com duas
  iterações fica perto de 100. Os padrões da especificação (200 pedidos de IA
  por dia e 3.600 s de áudio) somam mais que a cota: 200 × 70 = 14.000 com a
  saída máxima, mais 60 min × 46,63 = 2.800 de voz. Veja "Para o Pablo".

## Regras para toda etapa

Numeradas para o PR poder citar ("segue P2 e P4").

- **P1. Medir.** Rota nova ou alterada que lê ou grava o banco entra em
  `free-tier-budget.test.ts` com teto de linhas lidas e escritas. O PR traz a
  tabela "Custo no plano Free": o que muda em cada cota, com a medida.
- **P2. Listas por índice.** Toda lista tem um índice que cobre o `WHERE` e o
  `ORDER BY`, com as colunas na mesma direção, e lê perto de `LIMIT` linhas.
  Nada de `OFFSET` grande: pagine por cursor. Nada de `count(*)` em tabela que
  cresce: use `zur_counts`. Ordem calculada (como a prioridade das tarefas)
  vira índice de expressão com o texto idêntico ao da consulta.
- **P3. Busca por FTS5.** Tabela que pode passar de alguns milhares de linhas é
  buscada por FTS5, nunca por `instr` ou `LIKE` sobre a tabela inteira.
- **P4. Escrever pouco.** Cada índice e cada gatilho é uma linha escrita a mais
  por mudança. Não grave o que não mudou; em rota frequente, no máximo uma
  escrita por minuto (como o heartbeat); agrupe numa transação. `setAlarm`
  conta uma escrita.
- **P5. Objeto sempre hibernável.** Sem `setTimeout`, `setInterval`, WebSocket
  padrão ou `fetch` esquecido no Durable Object. Espera longa é
  `this.schedule`; `keepAliveWhile` só pelo tempo do trabalho.
- **P6. Worker fino.** O Worker tem 10 ms de CPU: só os portões e um repasse
  ao objeto por requisição, sem RPC extra (`getByName`, não
  `getAgentByName`). Hash, cifra, Markdown e JSON grande rodam no objeto.
- **P7. Neurons contados antes.** Todo chamado ao Workers AI estima os Neurons
  pela tabela de preços datada, confere o teto diário e só então chama. Sem
  nova tentativa automática. Contexto e saída curtos por padrão; embedding de
  um texto só é calculado uma vez.
- **P8. Um alarme para as vigias.** Tarefas periódicas dividem um agendamento
  (a cada 15 min são 96 requisições e 96 escritas por dia). Nunca um alarme por
  item. Passos de Workflow ficam abaixo de 10 ms de CPU.
- **P9. Subrequisições contadas.** Cada turno conta as suas e para antes de 45;
  no máximo 6 conexões abertas ao mesmo tempo.
- **P10. Logs enxutos.** Um evento por requisição; nada de `console.log` dentro
  de laço; traces desligados; amostragem só se os logs passarem de 50.000 por
  dia.
- **P11. Interface leve.** JavaScript inicial até 160 KB com gzip (hoje 156 KB;
  meta de 150 KB). Tela nova é carregada sob demanda; biblioteca pesada só no
  uso. Sem polling além do heartbeat; buscas com espera de digitação; nada de
  `staleTime` abaixo de 15 s. Cada refetch é uma requisição ao objeto.
- **P12. Cache certo.** Arquivos com hash: `immutable` por um ano. HTML e
  service worker: `no-cache`. API: `no-store`. O service worker não guarda
  respostas da API.
- **P13. Armazenamento com teto.** O teto de 900 MB e os limites por tipo
  valem para toda tabela nova; arquivos não ficam no banco (decisão N4);
  dado temporário tem prazo de limpeza.
- **P14. Recurso pago nunca entra sozinho.** KV, D1, R2, Vectorize, Queues,
  Workers Paid ou modelo pago só com o OK do Pablo, marcado com ⚠️.

## O que já foi ajustado

- Migration 5: índice `zur_tasks_board` com a ordem da lista de tarefas. "Todas"
  passou de 4.001 para 201 linhas lidas e "Próximas" de 2.491 para 711, com
  2.000 tarefas. Custa uma linha escrita a mais por tarefa criada ou alterada.
- `migrate()` não procura mais a tabela de versão no `sqlite_master` a cada vez
  que o objeto acorda: 91 linhas viraram 1, e o número antigo crescia com cada
  tabela nova.
- `Database.usage` soma as linhas lidas e escritas, para os testes de orçamento.

## Para o Pablo (pede decisão)

1. **Teto diário de Neurons.** Os padrões de "pedidos de IA" e de áudio passam
   da cota gratuita. Recomendo um teto único de 9.000 Neurons por dia para chat,
   voz e embeddings, com o pedido recusado e um aviso claro ao chegar nele, e
   os limites por recurso abaixo desse teto. Afeta a etapa 8.
2. **Busca de tarefas por FTS5.** Hoje a busca varre a tabela; com muitas
   tarefas, 30 buscas por dia já leem mais de um milhão de linhas. O FTS5 muda
   um pouco o resultado (acha palavras e prefixos, não pedaços no meio da
   palavra). Recomendo trocar quando as tarefas passarem de 5.000 ou junto com a
   busca global da etapa 9.
3. **Sessão máxima de 24 h.** Com a hibernação funcionando, a sessão longa
   custa pouco. Se o painel mostrar a duração alta, a saída é baixar o máximo,
   não espaçar o heartbeat (ver `docs/arquitetura.md`).
