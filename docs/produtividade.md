# Tarefas, notas e projetos

Entregue na etapa 6. Tudo fica no SQLite do Durable Object do dono e funciona
sem IA. O chat ganha ferramentas sobre estes mesmos dados na etapa 9, com as
mesmas regras: os repositórios validam a entrada de novo, seja quem for que
chame.

## Rotas

Todas exigem sessão, o cabeçalho `x-zuri-request: 1` e a origem do
`PUBLIC_URL` (CSRF). Os corpos são JSON e os campos desconhecidos são
recusados. Os ids são UUIDs do servidor; qualquer outra coisa no caminho
responde `404 NOT_FOUND`.

| Método e rota | Corpo ou consulta | Resposta |
| --- | --- | --- |
| `GET /api/tasks` | `view` (`today`, `upcoming`, `overdue`, `completed`, `all`), `projectId` (ou `none`), `q`, `limit` (até 500) | `200 {tasks}` |
| `POST /api/tasks` | `{title, description?, status?, priority?, dueAt?, projectId?}` | `201 {task}` |
| `GET`, `PATCH`, `DELETE /api/tasks/:id` | `PATCH`: qualquer campo acima, pelo menos um | `200 {task}`; `DELETE`: `200 {trashItem}` |
| `GET /api/notes` | `q`, `projectId` (ou `none`), `limit` | `200 {notes}` com `excerpt` (200 caracteres), sem o texto inteiro |
| `POST /api/notes` | `{title, content?, projectId?}` | `201 {note}` |
| `GET`, `PATCH`, `DELETE /api/notes/:id` | `PATCH`: `{title?, content?, projectId?}` | `200 {note}`; `DELETE`: `200 {trashItem}` |
| `GET /api/projects` | — | `200 {projects}` (todos, até 1.000) |
| `POST /api/projects` | `{name, description?, status?}` | `201 {project}` |
| `PATCH`, `DELETE /api/projects/:id` | `PATCH`: `{name?, description?, status?}` | `200 {project}`; `DELETE`: `200 {trashItem}` |
| `GET /api/trash` | `kind` (`task`, `note`, `project`), `limit` | `200 {items, total}` |
| `POST /api/trash/:id/restore` | — | `200 {restored: {kind, itemId}}`; `404` se não está mais lá (já restaurado, apagado de vez ou vencido); `409` se a cópia não pode voltar |
| `DELETE /api/trash/:id` | — | `204` |
| `POST /api/trash/empty` | — | `200 {deleted}` |

Erros: `400 VALIDATION_FAILED` com `details.fields` (só os nomes dos campos,
nunca os valores), `404 NOT_FOUND` e `507 STORAGE_LIMIT_REACHED` com
`details.kind` e `details.limit`.

## Datas

O prazo (`dueAt`) chega como ISO 8601 com fuso explícito (`Z` ou `±HH:MM`) e é
guardado em UTC. O servidor confere cada campo por conta própria, porque
`Date.parse` empurraria 30/02 para março:

- o dia tem que existir no calendário (29/02 só em ano bissexto; 2100 não é);
- hora de 00 a 23, minuto e segundo de 00 a 59;
- fuso de −12:00 a +14:00;
- ano de 2000 a 2199.

A tela pede dia e, se quiser, hora, no fuso do dono (Configurações › Conta).
Sem hora, o prazo vale até 23:59 daquele dia. Um horário que não existe por
causa do horário de verão (como 00:30 em São Paulo em 04/11/2018) anda para a
frente; um horário repetido fica com a primeira passagem.

"Hoje" vai da meia-noite à meia-noite no fuso do dono. A visão Hoje mostra o
que vence até o fim do dia (as atrasadas também) e o que está em andamento sem
prazo; Próximas mostra o resto do que está aberto.

## Busca

