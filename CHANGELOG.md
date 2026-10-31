# Changelog

Todas as mudanças visíveis do Zuri ficam aqui, em pt-BR. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem
o [SemVer](https://semver.org/lang/pt-BR/). Cada PR escreve a sua entrada em
"Não lançado"; a release copia a seção para a versão.

## Não lançado

### Adicionado

- Repositório preparado: monorepo com npm workspaces (`apps/agent`,
  `apps/web`, `packages/shared`), TypeScript estrito, Biome, Vitest,
  Playwright e o catálogo inicial de traduções em pt-BR e en.
- Integração contínua em todo PR (typecheck, lint, testes, i18n, build, e2e e
  `npm audit`), CodeQL, Dependabot e rulesets para a `develop` e a `main`.
- `LICENSE` (MIT), `NOTICE.md`, `SECURITY.md` e `CONTRIBUTING.md`.
- Worker único com o Durable Object do agente, que serve a interface e a API
  e passa toda requisição pelos portões de segurança: host permitido, HTTP
  para HTTPS, Cloudflare Access opcional, cabeçalhos de segurança e
  autenticação. `GET /api/health` responde se o Zuri está no ar e
  configurado, sem nenhum dado.
- Erros da API no formato `{ code, message }`, com o texto em pt-BR.

### Segurança

- Conexões WebSocket e caminhos de sub-agente são recusados, e os cabeçalhos
  internos do Agents SDK são removidos antes de chegar ao agente.
- Sem `PUBLIC_URL` válido, o Worker recusa tudo com `NOT_CONFIGURED` em vez de
  atender qualquer host.

### Atualização

- Novos valores no painel da Cloudflare: a variável `PUBLIC_URL` e os segredos
  `SESSION_SECRET`, `PASSWORD_PEPPER`, `OWNER_PASSWORD_HASH` e `OWNER_EMAIL`.
  Opcionais: `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`. Detalhes em
  `docs/arquitetura.md`.
