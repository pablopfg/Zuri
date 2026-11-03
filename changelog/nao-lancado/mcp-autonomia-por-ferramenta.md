### Adicionado

- Três níveis para cada ferramenta externa, em Configurações › Integrações:
  "Perguntar sempre" (o padrão), "Sem perguntar na conversa" e "Sem
  perguntar, também em rotinas e workflows". Subir de nível pede a sua senha e
  gera um aviso de segurança. Uma ferramenta que pode mudar dados também sobe,
  com um aviso a mais na tela.
- As rotinas com IA podem usar ferramentas externas: as do terceiro nível e as
  que você liberar só para aquela rotina, na nova seção "Ferramentas externas"
  ao editar a rotina.
- Quando uma rotina esbarra num limite (dados demais, ou outro serviço já
  respondeu), nada é enviado: a chamada fica esperando a sua aprovação numa
  conversa "Rotina: <nome>", você recebe um aviso no app e no Telegram, e a
  rotina segue.

### Segurança

- Ferramentas que o serviço marca como destrutivas sempre perguntam, em
  qualquer nível, e nunca são liberadas para uma rotina.
- Mudar a definição de uma ferramenta volta ela para "Perguntar sempre" e a
  tira das rotinas. Mudar a instrução de uma rotina, ou apagá-la, desfaz a
  liberação das ferramentas dela.
- Cada execução de rotina deixa no máximo 3 propostas e faz no máximo 12
  chamadas externas.
