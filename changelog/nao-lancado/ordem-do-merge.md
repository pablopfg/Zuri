### Adicionado

- Check `merge-order` na CI: uma PR espera enquanto outra mais antiga, aberta
  para a `develop`, muda os mesmos arquivos de código. O auto-merge do GitHub
  passa a respeitar a ordem de abertura. Changelog, README, memória, docs e
  catálogos de texto não contam, porque o `Update PRs` já junta esses
  sozinho. Para passar na frente de propósito, o rótulo `fora-de-ordem`.
