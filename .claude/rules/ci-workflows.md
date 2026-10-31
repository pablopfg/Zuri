---
paths:
  - ".github/**"
---

# CI e workflows

- Actions fixadas por SHA, `permissions` mínimas, `persist-credentials: false`.
- CI só em `pull_request`, sem segredos. Deploy só em push para `main`, com o ambiente `production` (restrito à `main`, com aprovação).
- Nunca interpole texto de terceiros (título de PR, branch, comentário) direto em `run:`; passe por variável de ambiente.
- Jobs exigidos pelo ruleset: `typecheck`, `lint`, `test` (com cobertura e pisos), `i18n`, `build`, `e2e`, `audit`, `lighthouse`. Job novo exigido entra em `REQUIRED_CI_JOBS` (`tests/repo/helpers.ts`) e nos dois rulesets; o Pablo importa as rulesets de novo.
- O token do bot do Telegram e os segredos do Worker nunca entram no GitHub.
