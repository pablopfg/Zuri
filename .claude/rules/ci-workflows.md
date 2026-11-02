---
paths:
  - ".github/**"
---

# CI e workflows

- Actions fixadas por SHA, `permissions` mínimas, `persist-credentials: false`.
- CI só em `pull_request`, sem segredos. Única exceção: `ci.yml` e `codeql.yml` aceitam `workflow_dispatch` para o `update-prs.yml` rodar os mesmos checks depois do push dele (push com `GITHUB_TOKEN` não dispara `pull_request`); mesmo token só de leitura, nenhum segredo. Deploy só em push para `main`, com o ambiente `production` (restrito à `main`, com aprovação).
- Nunca interpole texto de terceiros (título de PR, branch, comentário) direto em `run:`; passe por variável de ambiente.
- Jobs exigidos pelo ruleset: `typecheck`, `lint`, `test` (com cobertura e pisos), `i18n`, `build`, `e2e`, `audit`, `lighthouse` (em `ci.yml`) e `merge-order` (em `merge-order.yml`). Job novo exigido entra em `REQUIRED_CI_JOBS` (`tests/repo/helpers.ts`) e nos dois rulesets; o Pablo importa as rulesets de novo.
- O token do bot do Telegram e os segredos do Worker nunca entram no GitHub.
- `update-prs.yml` (push na `develop` e a cada 15 minutos): roda `scripts/atualizar-prs.ts` a partir da `develop`, com `contents`, `pull-requests` e `actions` de escrita só no job. Nunca mescla, nunca faz force push, nunca envia para `develop` ou `main`, pula rascunho, fork e o rótulo `sem-atualizacao-automatica`. Mudou a lista de workflows que reportam checks exigidos: atualize `DISPATCHED_WORKFLOWS` (o teste de `tests/repo/workflows.test.ts` cobra).
- `report-failure` (job do `update-prs.yml`, `scripts/issue-de-falha.ts`): só quando o `update` falha ou estoura o tempo na `develop`; `issues: write` e `actions: read`, nenhum segredo. Abre ou comenta (no máximo uma vez por dia) a issue `[falha automática] <workflow>` no modelo `erro`. O workflow não roda em PR, então falha em PR nunca abre issue. Veja `docs/agente/issues.md`.
- `merge-order.yml` (check `merge-order`, `scripts/ordem-de-merge.ts`): só leitura (`contents` e `pull-requests`), roda o script da `develop`, falha enquanto uma PR mais antiga, deste repositório e aberta para a `develop`, muda os mesmos arquivos de código. O número da PR e a branch chegam por `env`, nunca interpolados no `run:`. O `update-prs.yml` (também a cada 15 minutos) dispara o check de novo onde o resultado ficou velho.
