# Progresso das etapas

Passagem de bastão entre conversas. Cada etapa começa numa conversa nova e lê
este arquivo **em vez** do histórico das anteriores. Atualize no mesmo PR da
etapa, antes de mesclar. Mantenha curto (até ~80 linhas): só as 3 últimas
etapas ficam detalhadas; as mais antigas viram uma linha na tabela.

## Modo contínuo

- Situação: ligado
- Avanço: mescla sozinho na `develop`, sem pausa por fase (decisão do Pablo, 30/10/2026)
- Pausado por:

## Etapas

| Etapa | Situação | PR | Resumo em uma linha |
| --- | --- | --- | --- |
| 0 | mesclada (31/10/2026) | #1 | Monorepo, CI, CodeQL, rulesets, Dependabot |

## Últimas etapas (detalhe)

### Etapa 0 · Repositório e esteira
- Entregou: monorepo (`packages/shared`, `apps/agent` e `apps/web` ainda de esqueleto), CI com os 7 checks, CodeQL, `branch-policy`, rulesets em `.github/rulesets/`, Dependabot, testes do próprio repositório em `tests/repo/`.
- Decisões técnicas: Node 26 (LTS atual) no `.nvmrc`, `engines >=24`; TypeScript 6.0.3, Vitest 4.1.12 (compatível com `vitest-pool-workers`), Biome 2.5.15, Playwright 1.64.1; squash na `develop`, merge commit na `main`; plugin `cloudflare` fixado por `sha`.
- Ficou para depois: lint de literais fora do catálogo (etapa 2); Worker real (etapa 1).
- Atenção para a próxima: a etapa 1 troca `apps/agent/src/index.ts` (esqueleto 404) e move o projeto `agent` do Vitest para o workerd. O catálogo já tem 3 chaves e o teste exige que toda chave seja usada.

<!-- Modelo, até 10 linhas por etapa:
### Etapa NN · <nome>
- Entregou: arquivos/rotas/tabelas principais.
- Migrations: versão N (o quê).
- Decisões técnicas tomadas: ...
- Ficou para depois: ...
- Riscos ou dívidas: ...
- Atenção para a próxima: ...
-->

## Esperando o Pablo

<!-- Itens "▶ Antes, você fornece" das próximas etapas e perguntas abertas. -->

- Nada no momento. Rulesets da `develop` e da `main` conferidos ativos pela API em 31/10/2026.

## Próxima etapa

- Número e nome: 1 · Worker, Durable Object e portões
- Dependências mescladas: sim (etapa 0, #1)
- Precisa de algo do Pablo antes: não
