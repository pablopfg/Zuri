# Google Contatos

A partir da etapa 19b, a Zuri guarda uma cópia, só para leitura, dos seus
contatos do Google que estão nas etiquetas que você escolher. Ela usa essa
cópia para responder na conversa, para a tela **Contatos** e para avisar dos
aniversários e das datas especiais. Ela nunca muda um contato no Google e não
manda mensagem para ninguém. O plano está em `docs/planos/google-contatos.md`.

## Para o dono

### Ligar

1. Conecte o Google Agenda primeiro (veja [Google Agenda](google-agenda.md)).
   Os contatos usam a mesma conta.
2. No cartão **Google Agenda e Contatos**, em **Contatos**, toque em **Ligar
   contatos**. Se a última senha foi digitada há mais de 15 minutos, a Zuri
   pede de novo.
3. O Google mostra a permissão nova, "ver seus contatos". As permissões da
   agenda continuam como estavam.
4. Você volta para Integrações. A Zuri lê as suas etiquetas em instantes, ou
   na hora se você tocar em **Sincronizar agora**.

Se o Google não der a permissão dos contatos, nada é guardado e o cartão pede
para ligar de novo.

### Escolher as etiquetas

Nada é copiado antes de você marcar uma etiqueta. Só aparecem as etiquetas que
você criou no Google Contatos; os grupos do próprio Google ("Meus contatos",
"Com estrela") ficam de fora. Marque as etiquetas e toque em **Salvar
etiquetas**:

- Acrescentar uma etiqueta pede a senha digitada há pouco e faz a próxima
  sincronização ler a lista inteira de novo.
- Tirar uma etiqueta apaga na hora, da cópia, quem só estava nela.
- O teto é de 5.000 contatos copiados. Se as etiquetas passarem disso, a Zuri
  para e pede para você escolher menos.

### Sincronização

A cópia é atualizada de hora em hora, e só com o que mudou desde a última vez
(o Google entrega só as diferenças). **Sincronizar agora** faz a mesma coisa
na hora. Uma mudança feita no Google pode levar alguns minutos para chegar.

Quando o Google falha, a Zuri tenta de novo sozinha, com intervalos que
crescem de 30 minutos até 6 horas. Na terceira falha seguida, um aviso entra na
central. Se a permissão for retirada, ou se a People API estiver desligada no
seu projeto do Google Cloud, o cartão diz o que fazer.

### Tela Contatos

No menu lateral (e na paleta Ctrl/⌘K), **Contatos** lista a cópia em ordem de
nome, de 50 em 50. A busca acha pelo nome, apelido, um pedaço do telefone
(digitado de qualquer jeito, com ou sem DDD e +55) ou o e-mail, e dá para
filtrar por etiqueta. Tocar num contato abre os telefones, os e-mails, o
aniversário, as datas especiais, a empresa, as observações e os campos
personalizados, com o atalho **Abrir no Google Contatos** para mudar algo lá.

### Avisos

No cartão, em **Avisos**:

| Opção | O que faz |
| --- | --- |
| **Aniversários do dia** | Ligado por padrão. No horário escolhido, um aviso com quem faz aniversário hoje (até 20 nomes e "+N"). |
| **Datas especiais** | Desligado por padrão. Avisa das datas personalizadas dos contatos (por exemplo "Retorno"), no dia ou com até 30 dias de antecedência. |
| **Só datas com este rótulo** | Opcional. Com "Retorno", só as datas com esse rótulo entram no aviso. |
| **Horário dos avisos** | 08:00 por padrão, no seu fuso. |
| **Quando alguém entrar numa etiqueta** | Não fazer nada, me avisar (padrão) ou me avisar e criar uma tarefa para o dia seguinte às 9h. |

Quem faz aniversário em 29 de fevereiro aparece em 28 de fevereiro nos anos
que não são bissextos.

Os avisos saem do mesmo alarme das outras rotinas e não usam IA. Para algo
mais elaborado (uma mensagem sugerida, um resumo da semana), crie uma rotina
com IA em Automações: ela pode usar a ferramenta `search_contacts` com os
aniversários de hoje ou da semana.

