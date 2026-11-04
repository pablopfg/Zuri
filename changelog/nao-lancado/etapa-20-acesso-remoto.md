<!-- versao: minor -->
### Adicionado

- **Acesso remoto** em **Configurações › Segurança**: tokens para o n8n, o
  Home Assistant ou um script falarem com a Zuri de outro servidor. Cada token
  tem um escopo (**Só ler**, **Ler e escrever** ou **Só eventos**), vale 90
  dias e aparece uma única vez, com um exemplo de `curl` pronto. A lista mostra
  quando cada um foi criado, quando vence e quando foi usado pela última vez.
- `POST /api/remote/events`: com um token **Só eventos**, o n8n manda avisos
  como "n8n: Backup falhou" para a central, na categoria **Eventos**. Até 60
  por hora e 100 por dia, e um evento repetido em 24 horas é descartado.
- `/tokens` no bot do Telegram lista os tokens ativos com **Revogar** em cada
  um.

### Segurança

- O acesso remoto nasce desligado. Ligar e criar um token pedem a senha
  digitada há pouco e geram um alerta de segurança.
- O banco guarda só uma impressão do token (HMAC). Um token só alcança uma
  lista fechada de rotas, e um teste percorre todas as rotas para garantir que
  nenhum chega a login, Telegram, aprovações, fluxos, CRM, MCP, Google ou
  configurações, e que **Só ler** nunca escreve. Tokens não apagam memórias nem
  automações e não criam rotinas com IA.
- Token errado nunca cai para o cookie de sessão. Dez tokens recusados de uma
  rede em 15 minutos seguram a rede; cada token faz até 120 pedidos por minuto.
- Eventos de fora usam no máximo metade do limite de cada canal, nunca são
  críticos, levam a origem no título e entram como dado, nunca como instrução.
- O modo de bloqueio suspende os tokens; trocar ou recuperar a senha revoga
  todos.

### Atualização

- Migration 28 (`remote_access`): tabelas dos tokens e das tentativas
  recusadas. Roda sozinha no primeiro acesso depois da atualização.
