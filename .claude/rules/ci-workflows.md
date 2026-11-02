---
paths:
  - ".github/**"
---

# CI e workflows

- Actions fixadas por SHA, `permissions` mínimas, `persist-credentials: false`.
- CI só em `pull_request`, sem segredos. Única exceção: `ci.yml` e `codeql.yml` aceitam `workflow_dispatch` para o `update-prs.yml` rodar os mesmos checks depois do push dele (push com `GITHUB_TOKEN` não dispara `pull_request`); mesmo token só de leitura, nenhum segredo. Deploy só em push para `main`, com o ambiente `production` (restrito à `main`, com aprovação).
- Nunca interpole texto de terceiros (título de PR, branch, comentário) direto em `run:`; passe por variável de ambiente.
- Jobs exigidos pelo ruleset: `typecheck`, `lint`, `test` (com cobertura e pisos), `i18n`, `build`, `e2e`, `audit`, `lighthouse`. Job novo exigido entra em `REQUIRED_CI_JOBS` (`tests/repo/helpers.ts`) e nos dois rulesets; o Pablo importa as rulesets de novo.
- O token do bot do Telegram e os segredos do Worker nunca entram no GitHub.
- `update-prs.yml` (push na `develop`): roda `scripts/atualizar-prs.ts` a partir da `develop`, com `contents`, `pull-requests` e `actions` de escrita só no job. Nunca mescla, nunca faz force push, nunca envia para `develop` ou `main`, pula rascunho, fork e o rótulo `sem-atualizacao-automatica`. Mudou a lista de workflows que reportam checks exigidos: atualize `DISPATCHED_WORKFLOWS` (o teste de `tests/repo/workflows.test.ts` cobra).
