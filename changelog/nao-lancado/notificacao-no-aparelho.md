### Adicionado

- Notificação no aparelho: em Configurações > Avisos, "Receber avisos neste
  aparelho" faz os avisos aparecerem no celular ou no computador mesmo com a
  Zuri fechada. Até 3 aparelhos; quem fica 7 dias sem abrir a Zuri deixa de
  receber. Dá para mandar um teste e remover um aparelho dali mesmo.
- Ativar ou remover um aparelho pede a senha e vira alerta de segurança nos
  outros canais. Os avisos importantes passam a insistir pelo aparelho.
- Configurações > Avisos ganhou a tabela "O que vai para cada canal", para
  escolher por onde cada tipo de aviso sai do app, e os limites por canal por
  hora e por dia. Segurança vai sempre por todos.

### Alterado

- O registro de acessos e a atividade em Configurações > Segurança passaram a
  carregar só quando abertos, e o pacote inicial da interface ficou 0,4 kB menor.

### Segurança

- As notificações saem cifradas para cada aparelho e assinadas com a chave da
  instalação; o serviço de notificação do navegador não lê o conteúdo. O
  servidor só envia para os serviços de notificação conhecidos.

### Atualização

- A migration 12 cria a tabela dos aparelhos e roda sozinha na primeira
  requisição depois do deploy.
- Para ligar a notificação no aparelho, gere o par de chaves com
  `node scripts/gerar-chaves-vapid.ts` e grave os segredos `VAPID_PUBLIC_KEY` e
  `VAPID_PRIVATE_KEY` (passo a passo em `docs/configuracao-cloudflare.md`). Sem
  eles, tudo continua funcionando e os avisos ficam no sino.
