# AI Gateway, Hyperdrive e Vectorize: avaliação

Situação: **avaliação, sem código.** Escrita em 02/11/2026 a partir do pedido do
Pablo: "verifique se AI Gateway, Cloudflare Hyperdrive e Vectorize podem ser
aproveitados e trazer melhorias em nosso projeto".

Limites e preços conferidos na documentação oficial da Cloudflare em
02/11/2026 (links em cada seção). Preço muda; quem for usar estes números numa
etapa confere de novo.

## Resumo

| Produto | O que resolve | Serve ao Zuri? | Recomendação |
| --- | --- | --- | --- |
| AI Gateway | Painel, cache, limite e registro de chamadas a modelos de IA | Pouco: o Zuri já mede e limita tudo no `MeteredAI`, e os registros guardariam o texto do dono | **Não adotar agora.** Reavaliar só na etapa 21, se os modelos pagos forem aprovados |
| Hyperdrive | Acelera um banco Postgres ou MySQL que fica fora da Cloudflare | Não: o Zuri não tem banco externo, e ter um iria contra a arquitetura | **Descartar** |
| Vectorize | Banco de vetores para busca por significado | Não cabe: a cota gratuita guarda uns 4.900 vetores do modelo que o Zuri usa, e só as memórias podem chegar a 10.000 | **Descartar.** A etapa 17 segue com vetores no SQLite do Durable Object, com os ajustes abaixo |

Nada aqui liga recurso novo. O que muda nos prompts das etapas: a 17 ganha as
regras de custo da seção "O que a etapa 17 leva daqui", e a 21 passa a citar
este documento na recomendação ao Pablo.

## Como o Zuri funciona hoje (o que importa aqui)

- Um Worker e um Durable Object com SQLite. Todos os dados do dono moram nesse
  SQLite; não existe banco externo (`README.md`, "Seus dados ficam com você").
- Toda chamada de IA passa por `agent.ai()`, que é o `MeteredAI`
  (`apps/agent/src/ai/metered.ts`): estima os Neurons antes, confere o teto de
  9.000 por dia, acerta pelo uso real de cada passo e grava os contadores em
  `zur_usage_daily` e `zur_model_usage_daily`. A aba Configurações > IA mostra
  esse uso.
- O provedor chama o binding `AI` pelo `workers-ai-provider`
  (`apps/agent/src/ai/workers-ai.ts`), sem nova tentativa automática.
