# Google Agenda

A partir da etapa 19, a Zuri lê e muda eventos do seu Google Agenda. Você
escolhe, agenda por agenda, o que ela pode fazer. O plano está em
`docs/planos/etapa-19-google-agenda.md`.

## Para o dono

### Conectar

1. Em **Configurações > Integrações**, no cartão **Google Agenda**, toque em
   **Conectar com o Google**. Se a última senha foi digitada há mais de 15
   minutos, a Zuri pede de novo.
2. O Google avisa que não verificou o app (é o seu próprio app, veja abaixo).
   Escolha **Avançado > Acessar Zuri** e marque as duas permissões: ver e
   editar eventos, e ver a lista de agendas.
3. Você volta para Integrações com a conta conectada. Um alerta de segurança
   "Google Agenda conectada" entra na central de avisos e em Acessos.

Se faltar uma das permissões, nada é guardado e a Zuri pede para conectar de
novo marcando as duas.

### O que a Zuri pode fazer em cada agenda

Toda agenda começa **Fechada**. Em cada uma você escolhe:

| Opção | O que acontece |
| --- | --- |
| **Fechada** | A Zuri não vê a agenda, nem na tela Agenda. |
| **Só ler** | Os eventos aparecem na tela Agenda, no `/hoje` do bot e nas rotinas, e a Zuri consulta na conversa. Ninguém muda nada por aqui. |
| **Ler e editar** | Além de ler, você cria, muda e apaga eventos na tela Agenda, e a Zuri cria e muda eventos na conversa. Apagar pela conversa sempre vira um cartão para você aprovar. Só aparece onde o Google deixa a sua conta editar. |

Na conversa, o que outras pessoas veem só muda com a sua aprovação: eventos
com convidados, eventos que outra pessoa organiza e eventos de agendas que
são de outra pessoa (em que a sua conta só pode escrever). A Zuri propõe a
mudança e você vê, no cartão, o evento como está no Google e os valores novos,
no app e no bot. Criar evento numa agenda de outra pessoa pela conversa não
vale; isso você faz na tela Agenda. Assim, o texto de um convite não consegue
fazer a Zuri copiar os seus dados para um evento que outra pessoa lê
(decisão de 03/11/2026).

Abrir uma agenda pede a senha recente; fechar nunca pede. Abrir uma para
edição gera o alerta de segurança "Agenda liberada para escrita". Agendas em
que o Google só mostra livre/ocupado ficam sempre fechadas.

**Atualizar lista** lê de novo as agendas da conta (uma nova, uma removida, um
papel que mudou). Se o Google tirar o direito de editar, a agenda volta para
**Só ler** sozinha.

### Tela Agenda

**Agenda**, no menu lateral (ou Ctrl/⌘ K > Agenda), mostra os eventos das
agendas abertas por **dia**, **semana** ou **mês**, no seu fuso. Os botões de
cada agenda, acima da lista, escondem ou mostram os eventos dela só na tela.

- **Novo evento** (ou Ctrl/⌘ K > Novo evento): título, agenda, dia inteiro ou
  horário, local e descrição.
- Toque num evento para ver os detalhes. Em agendas **Ler e editar**, aparecem
  **Editar** e **Apagar** (com confirmação). Em **Só ler**, só os detalhes.
- Se alguém mudou o evento no Google depois que a tela abriu, a Zuri não
  sobrescreve: avisa que o evento mudou e mostra a versão nova.
- Um evento que se repete muda só naquele dia.
- Convidados ficam no Google: a Zuri não convida nem avisa ninguém
  (`sendUpdates=none`).

O que muda no Google (pelo celular, pelo computador, por outra pessoa) aparece
na tela aberta sem recarregar: o Google avisa a Zuri, e a tela lê o período de
novo. Isso precisa do endereço público com HTTPS (`PUBLIC_URL`). Sem ele, ou
se o Google recusar o aviso, a tela lê de novo quando você volta para ela.

A tela mexe só nos eventos. Criar, renomear ou apagar agendas continua no
Google Agenda (decisão de 03/11/2026).

### Na conversa, no bot e nas rotinas

- "O que tenho amanhã?", "Marca dentista sexta às 15h", "Muda a reunião de
  quinta para as 10h": a Zuri usa as ferramentas da agenda nas agendas
  abertas. Apagar vira cartão de aprovação, também pelo bot e pela página
  `/aprovar`. Se o Google falhar na hora de apagar (fora do ar, limite de
  pedidos), o cartão fica como falha e nada é apagado; peça de novo na
  conversa.
- `/hoje` no Telegram ganha o bloco **Agenda** com os eventos do dia. Com o
  Google fora do ar, aparece "Agenda indisponível agora."
- Em **Automações > Nova automação > Rotina com IA**, os modelos **Briefing da
  manhã** (todo dia, 07:00) e **Fechamento do dia** (segunda a sexta, 19:00)
  preenchem o formulário. Rotinas só leem a agenda; nunca criam nem mudam.

