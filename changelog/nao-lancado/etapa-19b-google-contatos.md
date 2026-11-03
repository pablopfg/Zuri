<!-- versao: minor -->
### Adicionado

- Google Contatos: no cartão Google Agenda e Contatos, em Configurações >
  Integrações, ligue os contatos e escolha quais etiquetas a Zuri copia. Ela
  só lê: nunca muda um contato no Google e não manda mensagem para ninguém.
- A cópia se atualiza de hora em hora, só com o que mudou, até 5.000 contatos.
  O botão Sincronizar agora atualiza na hora.
- Tela Contatos no menu lateral e na paleta Ctrl/⌘K, com busca por nome,
  apelido, pedaço do telefone ou e-mail, filtro por etiqueta e os detalhes de
  cada contato, com atalho para abrir no Google Contatos.
- Avisos de aniversário do dia e, se você ligar, de datas especiais (com
  antecedência de até 30 dias e filtro por rótulo, como "Retorno"), no horário
  que você escolher. Quando alguém entra numa etiqueta, a Zuri pode avisar e
  criar uma tarefa.
- Na conversa e nas rotinas com IA, a Zuri busca contatos e lê os detalhes de
  um contato, inclusive os aniversários de hoje ou da semana.

### Segurança

- Ligar os contatos e acrescentar uma etiqueta pedem a senha digitada há
  pouco, e a permissão nova gera alerta de segurança. Nome, telefone, e-mail e
  observações dos contatos nunca vão para o log, e o que a Zuri lê deles entra
  na conversa como dado, nunca como ordem.
- Desligar os contatos apaga a cópia inteira. Desconectar o Google também
  retira a permissão no Google. No modo de bloqueio nada sai para o Google.

### Atualização

- O banco ganha a migration 23 (a cópia dos contatos, as etiquetas e o estado
  da sincronização). Ela roda sozinha na primeira requisição e só acrescenta.
- Para usar os contatos, ligue a People API no projeto do Google Cloud do seu
  cliente OAuth e acrescente o escopo `contacts.readonly` na tela de
  consentimento. O passo a passo está em `docs/google-contatos.md`.
