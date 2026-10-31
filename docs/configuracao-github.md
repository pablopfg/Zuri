# Configuração do GitHub

O que o dono configura uma vez no GitHub, todo pelo navegador. Os caminhos
partem da página do repositório. A etapa 24 acrescenta os segredos do deploy.

## 1. Branches

| O quê | Onde | Como |
| --- | --- | --- |
| `develop` como padrão | **Settings → General → Default branch** | Clique no ícone de troca e escolha `develop` |
| Formas de mesclar | **Settings → General → Pull Requests** | Marque **Allow merge commits** (releases para a `main`) e **Allow squash merging** (PRs para a `develop`); desmarque **Allow rebase merging**; marque **Automatically delete head branches** |

## 2. Rulesets

Os arquivos ficam em `.github/rulesets/`. Importe cada um em
**Settings → Rules → Rulesets → New ruleset → Import a ruleset**, escolha o
arquivo, confira a tela e clique em **Create**.

| Arquivo | Protege | Regras |
| --- | --- | --- |
| `develop.json` | `develop` | PR obrigatório, **nenhuma aprovação humana** (o agente mescla no modo contínuo), só squash, histórico linear, checks `typecheck`, `lint`, `test`, `i18n`, `build`, `e2e`, `audit`, `lighthouse` e os dois do CodeQL (`analyze (javascript-typescript)` e `analyze (actions)`), branch atualizada com a `develop` antes de mesclar, sem force-push nem exclusão, ninguém dispensa as regras |
| `main.json` | `main` | PR obrigatório, só merge commit, os mesmos checks mais `source-branch` (só aceita PR vindo da `develop` deste repositório), sem force-push nem exclusão |

Quando um arquivo de ruleset mudar (por exemplo, um check novo), atualize a
ruleset no GitHub: abra a ruleset em **Settings → Rules → Rulesets**, apague-a e
importe o arquivo de novo (ou ajuste a tela para ficar igual ao arquivo). Até
lá, o check novo roda em todo PR mas não bloqueia a mesclagem.

O check `source-branch` roda o `branch-policy.yml` da própria branch do PR. Um
PR de outra branch que altere esse arquivo poderia deixá-lo verde. Por isso,
antes de mesclar na `main`, confira que o PR vem da `develop` (o cabeçalho do
PR mostra `develop → main`).

O GitHub não sabe quem clica em **Merge**, então "a `main` é mesclada só pelo
Pablo" é uma regra do agente (instruções do projeto e `AGENTS.md`), não do
ruleset. O agente nunca abre nem mescla PR para a `main`.

## 3. Actions

Em **Settings → Actions → General**:

- **Actions permissions:** marque **Require actions to be pinned to a
  full-length commit SHA**.
- **Fork pull request workflows from outside collaborators:** **Require
  approval for all external contributors**.
- **Workflow permissions:** **Read repository contents and packages
  permissions** e desmarque **Allow GitHub Actions to create and approve pull
  requests**.

## 4. Segurança do código

Em **Settings → Advanced Security** (em contas antigas, **Code security**):

- **Dependency graph**, **Dependabot alerts**, **Dependabot security updates**
  e **Grouped security updates**: ligados.
- **Secret Protection** (secret scanning) e **Push protection**: ligados.
- **Private vulnerability reporting**: ligado (o `SECURITY.md` aponta para ele).
- **CodeQL analysis**: deixe o **Default setup** desligado. O repositório usa o
  workflow `.github/workflows/codeql.yml`, e os dois juntos dão erro.

## 5. Ambiente `production`

Em **Settings → Environments → New environment**, nome `production`:

- **Deployment branches and tags:** **Selected branches and tags → Add
  deployment branch or tag rule** → `main`.
- **Required reviewers:** você mesmo (cada deploy espera o seu clique).
- **Prevent self-review:** desligado (você é o único revisor).
- Os segredos (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) e a variável
  `ZURI_ALERT_EMAIL_TO` entram na etapa 24. Nunca no repositório.

## 6. Rótulo do Dependabot

Em **Issues → Labels → New label**, crie `sem-changelog`. O Dependabot marca
os PRs dele com esse rótulo.

## 7. App do Claude

Em <https://github.com/settings/installations> → **Claude → Configure**,
confira que o repositório está em **Repository access** e que o app tem
permissão de escrita em **Contents** e **Pull requests** (necessária para
mesclar na `develop`).
