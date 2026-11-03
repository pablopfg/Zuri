<!-- versao: minor -->
### Adicionado

- Google Agenda: em Configurações > Integrações, conecte a sua conta do Google
  pelo seu próprio app OAuth (de graça) e escolha, agenda por agenda, se a
  Zuri não vê, só lê, ou lê e edita. Tudo começa fechado.
- Tela Agenda no menu lateral, com os eventos por dia, semana ou mês, no seu
  fuso. Nas agendas abertas para edição, você cria, edita e apaga eventos ali
  mesmo. O que muda no Google aparece na tela aberta sem recarregar.
- Na conversa, a Zuri consulta a agenda, cria e muda eventos. Apagar um evento,
  ou mudar um que tem convidados ou foi marcado por outra pessoa, vira um
  cartão para você aprovar, também pelo Telegram.
- O endereço de volta a cadastrar no Google é
  `https://exemplo.com.br/rest/oauth2-credential/callback`, com o domínio da sua
  Zuri.
- `/hoje` no Telegram mostra os eventos do dia.
- Em Automações, os modelos de rotina com IA Briefing da manhã (todo dia, 7h)
  e Fechamento do dia (segunda a sexta, 19h).

### Segurança

- Conectar a conta e abrir uma agenda pedem a senha digitada há pouco e geram
  alerta de segurança. Os tokens do Google ficam cifrados e nunca voltam ao
  navegador, ao log nem ao backup.
- A Zuri não convida nem avisa ninguém, e editar ou apagar confere a versão do
  evento: se ele mudou no Google, nada é sobrescrito.
- Os avisos de mudança do Google só são aceitos com o token do canal, e no
  modo de bloqueio nenhuma chamada sai para o Google.

### Corrigido

- Ao voltar do login de um serviço MCP, o cartão às vezes continuava em "Falta
  entrar" até recarregar a página. Agora mostra "Conectado" na hora.

### Atualização

- O banco ganha a migration 22 (a conta do Google e as agendas, com o modo de
  cada uma). Ela roda sozinha na primeira requisição e só acrescenta.
- Para usar a Agenda, cadastre os secrets `GOOGLE_CLIENT_ID` e
  `GOOGLE_CLIENT_SECRET` do seu cliente OAuth e tenha o `MCP_CREDENTIAL_KEY`.
  O passo a passo está em `docs/google-agenda.md`. Sem eles, o cartão do Google
  explica o que falta e nada mais muda.
