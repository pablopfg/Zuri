### Adicionado

- Três níveis para cada ferramenta externa, em Configurações › Integrações:
  "Perguntar sempre" (o padrão), "Sem perguntar na conversa" e "Sem
  perguntar, também em rotinas e workflows". Subir de nível pede a sua senha e
  gera um aviso de segurança. Uma ferramenta que pode mudar dados também sobe,
  com um aviso a mais na tela.
- A Zuri diz o que cada ferramenta externa faz (só consulta, altera dados, ou
  apaga e sobrescreve) lendo o nome, a descrição e os campos dela, e mostra o
  motivo no cartão. Você confirma ou troca; deixar menos cautelosa pede a sua
  senha.
- As rotinas com IA podem usar ferramentas externas: as do terceiro nível e as
  que você liberar só para aquela rotina, na nova seção "Ferramentas externas"
  ao editar a rotina.
- Quando uma rotina esbarra num limite (dados demais, ou outro serviço já
  respondeu), nada é enviado: a chamada fica esperando a sua aprovação numa
  conversa "Rotina: <nome>" por 24 horas, você recebe um aviso no app e no
  Telegram, e a rotina segue.

### Segurança

- Ferramentas que apagam ou sobrescrevem sempre perguntam, em qualquer nível,
  e nunca são liberadas para uma rotina. A marcação do serviço só pode deixar
  uma ferramenta mais cautelosa.
- Enquanto alguma ferramenta roda sozinha em rotinas, criar uma rotina com IA,
  mudar a instrução dela ou aprovar uma que a Zuri propôs pede a sua senha.
- Desligar uma ferramenta, ou voltá-la para "Perguntar sempre", também a tira
  das rotinas.
- Mudar a definição de uma ferramenta volta ela para "Perguntar sempre" e a
  tira das rotinas. Mudar a instrução de uma rotina, ou apagá-la, desfaz a
  liberação das ferramentas dela.
- Cada execução de rotina deixa no máximo 3 propostas, e as rotinas de um
  mesmo despertar dividem no máximo 12 chamadas externas.

### Atualização

- O banco ganha a migration 20 (nível das ferramentas para rotinas, o tipo
  confirmado por você, as ferramentas liberadas por rotina e a conversa de
  cada rotina). Ela roda sozinha na primeira requisição e só acrescenta. Uma
  ferramenta que estava em "Usar sem perguntar" sem ser marcada como consulta
  volta para "Perguntar sempre".
