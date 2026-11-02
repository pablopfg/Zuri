### Alterado

- O changelog de cada PR agora fica num arquivo próprio em
  `changelog/nao-lancado/`, e o release junta tudo em "Não lançado" com
  `node scripts/changelog.ts --gravar`. Duas PRs não mexem mais nas mesmas
  linhas do `CHANGELOG.md`.
- O registro das partes do catálogo de textos (`pt-BR.ts`, `index.ts` e o
  teste de i18n) ficou uma parte por linha, para duas telas novas ao mesmo
  tempo não brigarem pela mesma linha.

### Adicionado

- Workflow `Update PRs`: quando a `develop` muda, ele traz a `develop` para
  cada PR aberta, resolve sozinho o conflito que é só acréscimo dos dois lados
  (changelog, README, memória, docs e catálogo de textos), roda a CI de novo
  no commit novo e deixa um comentário na PR quando sobra conflito para uma
  pessoa. Nunca mescla nem faz force push. Nas branches, o mesmo resultado sai
  com `node scripts/atualizar-prs.ts --local`.