### Desconectar

**Desconectar** apaga daqui a conta e as agendas, devolve o acesso ao Google e
para os avisos de mudança. Seus eventos continuam no Google Agenda.

Se o Google recusar o acesso (você tirou a permissão na conta Google, trocou a
senha ou o acesso venceu), o cartão mostra **Conectar de novo** e a central
avisa uma vez. Se o acesso voltar e cair de novo, o novo aviso só sai depois
de um dia do anterior.

## Para quem instala: o cliente OAuth do Google

A Zuri usa o seu próprio app do Google, gratuito. Faça uma vez:

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um
   projeto (por exemplo, "Zuri").
2. Em **APIs e serviços > Biblioteca**, ative a **Google Calendar API**.
3. Em **APIs e serviços > Tela de consentimento OAuth**: tipo **Externo**,
   nome do app "Zuri", o seu e-mail de suporte. Em **Escopos**, adicione
   `.../auth/calendar.events` e `.../auth/calendar.calendarlist.readonly`.
   Depois, em **Público-alvo**, **Publicar app** (status **Em produção**). Sem
   publicar, o Google derruba o acesso a cada 7 dias. Não é preciso pedir a
   verificação do Google: o app é só seu, e o aviso "app não verificado"
   aparece só para você.
4. Em **APIs e serviços > Credenciais > Criar credenciais > ID do cliente
   OAuth**: tipo **Aplicativo da Web**. Em **URIs de redirecionamento
   autorizados**, ponha `https://exemplo.com.br/configuracoes/integracoes`
   (troque pelo endereço da sua Zuri, o mesmo de `PUBLIC_URL`).
5. Grave o ID e a chave secreta como **Secrets** do Worker, em **Workers e
   Pages > zuri > Configurações > Variáveis e segredos**, ou pelo terminal
   dentro de `apps/agent`:
   - `npx wrangler secret put GOOGLE_CLIENT_ID`
   - `npx wrangler secret put GOOGLE_CLIENT_SECRET`
6. O `MCP_CREDENTIAL_KEY` também é preciso (é ele que cifra os tokens do
   Google); veja [configuracao-cloudflare.md](configuracao-cloudflare.md).

Nunca cole o ID, a chave secreta ou um token no chat, num issue ou no
repositório. Sem os três segredos, o cartão diz que o Google ainda não está
configurado e nada mais muda.

A etapa 19b (Google Contatos) vai pedir uma permissão a mais na mesma conexão:
o Google mostra a tela de novo só com o que falta.

## Como funciona

| Parte | Onde |
| --- | --- |
| OAuth (PKCE S256, `state` de uso único por 10 min, preso à sessão), tokens, agendas, eventos, canais de push | `apps/agent/src/google/service.ts` |
| Datas dos eventos, limpeza de texto | `apps/agent/src/google/events.ts` |
| Rotas `/api/google/*` e o aviso de push | `apps/agent/src/api/google.ts`, `apps/agent/src/gates/google-push.ts` |
| Ferramentas do agente | `apps/agent/src/tools/calendar.ts` |
| Google simulado (desenvolvimento, e2e e testes) | `apps/agent/src/google/dev-google.ts` |
| Tela Agenda e cartão em Integrações | `apps/web/src/pages/agenda/AgendaPage.tsx`, `apps/web/src/pages/settings/GoogleCard.tsx` |
| Banco (migration 22) | `zur_google_account`, `zur_google_calendars` |

- Os tokens ficam cifrados com AES-256-GCM, numa chave derivada do
  `MCP_CREDENTIAL_KEY` com um `info` próprio (`google-v1`). Nunca voltam para
  o navegador, para o log nem para o backup.
- Os eventos não ficam guardados aqui: cada leitura vai ao Google.
- Cada chamada ao Google vai para um endereço fixo, com 10 s de prazo, sem
  seguir redirecionamento e até 1 MB de resposta (uma resposta que não é
  JSON conta como falha). Um turno da conversa faz no máximo 8 chamadas (6
  pelo bot, 4 numa rotina); uma ação da tela, 12; o `/hoje`, 4. Com mais
  agendas abertas do que o teto cobre, a leitura começa pela principal e diz
  quais ficaram de fora, em vez de falhar.
- No modo de bloqueio (`/bloquear`), nenhuma chamada sai para o Google.
- Títulos, locais e descrições dos eventos entram no prompt como dado
  (`<data source="calendar">`), nunca como ordem: quem convida você escreve o
  título.
- O aviso de push chega em `/api/google/push` com um token que é o HMAC do
  `SESSION_SECRET` sobre o id do canal. Sem token certo, a resposta é a mesma
  (200 vazio) e nada acontece.

## Custo

Tudo grátis: a Google Calendar API não cobra, e nenhum recurso novo da
Cloudflare entra. Cada aviso de mudança custa uma requisição ao Worker.
