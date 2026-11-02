# Fluxos do n8n dentro da Zuri: viabilidade para a etapa 22

Situação: estudo para a etapa 22. Nada aqui foi implementado.
Atualizado em 02/11/2026, depois das respostas do Pablo: os fluxos a trazer são
os do CRM que hoje rodam no n8n, no escopo "CRM interno, atendimento no n8n".
O volume (contatos ativos e mensagens por dia) ainda não foi informado; os
tetos abaixo são o padrão até lá.

## Resposta curta

Dá para trazer boa parte dos fluxos do n8n sem sair do plano gratuito, desde que
a Zuri não tente ser um n8n completo. Cabe um motor de **fluxos declarativos**:
um gatilho, até 20 passos de um catálogo fechado de nós, tudo configurado na
tela, rodando dentro do Durable Object que já roda as automações. Não cabem o nó
de código livre, chamadas HTTP para qualquer endereço, laços sobre milhares de
itens numa execução nem gatilhos de minuto em minuto.

Os limites que realmente apertam são três, nesta ordem:

1. **Neurons do Workers AI** (9.000 por dia, já com 65% gastos num dia cheio).
   Todo nó de IA divide essa cota com o chat.
2. **50 subrequisições por invocação.** Uma execução de fluxo faz no máximo 40
   chamadas para fora, somando todos os passos.
3. **100.000 linhas escritas por dia no SQLite.** Cada execução e cada passo
   registrado escrevem; um fluxo de 15 em 15 minutos com 10 passos gasta umas
   10.000 por dia se registrar tudo.

Requisições (100.000 por dia), CPU do Durable Object (30 s por requisição) e
tempo do alarme (15 min) sobram com folga para o volume de um dono só.

## O que a etapa 22 é hoje

A especificação descreve um **monitor de sites**: até 10 endereços https
cadastrados só na tela, com senha recente; o fetch protegido da etapa 18 (sem
redirecionamento, 10 s, 64 KB lidos, nada do corpo vai ao modelo); intervalo
mínimo de 15 min; cada endereço é um passo durável do Cloudflare Workflows com 3
tentativas; o resultado volta ao agente, que guarda o estado e avisa; `/status`
no bot mostra os monitores.

A proposta deste documento transforma o monitor no **primeiro modelo de fluxo**
do motor, sem perder nenhuma dessas travas.

## Limites conferidos (02/11/2026)

