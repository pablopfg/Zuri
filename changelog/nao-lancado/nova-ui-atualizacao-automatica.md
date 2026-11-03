### Adicionado

- As telas se atualizam sozinhas, só no trecho que mudou: uma tarefa, nota,
  memória, automação ou conversa nova (ou alterada) aparece sem recarregar a
  página e acende de verde por 2 segundos. O que a Zuri faz na conversa aparece
  na hora; o que chega de fora (Telegram, rotinas, outro aparelho) aparece em
  até 1 minuto com o app aberto, ou na hora ao voltar para a aba.
- O menu lateral mostra quantas tarefas há para hoje, e as abas de Tarefas
  mostram quantas há em cada uma (Hoje, Próximas, Atrasadas, Concluídas e
  Todas).
- Se uma nota aberta mudar em outro aparelho enquanto você edita, a Zuri avisa
  e deixa você escolher entre "Ver a versão nova" e "Manter a minha". O que
  você digitou nunca some sozinho.

### Alterado

- Concluir uma tarefa, pausar ou retomar uma automação e restaurar algo da
  lixeira mudam a tela no mesmo instante. Se o servidor recusar, a tela volta
  ao que era e diz o motivo.
- O leitor de tela ouve uma frase curta quando itens da lista mudam por algo
  feito fora da tela, e as abas com contagem passam a ser lidas com o número
  ("Hoje 3").

### Corrigido

- Ao voltar da página de login de um serviço externo (MCP), o cartão às vezes
  continuava em "Falta entrar" até recarregar. Agora a lista é lida de novo
  depois da volta.

### Atualização

- Migration 21: a tabela `zur_area_versions` (uma linha com um número por área
  da tela) e o contador `tasks_done`, mantidos por gatilhos. Nada do que já
  existe muda.
