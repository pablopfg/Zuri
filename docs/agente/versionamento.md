# Versões, changelog e pré-releases

Cada PR mesclada na `develop` vira uma versão do Zuri. Ninguém precisa lembrar
de subir número, editar o `CHANGELOG.md` ou criar tag: o workflow
[`versao.yml`](../../.github/workflows/versao.yml) faz isso logo depois do
merge. Decisão do Pablo de 02/11/2026 (`.claude/memoria/decisoes.md`).

## Numeração

[SemVer](https://semver.org/lang/pt-BR/) para software em desenvolvimento:

| Merge | Sobe | Exemplo |
| --- | --- | --- |
| Conclui uma etapa ou subetapa da especificação (11a, 19b, 22c…) | o número do meio | 0.17.4 → 0.18.0 |
| Qualquer outro (ajuste, correção, docs, CI, dependência) | o último | 0.18.0 → 0.18.1 |
| Primeiro lançamento na `main` | o primeiro, uma vez, com o OK do Pablo | 0.x.y → 1.0.0 |

Enquanto o primeiro número for 0, tudo é desenvolvimento. A 1.0.0 é decisão do
Pablo, junto com o primeiro release para a `main` (etapa 25); o workflow nunca
gera um número maior que 0.x sozinho.

A versão é a mesma em todos estes lugares (o `npm run lint` roda
`node scripts/versao.ts --conferir` e falha se um deles divergir; um teste em
`tests/repo/versao.test.ts` confere o mesmo):

- a seção mais nova do [`CHANGELOG.md`](../../CHANGELOG.md), que é a fonte;
- `packages/shared/src/version.ts` (`APP_VERSION`), escrito pelo script a
  partir dela e mostrado na interface: no pé do menu lateral, no pé da lista de
  Configurações no celular, em Configurações > Diagnóstico ("Versão da Zuri") e
  no formulário de "Relatar no GitHub";
- o campo `version` do `package.json` da raiz e de cada workspace
  (`packages/shared`, `apps/agent`, `apps/web`, lidos do campo `workspaces`);
- o `package-lock.json`: o `version` do topo, de `packages[""]` e de cada
  workspace;
- a tag `vX.Y.Z` no commit do merge, com a pré-release do GitHub (a partir da
  0.15.5; veja "Histórico").

Os outros arquivos não guardam versão: o `wrangler.jsonc` não tem esse campo
(cada deploy ganha o seu código, mostrado no Diagnóstico ao lado da versão), o
`manifest.webmanifest` também não, e o service worker não guarda cache, então
não tem número para trocar. Arquivo novo que passe a guardar a versão entra em `versionFiles` de
`scripts/versao.ts`, com teste.

Se algo ficar fora de sincronia (por exemplo, depois de resolver um conflito na
mão), `node scripts/versao.ts --sincronizar` escreve a versão do `CHANGELOG.md`
em todos os arquivos.

Esses arquivos só mudam quando a PR `chore(release):` mescla, minutos depois do
merge. Por isso o build do commit marcado com `vX.Y.Z` ainda mostra a versão
anterior; o build da `develop` depois da PR de versão mostra a certa. Um deploy
sempre parte da `develop` (ou da `main`) em dia, nunca de uma tag solta.

Os pacotes continuam privados (`"private": true`) e nada vai para o npm: o
número nos `package.json` serve só para que todo arquivo diga a mesma versão
(pedido do Pablo de 02/11/2026).

## O que cada PR faz

Escreve a sua parte do changelog num arquivo novo
`changelog/nao-lancado/<assunto>.md`, como sempre (grupos `### Adicionado`,
`### Alterado`, `### Corrigido`, `### Segurança` e `### Atualização`, itens
`- `). A PR que conclui uma etapa ou subetapa põe esta linha no topo do arquivo:

```markdown
<!-- versao: minor -->
### Adicionado

- …
```

Sem a linha, o merge sobe o último número. Não existe `major`: a 1.0.0 é do
Pablo. Confira o arquivo com `node scripts/changelog.ts`, que mostra o tipo de
cada um.

PR sem mudança visível (CI, docs internas, dependências) pode ficar sem arquivo
(rótulo `sem-changelog`): a versão sai do mesmo jeito, com a linha "Sem mudança
visível: <título da PR>". Por isso o título da PR importa: ele vira o título da
versão no `CHANGELOG.md` e nas notas da pré-release.

Nunca edite o `CHANGELOG.md`, o `version.ts` nem o `version` dos `package.json` e do `package-lock.json` à mão. "## [Não lançado]" fica
sempre vazio; o teste do repositório falha se alguém escrever ali.

## O que acontece depois do merge

1. O merge na `develop` dispara o workflow **Versão** (também roda de hora em
   hora e por `workflow_dispatch`).
2. `scripts/publicar-versao.ts` lê o `CHANGELOG.md` e acha os merges da
   `develop` depois da versão mais nova (só a linha principal, `--first-parent`).
   Cada merge ganha um número, na ordem, pelos arquivos que ele acrescentou em
   `changelog/nao-lancado/` (`scripts/versao.ts`).
3. Cada versão sem tag ganha a tag `vX.Y.Z` no commit do merge (por `git push`:
   a API de releases recusa ao `GITHUB_TOKEN` criar tag num commit cujos
   workflows diferem dos da `develop`) e uma
   **pré-release** no GitHub, com o título só "vX.Y.Z" (pedido do Pablo) e as
   notas da seção, que começam pela linha do merge com o título da PR.
   Pré-release antiga com outro título tem o título trocado para "vX.Y.Z"
   no run seguinte; tag e notas não mudam. Pré-release nunca vira "Latest" e não publica nada: não é deploy.
4. A branch `chore/versao` é refeita a partir da `develop` com as seções novas
   no `CHANGELOG.md`, os arquivos de `changelog/nao-lancado/` apagados e a
   versão nova no `version.ts`, nos `package.json` e no `package-lock.json`. Uma única PR `chore(release): versão X` fica aberta com
   ela, com o rótulo `sem-atualizacao-automatica` (o Update PRs não mexe nela)
   e auto-merge por squash. A CI que o push do bot dispara é aprovada pelo
   próprio workflow, como no Update PRs.
5. Se outra PR entrar antes, o próximo run refaz a branch e a mesma PR passa
   a cobrir as duas versões. Quando ela mescla, o merge dela não vira versão
   (título `chore(release):`), e o `CHANGELOG.md` fica em dia. A branch
   `chore/versao` é apagada em até 15 minutos pelo workflow `Branches`
   (`scripts/limpar-branches.ts`): o "Automatically delete head branches" do
   GitHub não apaga a branch de uma PR mesclada por auto-merge do
   `GITHUB_TOKEN`. Se ela fechar sem mesclar ("Nada a versionar"), o próprio
   workflow de versão apaga a branch.
6. A PR do workflow `README` (`docs(readme): atualiza o estado das etapas
   (automático)`, `.claude/rules/readme.md`) também não vira versão: muda só o
   mapa das etapas e as contagens do `README.md`.

Cada seção traz:

```markdown
## [0.17.0] - 2026-11-02

Mesclada às 09:20 (UTC-3) · commit [`d61079a`](…/commit/…) · PR [#73](…/pull/73) · Envia avisos com botões (etapa 13)

### Adicionado
…
```

A data e a hora são as do merge no fuso `America/Sao_Paulo`; o deslocamento
(`UTC-3`) é lido do fuso, não fixado. No pé do arquivo ficam os links de cada
versão para a pré-release e de "Não lançado" para a comparação com a `develop`.

## Garantias

- O workflow só roda na `develop`, com `GITHUB_TOKEN` (sem custo, sem segredo
  novo) e permissões de escrever tags, releases, a própria branch e a própria
  PR. Nunca empurra para `develop` ou `main` e nunca apaga tag; de uma
  pré-release que já existe, só acerta o título para "vX.Y.Z".
- Versão com tag fica congelada: se um fragmento for corrigido depois (por
  exemplo, o marcador `minor` esquecido), o número e as notas daquele merge
  não mudam, e os merges seguintes contam a partir dele.
- Tag que já aponta para outro commit para o workflow antes de mexer na PR de
  versão, em vez de ser movida, e ele abre a issue padrão de falha
  (`docs/agente/issues.md`).
- Sem mudança desde o último run, a branch `chore/versao` não é empurrada de
  novo, para a CI dela não recomeçar a cada hora.
- Esquecer o marcador numa branch `feat/etapa-*` falha o `npm run lint`
  (`node scripts/changelog.ts`) na CI da própria PR.
- Fragmento fora do formato, `CHANGELOG.md` editado à mão ou a seção mais nova
  apontando para um commit fora da `develop` também param o workflow.
- A rotina de merge e as threads tratam a PR `chore(release):` como qualquer
  outra: ela não muda código, só `CHANGELOG.md`, `changelog/` e as linhas de
  versão. O check `merge-order` nunca a segura nem deixa que ela segure outra
  PR (uma atualização de dependência também muda o `package.json`).

## Quando algo dá errado

| Sinal | Causa provável | O que fazer |
| --- | --- | --- |
| Issue "[falha automática] Versão" com "GitHub Actions is not permitted to create or approve pull requests" | a opção do repositório está desligada | Pablo liga **Settings > Actions > General > Allow GitHub Actions to create and approve pull requests** e roda o workflow de novo |
| "tag vX.Y.Z could not be created" ou "release vX.Y.Z not created" | o GitHub recusou a tag ou a pré-release ao `GITHUB_TOKEN` | o resto do run segue (a PR de versão abre); veja a linha recusada no log e rode o workflow de novo |
| "vX.Y.Z points to …" | alguém criou a tag na mão | apague a tag errada (Pablo) ou corrija a seção, e rode de novo |
| A PR `chore(release):` parada com checks esperando | a aprovação da CI do bot falhou | aprove as execuções na aba Actions ou rode o workflow de novo |
| `node scripts/versao.ts` mostra versões pendentes há mais de uma hora | o workflow não rodou | abra Actions > Versão > Run workflow |

Localmente: `node scripts/versao.ts` mostra o que falta escrever,
`node scripts/versao.ts --notas 0.17.0` mostra as notas de uma versão.

## Histórico

O `CHANGELOG.md` foi refeito em 02/11/2026 a partir das 69 PRs mescladas na
`develop` até a #73: cada item do changelog antigo e de `changelog/nao-lancado/`
voltou para a PR que o escreveu, as etapas 0 a 13 subiram o número do meio e o
resto o último.

As tags e pré-releases começam na **0.15.5** (#68), constante
`FIRST_TAGGED_VERSION` de `scripts/publicar-versao.ts`. O GitHub não deixa o
`GITHUB_TOKEN` criar uma tag num commit cujos arquivos de `.github/workflows/`
diferem dos da `develop` ("refusing to allow a GitHub App to create or update
workflow … without `workflows` permission"), e todas as versões antes da #68
estão nesse caso. Elas ficam só no `CHANGELOG.md`, com o commit e a PR de cada
uma. Daqui em diante isso não se repete: o workflow cria a tag logo depois do
merge, quando os workflows do commit ainda são os da `develop`.
