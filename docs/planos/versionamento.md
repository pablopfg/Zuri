# Plano · Changelog por versão e pré-releases de desenvolvimento

Origem: pedido do Pablo em 02/11/2026 (changelog organizado por merge, com data, hora UTC-3, commit e versão; releases para as versões em desenvolvimento). Numeração escolhida por ele no mesmo dia: 0.x, etapa sobe o número do meio.

- **Problema:** o `CHANGELOG.md` tinha um "Não lançado" único com mais de 400 linhas, grupos repetidos e nenhuma versão; 21 fragmentos esperavam um release que não acontece até a etapa 25. A versão do sistema era `0.0.0` em todo lugar e não havia tag nem release.
- **Mudança:**
  - `CHANGELOG.md` refeito no formato Keep a Changelog: uma seção por PR mesclada (69, de 0.1.0 a 0.17.0), com a linha "Mesclada às HH:MM (UTC-3) · commit · PR · título" e os links no pé. Cada item antigo voltou para a PR que o escreveu (pelo histórico do arquivo e dos fragmentos).
  - `scripts/versao.ts`: lê e escreve o `CHANGELOG.md`, numera os merges que ainda não têm seção e grava `packages/shared/src/version.ts`.
  - `scripts/publicar-versao.ts` e `.github/workflows/versao.yml`: depois de cada merge, tag `vX.Y.Z` e pré-release no commit do merge, e uma PR `chore(release):` com auto-merge que escreve as seções.
  - Marcador `<!-- versao: minor -->` nos fragmentos (`scripts/changelog.ts`); sem ele, sobe o último número.
  - Versão em Configurações > Diagnóstico e no formulário "Relatar no GitHub".
  - Regras, skills, modelo de PR, especificação e `docs/agente/versionamento.md` explicam o fluxo.
- **Fica fora:** release e deploy na `main` (continuam do Pablo; a 1.0.0 sai com eles), `package.json` (fica em 0.0.0, pacotes privados), commit direto na `develop` (os rulesets exigem PR e não têm bypass).
- **Testes:** `tests/repo/versao.test.ts` (ida e volta do `CHANGELOG.md`, `APP_VERSION` igual à seção mais nova, numeração, fuso, títulos do Dependabot, repositório git de verdade com merges, fragmento editado depois, PR de versão ignorada, tag em outro commit, workflow só na `develop` e permissões mínimas); `tests/repo/changelog.test.ts` (marcador); `apps/web/test/issue-report.test.ts`; e2e do Diagnóstico.
- **Riscos e custo:** nenhum custo (GitHub Actions de repositório público e `GITHUB_TOKEN`). Uma PR a mais por merge, pequena e sem código; a CI dela é aprovada pelo próprio workflow. Se a opção "Allow GitHub Actions to create and approve pull requests" estiver desligada, a PR não abre e o workflow abre uma issue dizendo o que ligar; tags e pré-releases saem mesmo assim.
- **Segurança:** o workflow só roda na `develop`, não instala dependências, não lê segredo, não empurra para `develop` nem `main`, não move nem apaga tag. A versão mostrada na tela não revela nada que o repositório público já não mostre.
