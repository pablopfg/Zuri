### Corrigido

- Ao fechar uma janela de confirmação, como "Sair sem salvar?" das notas,
  a tela de trás volta a responder na hora. Antes, por um instante, a janela
  já tinha sumido mas ainda bloqueava a página, e um `Ctrl+S` ou um toque
  logo em seguida podia não fazer nada. Isso também deixava instável um
  teste de notas no celular.
