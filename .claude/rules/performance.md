---
paths:
  - "apps/agent/src/**"
  - "apps/agent/wrangler*.jsonc"
  - "apps/web/src/**"
  - "apps/web/public/**"
  - "packages/shared/src/**"
---

# Performance e cotas do plano Free

Vale para todo código. Números, medidas e o porquê de cada regra: `docs/arquitetura/orcamento-free-tier.md`. Cite a regra pelo número no PR.

- **P1.** Rota que lê ou grava o banco entra em `apps/agent/test/free-tier-budget.test.ts` com teto de linhas lidas e escritas (`Database.usage`, que conta só o SQL do Zuri, não o do Agents SDK). O PR traz a tabela "Custo no plano Free" com a medida antes e depois.
- **P2.** Toda lista tem índice que cobre `WHERE` e `ORDER BY` (mesma direção em todas as colunas) e lê perto de `LIMIT` linhas. Sem `OFFSET` grande (cursor), sem `count(*)` em tabela que cresce (`zur_counts`). Ordem calculada vira índice de expressão com texto idêntico ao da consulta.
- **P3.** Tabela que pode passar de alguns milhares de linhas é buscada por FTS5, nunca por `instr`/`LIKE` na tabela toda.
- **P4.** Escrita custa: cada índice e gatilho soma uma linha. Não grave o que não mudou; rota frequente escreve no máximo uma vez por minuto; agrupe em transação. `setAlarm` conta uma escrita.
- **P5.** O Durable Object precisa poder hibernar: nada de `setTimeout`, `setInterval`, WebSocket padrão ou `fetch`/`waitUntil` sem fim (I/O travado segura o objeto até 15 min; toda chamada externa tem prazo). Espera é `this.schedule`; `keepAliveWhile` só durante o trabalho.
- **P6.** Worker fino (10 ms de CPU): portões e um repasse ao objeto por requisição, sem RPC extra. Hash, cifra, Markdown e JSON grande rodam no objeto.
- **P7.** Workers AI: estime os Neurons pela tabela de preços datada e confira o teto diário antes de chamar (cota: 10.000/dia). Sem nova tentativa automática; embedding de um texto só uma vez.
- **P8.** Tarefas periódicas dividem um agendamento; nunca um alarme por item (cada disparo do SDK grava 4 a 5 linhas; `keepAliveWhile` bate a cada 30 s). Passo de Workflow abaixo de 10 ms de CPU.
- **P9.** Subrequisições contadas por turno, parada antes de 45; até 6 conexões simultâneas.
- **P10.** O log de invocação já é o evento da requisição: nada de `console.log` no caminho comum nem em laço; traces desligados.
- **P11.** Interface: JavaScript inicial até 160 KB gzip (meta 150), conferido na CI por `npm run size` (`scripts/check-bundle-size.ts`, teto que só desce); tela nova sob demanda; biblioteca pesada só no uso; sem polling além do heartbeat; busca com debounce; `staleTime` de 15 s ou mais. Schema que a interface usa em tempo de execução é escrito com `zod/mini`, e todo schema de nível de módulo em `packages/shared` leva `/* @__PURE__ */` (na `z.union`, também em cada item), senão o zod clássico (cerca de 18 KB) volta ao primeiro carregamento e `npm run size` falha. Os textos em pt-BR de uma tela sob demanda ficam num arquivo `packages/shared/i18n/pt-BR-<tela>.ts` e entram com `addMessages` no módulo que a tela importa (veja `pt-BR-memory.ts`). Tela nova não importa hook ou módulo que só outra tela sob demanda usa: o bundler cria um pedaço comum para ele e passa a dividir o primeiro carregamento (veja `armadilhas.md`).
- **P12.** Cache: arquivos com hash `immutable` por um ano; HTML e `sw.js` `no-cache`; API `no-store`; service worker sem cache de API.
- **P13.** Tabela nova respeita o teto de 900 MB e os limites por tipo; nada de arquivo no banco; dado temporário tem prazo de limpeza.
- **P14.** Recurso que gera cobrança só com OK do Pablo, marcado com ⚠️.
