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
| 1 | mesclada (31/10/2026) | #6 | Worker único, Durable Object `ZuriAgent` e os seis portões |

## Últimas etapas (detalhe)

### Etapa 1 · Worker, Durable Object e portões
- Entregou: `apps/agent/wrangler.jsonc`, `src/index.ts` (portões 1 a 4 e 6), `src/gates/` (Access, cabeçalhos, segredo do webhook do Telegram), `src/agent/zuri-agent.ts`, `src/api/app.ts` (Hono no DO, portão 5 fechado: só `GET /api/health` é pública), `apps/web/public/_headers`, códigos de erro em `packages/shared/src/errors.ts`. Doc: `docs/arquitetura.md`.
- Decisões técnicas: agents 0.30.1, hono 4.13.14, wrangler 4.153.0, @cloudflare/vitest-plugin 1.4.8 (o antigo vitest-pool-workers foi renomeado); `compatibility_date` 2026-10-23 (máximo do workerd fixado); tipos por `wrangler types` (o typecheck falha se desatualizados); `INTERNAL_ERROR` 500 para falha sem código; erros com o texto pt-BR do catálogo; repasse com `env.AGENT.getByName` (sem RPC extra); traces desligados (cota a partir de 1/12/2026); `send_metrics: false`.
- `PUBLIC_URL`, `ACCESS_*` documentados como **segredo** no painel: o `wrangler deploy` apaga variáveis do painel que não estão no `wrangler.jsonc`. A etapa 24 confirma isso no deploy.
- e2e sobe o Worker real (`wrangler dev` com `tests/e2e/worker.env`). `npm run dev` exige `apps/agent/.dev.vars` só com os segredos.
- Atenção para a próxima: o catálogo exige que toda chave seja usada; erros vêm de `DEFAULT_ERROR_MESSAGE` em `packages/shared`. A etapa 2 troca `DEFAULT_LOCALE` em `http/errors.ts` pelo idioma das configurações. Armadilhas novas do Agents SDK em `armadilhas.md`.

### Etapa 0 · Repositório e esteira
- Entregou: monorepo (`packages/shared`, `apps/agent` e `apps/web` ainda de esqueleto), CI com os 7 checks, CodeQL, `branch-policy`, rulesets em `.github/rulesets/`, Dependabot, testes do próprio repositório em `tests/repo/`.
- Decisões técnicas: Node 26 (LTS atual) no `.nvmrc`, `engines >=24`; TypeScript 6.0.3, Vitest 4.1.12 (compatível com `vitest-pool-workers`), Biome 2.5.15, Playwright 1.64.1; squash na `develop`, merge commit na `main`; plugin `cloudflare` fixado por `sha`.
- Ficou para depois: lint de literais fora do catálogo (etapa 2); Worker real (etapa 1).

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

- Número e nome: 2 · Banco, configurações e i18n
- Dependências mescladas: sim (etapa 1, #6)
- Precisa de algo do Pablo antes: não
