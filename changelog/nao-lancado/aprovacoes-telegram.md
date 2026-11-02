<!-- versao: minor -->

### Adicionado

- As propostas da Zuri feitas numa conversa pelo Telegram (apagar uma tarefa
  ou nota, trocar o texto de uma nota, esquecer uma memória, cancelar uma
  automação) chegam com o botão **Aprovar** e uma prévia montada com o que
  está guardado agora, nunca com as palavras da Zuri.
- Tocar em **Aprovar** não basta: você confirma com a passkey, na página
  `/aprovar` (que mostra a mesma prévia), ou com um código de 6 dígitos no
  e-mail. Só então a proposta é feita, uma vez, e o bot diz o resultado.
- `/aprovar` mostra as propostas que ainda esperam por você, até 5 por vez.

### Segurança

- O link e o código valem 5 minutos, uma vez só e só para aquela proposta. Se
  o item mudou depois da proposta, nada é feito e a página e o bot dizem por
  quê. As mesmas 5 confirmações erradas em 15 minutos travam as aprovações
  pelo bot por 1 hora.
- O e-mail do código traz a prévia com links desarmados e o aviso "Se não foi
  você que tocou em Aprovar no Telegram, não digite este código".
- Cada aprovação pelo bot aparece em Acessos e gera um aviso de segurança, uma
  vez, que só se reconhece no app. Ações como trocar a senha ou desvincular o
  Telegram continuam fora do bot.
