### Corrigido

- O workflow de versão não falha mais quando a branch da PR de versão anterior
  é apagada no meio do run: ele cria a branch e a PR de novo. Foi o que deixou a
  0.25.8 com tag e pré-release, mas sem a PR que atualiza o `CHANGELOG.md`.
