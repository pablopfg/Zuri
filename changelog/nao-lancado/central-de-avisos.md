### Adicionado

- Central de avisos: o sino da barra mostra quantos avisos estão sem ler e abre
  a lista, onde cada aviso pode ser aberto, marcado como lido, silenciado ou
  apagado. Chegam ali os resultados das automações, o resumo do dia, prazos
  chegando, tarefas atrasadas ou paradas, rotinas falhando, o uso da IA perto do
  limite e os alertas de segurança.
- Alerta de segurança não pode ser silenciado, e apagar um deles pede a senha.
  A insistência dos avisos importantes já está pronta e passa a valer quando
  houver canal fora do app.
- Configurações > Avisos: liga ou desliga o resumo do dia e escolhe o horário,
  liga ou desliga os avisos que a Zuri dá por conta própria e mostra os últimos
  envios. Notificação no aparelho e e-mail chegam na próxima parte da etapa 11.
- Configurações > Diagnóstico: as falhas dos últimos 30 dias por tipo, com
  contagem e referência para achar no log, e aviso quando uma falha se repete ou
  aparece numa versão nova. Nada do que você escreveu entra nesse registro.

### Corrigido

- Um teste de interface media o botão "Fechar" com 43,99994 px e falhava às
  vezes; a medida agora aceita a diferença de arredondamento do navegador.

### Atualização

- A migration 11 cria as tabelas dos avisos, dos envios e do Diagnóstico e roda
  sozinha na primeira requisição depois do deploy. Os alertas de acesso
  guardados desde a etapa 3 viram avisos nessa hora.
- O `wrangler.jsonc` ganhou o binding grátis `CF_VERSION_METADATA` (a versão
  publicada, para o Diagnóstico). Não há segredo novo nem nada para configurar.
