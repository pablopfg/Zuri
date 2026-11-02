<!-- versao: minor -->

### Adicionado

- Serviços externos (MCP) em Configurações › Integrações. Você adiciona o
  endereço de um servidor MCP, sem login ou com um token de acesso, e a Zuri lê
  a lista de ferramentas dele. Cada ferramenta começa desligada; você liga as
  que quiser e escreve uma dica de quando usar.
- Na conversa, a Zuri usa as ferramentas ligadas quando o pedido combina com
  elas. Com **Perguntar sempre** (o padrão), cada chamada vira um cartão com os
  dados exatos que vão para o serviço e só roda se você aprovar. A resposta do
  serviço aparece no cartão.
- **Usar sem perguntar**, para ferramentas que só consultam. Mesmo assim a
  Zuri pergunta quando a chamada leva muitos dados ou quando outro serviço já
  respondeu na mesma conversa.
- Com muitas ferramentas ligadas, a Zuri oferece ao modelo só as que combinam
  com o pedido e procura as outras quando precisa.
- O cartão do servidor mostra se ele está conectado, o motivo de um problema
  e quantas ferramentas estão ligadas. **Reconectar** lê a lista de novo.

### Segurança

- A Zuri só conecta a endereços `https` públicos. Endereços de rede
  particular ou de metadados são recusados, inclusive quando um nome público
  aponta para eles, e ela nunca segue redirecionamentos.
- Adicionar um servidor, trocar endereço ou token e ligar **Usar sem
  perguntar** pedem a senha digitada agora. Servidor novo e endereço trocado
  geram aviso de segurança.
- O token fica cifrado e nunca volta para a tela, o registro ou o modelo.
  Trocar o endereço descarta o token e desliga as ferramentas.
- Se o serviço mudar a descrição de uma ferramenta, ela sai de uso até você
  ligar de novo. Uma aprovação só roda se nada mudou desde o cartão.
- No modo de bloqueio e nas rotinas agendadas nenhuma ferramenta externa é
  usada. Aprovações de chamadas externas acontecem só no app.
