# Busca por significado

A busca semântica é opcional e começa desligada (etapa 17). Ligada, a Zuri
acha "carro" na memória "Meu automóvel é azul", mesmo sem nenhuma palavra em
comum. Desligada, tudo funciona como antes, conferido por teste.

Plano da etapa: [`docs/planos/etapa-17-busca-semantica.md`](planos/etapa-17-busca-semantica.md).

## Para o dono

- **Ligar:** Configurações › IA › **Busca por significado**. O cartão mostra
  quantos itens estão prontos, quantos faltam e quantos foram preparados hoje.
- **Enquanto prepara:** a busca já usa o que está pronto e, para o resto, as
  palavras. Nada some da busca.
- **Onde aparece:**
  - na paleta (Ctrl/⌘ K), no grupo **Pelo significado**;
  - na conversa e nas rotinas, a Zuri traz as memórias pelo significado;
  - na ferramenta de busca da Zuri e no `/buscar` do Telegram, que também
    passam a achar rotinas.
- **Preparar tudo de novo:** refaz o preparo aos poucos, sem apagar o que já
  está pronto. Pede confirmação.
- **Desligar:** a busca volta a ser só por palavra na hora. O que já foi
  preparado fica guardado e é aproveitado ao ligar de novo.

## Limites

Os valores estão em `SEMANTIC_LIMITS` (`packages/shared/src/semantic.ts`).

| Limite | Valor | No limite |
| --- | --- | --- |
| Textos por chamada ao modelo | 50 | o resto vai no próximo despertar |
| Textos preparados por dia (UTC) | 2.000 | pausa até 00:00 UTC (21:00 em Brasília) |
| Parte do teto de Neurons para o preparo | 50% do teto do dia | pausa até 00:00 UTC; a conversa fica com o resto |
| Buscas por significado por dia | 500 | a busca segue só por palavra |
| Texto por item | 2.000 caracteres | o resto não entra no vetor |
| Vetores por linha do banco | 64 | bloco novo |
| Resultados por significado | cosseno ≥ 0,55 e até 0,10 abaixo do melhor | fora da lista |

Se o modelo falhar, o preparo tenta de novo depois de 15 minutos. O registro
guarda só o código do erro, nunca o texto.

## Como funciona

- **Modelo:** `@cf/baai/bge-m3` do Workers AI, grátis, 1.024 dimensões e 1.075
  Neurons por milhão de tokens. A chamada passa pelo `MeteredAI`
  (`agent.ai().embed`) e conta no teto único de Neurons. Em desenvolvimento e
  nos testes, o `MockEmbedder` responde sem rede. Os textos nunca vão à cadeia
  de provedores do chat (decisão D8).
- **Onde os vetores ficam:** no SQLite do próprio Durable Object, sem
  Vectorize nem Hyperdrive (PR #38). Cada vetor é guardado com comprimento 1,
  em `int8` com uma escala própria (1 KB cada), e 64 vetores do mesmo tipo
  dividem uma linha. Uma busca lê uma linha por bloco, nunca uma por vetor.
- **Tabelas** (criadas só ao ligar, por uma trilha de migrations própria, só de
  acréscimo, com a versão em `zur_settings`):
  - `zur_semantic_vectors`: os blocos;
  - `zur_semantic_items`: onde está cada item e o hash do texto;
  - `zur_semantic_queue`: os itens que mudaram.
  - Ficam fora do backup, porque tudo se refaz a partir dos itens.
- **Fila:** gatilhos em `zur_memories`, `zur_tasks`, `zur_notes` e
  `zur_automations` põem na fila o item criado, apagado ou com o texto mudado.
  Mudar só o estado ou a data não entra na fila. Os gatilhos existem só com a
  busca ligada.
- **Preparo:** roda no alarme único das automações (`otherDue` recebe
  `semantic.nextDue()`). Primeiro vem a fila, depois uma varredura que acha os
  itens sem vetor e remove os vetores de itens que não existem mais. Um texto
  igual ao já preparado (mesmo hash) não chama o modelo de novo.
- **Busca híbrida:** `hybridSearch` (`semantic/hybrid.ts`) junta a busca por
  palavra e a por significado pela fusão de posição recíproca (k = 60). Um item
  achado dos dois jeitos vem primeiro. A recordação de memórias do chat usa a
  mesma fusão (`selectRelevantMemories`). Memórias passadas continuam fora,
  salvo quando a pergunta é sobre o passado.
- **Pergunta:** cada busca faz no máximo um embedding, com um cache das 32
  últimas perguntas.

## Segurança

- O resultado por significado é dado: entra no prompt pelos mesmos blocos
  `<data>` de antes.
- O texto do dono nunca vai a log. Segredos do deploy são removidos antes da
  chamada ao modelo, como no chat.
- Durante o modo de bloqueio, o preparo e a busca param, e as rotas
  respondem 423. Nenhuma está em `WHILE_LOCKDOWN`.
- A consulta nunca vira SQL: só parâmetros, de 2 a 200 caracteres.

## Rotas

| Rota | O que faz |
| --- | --- |
| `GET /api/semantic` | Estado do módulo (`semanticStatusSchema`) |
| `PATCH /api/semantic` | `{ enabled }` liga ou desliga |
| `POST /api/semantic/reindex` | Prepara tudo de novo (409 `CONFLICT` se desligada) |
| `GET /api/search/semantic?q=&limit=` | Só pelo significado: `{ enabled, tasks, notes, memories, automations }` |

## Custo no plano Free

- Neurons: 35.000 itens (todos os tetos de itens) dão perto de 5.650 Neurons no
  total, espalhados em 18 dias (cerca de 320 por dia, 3,6% do teto). Uma busca
  custa perto de 0,01 Neuron.
- Linhas lidas: uma busca lê uma linha por bloco de 64 vetores (até cerca de
  550 linhas).
- Linhas escritas: cerca de 3 por item preparado, só nos dias de preparo.
- Armazenamento: 1 KB por vetor, cerca de 36 MB com todos os tetos.
- Nenhum recurso novo da Cloudflare.
