<!-- versao: minor -->
### Adicionado

- Aba **Fluxos** em Automações, com endereço próprio (`/automacoes/fluxos`):
  passos que rodam sozinhos, só quando você executar ou num horário (a cada
  15 minutos ou mais, todo dia ou em dias da semana). Os passos são chamar um
  serviço, filtrar itens, montar campos, esperar, avisar você, pedir à IA e
  olhar sites.
- Modelo **Monitorar sites**: até 10 endereços somando todos os fluxos. Um
  site que falha é testado de novo 1 e 5 minutos depois antes de contar como
  fora do ar, e você recebe um aviso na queda e outro na volta. A tela mostra
  o estado de cada site, o código e o tempo de resposta.
- **Conexões**: o endereço de um serviço seu, os caminhos e os métodos que um
  fluxo pode usar (GET, POST, PUT e PATCH; nunca DELETE) e uma credencial
  opcional, guardada cifrada.
- Histórico das execuções, com o passo e o motivo de cada parada. Depois de 5
  falhas seguidas o fluxo se desliga e avisa.
- "Criar fluxo" na paleta Ctrl/⌘K. No bot, `/status` mostra os sites
  monitorados e os fluxos com falha (com a leitura travada, só as contagens).

### Segurança

- Todo fluxo nasce desligado. Ligar um fluxo, mudá-lo e criar ou mudar uma
  conexão pedem a senha digitada nos últimos 15 minutos; desligar não pede.
- Nenhuma ferramenta da Zuri, comando do bot ou token remoto cria, liga ou
  altera fluxos, conexões ou endereços. Não há passo de código nem chamada a
  endereço livre.
- A credencial de uma conexão nunca volta para a tela nem vai ao modelo, ao
  log ou ao histórico. Mudar o endereço ou o tipo apaga a credencial, e criar
  ou mudar o destino de uma conexão gera alerta de segurança.
- Toda chamada confere o nome por DNS, recusa rede interna, não segue
  redirecionamento e tem teto de tempo e tamanho. O que um serviço responde é
  dado: não muda os passos e entra na IA como `<data source="flow">`.
- Desligar ou mudar um fluxo encerra a execução dele que estava esperando. Um
  valor vindo de fora igual a `.` ou `..` não muda o caminho chamado: a
  execução para.
- No modo de bloqueio nenhum fluxo roda e as rotas dos fluxos respondem 423.
- O teste dos logs passa a conferir que números de telefone nunca aparecem neles.
