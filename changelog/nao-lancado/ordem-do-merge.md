### Adicionado

- Check `merge-order`: uma PR espera enquanto outra mais antiga, aberta para
  a `develop`, muda os mesmos arquivos de código. Com isso o auto-merge do
  GitHub respeita a ordem de abertura. Changelog, README, memória, docs e
  catálogos de texto não contam, porque o `Update PRs` junta esses sozinho.
  Para passar na frente de propósito, existe o rótulo `fora-de-ordem`.

### Alterado

- O `Update PRs` também roda a cada 15 minutos e dispara o `merge-order` de
  novo onde o resultado ficou velho, por exemplo quando a PR mais antiga foi
  fechada ou saiu do rascunho.
