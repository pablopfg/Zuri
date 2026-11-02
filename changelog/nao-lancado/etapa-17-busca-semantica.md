<!-- versao: minor -->

### Adicionado

- Busca por significado, opcional, em Configurações › IA. Ligada, a busca
  acha "carro" na memória sobre o "automóvel". Ela aparece na paleta
  (Ctrl/⌘ K, grupo **Pelo significado**), nas memórias que a Zuri lembra na
  conversa e nas rotinas, na busca da Zuri e no `/buscar` do Telegram, que
  também passam a achar rotinas.
- O cartão mostra quantos itens estão prontos e quantos foram preparados hoje,
  e tem **Preparar tudo de novo**.
- `/uso` no Telegram mostra as perguntas e os itens preparados do dia enquanto
  a busca está ligada.
- Desligada, a busca é exatamente a de antes.

### Segurança

- Os textos vão só ao modelo grátis do Workers AI da sua conta, nunca a outro
  provedor, e o resultado entra no prompt como dado.
- O preparo e a busca param no modo de bloqueio, e o registro de falhas guarda
  só o código do erro, nunca o texto.
- No máximo 2.000 textos preparados por dia e nunca mais da metade do teto de
  IA do dia. A conversa sempre fica com o resto.
- Um item editado ou apagado enquanto a Zuri prepara a busca nunca fica com o
  texto antigo no índice.
- Três falhas seguidas do modelo param o preparo até o dia seguinte, sem
  gastar a cota com tentativas.