### Na conversa e nas rotinas

Com os contatos ligados, a Zuri ganha duas ferramentas de leitura:

- `search_contacts`: busca por nome, apelido, telefone ou e-mail, numa
  etiqueta ou pelos aniversários de hoje ou da semana (até 10 resultados).
- `get_contact`: o contato inteiro.

As duas leem a cópia da Zuri, nunca o Google, e o que voltam entra no prompt
como dado (`<data source="contact">`): um nome ou uma observação escrita por
outra pessoa nunca vale como ordem. Nenhuma ferramenta muda contato, escolhe
etiqueta ou liga os contatos.

### Desligar

- **Desligar contatos** apaga a cópia inteira (contatos, etiquetas, datas) e
  para a sincronização. A agenda continua conectada. A permissão de ler os
  contatos continua dada no Google, porque o Google só deixa retirar a
  conexão inteira; para retirar, desconecte o Google.
- **Desconectar** o Google retira a permissão no Google e também apaga a cópia
  dos contatos.

Os contatos continuam no Google em qualquer caso.

## Para quem instala

Nada novo além do cliente OAuth da Agenda:

1. No projeto do Google Cloud do cliente OAuth, em **APIs e serviços >
   Biblioteca**, ligue a **People API** (de graça).
2. Na tela de consentimento OAuth, acrescente o escopo
   `https://www.googleapis.com/auth/contacts.readonly`. Com o app "Em
   produção" sem verificação, o Google mostra o aviso de app não verificado,
   como na Agenda.

Os mesmos secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`MCP_CREDENTIAL_KEY`) servem para os dois.

## Como funciona

- Conexão: a mesma de `GoogleCalendar` (`apps/agent/src/google/service.ts`),
  com `include_granted_scopes=true` e o propósito `contacts` guardado no
  `state` pendente. A coluna `scopes` guarda o que o Google deu; os contatos só
  valem com `contacts.readonly` concedido. Os tokens seguem cifrados com o
  `MCP_CREDENTIAL_KEY`.
- Leitura: `GET people/me/connections` com `personFields` fixo, páginas de
  1.000, até 10 páginas por despertar, e `syncToken` para as diferenças. Token
  vencido (o Google guarda 7 dias, `EXPIRED_SYNC_TOKEN`) recomeça uma vez como
  leitura inteira. As etiquetas vêm de `GET contactGroups`, só
  `USER_CONTACT_GROUP`.
- Banco (migration 23): `zur_contact_labels`, `zur_contacts` (com o nome
  normalizado para a busca), `zur_contact_keys` (telefone canônico e e-mail,
  para a busca por pedaço), `zur_contact_memberships`, `zur_contact_dates`
  (mês-dia para os avisos) e `zur_contact_sync` (uma linha: estado, tokens de
  sincronização, escolhas dos avisos). Coluna `contacts` em
  `zur_area_versions`, para a tela atualizar sozinha.
- Uma sincronização por vez: trava no banco (`running_since`, 10 minutos) e,
  a cada `await`, a Zuri confere se a trava ainda é dela.
- Orçamento de chamadas ao Google por despertar: 14 na sincronização, dentro
  das 50 subrequisições do plano Free.
- Logs: só contagens e o motivo da falha (`contacts_synced`,
  `contacts_ignored`, `contacts_sync_failed`), nunca nome, telefone ou e-mail.
- Backup (etapa 23): as tabelas dos contatos ficam fora, porque a cópia se
  refaz sozinha a partir do Google.
- Modo de bloqueio: nada sai para o Google, a tela e as rotas respondem 423.

## Custo

Tudo de graça. A People API não cobra pela leitura. No plano Free da
Cloudflare: uma sincronização por hora que não acha mudança escreve só a linha
de estado; com 500 contatos copiados, a primeira leitura escreve uns 3.500
registros (contatos, chaves e índices), uma única vez. A busca da tela e das
ferramentas lê só o banco da Zuri. Os números medidos estão no teste
`apps/agent/test/free-tier-budget.test.ts` ("Google contacts").
