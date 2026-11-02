# Plano · Etapa 17, busca por significado

Situação: aprovado em 02/11/2026 (modo contínuo; sem perguntas ao Pablo, seção 14)
Origem: etapa 17 da especificação ("Busca semântica"), bloco da etapa em `docs/agente/prompts-das-etapas.md` e "O que a etapa 17 leva daqui" em `docs/planos/ai-gateway-hyperdrive-vectorize.md`
Dependências: etapas 7 (memória), 8 (medidor de IA), 9 (ferramentas), 10 (automações e alarme único) e 15b (`/buscar`), todas mescladas

## 1. Resumo

Um módulo opcional, desligado por padrão, que acha memórias, tarefas, notas e automações pelo sentido, além das palavras. Ligar cria as tabelas do módulo e começa a preparar o que já existe, em lotes de 50, espalhados pelos dias dentro de um teto diário. Os vetores ficam no SQLite do Durable Object, quantizados em `int8` e empacotados 64 por linha. A busca junta palavra-chave e significado (fusão por posição) na ferramenta `search`, na recordação de memórias do chat e das rotinas, no `/buscar` do bot e na paleta Ctrl/⌘K. Desligado, nada muda: nenhuma tabela, nenhuma chamada de IA, as mesmas respostas.

## 2. Contexto no sistema

