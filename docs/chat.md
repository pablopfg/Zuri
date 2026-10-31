# Conversa e ferramentas

Entregue na etapa 9. A tela **Conversa** (`/conversa` e `/conversa/:id`) é o
chat com o agente. A resposta chega aos poucos (SSE), o agente usa as
ferramentas da tabela abaixo e tudo o que apaga ou reescreve vira um cartão que
o dono aprova. Um plano de tarefas também só cria alguma coisa depois que o
dono confirma.

## Um turno, do começo ao fim

`apps/agent/src/agent/runner.ts` faz um turno inteiro:

1. Guarda a mensagem do dono (conversa nova se não houver `conversationId`; o
   título sai da primeira mensagem) e manda o evento `start`.
2. Monta o prompt de sistema (`agent/prompt.ts`): o nome do agente numa linha
   só, as regras fixas em inglês, a hora local do dono, as memórias relevantes
   e o resumo da conversa, os dois em linhas `<data>`.
3. Escolhe o histórico que cabe no orçamento (`agent/context.ts`). O orçamento
   é o menor entre o limite do dono e a janela do modelo menos a resposta, as
   ferramentas e uma folga de 1.024 tokens. O Llama 3.3 70B (24.000 tokens) é
   o mais apertado. Respostas que falharam ou foram paradas ficam fora.
4. Quando 8 mensagens ou mais já não cabem, pede ao modelo um resumo curto
   (uma chamada a mais, contada no limite diário) e guarda até onde ele vai.
5. Chama o modelo pelo medidor (`MeteredAI`, regra P7), com as ferramentas do
   turno. Cada passo é contado antes de acontecer. O prazo do turno é de
   120 s e o botão **Parar** encerra a chamada.
6. Guarda a resposta uma vez só, do jeito que o turno terminou: completa,
   parada (`cancelled`, e os planos do turno são retirados) ou com erro (o
   código e o texto no idioma do dono).

Eventos do stream, em ordem: `start`, `text`, `tool`, `approval`, `plan`,
`error` e `done`. A cada 5 s sai também uma linha de comentário (`: ping`): se
a aba fechou, a escrita falha e o modelo para, mesmo num passo sem texto. Um erro antes do turno (conversa cheia, por exemplo) chega
como `error`. Uma recusa antes do stream (409 ocupado, 400, 401) vem como
resposta JSON comum.

Os limites do turno ficam em **Configurações > IA**:

| Limite | Padrão | Faixa |
| --- | --- | --- |
| Ações (chamadas de ferramenta) por resposta | 6 | 1 a 20 |
| Passos (chamadas ao modelo) por resposta | 4 | 1 a 10 (com 1, nenhuma ferramenta é oferecida) |
| Memória da conversa (tokens de contexto) | 6.000 | 2.000 a 32.000 |
| Tamanho da resposta (tokens) | 1.024 | 256 a 4.096 |

Há no máximo uma resposta por conversa e duas ao mesmo tempo (várias abas).
Fora disso a API responde `409 CONFLICT`.

## Ferramentas

Ficam em `apps/agent/src/tools/`. Cada uma tem schema Zod estrito (campo
desconhecido é recusado), permissão e limite por turno.

| Ferramenta | Permissão | Por turno | O que faz |
| --- | --- | --- | --- |
| `create_task` | write | 5 | Cria uma tarefa (data local, projeto por nome) |
| `list_tasks` | read | 3 | Hoje, próximas, atrasadas, abertas ou concluídas |
| `update_task` | write | 5 | Título, status (a fazer ou em andamento), prioridade, prazo, projeto; descrição só se estiver vazia |
| `complete_task` | write | 3 | Conclui uma tarefa |
| `delete_task` | destructive | 3 | Proposta: tarefa para a lixeira |
| `replace_task_description` | destructive | 2 | Proposta: troca ou limpa a descrição |
| `create_project` | write | 2 | Cria um projeto (o mesmo nome reaproveita o existente) |
| `list_projects` | read | 2 | Lista os projetos |
| `create_note` | write | 3 | Cria uma nota |
| `read_note` | read | 3 | Lê uma nota (até 6.000 caracteres) |
| `update_note` | write | 3 | Só renomeia ou acrescenta texto no fim (nota até 50.000 caracteres) |
| `replace_note_content` | destructive | 2 | Proposta: troca o texto inteiro |
| `delete_note` | destructive | 2 | Proposta: nota para a lixeira |
| `search_notes` | read | 3 | Busca nas notas |
| `remember` | write | 3 | Guarda uma memória (duplicata vira "já sabia") |
| `search_memories` | read | 3 | Busca nas memórias |
| `update_memory` | write | 3 | Nova versão; a antiga vira fato passado |
| `forget_memory` | destructive | 3 | Proposta: apaga a memória de vez |
| `search` | read | 2 | Tarefas, notas, memórias e títulos de conversa de uma vez |
| `propose_task_plan` | write | 1 | Guarda um rascunho de plano; nada é criado |

O executor (`tools/registry.ts`) também:

- recusa o nome de uma ferramenta que não existe e a chamada exata repetida no
  mesmo turno (laço);
