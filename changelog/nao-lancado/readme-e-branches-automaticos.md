### Alterado

- O mapa das etapas, o selo de etapas e as contagens do `README.md` se
  atualizam sozinhos: o workflow `README` lê o `progresso.md` e as PRs de
  etapa a cada merge na `develop` e a cada 10 minutos, e abre uma PR com
  merge automático quando algo muda.
- Os selos CI e CodeQL do `README.md` mostram o estado real da `develop`: os
  dois workflows passam a rodar também a cada merge nela.

### Corrigido

- A branch `chore/versao` ficava no GitHub depois que a PR de versão
  mesclava. O workflow `Branches` apaga, em até 10 minutos, toda branch cuja
  PR já mesclou, desde que ela não tenha commit novo nem outra PR aberta.
