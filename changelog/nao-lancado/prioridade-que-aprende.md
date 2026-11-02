### Adicionado

- A Zuri aprende a prioridade dos avisos: o tipo de aviso que você quase sempre
  deixa de lado passa a chegar com um nível a menos, e o que você abre em até
  15 minutos sobe um nível, no máximo até alta. Cada tipo muda no máximo um
  nível por semana, e a Zuri avisa quando muda.
- Em Configurações › Avisos, o cartão "Prioridades que a Zuri aprendeu" mostra
  o que mudou, com "Desfazer" em cada item e uma chave para desligar o
  aprendizado.
- As automações ganharam o campo "Prioridade dos avisos" (baixa, normal ou
  alta).

### Atualização

- A migration 13 guarda a origem de cada aviso, o que foi aprendido e a
  prioridade das automações (as que já existem ficam em normal). Roda sozinha
  na primeira requisição depois do deploy.