- IA: `apps/agent/src/ai/metered.ts` (`MeteredAI`, único caminho ao modelo), `ai/usage.ts` (`UsageMeter`, teto de 9.000 Neurons), `ai/transcription.ts` (modelo de binding direto, mesmo padrão do embedder), `packages/shared/src/ai.ts` (`EMBEDDING_MODEL = @cf/baai/bge-m3`, 1.075 Neurons por milhão de tokens, tipo de uso `embedding` já previsto).
- Busca por palavra: `productivity/search.ts` (`searchTerms`, FTS5), `tools/search.ts`, `memory/recall.ts` (`selectRelevantMemories`, "até a busca semântica, etapa 17"), `telegram/commands.ts` (`#search`), `apps/web/src/components/CommandPalette.tsx`.
- Alarme único: `ZuriAgent.runAutomations` e `otherDue` (regra P8).
- Bloqueio: `auth.lockdown.active()` (etapa 16b): trabalho de IA em segundo plano não roda durante o bloqueio.
- Decisões: busca no próprio banco, sem Vectorize nem Hyperdrive (PR #38); embeddings só no Workers AI da conta do dono (D8, `docs/planos/troca-de-provedores-e-protecao-de-dados.md`); teto único de 9.000 Neurons (31/10/2026).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Desligada (padrão), o comportamento é idêntico ao de antes: nenhuma tabela `zur_semantic_*`, nenhum gatilho, nenhuma chamada de embedding; `search`, recordação e `/buscar` devolvem o mesmo | aceite |
| CA2 | Ligar cria as tabelas e os gatilhos; desligar remove os gatilhos e para o trabalho, mantendo os vetores | especificação |
| CA3 | A busca híbrida acha "carro" na memória "automóvel" com o mock de embeddings (ferramenta, recordação, `/buscar` e rota da paleta) | aceite |
| CA4 | Embeddings em lotes de 50, com teto diário de textos e sem passar de metade do teto de Neurons do dia; o resto fica para o dia seguinte | especificação, plano de custo |
| CA5 | Toda chamada de embedding passa pelo `MeteredAI` e conta no teto de 9.000 Neurons; recusada no teto, a busca cai para palavra-chave sem erro | regra P7 |
| CA6 | Embeddings só pelo Workers AI (ou o mock local), nunca por provedor de chat | D8 |
| CA7 | Vetores em `int8`, 64 por linha; a ordem dos resultados em `int8` bate com `float32` | plano de custo |
| CA8 | Busca lê uma linha por bloco, nunca uma por vetor; medido no teste de orçamento | regra P1 |
| CA9 | Mudou, apagou, foi para a lixeira ou voltou: o índice acompanha (gatilhos + fila); item apagado nunca aparece | especificação |
| CA10 | Reindexar refaz tudo aos poucos, sem perder a busca enquanto isso | especificação |
| CA11 | Durante o bloqueio, o preparo em segundo plano não roda | nota da 16b |
| CA12 | Configurações › IA mostra o cartão: chave, progresso, uso de hoje e **Preparar tudo de novo**; estados de carregando e erro; teclado, leitor de tela, claro/escuro, celular | especificação, qualidade |

## 4. Escopo

**Entra:** `apps/agent/src/semantic/` (esquema preguiçoso, vetores, embedder, armazenamento, indexador, serviço), `MeteredAI.embed`, `UsageMeter.reserveEmbedding`, rotas `GET/PATCH /api/semantic`, `POST /api/semantic/reindex`, `GET /api/search/semantic`, integração com `search`, recordação, `/buscar`, paleta e alarme, cartão em Configurações › IA, docs (`docs/semantic-recall.md`), README, changelog.

**Fica fora:** troca do modelo de embedding pela tela (só `bge-m3`); limites configuráveis pelo dono (constantes fixas, abaixo); busca por significado em conversas (fora da especificação); backup dos vetores (são derivados; a etapa 23 não os leva).

## 5. Como funciona para o Pablo

1. Configurações › IA › **Busca por significado**: liga a chave. O cartão mostra "Preparando: 120 de 1.430 itens" e o uso de hoje.
2. Enquanto prepara, a busca já usa o que está pronto e, para o resto, as palavras.
3. Na paleta (Ctrl/⌘K), ao digitar "carro", aparece o grupo **Pelo significado** com a memória "Meu automóvel é azul".
4. No chat, "qual a cor do meu carro?" traz a memória do automóvel para o prompt. No bot, `/buscar carro` também.
5. **Preparar tudo de novo** refaz o preparo aos poucos (pede confirmação). Desligar para tudo na hora.

Estados do cartão: carregando (esqueleto), erro (mensagem e **Tentar de novo**), desligado (explicação curta), preparando, pronto, pausado pelo limite do dia (volta às 21:00 de Brasília, 00:00 UTC) e pausado pelo bloqueio.

### Textos visíveis

Em `web.ai.semantic.*` (catálogo `pt-BR-ai.ts`, en em `en.ts`) e `web.palette.groupMeaning`. Nada cita infraestrutura: "preparar" no lugar de "indexar", "busca por significado" no lugar de "embeddings".

## 6. Regras de negócio e limites

| Limite | Valor | No limite |
| --- | --- | --- |
| Lote | 50 textos por chamada | o resto vai no próximo despertar |
| Textos preparados por dia (UTC) | 2.000 | pausa até 00:00 UTC |
| Parte do teto de Neurons para preparo | 50% do teto do dia | pausa até 00:00 UTC (o chat fica com o resto) |
| Buscas por significado por dia | 500 | a busca segue só por palavra |
| Texto por item | 2.000 caracteres | o resto não entra no vetor |
| Falhas seguidas do modelo no preparo | 3 (espera de 15 min entre elas) | pausa até 00:00 UTC |
| Prazo de uma chamada | 30 s no preparo, 10 s numa pergunta | a rodada falha (preparo) ou a busca fica só por palavra |
| Vetores por linha | 64 | bloco novo |
| Resultados por significado | piso 0,55 do cosseno e até 0,10 abaixo do melhor (bge-m3) | fora da lista |

## 7. Desenho técnico

### Arquivos

- `semantic/schema.ts`: trilha própria só de acréscimo (`SEMANTIC_MIGRATIONS`, versão em `zur_settings` pela `InternalState`), gatilhos criados ao ligar e removidos ao desligar.
- `semantic/vectors.ts`: normalizar, quantizar `int8` com escala por vetor, produto escalar, piso dos resultados e `fuse` (fusão por posição recíproca, k = 60).
- `semantic/embedder.ts`: `Embedder`, `WorkersAIEmbedder` (binding `AI`, `{ text: [...], truncate_inputs: true }`), `MockEmbedder` (determinístico, com grupos de sinônimos em pt-BR e en).
- `semantic/store.ts`: `VectorStore` (gravar, remover, buscar por blocos).
- `semantic/service.ts`: `SemanticSearch` (ligar, desligar, reindexar, estado, `tick`, `nextDue`, `search`).
- `semantic/hybrid.ts`: `hybridSearch`, a busca por palavra e por significado juntas (ferramenta `search`, `/buscar`).
- Integração: `ai/metered.ts`, `ai/usage.ts`, `agent/zuri-agent.ts`, `agent/runner.ts`, `memory/recall.ts`, `tools/search.ts`, `tools/registry.ts`, `telegram/commands.ts`, `api/semantic.ts`, `api/app.ts`.
- Interface: cartão `SemanticCard` em `apps/web/src/pages/settings/AiTab.tsx` (no chunk da aba IA) e `CommandPalette.tsx`.

### Rotas e contratos

- `GET /api/semantic` → `semanticStatusSchema` (`enabled`, `ready`, `total`, `waiting`, `today`, `limitPerDay`, `paused`).
- `PATCH /api/semantic` `{ enabled }` → estado.
- `POST /api/semantic/reindex` → estado (409 `CONFLICT` se desligada).
- `GET /api/search/semantic?q=&limit=` → `{ enabled, tasks, notes, memories, automations }`; `q` de 2 a 200 caracteres, `limit` 1 a 10.

### Banco

Criadas só ao ligar: `zur_semantic_vectors` (blocos: `kind`, `model`, `used`, `ids` JSON, `scales` BLOB float32, `vectors` BLOB int8), `zur_semantic_items` (item → bloco, posição e hash do texto), `zur_semantic_queue` (itens mudados). Contador `semantic` em `zur_counts`. Gatilhos nas tabelas de memórias, tarefas, notas e automações enfileiram mudanças de texto e exclusões. Fora do backup.

### Ferramentas do agente

`search` (read) passa a ser híbrida e, ligada, também lista automações. Nenhuma ferramenta nova.

### Agendamentos, IA e integrações externas

O preparo roda no alarme único: `otherDue` recebe `semantic.nextDue()` (com o piso de 60 s já existente). Busca de memória do chat e das rotinas faz no máximo 1 embedding da pergunta, com cache em memória das 32 últimas.

## 8. Custo e cotas do plano Free

- Neurons: 150 tokens por item → 35.000 itens (todos os tetos) ≈ 5.650 Neurons, espalhados em 18 dias a 2.000 itens/dia (≈ 320 Neurons/dia, 3,6% do teto). Pergunta: ≈ 10 tokens → 500 buscas ≈ 5 Neurons.
- Linhas lidas: busca = 1 linha por bloco de 64 → ≈ 550 linhas no pior caso; 90 buscas/dia ≈ 50.000 (1% da cota de 5 milhões).
- Linhas escritas: ≈ 3 por item preparado → 2.000/dia ≈ 6.000 (6% da cota de 100.000) só nos dias de preparo.
- Armazenamento: 1 KB por vetor → 35.000 ≈ 36 MB do teto de 900 MB.
- CPU: comparação no objeto, nunca no Worker (P6).
- Nenhum recurso novo da Cloudflare.

## 9. Segurança e privacidade

- Embeddings só no Workers AI da conta do dono (D8), com teste. Segredos do deploy são removidos do texto antes da chamada, como no chat.
- Resultado por significado é dado: entra no prompt pelos mesmos `<data>` de antes.
- Texto do dono nunca vai a log; erros do preparo registram só o código.
- Busca e preparo param durante o bloqueio; as rotas não estão em `WHILE_LOCKDOWN`.
- Consulta do dono nunca vira SQL (só parâmetros); `q` limitado a 200 caracteres.

## 10. Testes

| CA | Testes |
| --- | --- |
| CA1 | `semantic.test.ts` "desligada" (sem tabelas, sem chamadas, `search` igual), `migrations.test.ts` |
| CA2 | `semantic.test.ts` ligar/desligar |
| CA3 | `semantic.test.ts` híbrida, `chat-tools.test.ts`, `chat-runner` (recordação), `telegram-commands.test.ts`, `semantic-routes.test.ts`, e2e |
| CA4, CA5 | `semantic.test.ts` lotes e tetos, `ai-usage.test.ts` |
| CA6 | `semantic.test.ts` D8 |
| CA7 | `semantic-vectors.test.ts` (int8 x float32) |
| CA8 | `free-tier-budget.test.ts` |
| CA9, CA10, CA11 | `semantic.test.ts` |
| CA12 | `tests/e2e/busca-semantica.spec.ts` com axe |

## 11. Entrega

Um PR para `develop` (`feat/etapa-17-busca-semantica`), fragmento `changelog/nao-lancado/busca-semantica.md` com `<!-- versao: minor -->`, README ("O que já funciona"), capturas do cartão e da paleta, `progresso.md`.

## 12. Riscos

- Qualidade do `bge-m3` em pt-BR com `int8`: teste de ordem contra `float32`; pisos herdados do Talorys (avaliados lá com frases reais).
- Gatilhos novos em tabelas antigas: só existem com o módulo ligado e só inserem na fila.

## 13. Suposições

- Limites fixos (seção 6), sem campo na tela: o custo é pequeno e fica dentro do teto que o dono já controla.
- Desligar mantém os vetores (são derivados e evitam refazer tudo ao religar).
- A paleta só pergunta por significado quando o módulo está ligado.

## 14. Entrevista com o Pablo

Sem perguntas: tudo coberto pela especificação (etapa 17, "desligada por padrão"), pela decisão do PR #38 (vetores no SQLite) e pelo teto de 9.000 Neurons (31/10/2026).

### Perguntas abertas

Nenhuma.