- **Tarefas:** `instr(lower(coluna), ?)` no título e na descrição, então `%`,
  `_` e `\` são caracteres comuns. Maiúsculas e minúsculas só se igualam em
  letras sem acento (o `lower()` do SQLite só dobra A–Z). Não usamos `LIKE`
  porque o SQLite do Durable Object recusa um padrão de `LIKE` com mais de 50
  bytes, e a caixa de busca aceita 200 caracteres.
- **Notas:** índice FTS5 (`unicode61 remove_diacritics 2`), então "reuniao"
  acha "reunião". O texto vira palavras (só letras e números), cada uma entre
  aspas e como prefixo, e todas precisam aparecer. Aspas, `AND`, `OR`, `NOT`,
  `NEAR`, `*`, `^` e `coluna:` digitados nunca viram sintaxe do FTS5. Palavras
  muito comuns ("de", "com", "the") são ignoradas. Uma busca sem palavra
  nenhuma (só `%` ou `_`) procura o texto literal com `instr`, no título e no
  conteúdo.

## Custo das listas

O SQLite do Durable Object cobra cada linha lida, então as visões usam
índices que leem só o que aparece:

- **Hoje** e **Atrasadas** buscam no índice parcial `zur_tasks_open_due`
  (prazo das tarefas abertas). Hoje junta essa busca com a das tarefas em
  andamento sem prazo, por `OR` entre dois índices.
- **Concluídas** segue `zur_tasks_done_completed` (status e data de
  conclusão), então lê no máximo o limite da página, por mais tarefas
  concluídas que existam.
- **Próximas**, **Todas** e qualquer busca de tarefas ainda leem a tabela
  inteira: até 20.000 linhas por carga no pior caso. A busca de notas com
  palavras usa o FTS5; a busca só com símbolos lê todas as notas (até 5.000).

## Limites

| Tipo | Máximo |
| --- | --- |
| Tarefas | 20.000 |
| Notas | 5.000 (até 200.000 caracteres cada) |
| Projetos | 1.000 |
| Banco inteiro | 900 MB |

A conferência lê uma linha de `zur_counts` (mantida por gatilhos) em vez de
contar a tabela, porque o SQLite do Durable Object cobra cada linha lida.
Passar do limite recusa o novo registro; nada é apagado para abrir espaço.
Restaurar da lixeira também conta.

## Lixeira

- Apagar uma tarefa, nota ou projeto guarda uma cópia em `zur_trash` (na mesma
  transação) por 30 dias.
- Restaurar devolve a linha como estava, coluna por coluna (as colunas vêm de
  uma lista fixa no código, nunca das chaves da cópia). Um projeto que não
  existe mais deixa a tarefa ou a nota sem projeto.
- Apagar um projeto deixa as tarefas e notas dele sem projeto. Restaurar o
  projeto liga de novo as que continuam sem projeto; as que o dono pôs em outro
  projeto ficam onde estão. Uma tarefa ou nota apagada depois do projeto já
  estava sem projeto, então volta sem ele.
- Limpeza automática: o que passou de 30 dias some no próximo uso da lixeira e
  sempre que o Durable Object acorda. Passando de 10.000 itens ou 128 MB, os
  mais antigos saem primeiro.
- Apagar de vez e esvaziar ficam na atividade (`trash.purged`,
  `trash.emptied`, `trash.restored`) só com o tipo e o id, sem títulos.

A tela fica em Configurações › Dados. Depois de apagar, as telas de tarefas e
notas oferecem "Desfazer".

## Markdown das notas

A visualização usa `react-markdown` com `remark-gfm` e `skipHtml`: HTML
digitado não é renderizado, imagens nunca são carregadas (aparecem como
`[imagem: texto]`) e só links `http`, `https` e `mailto` ficam clicáveis,
abrindo em outra aba com `noopener noreferrer`. Nenhum
`dangerouslySetInnerHTML`.

## Telas

- **Tarefas** (`/tarefas`): adição rápida no topo. Na visão Hoje, uma tarefa
  sem data vence hoje às 23:59 no seu fuso, para aparecer onde foi digitada.
  Prazo, hora, projeto e prioridade ficam num painel que abre quando
  precisa; com ele fechado, o que foi escolhido aparece ao lado. Depois de
  adicionar, tudo volta ao padrão. Concluídas e Atrasadas não têm adição
  rápida, porque a tarefa nova não apareceria nelas.
- **Notas** (`/notas`): em telas largas a lista fica ao lado do editor; no
  celular, uma de cada vez. Sair de uma nota com alterações não salvas pela
  lista, por "Nova nota", pela lixeira ou por "Todas as notas" pede
  confirmação, e fechar a aba avisa. Limitação conhecida: os links da casca
  (menu lateral, barra de baixo, Sair) e o voltar do navegador ainda não
  perguntam, porque o app usa `BrowserRouter`, sem o `useBlocker` do React
  Router.

## Backup

Tarefas, notas e projetos entram no backup da etapa 23. A lixeira e os
contadores não entram.
