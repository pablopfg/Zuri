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
- Siga as "Exigências por área" e os "Portões obrigatórios de cada etapa" da estratégia: limites n−1/n/n+1, corpos e consultas hostis, concorrência com `Promise.all`, dia de 23 h e 25 h, fuso do aparelho diferente do dono, XSS do conteúdo do dono.
- Prove que o teste pega a falha: quebre o código de propósito e veja ficar vermelho. `not.toThrow`, `toBeDefined` ou só o status não bastam.
- Cobertura: `npm run test:coverage`; os pisos em `vitest.config.ts` só sobem. Não baixe um piso para a CI passar.
- Rota nova com sessão entra sozinha no teste que percorre `app.routes`; rota pública nova vai para a lista `PUBLIC` dele, de propósito.
- E2E que calcula "hoje" congela o relógio da página (`page.clock.setFixedTime`) no mesmo instante que usa no cálculo.
- Tela nova: `a11y.spec.ts`, `csp.spec.ts` e, se for principal, `tests/lighthouse/lighthouse.spec.ts`.
