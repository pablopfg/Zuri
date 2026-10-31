# Provedor de IA e medição de uso

Como o Zuri chama a IA e conta o que ela gasta (etapa 8). A conversa com
ferramentas chega na etapa 9 e usa o que está aqui.

## Provedores

| Provedor | Quando | Gasta Neurons |
| --- | --- | --- |
| Workers AI (`apps/agent/src/ai/workers-ai.ts`) | Produção: qualquer `PUBLIC_URL` que não seja loopback | Sim |
| IA simulada (`apps/agent/src/ai/mock.ts`) | Desenvolvimento local (`npm run dev`) e e2e, com `PUBLIC_URL` em `http://127.0.0.1` ou `localhost` | Não |

- Os dois seguem a mesma interface `AIProvider`: `generate`, `stream` e
  `generateWithTools`.
- O Workers AI usa o AI SDK (`ai` 7.0.137) com o provedor oficial da
  Cloudflare (`workers-ai-provider` 4.0.0). O raciocínio do modelo fica
  desligado (`enable_thinking: false`) nos modelos cujo template tem essa
  chave (GLM 4.7 Flash e Qwen3); os Llama não recebem o campo. As novas
  tentativas do SDK ficam desligadas (`maxRetries: 0`), e a telemetria do SDK
  também.
- Sem o binding `AI` fora do ambiente local, a IA responde `NOT_CONFIGURED`.
- `npm run dev` e os testes e2e rodam o `wrangler dev --local`: o binding de IA
  fica desligado e nada sai para a conta da Cloudflare.
- A IA simulada repete a mensagem e, com `call <ferramenta> {json}`, chama uma
  ferramenta pelo caminho real (limites, validação, aprovações). Os textos
  dela vêm do catálogo de i18n.
- Modelos pagos (Anthropic, OpenAI) não existem aqui (decisão N7).

## Modelos e preços

Conferidos na [tabela de preços do Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)
em 31/10/2026 e gravados em `packages/shared/src/ai.ts` (`WORKERS_AI_PRICING`).

| Modelo | Uso | Neurons |
| --- | --- | --- |
| `@cf/zai-org/glm-4.7-flash` (padrão) | Conversa | 5.500 por milhão de tokens de entrada, 36.400 de saída |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Conversa | 4.625 / 30.475 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Conversa | 24.545 / 77.273 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Conversa | 26.668 / 204.805 |
| `@cf/openai/whisper-large-v3-turbo` | Voz (etapa 9) | 46,63 por minuto de áudio |
| `@cf/baai/bge-m3` | Busca semântica (etapa 17) | 1.075 por milhão de tokens |

1.000 Neurons custam US$ 0,011 no plano pago. No plano gratuito, 10.000
Neurons por dia não são cobrados.

Uma resposta típica (6.000 tokens de contexto, 400 de saída) no modelo padrão
gasta cerca de 48 Neurons: o teto padrão cabe umas 189 delas por dia.

Para trocar um preço: confira a página oficial, mude a tabela e a data
`asOf` no mesmo PR. O preço vale para as chamadas novas; o que já foi contado
não muda.

## Limites diários

| Limite | Padrão | Faixa | Onde muda |
| --- | --- | --- | --- |
| Teto de Neurons (conversa, voz e busca juntas) | 9.000 | 1.000 a 9.000 | Configurações > IA |
| Pedidos à IA (cada chamada ao modelo conta um) | 200 | 1 a 2.000 | Configurações > IA |
| Tamanho máximo da resposta | 1.024 tokens | 256 a 4.096 | Configurações > IA |
| Áudio transcrito | 3.600 s | fixo | — |

- O teto de 9.000 é decisão do Pablo (31/10/2026): fica 1.000 abaixo da cota
  grátis, para sobrar folga a outro uso da conta.
- O teto vale para o Zuri; a cota de 10.000 é da **conta** inteira. Outro
  Worker que use Workers AI na mesma conta gasta da mesma cota sem o Zuri ver.
  No plano Free, a cota esgotada só faz a Cloudflare recusar (4006); numa
  conta Workers Paid, esse outro uso pode ser cobrado.