- recusa propor apagar ou reescrever um item que o agente mudou no mesmo turno;
- devolve ao modelo toda saída numa linha `<data source="tool">`, cortada em
  8.000 caracteres;
- descreve as falhas em inglês, só para o modelo, sem detalhe interno;
- oferece só as ferramentas `read` numa execução agendada (etapa 10).

## Aprovações

Uma ferramenta destrutiva nunca roda no turno. Ela grava uma proposta em
`zur_pending_actions` com o alvo resolvido (o título como está guardado, nunca
o texto do modelo) e o hash SHA-256 de um retrato do alvo. O cartão mostra o
que vai acontecer e, numa reescrita, o texto novo inteiro.

- **Aprovar** (`POST /api/actions/:id/approve`) reivindica a proposta num único
  `UPDATE … RETURNING`, então ela roda no máximo uma vez, mesmo com cliques ao
  mesmo tempo. Se o alvo mudou ou sumiu, nada acontece e a resposta é
  `409 TARGET_CHANGED`. O retrato é conferido de novo dentro da transação.
- **Recusar** (`POST /api/actions/:id/cancel`) fecha a proposta.
- A proposta vale 30 minutos; depois disso a resposta é `410 APPROVAL_EXPIRED`.

## Planos de tarefas

`propose_task_plan` guarda um rascunho em `zur_task_plan_drafts` (2 a 15
tarefas, as repetidas ficam fora) que vale 24 horas. No cartão, o dono edita
títulos, prioridades e prazos, tira tarefas e confirma. Acrescentar tarefas não
é possível: o servidor recusa as que o agente não propôs. A confirmação
(`POST /api/plans/:id/confirm`) valida o plano de novo, confere a revisão,
reivindica o rascunho e cria o projeto e as tarefas numa transação. Repetir a
confirmação devolve o mesmo resultado (`replayed: true`) sem criar nada.

## Voz

O microfone do compositor grava um áudio (no máximo 60 s, para sozinho no
limite) e manda para `POST /api/transcribe`. O texto volta para o compositor e
o dono lê antes de enviar. O áudio não é guardado. Limites: 2 MB por áudio, um
de cada vez e uma hora por dia. Cada áudio conta o maior entre o tempo medido
pelo navegador e o que o tamanho indica, e é contado antes da chamada. A
política `Permissions-Policy` libera o microfone só para a própria Zuri
(`microphone=(self)`).

## Modelo de dados (migration 8)

| Tabela | Guarda |
| --- | --- |
| `zur_conversations` | Título, resumo e até onde o resumo vai |
| `zur_messages` | Papel, texto, atividade das ferramentas, status, erro e origem (`app`, `telegram`, `import`) |
| `zur_pending_actions` | Propostas destrutivas, com alvo, hash e prazo |
| `zur_task_plan_drafts` | Rascunhos de plano, revisão e resultado |

Os contadores `conversations` (até 5.000) e `messages` (até 200.000) ficam em
`zur_counts`, mantidos por gatilhos. Apagar uma conversa apaga as mensagens,
propostas e planos dela; as tarefas, notas e memórias criadas continuam.
Propostas e planos são limpos 30 dias depois de criados. Apagar uma conversa
no meio de uma resposta para o turno e não deixa nenhuma linha para trás.
`zur_messages.seq` (a rowid como `INTEGER PRIMARY KEY`) dá a ordem das
mensagens e não muda nem num `VACUUM`.

## API

| Rota | O que faz |
| --- | --- |
| `GET /api/conversations?before=` | Conversas, 50 por página |
| `GET /api/conversations/:id?before=` | 100 mensagens por página, as propostas e os planos |
| `PATCH /api/conversations/:id` | Renomeia (até 120 caracteres) |
| `DELETE /api/conversations/:id` | Apaga a conversa (para a resposta em andamento) |
| `POST /api/chat` | Um turno, em SSE |
| `POST /api/chat/cancel` | Para a resposta de uma conversa |
| `POST /api/actions/:id/approve` e `/cancel` | Aprova ou recusa uma proposta |
| `POST /api/plans/:id/confirm` e `/cancel` | Confirma (com as edições) ou descarta um plano |
| `POST /api/transcribe` | Áudio para texto |

Todas pedem sessão, o cabeçalho CSRF e a origem do dono. O agente não alcança
essas rotas: só o navegador do dono.

## Testes

- `apps/agent/test/chat-tools.test.ts`: cada ferramenta, limites (n e n+1),
  laço, aprovações (concorrência, alvo mudado, sumido, expirado) e planos.
- `apps/agent/test/chat-runner.test.ts`: o prompt e os cenários de injeção de
  prompt de [segurança](seguranca.md#ferramentas-do-agente-e-injeção-de-prompt),
  com um modelo roteirizado que obedece ao texto injetado.
- `apps/agent/test/chat-routes.test.ts` e `ai-transcription.test.ts`: as rotas
  e a voz. `free-tier-budget.test.ts` mede as linhas lidas por rota.
- `tests/e2e/chat.spec.ts` e `chat-voice.spec.ts`: a tela no navegador, com o
  modelo simulado (`call <ferramenta> {json}` chama uma ferramenta de verdade, e
  uma mensagem que começa com `slow ` volta uma palavra a cada 200 ms, para
  testar o botão Parar).