Fontes: [Workers: limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workflows: limits](https://developers.cloudflare.com/workflows/reference/limits/) e
`docs/arquitetura/orcamento-free-tier.md`.

| Recurso | Free | O que significa para fluxos |
| --- | --- | --- |
| Requisições ao Worker e ao DO | 100.000 por dia cada | Folga grande; o dia cheio usa ~1.300 |
| Linhas escritas no SQLite | 100.000 por dia | O limite que mais pesa no registro de execuções |
| Linhas lidas no SQLite | 5 milhões por dia | Folga |
| CPU do Durable Object | 30 s por requisição | Folga para transformar dados |
| Duração do alarme do DO | 15 min | Uma execução precisa terminar dentro dele |
| Subrequisições | 50 por invocação, 6 conexões ao mesmo tempo | Teto de 40 chamadas externas por execução |
| Cron Triggers | 5 por conta | Não usar cron por fluxo; tudo pelo alarme único (P8) |
| Workers AI | 10.000 Neurons por dia (teto da Zuri: 9.000) | Nó de IA divide a cota com o chat |
| Workflows: CPU por passo | 10 ms | Passo só faz I/O; nada de transformar JSON grande |
| Workflows: passos por instância | 1.024 | Folga |
| Workflows: subrequisições | 50 por instância | O mesmo teto de 40 chamadas |
| Workflows: estado guardado | 100 MB por instância, 3 dias de retenção | Credenciais nunca podem ir nos parâmetros |
| Workflows: instâncias simultâneas | 100 por conta | Folga |

## Que tipo de nó cabe

| Nó ou gatilho do n8n | Na Zuri | Observação |
| --- | --- | --- |
| Schedule / Cron | ✅ Cabe | Pelo alarme único das automações; intervalo mínimo de 15 min (o de rotinas com IA continua 1 h) |
| Webhook de entrada | ✅ Cabe, com trava | Pela rota de eventos da etapa 20 (token `zur_pat_`, 60 por hora, 100 por dia). Serviço que não manda cabeçalho próprio pede uma rota com assinatura HMAC; ver "Decisões pendentes" |
| Mensagem no Telegram | ✅ Cabe | Depois da etapa 12; o texto recebido é dado |
| E-mail recebido (IMAP/Gmail trigger) | ⚠️ Não agora | IMAP não roda no Worker. Gmail por API exige OAuth com escopo sensível e consulta periódica |
| Google Agenda | ✅ Cabe | Depois da etapa 19, pelas ferramentas dela |
| Google Contatos | ✅ Cabe | Depende do estudo de sincronização por tags (outra thread); os contatos ficam no SQLite do DO |
| IF / Switch / Filter | ✅ Cabe | Condições declarativas (igual, contém, maior que, existe, data antes/depois), sem expressão livre |
| Set / Edit Fields / Date & Time | ✅ Cabe | Mapear campos com caminhos fixos e funções de uma lista fechada |
| Merge, Aggregate, Split Out | ✅ Cabe com teto | Até 200 itens por execução |
| Loop / Split in Batches | ✅ Cabe com teto | O teto de 40 chamadas externas vale para o laço inteiro; acima disso, o fluxo continua na próxima execução (cursor guardado) |
| Wait | ✅ Cabe | Pelo agendamento do DO, sem objeto acordado (P5); até 30 dias |
| HTTP Request para serviço cadastrado | ✅ Cabe, com trava | Só para **conexões** cadastradas na tela com senha recente: origem fixa, método e caminho permitidos, fetch protegido da etapa 18, credencial cifrada que nunca vai ao modelo |
| HTTP Request para qualquer URL | ❌ Não | Regra inviolável 3 e risco de SSRF |
| Code (JavaScript/Python) | ❌ Não | Regra inviolável 3 (sem execução de código) |
| Execute Command, SSH, FTP | ❌ Não | Regra inviolável 3 |
| Nó de IA (resumo, classificação, extração) | ✅ Cabe, contado | `agent.ai()` com estimativa de Neurons antes (P7), teto diário próprio para fluxos dentro dos 9.000; entrada sempre em bloco `<data>` |
| AI Agent com ferramentas | ✅ Só leitura | Igual às rotinas de IA da etapa 10: ferramentas `read` e `notify_owner`; nada de escrita |
| Notificar o dono (Telegram, push, e-mail, central de avisos) | ✅ Cabe | Pelos canais da etapa 11; e-mail continua com 10 por dia |
| Enviar mensagem a terceiros (WhatsApp/fzap, Chatwoot, e-mail para outra pessoa) | ⚠️ Cabe só como proposta | Mensagem para fora é ação que não se desfaz: vira proposta aprovada pelo dono, a não ser que o Pablo decida o contrário para um fluxo específico |
| Banco externo (Supabase/Postgres) | ✅ Pela API REST | Como conexão cadastrada. Hyperdrive foi descartado (PR #38) |
| Guardar dados entre execuções (como uma tabela no Supabase) | ✅ Cabe com teto | Coleções no SQLite do DO, até 10.000 registros e 50 MB no total (P13) |
| Planilhas Google, Drive, Gmail enviar | ⚠️ Avaliar caso a caso | OAuth do Google já vem na etapa 19; cada escopo novo pede revisão de segurança |
| Gatilho de minuto em minuto | ❌ Não | Gasta escritas e requisições sem necessidade; mínimo de 15 min |

Nada da tabela exige recurso pago. Os itens ⚠️ são decisões de produto ou de
segurança, não de custo.

## Arquitetura proposta

### Onde o fluxo roda

**Recomendação: o motor fica no Durable Object da Zuri**, como extensão das
automações da etapa 10, e não no Cloudflare Workflows.

- O alarme único (P8) já acorda o objeto na hora certa; um fluxo vencido roda
  ali, com 30 s de CPU e até 15 min de duração por despertar.
- O estado de cada execução fica no SQLite, junto das credenciais cifradas. No
  Cloudflare Workflows, tudo o que um passo devolve fica guardado pela
  Cloudflare por 3 dias, fora do banco do dono, e os passos têm só 10 ms de CPU.
- O código fica portátil para a VPS (`docs/planos/portabilidade-vps.md`): o
  motor é TypeScript comum, e só o despertar depende da Cloudflare.
- Nova tentativa durável sai do próprio agendamento: o passo que falha grava o
  ponto onde parou e marca um novo despertar (1 min, 5 min, 15 min), até 3
  tentativas.

O binding `WORKFLOW` da especificação fica como opção. Se na etapa 22 a medida
mostrar que um fluxo precisa de mais de 15 min seguidos, aquele fluxo passa a
usar o Cloudflare Workflows, com a regra de que o passo recebe só ids e nunca
dado do dono nem credencial.

### Peças

- **Definição do fluxo**: JSON validado por Zod em `packages/shared`
  (`flowSchema`), com versão do formato. Um gatilho, até 20 nós, cada nó de um
  tipo do catálogo, ligações sem ciclo (laço só pelo nó Loop, com teto).
- **Catálogo de nós**: um módulo por tipo em `apps/agent/src/flows/nodes/`,
  cada um com schema de configuração, custo estimado (chamadas, Neurons,
  escritas) e a função que roda. Nó novo é PR com teste, como ferramenta nova.
- **Conexões**: serviço externo cadastrado na tela (nome, origem https, métodos
  e caminhos permitidos, tipo de credencial). Credencial cifrada com AES-GCM
  como as do MCP, nunca devolvida, logada, exportada ou enviada ao modelo.
  Cadastrar ou mudar pede senha recente; trocar a origem apaga a credencial.
- **Executor**: percorre os nós, conta subrequisições (para em 40), Neurons
  (pelo `MeteredAI`) e tempo (10 min por execução), grava o ponto de retomada.
- **Registro**: uma linha por execução com o resumo; o detalhe por nó só fica
  guardado quando falha ou quando o dono liga "registrar tudo" para depurar,
  por 24 h. Histórico de 2.000 execuções, como as automações.
- **Tela Fluxos**: lista, editor por formulário (passo a passo, sem tela de
  arrastar nós nesta etapa), execução manual, histórico e erros na aba
  Diagnóstico. A tela é carregada sob demanda (P11).

### Travas de segurança

- Fluxos e conexões só mudam pela tela, com senha recente. Nenhuma ferramenta
  do agente, comando do bot ou token remoto cria, liga ou muda um fluxo (teste
  por caminho, como o monitor já pedia). O chat pode **propor** um fluxo, que
  nasce desligado.
- Tudo o que entra (webhook, resposta de API, Telegram, contato) é dado: vai
  ao modelo só em bloco `<data>` neutralizado e nunca muda a definição do fluxo.
- Fetch protegido da etapa 18 em toda chamada: só host público, DNS conferido,
  sem redirecionamento, 10 s, até 256 KB lidos.
- Ação que sai para terceiros ou apaga dado vira proposta aprovada, salvo
  decisão contrária do Pablo por fluxo.
- O modo de bloqueio (`/bloquear`) já pausa os workflows pela especificação;
  vale para todos os fluxos, e o teto diário de execuções e Neurons para tudo
  o que sobrar.

## Orçamento por fluxo

Conta para um fluxo típico de 6 nós, 3 chamadas externas e 1 nó de IA curto
(1.500 tokens de entrada, 200 de saída):

| Frequência | Execuções/dia | Requisições ao DO | Escritas | Neurons |
| --- | --- | --- | --- | --- |
| 1 vez por dia | 1 | ~2 | ~20 | ~16 |
| De hora em hora | 24 | ~50 | ~480 | ~380 |
| A cada 15 min | 96 | ~200 | ~1.900 | ~1.500 |

As escritas contam a execução, o ponto de retomada e o alarme (~20 por
execução, como as automações medidas no teste de orçamento). Nó de IA de 15 em
15 minutos come um sexto da cota diária de Neurons sozinho; por isso o teto
abaixo.

Limites propostos para a etapa:

| Limite | Valor |
| --- | --- |
| Fluxos ativos | 20 |
| Nós por fluxo | 20 |
| Intervalo mínimo | 15 min (1 h se o fluxo tem nó de IA) |
| Chamadas externas por execução | 40 |
| Itens por execução | 200 |
| Execuções por dia, somando todos | 500 |
| Neurons por dia para fluxos | 3.000, dentro do teto de 9.000 |
| Duração de uma execução | 10 min |
| Dados guardados pelos fluxos | 10.000 registros, 50 MB |
| Webhooks recebidos | os da etapa 20: 60 por hora, 100 por dia |

No pior caso (500 execuções de 20 escritas e 3.000 Neurons), os fluxos somam
10.000 escritas (10% da cota) e um terço dos Neurons. Com o pior caso do resto
do sistema (48.000 escritas), sobra margem.

## Fluxos do Pablo: o CRM

Resposta do Pablo (02/11/2026): a ideia é trazer para a Zuri os fluxos do n8n
usados como CRM. Escopo escolhido pelo Pablo: **CRM interno, atendimento no
n8n**. A Zuri guarda contatos, funil, follow-ups e avisa o dono; o atendimento
aos clientes por IA e o envio de mensagens continuam no n8n, que manda eventos
para a Zuri.

| Parte do CRM | Viabilidade | Como |
| --- | --- | --- |
| Contatos com tags, etapa do funil e histórico | ✅ Cabe | Tabela própria no SQLite do DO, com teto (P13) e busca por FTS5 (P3) |
| Importar e sincronizar do Google Contatos por tag | ✅ Cabe | Depende do estudo de sincronização (outra thread) e da etapa 19 |
| Follow-up, lembrete de retorno, aniversário | ✅ Cabe | Gatilho por agenda no alarme único; aviso ao dono |
| Cruzar com consultas da agenda | ✅ Cabe | Depois da etapa 19 |
| Receber eventos do n8n/Chatwoot (nova conversa, mudança de etiqueta) | ✅ Cabe com rota própria | A rota da etapa 20 aceita 100 eventos por dia; o CRM pede uma rota com assinatura HMAC e limite próprio (sugestão: 1.000 por dia, cada evento ~10 escritas = 10.000 escritas) |
| Resumo do dia e do funil pela Zuri | ✅ Cabe, contado | Uma rotina de IA por dia, dentro do teto de Neurons |
| Enviar mensagem a cliente (WhatsApp/Chatwoot) | Fora do escopo | Continua no n8n (decisão do Pablo). Se um dia entrar, vira proposta aprovada pelo dono |
| Atendimento por IA aos clientes (o agente que conversa com eles no n8n) | Fora do escopo | Continua no n8n. Tornaria a Zuri um bot público, e os 9.000 Neurons do dia não aguentam (precisaria da etapa 21 ⚠) |

Dados de clientes podem incluir dados sensíveis na LGPD (saúde, por exemplo).
Cabem no banco da Zuri, com estas travas: nada de dado de contato em log
(o lint de logs já barra e-mail e texto do dono; ganha telefone e nome de
contato), ao modelo só os campos que o pedido precisa e em `<data>`, backup só
cifrado (etapa 23), e apagar um contato apaga o histórico dele.

Falta do Pablo: quantos contatos ativos e quantas mensagens por dia passam pelo
CRM hoje, para fechar os tetos acima.

## Decisões pendentes para o Pablo

1. **Volume do CRM**: contatos ativos e mensagens por dia, para fechar os tetos.
2. **Webhook de serviços que não mandam cabeçalho.** Recomendação: rota própria
   com assinatura HMAC quando o serviço assina (Chatwoot, Telegram, Google);
   segredo na URL só se não houver outra saída, e nesse caso a URL nunca vai
   para log.

## Impacto no bloco da etapa 22

- A etapa passa a se chamar "Workflows (fluxos, CRM e monitor de sites)" e se
  divide em três PRs:
  - **22a**: motor de fluxos no Durable Object, catálogo básico de nós
    (agenda, condição, campos, laço com teto, espera, aviso ao dono, IA contada),
    conexões cadastradas na tela e o monitor de sites como primeiro modelo.
  - **22b**: CRM interno: contatos com tags, funil e histórico, follow-ups e
    aniversários, rota de eventos do n8n com assinatura HMAC e limite próprio,
    resumo do funil.
  - **22c**: nós que dependem de outras etapas (Google Agenda da 19 e
    sincronização do Google Contatos por tags).
- Depende da etapa 18 (fetch protegido e cifra de credenciais), da 20 (tokens e
  eventos de entrada) e da 11 (canais de aviso). A 22c depende também da 19 e
  da sincronização de contatos.
- O contrato da especificação ganha as tabelas `flows`, `flow_connections`,
  `flow_runs`, `flow_data`, `crm_contacts` e `crm_events` (migration de
  acréscimo) quando a etapa começar; o `workflow_runs` previsto vira
  `flow_runs`. A etapa atualiza a especificação no próprio PR.