- Os dias são dias **UTC**, porque a cota da Cloudflare renova às 00:00 UTC
  (21:00 em Brasília). A tela mostra a hora da renovação no fuso do dono.

## Como a medição funciona

1. **Antes da chamada** (`UsageMeter.reserveChat`): o Zuri estima o custo
   máximo (entrada estimada por ~4 caracteres por token, mais a saída máxima),
   confere os pedidos e o teto de Neurons do dia e grava a reserva. Se não
   cabe, responde `429 AI_LIMIT_REACHED` com `details.limit` (`requests`,
   `neurons` ou `audio`), `max`, `resetsAt` e `retryAfter`, antes de mandar
   qualquer coisa.
2. **Durante**: o binding de IA passa por um medidor (`workers-ai-usage.ts`)
   que cria a conta da chamada no instante em que ela começa e lê os tokens que
   a Cloudflare informa, inclusive no meio do stream.
3. **Depois** (`settle`): a reserva vira o gasto de verdade (tokens informados
   pela Cloudflare ou, sem eles, estimados), por passo. Uma chamada com
   ferramentas conta um pedido por passo; o passo seguinte só acontece se a
   reserva dele couber, e essa reserva já inclui o prompt anterior, a resposta
   do passo e os resultados das ferramentas. Se a Cloudflare informar mais do
   que o reservado, o gasto entra inteiro e a próxima chamada que não couber é
   recusada; o excesso fica limitado às chamadas já em andamento, dentro da
   folga de 1.000 Neurons.
4. **Falha ou parada**: a chamada que chegou ao modelo é contada mesmo assim,
   com o que se viu dela. Parar a leitura no meio (botão Parar, aba fechada) ou
   abortar pelo sinal conta como interrompida. Quando a vez termina, de
   qualquer jeito, o sinal da chamada é cancelado e o medidor fecha: nenhuma
   chamada nova ao modelo começa depois. Uma reserva cuja chamada nunca começou
   é devolvida.
5. **Prazo**: cada vez tem até 120 s (`AI_TURN_DEADLINE_MS`). Passou disso, a
   chamada é cancelada, conta como falha e a resposta é
   `503 SERVICE_UNAVAILABLE` com "O modelo demorou demais para responder". O
   relógio é desligado no fim da vez, então nada segura o Durable Object
   (regra P5).

Concorrência: a conferência e a reserva acontecem num único passo síncrono do
Durable Object, que roda um pedaço de JavaScript por vez. N pedidos ao mesmo
tempo nunca passam juntos de um limite.

Uma chamada que a Cloudflare recusa por cota esgotada na conta (código 4006)
vira `AI_LIMIT_REACHED` com `details.limit: "account"`.

## Modelo de dados (migration 7)

| Tabela | Linha | Para quê |
| --- | --- | --- |
| `zur_usage_daily` | uma por dia UTC | Pedidos, falhas, interrompidas, segundos de áudio, Neurons (reservados + gastos) e US$ estimados |
| `zur_model_usage_daily` | uma por dia, modelo, tipo e cobrável | Chamadas, tokens informados e estimados, segundos de áudio, Neurons e US$ |

- Guardam só contadores: nenhum texto do dono, prompt ou resposta.
- O histórico guarda 90 dias. A primeira chamada de um dia novo apaga o resto.
- Não entram no backup (são medidas, não dados do dono).

## API

`GET /api/usage` (sessão + CSRF): o uso de hoje contra os limites, uma linha
por modelo e os últimos 7 dias. Formato em `usageReportSchema`
(`packages/shared/src/ai.ts`). Os limites mudam por `PATCH /api/settings`
(`aiModel`, `aiRequestsPerDay`, `aiNeuronsPerDay`, `aiMaxOutputTokens`).

## Custo no plano Free

- Cada chamada lê as três configurações e a linha do dia e grava de 2 a 3
  linhas (reserva e acerto). `GET /api/usage` lê cerca de 10 linhas.
- Medido em `apps/agent/test/free-tier-budget.test.ts`.
