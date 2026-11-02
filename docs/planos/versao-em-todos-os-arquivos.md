# Plano · Versão em todos os arquivos e visível no app

Origem: pedido do Pablo em 02/11/2026

- **Problema:** a versão do sistema (0.18.x) só existia no `CHANGELOG.md`, em `packages/shared/src/version.ts` e nas tags. Os quatro `package.json` e o `package-lock.json` ficavam em 0.0.0, e a interface só mostrava a versão dentro de Configurações > Diagnóstico.
- **Mudança:**
  - `scripts/versao.ts`: `versionFiles`, `writeVersion` e `versionMismatches`. O `applyPlan` escreve a versão no `version.ts`, no `package.json` da raiz e de cada workspace e nas entradas do `package-lock.json` (topo, `packages[""]` e cada workspace). Novas opções `--conferir` (no `npm run lint`) e `--sincronizar`.
  - `scripts/publicar-versao.ts`: a PR `chore(release):` inclui esses arquivos.
  - `scripts/ordem-de-merge.ts`: a PR de versão (branch `chore/versao` do próprio repositório) não espera nem segura outras PRs. Ela só muda linhas de versão, mas agora toca o `package.json`, que as atualizações de dependência também mudam.
  - Interface: "Versão X" em texto pequeno no pé do menu lateral (só para leitor de tela quando o menu está recolhido) e no pé da lista de Configurações no celular. Uma chave nova no catálogo, `web.nav.version`, em pt-BR e en.
- **Fica fora:** `wrangler.jsonc`, `manifest.webmanifest` e o service worker, que não guardam versão. Nada é publicado no npm, e os pacotes continuam privados.
- **Testes:** `tests/repo/versao.test.ts` confere que os arquivos do repositório batem com o `CHANGELOG.md`, que `writeVersion` só muda as linhas de versão (nem uma dependência com o mesmo número), que cada divergência é listada e que `--conferir` falha e `--sincronizar` corrige. O teste de `applyPlan` com git de verdade também confere o `package.json`. `tests/repo/ordem-de-merge.test.ts` cobre a PR de versão, que não espera nem segura outras, e a mesma branch vinda de um fork, que espera como qualquer PR. E2e: `shell.spec.ts` (computador e celular) e `sidebar.spec.ts` (menu recolhido).
- **Riscos e custo:** o JavaScript inicial vai de 138,9 para 138,99 kB, abaixo do teto de 139 kB. Um conflito no `package-lock.json` perto da linha de versão de um workspace é possível, mas improvável, porque a linha `dependencies` fica entre elas. Nenhum efeito nas cotas.
- **Segurança:** o workflow continua sem instalar nada e só escreve arquivos do repositório. A isenção do `merge-order` vale só para a branch `chore/versao` do próprio repositório, nunca para um fork.
