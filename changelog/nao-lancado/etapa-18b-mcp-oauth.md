<!-- versao: minor -->

### Adicionado

- Servidores MCP que pedem conta: em Configurações › Integrações, escolha
  **Entrar com a conta do serviço (OAuth)**. Ao salvar, aparece o botão
  **Entrar no serviço**; você entra na página do serviço e volta para a Zuri,
  que conecta e lista as ferramentas. Quando o login vence, o cartão avisa e o
  botão volta.
- Com a busca pelo significado ligada, a Zuri escolhe as ferramentas externas
  também pelo sentido do pedido: "planejar a viagem" acha a ferramenta de
  reservas mesmo sem palavra em comum. Isso não gasta IA a mais na conversa.
- Chamadas a ferramentas externas também se aprovam pelo bot do Telegram, com
  a ferramenta, o serviço e os dados exatos que vão sair. Depois de aprovada, a
  resposta do serviço aparece no chat.
- `/status` avisa quando algum serviço espera você entrar na conta de novo.

### Segurança

- O login usa PKCE e registra a Zuri no serviço como app público, sem segredo
  guardado. O link de login vale 10 minutos e uma vez só, e terminar o login
  pede a senha digitada agora e gera aviso de segurança.
- O servidor de login passa pelas mesmas regras de endereço público, e o token
  de acesso nunca vai para outro endereço. Tokens ficam cifrados como o token
  comum. Uma conversa ou rotina nunca abre a página de login sozinha.
- No Telegram, se o serviço, o acesso ou a ferramenta mudaram depois da
  proposta, o bot não deixa aprovar. Dados com mais de 600 caracteres só se
  confirmam pela passkey, e a resposta do serviço chega como citação, só para
  ler.
