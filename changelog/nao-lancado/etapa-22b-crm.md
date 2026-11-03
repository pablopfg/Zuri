<!-- versao: minor -->
### Adicionado

- Aba **Clientes** em Contatos (`/contatos/clientes`): até 5.000 clientes com
  telefone, e-mail, aniversário, etapa do funil, etiquetas, anotações, retorno
  e um histórico com as 100 entradas mais novas de cada um. Filtros por etapa,
  etiqueta e retorno (atrasado, hoje, próximos 7 dias), e busca por nome,
  pedaço do telefone ou e-mail.
- Funil editável, de 2 a 12 etapas. Começa com Novo, Em conversa, Agendado,
  Cliente e Inativo, e os clientes de uma etapa que você tirar vão para a
  primeira.
- Avisos do CRM pela central de avisos: retorno na hora marcada, aniversários
  do dia às 9 h e cliente novo vindo do n8n (até 20 por dia). Cada um pode
  ser desligado.
- **Eventos do n8n**: o n8n manda clientes novos, mudanças, mensagens,
  agendamentos e retornos por um endereço próprio, com cada evento assinado.
  Até 300 por hora e 1.000 por dia, e um evento repetido não grava nada de
  novo. O passo a passo está em `docs/crm.md`.
- Na conversa, a Zuri busca clientes, resume o funil, cadastra clientes e muda
  etapa, etiquetas, retorno e anotações sem perguntar. As rotinas leem o CRM,
  mas não mudam nada.
- Pedir um fluxo na conversa deixa uma sugestão em **Automações › Fluxos**, na
  seção **Sugestões da Zuri**. Ela só vira fluxo quando você revisa e salva
  com a senha, e o fluxo começa desligado.

### Segurança

- Ligar os eventos ou trocar o segredo pede a senha digitada nos últimos 15
  minutos e gera alerta de segurança. O segredo aparece uma única vez e não
  fica guardado, e trocá-lo desliga o endereço anterior na hora.
- A assinatura de cada evento é conferida antes do Cloudflare Access e de
  novo dentro da Zuri, com janela de 5 minutos. Eventos com formato
  desconhecido são recusados inteiros.
- Nenhuma ferramenta da Zuri apaga cliente, mexe no funil, liga os eventos ou
  fala com clientes. Dados dos clientes entram no prompt marcados como dado,
  telefone e e-mail só quando você pede, e nada deles vai para o log.
- No modo de bloqueio, a aba e os eventos respondem 423.

### Atualização

- O banco ganha a migration 25 (clientes, funil, etiquetas, histórico e a
  fila dos eventos do n8n). Ela roda sozinha na primeira requisição e só
  acrescenta. Nenhum secret novo: o segredo dos eventos vem do
  `SESSION_SECRET`.