- Logs: Workers Logs grátis (200.000 eventos por dia, 3 dias). O módulo único
  de log barra texto do dono, e-mail, IP e token (PR #37). A etapa 11 traz o
  registro de falhas no banco e a aba Diagnóstico
  (`docs/planos/observabilidade.md`).
- A busca semântica é a etapa 17, opcional e desligada por padrão. A
  especificação já decidiu: embeddings `@cf/baai/bge-m3` do Workers AI
  (1.075 Neurons por milhão de tokens, 1.024 dimensões), vetores no SQLite do
  Durable Object, sem Vectorize.

## AI Gateway

### O que é

Um proxy da Cloudflare entre a aplicação e o provedor de IA (Workers AI,
OpenAI, Anthropic e outros). Para o Workers AI basta passar
`gateway: { id }` como terceiro argumento de `env.AI.run()`; o
`workers-ai-provider` aceita a mesma opção. Ele oferece painel de uso,
registro de cada chamada, cache, limite de taxa, troca de provedor quando um
falha, DLP e Guardrails.

### Plano gratuito (conferido em 02/11/2026)

| Item | Free | Fonte |
| --- | --- | --- |
| Painel, cache e limite de taxa | Grátis | [Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/) |
| Gateways por conta | 10 | [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/) |
| Registros (gateway criado a partir de 24/09/2026) | Seguem os limites do Workers Logs, a mesma cota que o Zuri já usa | idem |
| Registros (gateway antigo) | 100.000 no total da conta | idem |
| Cache | Só pedido idêntico (hash do corpo inteiro); sem cache por significado; validade de 60 s a 1 mês; desligado por padrão | [Caching](https://developers.cloudflare.com/ai-gateway/configuration/caching/) |
| DLP | Grátis, dois perfis prontos | Pricing |
| ⚠️ Guardrails | Cobrado como uso do Workers AI, proporcional ao tamanho do texto avaliado | Pricing |
| ⚠️ Unified Billing | Taxa de 5% sobre o crédito comprado | Pricing |
| ⚠️ Logpush | Cobrado pelo volume exportado | Pricing |

### Onde entraria no Zuri e quanto ganharia

| Uso possível | Ganho real | Por quê |
| --- | --- | --- |
| Painel de uso | Pequeno | A aba IA já mostra Neurons por dia e por modelo, e a etapa 11 traz a aba Diagnóstico com as falhas da IA. O painel do gateway fica só na Cloudflare; o dono teria de abrir outro lugar. |
| Registro de cada chamada | Negativo | O registro guarda o pedido e a resposta inteiros: memórias, notas, conversa e resultados de ferramentas. Isso quebra a regra dos logs (nada de texto do dono em log, PR #37), e os gateways novos ainda gastam a cota do Workers Logs que o Zuri divide com o resto. Teria de ficar desligado, e aí some o principal atrativo. |
| Cache | Quase nenhum | O cache só acerta com pedido idêntico. Cada turno de chat leva histórico, memórias e horário diferentes. Embeddings já são calculados uma vez por texto (regra P7). |
| Limite de taxa | Nenhum | Conta pedidos por período, não Neurons. O `MeteredAI` já limita por Neurons, por dia e por recurso, antes de chamar. Dois limites diferentes só confundem o aviso ao dono. |
| ⚠️ Guardrails | Negativo | Gasta Neurons por fora do `MeteredAI`: o teto de 9.000 deixaria de ser verdade. |
| Troca de provedor e chaves guardadas (BYOK) | Possível, mas só na etapa 21 | Com modelos pagos, o gateway junta num lugar só o gasto em US$ por provedor e pode trocar de provedor numa falha. A etapa 21 já exige o OK do Pablo e um teto diário em US$. |

### Riscos

- Mais um ponto de falha: gateway apagado ou com o id errado derruba toda a IA.
- Os registros, se ligados, guardam conteúdo do dono fora do SQLite e por
  fora da faxina do Zuri.
- Configurar o gateway é um passo a mais no guia de instalação, que hoje é só
  pelo navegador.
- ⚠️ Guardrails, Unified Billing e Logpush geram cobrança ou furam o teto.

### Recomendação

**Não adotar agora.** Para o Workers AI o ganho é pequeno e o registro de
conteúdo é um risco. Reavaliar na etapa 21 só se o Pablo aprovar os modelos
pagos. Nesse caso, a recomendação ao Pablo diz se vale passar esses modelos
pelo gateway, sempre com registro de conteúdo desligado e sem Guardrails,
Unified Billing ou Logpush. O teto em US$ continua no Zuri, antes da chamada.

## Hyperdrive

### O que é

Um conjunto de conexões e um cache de consultas da Cloudflare na frente de um
banco **Postgres ou MySQL que já existe** em outro lugar (outro provedor ou
servidor próprio). Ele encurta o caminho do Worker até esse banco.

### Plano gratuito (conferido em 02/11/2026)

| Item | Free | Fonte |
| --- | --- | --- |
| Disponível no Free | Sim | [Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Consultas | 100.000 por dia, zeram às 00:00 UTC | idem |
| Configurações por conta | 10 | [Limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) |
| Conexões com o banco de origem | Cerca de 20 por configuração | idem |
| Consulta mais longa | 60 s | idem |
| ⚠️ Banco de origem | Fica fora do Hyperdrive. Os bancos PlanetScale criados pela Cloudflare são cobrados à parte | Pricing |

### Onde entraria no Zuri

Em lugar nenhum. O Zuri não tem banco externo: o SQLite mora dentro do
Durable Object, no mesmo processo, sem rede. Nenhum proxy deixa isso mais
rápido. Para usar o Hyperdrive seria preciso mover os dados para um Postgres
ou MySQL de fora, o que:

- tira os dados da conta do dono, contra a proposta do produto;
- ⚠️ quase sempre cobra pelo banco;
- troca uma leitura local por uma ida e volta pela rede em cada consulta;
- abre um segredo novo (a senha do banco) e uma superfície de ataque nova.

Também não serve para a agente ler um banco do dono: a regra 3 proíbe dar à
agente acesso livre a sistemas de fora. Se um dia isso for pedido, o caminho é
um servidor MCP do dono (etapa 18), com as aprovações de lá.

### Recomendação

**Descartar.** Só voltaria à mesa se o Pablo decidir ter um banco externo, o
que mudaria a arquitetura e precisaria do OK dele (⚠️).

## Vectorize

### O que é

O banco de vetores da Cloudflare: guarda embeddings e devolve os mais
parecidos com uma consulta. É o que a busca semântica da etapa 17 precisa
fazer.

### Plano gratuito (conferido em 02/11/2026)

| Item | Free | Fonte |
| --- | --- | --- |
| Dimensões guardadas | 5 milhões | [Pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Dimensões consultadas | 30 milhões por mês, contadas como (vetores consultados + vetores guardados) × dimensões | idem |
| Índices | 100 | idem |
| Dimensões por vetor | até 1.536 | [Limits](https://developers.cloudflare.com/vectorize/platform/limits/) |
| `topK` | 50 com metadados, 100 sem | idem |
| O que acontece ao passar da cota no Free | A página não diz. No Workers Paid, cobra o excedente ⚠️ | Pricing |

### A conta com os limites do Zuri

O `bge-m3` gera vetores de 1.024 dimensões e é multilíngue. Trocar por um
modelo de 768 dimensões não resolve: a cota guardaria uns 6.500 vetores. Os de
384 dimensões do catálogo são de inglês e buscariam mal em pt-BR.

| Conjunto | Vetores | Dimensões guardadas | Cota de 5 milhões |
| --- | --- | --- | --- |
| Cota gratuita | ~4.880 | 5.000.000 | 100% |
| Só memórias, no teto (`STORAGE_LIMITS.memories`) | 10.000 | 10.240.000 | **205%** |
| Memórias, tarefas, notas e automações, nos tetos | ~35.050 | ~35.900.000 | **718%** |

A consulta caberia (umas 800 por dia com 4.880 vetores guardados), mas o
armazenamento estoura com uso normal de quem guarda bastante memória. Além
disso:

- é recurso novo, que a regra P14 e a especificação já deixaram de fora;
- os vetores ficariam num segundo lugar, fora do SQLite: apagar, restaurar da
  lixeira, importar backup (etapa 23) e "esquecer tudo" teriam de acertar dois
  bancos, com risco de sobrar vetor de item apagado;
- cada busca vira uma subrequisição a mais (regra P9);
- o comportamento do Free ao passar da cota não está documentado.

### Recomendação

**Descartar.** A decisão da especificação continua certa: vetores no SQLite
do Durable Object. Ela tem custos próprios, que a etapa 17 precisa controlar.

## O que a etapa 17 leva daqui

A conta acima também vale para guardar os vetores no SQLite. Sem cuidado, a
busca por significado vira o maior gasto de linhas lidas e de Neurons:

- **Linhas lidas.** Uma linha por vetor faria cada busca ler um item por
  vetor guardado: 10.000 memórias × 90 buscas por dia (30 buscas e 60 turnos
  de chat) = 900.000 linhas, 18% da cota de 5 milhões; com os quatro tipos no
  teto, umas 3,2 milhões (63%). Saída: empacotar os vetores em blocos (por
  exemplo, 64 vetores por linha num `BLOB`, bem abaixo do teto de 2 MB por
  linha), o que leva a mesma busca para umas 550 linhas. Medir no
  `free-tier-budget.test.ts` (regra P1).
- **Armazenamento.** Em `float32`, cada vetor tem 4 KB: 35.000 vetores somam
  uns 143 MB do teto de 900 MB. Em `int8`, 1 KB e uns 36 MB. Vale testar se a
  qualidade da busca se mantém em `int8` com o mock e com um conjunto pequeno
  de frases reais em pt-BR.
- **Neurons.** Indexar tudo de uma vez passa do dia: 35.000 itens com uns 150
  tokens cada são 5,25 milhões de tokens, uns 5.650 Neurons, mais da metade do
  teto de 9.000. A reindexação tem de andar em lotes de 50, por dias, dentro
  do teto diário de embeddings, sem tirar a vez do chat.
- **CPU.** Comparar a consulta com 35.000 vetores de 1.024 dimensões são uns 36
  milhões de multiplicações. Cabe nos 30 s de CPU do objeto, mas tem de ser
  feito no objeto, nunca no Worker (regra P6), e pode filtrar por tipo antes.

## Fontes

- [AI Gateway: Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
- [AI Gateway: Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- [AI Gateway: Caching](https://developers.cloudflare.com/ai-gateway/configuration/caching/)
- [AI Gateway: Workers AI binding](https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/)
- [Hyperdrive: Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Hyperdrive: Limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)
- [Vectorize: Pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Vectorize: Limits](https://developers.cloudflare.com/vectorize/platform/limits/)
