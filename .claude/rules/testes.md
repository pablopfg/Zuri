---
paths:
  - "apps/*/test/**"
  - "packages/*/test/**"
  - "tests/**"
  - "playwright.config.ts"
---

# Testes

Siga `docs/qa/estrategia-de-testes.md`.

- Vitest em todos os workspaces; o agente roda dentro do workerd (`@cloudflare/vitest-pool-workers`) com IA simulada.
- E2E com Playwright em `tests/e2e`, servidor próprio, Chromium. Testes de celular com a tag `@mobile`. Telas novas passam pelo axe (acessibilidade).
- Nenhum teste chega à rede: fakes para Telegram (fixtures em `apps/agent/test/fixtures/telegram/`), Google, MCP, HIBP e e-mail.
- Relógio falso para insistência, expiração, recorrência e horário de verão.
- Nunca `.skip`, `.only` no commit, `retries` ou timeout maior para esconder falha. Teste instável é bug.
- Correção de bug vem com teste que falhava antes. Achado de segurança corrigido ganha teste com o id do achado no nome.
- Cada critério de aceite da etapa aponta para pelo menos um teste (matriz no PR).
