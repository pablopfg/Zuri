---
paths:
  - ".github/**"
---

# CI e workflows

- Actions fixadas por SHA, `permissions` mínimas, `persist-credentials: false`.
- CI só em `pull_request`, sem segredos e sem `workflow_dispatch`: o ruleset só conta checks de execuções `pull_request`. O push do `update-prs.yml` (`GITHUB_TOKEN`) cria essas execuções presas em "action_required", e o próprio script aprova só as que o push dele criou. Deploy só em push para `main`, com o ambiente `production` (restrito à `main`, com aprovação).
- Nunca interpole texto de terceiros (título de PR, branch, comentário) direto em `run:`; passe por variável de ambiente.
- Jobs exigidos pelo ruleset: `typecheck`, `lint`, `test` (com cobertura e pisos), `i18n`, `build`, `e2e`, `audit`, `lighthouse` (em `ci.yml`) e `merge-order` (em `merge-order.yml`). Job novo exigido entra em `REQUIRED_CI_JOBS` (`tests/repo/helpers.ts`) e nos dois rulesets; o Pablo importa as rulesets de novo.
- O token do bot do Telegram e os segredos do Worker nunca entram no GitHub.
- `update-prs.yml` (push na `develop`, depois de cada merge do bot pelo `seguir-merge.yml` e a cada 15 minutos quando o GitHub roda o agendamento): roda `scripts/atualizar-prs.ts` a partir da `develop`, com `contents`, `pull-requests` e `actions` de escrita só no job. Nunca mescla, nunca faz force push, nunca envia para `develop` ou `main`, pula rascunho, fork e o rótulo `sem-atualizacao-automatica`. Mudou a lista de workflows que reportam checks exigidos: atualize `PR_WORKFLOWS` (arquivo → nome da execução; o teste de `tests/repo/workflows.test.ts` cobra).
- `report-failure` (job do `update-prs.yml`, `scripts/issue-de-falha.ts`): só quando o `update` falha ou estoura o tempo na `develop`; `issues: write` e `actions: read`, nenhum segredo. Abre ou comenta (no máximo uma vez por dia) a issue `[falha automática] <workflow>` no modelo `erro`. O workflow não roda em PR, então falha em PR nunca abre issue. Veja `docs/agente/issues.md`.
- `merge-order.yml` (check `merge-order`, `scripts/ordem-de-merge.ts`): só leitura (`contents` e `pull-requests`), roda o script da `develop`, falha enquanto uma PR mais antiga, deste repositório e aberta para a `develop`, muda os mesmos arquivos de código. O número da PR e a branch chegam por `env`, nunca interpolados no `run:`. O `update-prs.yml` (também a cada 15 minutos) reexecuta a execução de `pull_request` do check onde o resultado ficou velho.
- `seguir-merge.yml` (só `workflow_dispatch`, `scripts/seguir-merge.ts`): o `readme.yml` e o `versao.yml` o chamam no último passo de toda execução, com `if: always()`. Merge pelo `GITHUB_TOKEN` não gera `push`, e o agendamento falha quase sempre, então ele espera a PR do bot entrar e dispara `update-prs.yml`, `branches.yml` e o outro workflow do bot (`AFTER_MERGE`). Permissões `contents: read`, `pull-requests: read`, `actions: write`; a branch chega por `env`. Workflow novo que roda em `push` na `develop` e precisa ver merge de bot entra em `AFTER_MERGE`.
