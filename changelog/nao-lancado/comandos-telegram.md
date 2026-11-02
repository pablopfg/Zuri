<!-- versao: minor -->

### Adicionado

- Comandos rápidos no bot do Telegram, sem gastar IA: `/hoje`, `/tarefas`,
  `/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`,
  `/avisos`, `/uso`, `/status` e `/backup`. O menu do bot e o `/ajuda`
  mostram todos.
- `/nova` e `/lembrar` entendem datas como "amanhã 9h", "sexta-feira",
  "dia 5", "5/11", "daqui a 2 horas" e "semana que vem", respondem com a data
  entendida e o botão **Corrigir data**. Quando a data é ambígua, a Zuri
  pergunta em vez de adivinhar.
- `/tarefas` numera até 10 tarefas abertas, com **Feito** e **Adiar** em cada
  uma; `/feito 2` conclui a segunda e oferece **Desfazer** por 5 minutos.
  `/rotinas` tem **Pausar**.
- Foto ou documento com legenda vira nota, com uma linha dizendo o tipo e o
  tamanho do anexo. O arquivo não é baixado nem guardado.
- O aviso de leitura travada tem o botão **Destravar**.

### Segurança

- Os comandos que mostram ou mudam conteúdo pedem a leitura destravada,
  inclusive os botões das listas; `/uso`, `/status` e `/backup` nunca pedem, e
  `/avisos` travado mostra só a hora, a categoria e a prioridade.
- O que você guardou volta ao chat com links, comandos e menções desarmados.
  Os botões levam só um código aleatório, valem uma vez e vencem (1 hora nas
  listas, 5 minutos no Desfazer).
