<!-- versao: minor -->

### Adicionado

- Comandos de emergência no Telegram: `/acessos` (os 10 acessos mais
  recentes, com cidade, rede resumida e aparelho), `/sessoes` (as sessões
  abertas no app, com **Encerrar** em cada uma), `/encerrar_sessoes`,
  `/tokens`, `/pausar_rotinas` e `/bloquear`. Nenhum deles usa IA.
- `/encerrar_sessoes`, `/pausar_rotinas` e `/bloquear` confirmam com um toque
  e funcionam mesmo com a leitura do bot travada.
- Modo de bloqueio: `/bloquear` encerra todas as sessões do app, para as
  rotinas com IA e deixa o bot respondendo só a `/status`, `/avisos` e
  `/ajuda`. Lembretes e alertas de segurança continuam.
- Tela **Sair do bloqueio** no app, com quando o bloqueio foi ligado, o
  pedido do código para sair e o botão **Não fui eu: desvincular o
  Telegram**.
- **Confirmar que vi** na central de avisos, para os alertas de segurança que
  o bot causou.

### Segurança

- Na primeira hora do bloqueio, só se entra no app com a senha e um código de
  recuperação, e esse login já desliga o bloqueio. O código do aplicativo e a
  passkey são recusados sem gastar tentativa.
- Durante o bloqueio, o bot não aprova, não destrava e não conversa, e o app
  só abre a tela de sair. As rotinas com IA ficam paradas até a saída.
- Um segundo `/bloquear` pela mesma conta até 24 horas depois de sair também
  suspende o vínculo com o Telegram até você confirmar a conta no app.
- Os alertas de `/bloquear`, `/encerrar_sessoes` e `/pausar_rotinas` vão a
  todos os canais e só param quando você confirma no app, com a senha
  digitada nos últimos 15 minutos.
- `/acessos` nunca mostra o endereço IP inteiro.
