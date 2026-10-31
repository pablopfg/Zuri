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
