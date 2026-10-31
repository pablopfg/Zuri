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
| 2 | mesclada (31/10/2026) | #7 | Migration 1, configurações (idioma e fuso), erros no idioma do dono, lint de i18n |

## Últimas etapas (detalhe)

### Etapa 2 · Banco, configurações e i18n
- Entregou: `apps/agent/src/db/{database,migrations,settings,activity}.ts`, `ZuriAgent.store` (banco aberto e migrado no primeiro uso; falha não fica em cache), `packages/shared/src/{settings,format}.ts`, `plural()`/`createTranslator()` no i18n, `scripts/lint-i18n.ts` + `i18n-ignore.json` (no `npm run lint` e no job `i18n`).
- Migrations: versão 1 (`zur_settings` chave/valor JSON, `zur_activity`); `zur_schema_version` criada pelo `migrate()`. Teste fixa o sha256 de cada migration mesclada: migration nova = linha nova em `PINNED`.
- Decisões técnicas: parser do lint é `rolldown/parseAst` (TypeScript 7 não tem API JS; rolldown 1.2.16 já vinha com o Vite, agora devDependency explícita); fuso padrão vem de `DEFAULT_TIMEZONE` se válido; recusas dos portões do Worker ficam em pt-BR (não acordam o DO); sem rota de configurações ainda (precisa de sessão, etapa 3/5); limite do plano Free conferido em 31/10/2026: 1 GB por DO, 5 GB por conta, teto de 900 MB mantido.
- Atenção para a próxima: erros dentro do DO já saem no idioma das configurações via `errorResponse(error, locale)`; `Database.run` devolve `rowsWritten` (conta índices, não use como "linhas afetadas"); a checagem de 900 MB e a retenção de `zur_activity` ainda não existem (etapa 23, ou antes se uma rota gravar muito); a allowlist do backup de `zur_settings` deve ser positiva.

### Etapa 1 · Worker, Durable Object e portões
- Entregou: `apps/agent/wrangler.jsonc`, `src/index.ts` (portões 1 a 4 e 6), `src/gates/` (Access, cabeçalhos, segredo do webhook do Telegram), `src/agent/zuri-agent.ts`, `src/api/app.ts` (Hono no DO, portão 5 fechado: só `GET /api/health` é pública), `apps/web/public/_headers`, códigos de erro em `packages/shared/src/errors.ts`. Doc: `docs/arquitetura.md`.
- Decisões técnicas: agents 0.30.1, hono 4.13.14, wrangler 4.153.0, @cloudflare/vitest-plugin 1.4.8 (o antigo vitest-pool-workers foi renomeado); `compatibility_date` 2026-10-23 (máximo do workerd fixado); tipos por `wrangler types` (o typecheck falha se desatualizados); `INTERNAL_ERROR` 500 para falha sem código; erros com o texto pt-BR do catálogo; repasse com `env.AGENT.getByName` (sem RPC extra); traces desligados (cota a partir de 1/12/2026); `send_metrics: false`.
- `PUBLIC_URL`, `ACCESS_*` documentados como **segredo** no painel: o `wrangler deploy` apaga variáveis do painel que não estão no `wrangler.jsonc`. A etapa 24 confirma isso no deploy.
- e2e sobe o Worker real (`wrangler dev` com `tests/e2e/worker.env`). `npm run dev` exige `apps/agent/.dev.vars` só com os segredos.
- Atenção para a próxima: o catálogo exige que toda chave seja usada; erros vêm de `DEFAULT_ERROR_MESSAGE` em `packages/shared`. A etapa 2 trocou `DEFAULT_LOCALE` em `http/errors.ts` pelo idioma das configurações. Armadilhas novas do Agents SDK em `armadilhas.md`.

### Etapa 0 · Repositório e esteira
- Entregou: monorepo (`packages/shared`, `apps/agent` e `apps/web` ainda de esqueleto), CI com os 7 checks, CodeQL, `branch-policy`, rulesets em `.github/rulesets/`, Dependabot, testes do próprio repositório em `tests/repo/`.
- Decisões técnicas: Node 26 (LTS atual) no `.nvmrc`, `engines >=24`; TypeScript 6.0.3, Vitest 4.1.12 (compatível com `vitest-pool-workers`), Biome 2.5.15, Playwright 1.64.1; squash na `develop`, merge commit na `main`; plugin `cloudflare` fixado por `sha`.
- Ficou para depois: nada (lint de literais entregue na etapa 2, Worker na etapa 1).

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

- Número e nome: 3 · Login e sessões
- Dependências mescladas: sim (etapa 2, #7)
- Precisa de algo do Pablo antes: não
