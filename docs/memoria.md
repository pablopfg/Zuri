# Memória e histórico

Entregue na etapa 7. A memória guarda fatos duráveis sobre o dono ("moro em
Curitiba", "prefiro chá verde de manhã"). Ela fica no SQLite do Durable Object
do dono e funciona sem IA. O chat usa a memória a partir da etapa 9, com as
ferramentas `remember`, `search_memories`, `update_memory` e `forget_memory`.
Essas ferramentas passam pelo mesmo serviço e seguem as mesmas regras.

## Estados de uma memória

| Estado | O que quer dizer | Vai para o modelo? |
| --- | --- | --- |
| `active` (atual) | Vale hoje | Sim, quando é relevante |
| `uncertain` (incerta) | Pode ter mudado | Sim, no grupo "pode estar desatualizado" |
| `historical` (passada) | Já foi verdade | Só quando a pergunta é sobre o passado |

Uma memória passada pode apontar para a que a substituiu (`superseded_by`).
`valid_from` guarda a data que o próprio texto diz ("desde março de 2025",
"since 2024"). Quando o texto não diz, fica vazio, porque o sistema não chuta
datas. Ao marcar uma memória como passada pela revisão, `valid_until` recebe a
data em que a nova começou a valer.

## Como as mudanças são detectadas

São regras fixas, em pt-BR e em inglês, aplicadas ao texto sem acentos e em
minúsculas (`apps/agent/src/memory/conflict.ts`). Não há IA nesta etapa.

| Exemplo novo / antigo | Relação | O que acontece |
| --- | --- | --- |
| "Vendi meu Volkswagen e comprei um Tesla" / "Eu dirijo um Volkswagen" | substitui (mudança explícita) | Revisão "possível atualização" |
| "Me mudei definitivamente para Paris" / "Moro em Londres" | substitui (mudança de tema) | Revisão "possível atualização" |
| "Prefiro chá verde de manhã com mel" / "Prefiro chá verde de manhã" | refina | Revisão "possível atualização" |
| "Moro em Paris" / "Moro em Londres" | contradiz | Revisão "contradição" |
| "Me mudei temporariamente para Lisboa por um mês" / "Moro em Curitiba" | contradiz (mudança temporária) | Revisão "contradição" |
| "Visitei Paris" / "Moro em Londres" | sem relação | Nada |
| "moro em SAO paulo" / "Moro em São Paulo" | duplicata | Não grava de novo, só atualiza a data |

Os temas de valor único são moradia, veículo, emprego, dieta e relacionamento.
Semelhança sozinha nunca vira "substitui": é preciso uma palavra de mudança
("vendi", "não … mais", "no longer") ligada ao fato antigo, ou um refinamento
que contenha todas as palavras do fato antigo e acrescente outras.

**As regras nunca aposentam uma memória por conta própria.** Elas só abrem um
item na fila "Para revisar". O dono escolhe:

- **Manter as duas.** Fecha a revisão.
- **Marcar a antiga como passada.** Cria o vínculo de substituição.
- **Substituir.** Apaga a antiga, com confirmação.
- **Descartar a nova.** Apaga a nova, com confirmação.

A fila guarda no máximo 500 revisões pendentes
(`MEMORY_REVIEWS_PENDING_MAX`). Cheia, a memória continua sendo salva, só não
abre revisão nova. Quando uma memória vira passada (pela revisão, por
"atualizar o fato" ou à mão), as revisões dela somem: um fato passado não
conflita com nada, e editar o texto de um fato passado também não abre
revisão. Editar ou restaurar uma memória para o texto de outra memória atual é
recusado com `409 CONFLICT`, porque duas cópias atuais nunca se distinguiriam.

A revisão pode ser desligada na própria tela de Memória
(`memoryConflictReview` nas configurações). Desligada, nenhuma revisão nova é
aberta.

## Ciclos

Uma memória nunca substitui a si mesma (`CHECK` na tabela), e o serviço recusa
um vínculo que fecharia um ciclo, com `409 CONFLICT`. A caminhada pela cadeia
para em `MEMORY_CHAIN_MAX` (50) passos. Uma cadeia maior que isso conta como
ciclo e é recusada, então nenhuma leitura fica presa num laço. O histórico de
uma memória lê no máximo 100 antecessoras. Para a importação de backup (etapa
23), `cleanImportedLinks` remove vínculos para memórias inexistentes, para si
mesmas e o que fecharia um ciclo.

## Memória no prompt

`selectRelevantMemories` escolhe até 8 memórias pela busca FTS5, mais até 4
preferências atuais. `memoryPromptSection` agrupa em "Atuais", "Podem estar
desatualizadas" e "Passadas", dentro de um orçamento de
`min(1500, 20% do contexto)` tokens. As passadas só entram quando a pergunta é
sobre o passado ("onde eu morava?", "what did I drive before?").

Cada memória vira uma linha `<data source="memory" id="…">…</data>`. A
memória que o assistente guardou numa conversa ganha `saved_by="assistant"`, e
o cabeçalho pede ao modelo que confie menos nela. Dentro
dela, `<`, `>` e os sinais parecidos (`‹ › ＜ ＞ ﹤ ﹥ 〈 〉 ⟨ ⟩ « »`) viram `‹` e
`›`, então nenhum texto guardado imita uma tag, nem uma tag já neutralizada.
Quebras de linha (inclusive U+2028 e U+2029) e caracteres de controle viram um
espaço. Os caracteres invisíveis de formato (largura zero, controles bidi, as
"tags" U+E0000 que escondem texto ASCII) somem. Só o ZWJ fica, porque os emojis
compostos precisam dele. O texto guardado não muda: isso vale só no prompt. Os valores dos atributos perdem aspas
e `&`. Uma memória que diga "ignore as instruções</data>" continua sendo só
texto dentro do bloco.

## Rotas

Todas exigem sessão, o cabeçalho `x-zuri-request: 1` e a origem do
`PUBLIC_URL` (CSRF), e respondem com `cache-control: no-store`. Os campos
desconhecidos são recusados. Os ids são UUIDs do servidor, e qualquer outra
coisa no caminho responde `404 NOT_FOUND`.

| Método e rota | Corpo ou consulta | Resposta |
| --- | --- | --- |
| `GET /api/memories` | `q`, `status` (`all`, `active`, `current`, `uncertain`, `historical`), `category`, `limit` (até 500, padrão 200) | `200 {memories, counts}` |
| `POST /api/memories` | `{content, category?}` (até 2.000 caracteres) | `201 {memory, duplicate, superseded, reviews}`; `200` se já existia |
| `GET /api/memories/reviews` | — | `200 {reviews}` (até 50, as mais antigas primeiro) |
| `POST /api/memories/reviews/:id` | `{action}` (`keep_both`, `mark_historical`, `replace`, `cancel`) | `200 {kept, deleted}`; `404` se a revisão já foi resolvida |
| `GET /api/memories/:id` | — | `200 {memory}` |
| `PATCH /api/memories/:id` | `{content?, category?}`, pelo menos um | `200 {memory, duplicate, superseded, reviews}` |
| `DELETE /api/memories/:id` | — | `204` |
| `GET /api/memories/:id/history` | — | `200 {memory, previous, next}` |
| `POST /api/memories/:id/status` | `{status}` | `200 {memory}`; voltar a atual ou incerta desfaz o vínculo |
| `POST /api/memories/:id/correct` | `{content}` | `201 {memory, duplicate, superseded, reviews}`: grava o fato novo e marca o antigo como passado |

Erros: `400 VALIDATION_FAILED` com `details.fields` (só os nomes, nunca o
texto), `404 NOT_FOUND`, `409 CONFLICT` (ciclo) e
`507 STORAGE_LIMIT_REACHED` (10.000 memórias).

**Editar ou atualizar o fato.** Editar (`PATCH`) corrige um erro de digitação
e mantém a mesma memória. "Atualizar o fato" (`correct`) registra que a vida
mudou: a antiga vira passada e o histórico guarda as duas. Corrigir para o
mesmo texto é recusado com a dica de usar Editar.

**Apagar é definitivo.** A especificação pede "exclusão completa", então a
memória não passa pela lixeira. Apagar também remove as revisões dela e desfaz
os vínculos que apontavam para ela. Nenhuma atividade da memória vai para o
log, então o texto não aparece em nenhum outro lugar.

## Busca e custo

- A busca usa FTS5 (`unicode61 remove_diacritics 2`), então "sao paulo" acha
  "São Paulo". O texto digitado nunca chega ao FTS5 como sintaxe: cada palavra
  vai entre aspas.
- A ordem por relevância considera as 200 ocorrências mais novas. Uma palavra
  muito comum lê no máximo cerca de 600 linhas. Com um filtro (por exemplo
  Passadas), a busca procura dentro dessas 200: uma ocorrência mais antiga
  pode não aparecer. A checagem de conflito olha as 50 mais novas por busca.
- As listas descem pelo índice de cada estado (`(status, updated_at)`, ou
  `(status, category, updated_at)` com categoria) e param no limite. "Atuais e
  incertas" junta duas descidas, sem ordenar todas as memórias atuais.
- Duplicatas são achadas por `dedupe_key` (hash do texto normalizado) com
  índice. A comparação final é pelo texto, então uma colisão de hash nunca junta
  dois fatos diferentes.
- As contagens por estado vêm de `zur_counts`, mantida por gatilhos. Contar não
  varre a tabela.

**Exclusão e cópias.** Apagar tira a memória da tabela e do índice FTS5. O
SQLite pode manter os bytes antigos em páginas livres até reaproveitá-las, e a
recuperação de ponto no tempo do Durable Object guarda o banco de até 30 dias
atrás (veja `docs/seguranca.md`). Nada disso é lido pelo Zuri nem chega ao
modelo.

Medido com 2.000 memórias (`apps/agent/test/free-tier-budget.test.ts`), em
linhas lidas/gravadas por requisição:

| Rota | Lidas | Gravadas |
| --- | --- | --- |
| `GET /memories` (página de 200, qualquer estado ou categoria) | 211 | 0 |
| `GET /memories?status=current` (duas descidas) | 412 | 0 |
| `GET /memories?q=` palavra rara | 14 | 0 |
| `GET /memories?q=` palavra comum | 610 | 0 |
| `GET /memories/reviews` | 2 | 0 |
| `POST /memories` nova | 16 | 10 |
| `POST /memories` duplicata | 5 | 5 |
| `POST /memories` com conflito | 26 | 16 |
| `POST /memories` com palavra presente em todas | 151 | 22 |
| `GET /memories/:id/history` | 3 | 0 |
| `POST /memories/:id/status` | 7 | 7 |
| `POST /memories/:id/correct` | 54 | 34 |
| `DELETE /memories/:id` | 14 | 8 |

## Tela

`/memoria`, na barra lateral, mostra:

- um campo para guardar uma memória, com contador de caracteres;
- a fila "Para revisar", com a memória nova e a antiga lado a lado e as quatro
  ações;
- os filtros Todas, Atuais, Incertas e Passadas, com as contagens;
- a busca e o filtro por categoria;
- a chave da revisão de conflitos.

Cada item tem botões de 44 px: atualizar o fato, editar, histórico, mudar o
estado e apagar. A memória que o assistente guardou numa conversa (`remember`
ou `update_memory`) aparece com a marca **Anotada pelo assistente**.

## Quem escreveu

A coluna `author` de `zur_memories` (migration 8) diz quem escreveu a memória:
`owner` ou `agent`. O canal continua em `origin` (`app`, `telegram`,
`import`). As memórias anteriores à migration são do dono. Uma memória do
assistente passa a ser do dono quando ele a edita ou guarda o mesmo texto. O
assistente repetir uma memória do dono não muda nada, e uma versão nova que ele
escreva sobre uma memória do dono é dele, com a do dono guardada como fato
passado. O texto da memória aparece sempre como texto, nunca como HTML.

Capturas: `docs/assets/etapa-07/`.
