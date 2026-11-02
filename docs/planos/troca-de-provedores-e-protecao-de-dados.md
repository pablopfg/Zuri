# Troca automática de provedor de IA e proteção dos dados enviados aos modelos: plano

Situação: **proposta, sem código.** Escrita em 02/11/2026 a partir de dois
pedidos do Pablo:

- "Algo que me chamou atenção no Cloudflare's AI Gateway é a possibilidade de
  trocar de provedor automaticamente caso algum caia ou fique sem crédito
  [...] para que possamos implementar isso dentro do nosso sistema com dois
  Provedores distintos de LLM."
- "Quero que use as melhores técnicas em padronização e interação com modelos
  de LLM para evitar que os dados sejam vazados aos modelos, monte um plano de
  ação com relação a isso."

Documentação conferida em 02/11/2026. Complementa
[ai-gateway-hyperdrive-vectorize.md](ai-gateway-hyperdrive-vectorize.md).

## Resumo

1. **O AI Gateway troca de provedor, mas não serve bem ao Zuri.** O jeito
   simples (lista de provedores no Universal Endpoint) está **descontinuado**.
   O substituto (Dynamic Routing) exige gateway autenticado e chaves guardadas
   num produto em beta, só aceita o formato da OpenAI e só documenta a troca
   quando estoura um limite de pedidos ou de gasto do próprio gateway. "Ficou
   sem crédito" não aparece como gatilho em lugar nenhum. Pior: o gateway
   decide o provedor **depois** que o Zuri já contou o gasto, e manda o mesmo
   prompt inteiro ao reserva, sem saber o que pode ou não ir para ele.
2. **Fazer a troca no próprio Zuri é pouco código e fica mais seguro.** A
   interface `AIProvider`, o `MeteredAI` e a classificação de erros
   (`classifyAiError`) já existem. Falta uma cadeia de dois provedores com um
   disjuntor por provedor. A especificação já prevê isso na etapa 21
   ("fallback quando o principal falha antes de responder").
3. **O segundo provedor é a decisão que falta.** Hoje só existe o Workers AI
   grátis. Um segundo modelo do próprio Workers AI não custa nada, mas não
   cobre o Workers AI inteiro fora do ar nem a cota zerada. Um provedor
   distinto de verdade (Anthropic ou OpenAI) ⚠️ gera cobrança e só entra com o
   OK do Pablo. Provedor externo "grátis" que usa os dados para treinar fica
   vetado pela parte 3.
4. **Proteção de dados: o Zuri já faz o básico** (conteúdo guardado em
   `<data>`, nada de prompt nos logs, imagens remotas bloqueadas na conversa).
   O plano acrescenta um contrato do que pode entrar no prompt, um teste com
   valores "canário", pseudonimização antes de qualquer provedor externo,
   perfil de compartilhamento por provedor e a marca "nunca enviar para fora"
   em memórias e notas.

## Parte 1 · O que o AI Gateway faz na troca de provedor

| Caminho | Como troca | Situação em 02/11/2026 | Problema para o Zuri |
| --- | --- | --- | --- |
| Universal Endpoint | Lista ordenada de provedores no corpo do pedido; passa ao próximo se o anterior der erro ou estourar o prazo; o cabeçalho `cf-aig-step` diz qual respondeu | **Descontinuado**: a página manda usar Dynamic Routing em integrações novas | Não vale construir sobre ele |
| Dynamic Routing | Fluxo montado no painel (condição, porcentagem, limite de pedidos, limite de gasto, modelo); chamado pelo nome `dynamic/<rota>` | Exige gateway autenticado e chaves BYOK no Secrets Store (beta aberto; a página não diz se vale no Free) | Só o formato de chat da OpenAI; a troca documentada é só ao estourar limite de pedidos ou de gasto; erro do provedor e prazo não aparecem como gatilho |
| Novas tentativas | Cabeçalhos `cf-aig-max-attempts` (até 5), `cf-aig-retry-delay`, `cf-aig-backoff` | Disponível | Repetição que o medidor do Zuri não vê (por isso `maxRetries: 0`, regra P7) |
| Prazo | `cf-aig-request-timeout`, contado até o primeiro pedaço da resposta | Disponível | O Zuri já tem prazo próprio (120 s por vez) |

Nenhuma página diz que "sem crédito" (HTTP 402, `insufficient_quota`) faz o
gateway trocar. Também não há troca depois que a resposta começou a chegar: o
prazo vale até o primeiro pedaço.

### Por que não usar o gateway para isso

- **Conta antes da chamada (P7).** O `MeteredAI` reserva os Neurons (e, na
  etapa 21, os US$) do provedor que vai ser chamado, antes de chamar. Se o
  gateway escolhe depois, o Zuri teria de reservar o pior caso dos dois ou
  descobrir o gasto pelo cabeçalho. O teto em US$ do dono passaria a depender
  do limite de gasto do painel, e seriam dois tetos para manter iguais.
- **Dados.** O reserva recebe o mesmo prompt do principal. Se o principal é o
  Workers AI (na conta do dono) e o reserva é externo, memórias e notas iriam
  para fora sem passar pelo perfil da parte 3. No Zuri, a troca remonta o
  contexto para o provedor de destino.
- **Mais peças.** Token do gateway, chaves em produto beta, rota versionada no
  painel e mais um passo no guia de instalação. O gateway apagado ou mal
  configurado derruba toda a IA.
- **Formato.** Só chat no formato da OpenAI. A voz (Whisper) e os embeddings
  (etapa 17) ficariam de fora, e o medidor por passo, que hoje lê os tokens do
  binding, teria de ser refeito.

**Recomendação:** não usar o AI Gateway para a troca. Fazer a cadeia no Zuri,
na camada do `MeteredAI`.

## Parte 2 · Troca de provedor no Zuri

### Peças

```text
runner → agent.ai() = MeteredAI → ProviderChain [primário, reserva]
                                     │  disjuntor por provedor
                                     └─ cada provedor: AIProvider (Workers AI, mock, e na 21 Anthropic/OpenAI)
```

- **`ProviderChain`** implementa `AIProvider` e guarda até dois provedores em
  ordem. O primário vem das Configurações > IA; o reserva é opcional.
- **O medidor conta por provedor.** Antes de cada tentativa, reserva o custo
  daquele provedor (Neurons ou US$, pela tabela de preços datada) e confere o
  teto dele. Tentativa que falhou devolve o que não começou e acerta o que o
  provedor cobrou.
- **Contexto remontado para o destino.** A troca chama de novo o montador de
  contexto com o perfil do provedor reserva (parte 3) e a janela dele (o
  orçamento de contexto já é o menor entre o do dono e o do modelo).

### Quando trocar

| Situação | Troca? | Por quê |
| --- | --- | --- |
| Ocupado: 429, `3040`, "capacity" (`error.aiBusy`) | Sim | Falha do provedor, passageira |
| Modelo fora: `5007`, "model not found" (`error.aiModelUnavailable`) | Sim | O reserva tem outro modelo |
| Erro 5xx, rede, nenhum pedaço da resposta em 20 s | Sim | Falha do provedor |
| Cota do Workers AI zerada (`4006`) | Sim | Disjuntor aberto até 00:00 UTC |
| Sem crédito no provedor pago (402, `insufficient_quota`, saldo baixo) | Sim | Disjuntor aberto até o dono agir; aviso ao dono |
| Teto do próprio Zuri (`AI_LIMIT_REACHED` do dono) | **Não** | É escolha do dono, não falha |
| Pedido inválido, contexto grande demais (400) | **Não** | O reserva também recusaria; corta o contexto ou mostra o erro |
| Recusa por conteúdo | **Não** | Trocar de modelo para contornar recusa é burlar a regra |
| Dono apertou Parar | **Não** | Cancelado de propósito |
| A resposta já começou a aparecer | **Não** | Evita resposta duplicada; mostra o erro e o dono pede de novo |

No máximo uma troca por passo do modelo e duas por vez (turno), dentro do
mesmo prazo de 120 s e do limite de subrequisições (regra P9).

### Disjuntor por provedor

- **Fechado** (normal) → **aberto** depois de 3 falhas trocáveis em 2 minutos,
  ou de uma falha de cota ou de crédito.
- **Aberto**: o provedor nem é tentado; vai direto ao reserva. Ocupado ou fora
  do ar: 60 s. Cota do Workers AI: até 00:00 UTC. Sem crédito: até o dono
  confirmar na tela que recarregou.
- **Meio aberto**: depois do prazo, a próxima chamada real do dono testa o
  provedor. Deu certo, fecha; falhou, abre de novo com o prazo dobrado (até
  15 min).
- **Sem pings de saúde.** Uma chamada só para testar gastaria pedido e
  Neurons. A saúde é medida nas chamadas reais.
- **Onde fica.** Na memória do objeto. Só os estados longos (cota e crédito)
  vão para o SQLite, numa linha por provedor, gravada só quando o estado muda
  (regra P4).

### Ferramentas e repetição

- O runner guarda os passos já feitos no turno. A troca refaz só o passo do
  modelo que falhou, com os resultados de ferramenta já obtidos. **Nenhuma
  ferramenta roda de novo.** A recusa de repetição exata que já existe continua
  valendo.
- O reserva tem de aceitar ferramentas e a janela mínima do Zuri. Modelo que
  não aceita fica fora da lista de reserva.
- Proposta destrutiva e plano continuam como são: a troca não muda quem
  aprova.

### O que o dono vê

- Resposta dada pelo reserva leva uma marca discreta: "Respondida pelo modelo
  reserva". O texto não cita infraestrutura.
- A aba Diagnóstico (etapa 11) registra cada troca e cada disjuntor aberto. O
  alerta sai quando o primário fica aberto mais de 30 min, ou na hora em caso
  de falta de crédito (no máximo 1 por tipo por dia).
- Configurações > IA mostra o primário, o reserva e o estado de cada um
  ("funcionando", "fora do ar até 21:00", "sem crédito").

### Opções de segundo provedor

| Opção | Custo | Cobre | Dados | Recomendação |
| --- | --- | --- | --- | --- |
| Segundo modelo do Workers AI (por exemplo Qwen3 30B com GLM 4.7 Flash) | Grátis, dentro dos mesmos 9.000 Neurons | Modelo fora, capacidade | Fica na conta do dono | **Fazer**: protege contra a falha mais comum sem custo |
| ⚠️ Anthropic ou OpenAI | Cobra por uso, teto diário em US$ (etapa 21) | Workers AI inteiro fora, cota zerada | API não treina com os dados por padrão; guarda por até 30 dias; retenção zero só com aprovação da empresa | Só com o OK do Pablo (etapa 21) |
| Camada grátis de terceiros (por exemplo Gemini grátis) | Grátis | Workers AI fora | O Google pode usar o conteúdo da camada grátis para melhorar produtos, com leitura por pessoas | **Vetado** pela parte 3 |

"Dois provedores distintos" só existe com uma opção ⚠️ paga. A cadeia é a
mesma nos dois casos: a parte grátis pode entrar antes, e o provedor pago
entra depois como mais um item da lista.

## Parte 3 · Plano de proteção dos dados enviados aos modelos

Princípio: o modelo recebe o mínimo para responder, nunca um segredo, e
conteúdo guardado é sempre dado, nunca instrução. Quanto mais longe da conta
do dono está o provedor, menos ele recebe.

### O que já existe

| Proteção | Onde |
| --- | --- |
| Conteúdo guardado entra em `<data>` neutralizado, uma linha por item; o nome do dono também | `apps/agent/src/agent/data.ts`, `docs/seguranca.md` ("Conteúdo guardado no prompt") |
| Resultado de ferramenta cortado em 8.000 caracteres, em `<data source="tool">` | etapa 9 |
| Memórias escolhidas por relevância, dentro de um orçamento de tokens | `selectRelevantMemories`, `memoryTokenBudget` |
| Prompt e resposta nunca vão para o log; erro do provedor sem a mensagem (ela pode citar o prompt) | módulo de log (PR #37), `classifyAiError` |
| Ferramentas não leem login, Acessos, 2FA, sessões nem segredos | `apps/agent/src/tools/` |
| A conversa não carrega imagem de fora e mostra o destino de cada link (impede que o modelo mande dados para fora por URL) | `apps/web/src/components/Markdown.tsx` |
| Workers AI não usa o conteúdo do cliente para treinar nem para melhorar serviços | [Workers AI: data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) |

### O que falta, em ordem

| # | Medida | Como | Quando |
| --- | --- | --- | --- |
| D1 | **Contrato do prompt** | Cada seção do prompt declara a origem e a classe (`instrução`, `pessoal`, `sensível`). Um tipo único monta o prompt; nada entra por concatenação solta. Lista fechada do que **nunca** entra: e-mail do dono, senha e hashes, segredos e tokens, ids do Telegram, IP, cidade e rede dos Acessos, códigos de 2FA e de recuperação, cookies e ids de sessão, credenciais de MCP | PR curto avulso, depois do OK do Pablo a este plano |
| D2 | **Teste canário** | O teste grava valores marcados (`CANARIO-…`) em todo lugar sensível (e-mail, segredos, Acessos, sessões, credenciais) e roda conversas, automações e comandos com a IA simulada, que guarda o prompt recebido. Falha se um canário aparecer em qualquer prompt | Junto com D1; cresce a cada etapa |
| D3 | **Marca "nunca enviar para fora"** | Memória e nota podem ser marcadas pelo dono. Item marcado só vai ao Workers AI. Padrão: desmarcado | Etapa 21 (só faz diferença com provedor externo) |
| D4 | **Perfil por provedor** | `account` (Workers AI, na conta do dono): perfil completo. `external` (pago): sem itens marcados, notas só em trecho, histórico mais curto, sem dados de agenda de terceiros. A troca de provedor remonta o contexto com o perfil do destino | Etapa 21 |
| D5 | **Pseudonimização antes de sair** | Para provedor `external`, troca e-mail, telefone, CPF, cartão (Luhn), chave Pix, IBAN e padrões de chave de API (`sk-`, `ghp_`, `AKIA`, JWT) por marcadores (`[EMAIL_1]`). A tabela de troca fica só na memória do turno. Na volta, o Zuri repõe os valores no texto mostrado e nos argumentos das ferramentas, que rodam localmente e passam por Zod. Marcador que não veio desta vez não é reposto | Etapa 21 |
| D6 | **Só provedores com termos aceitáveis** | Entra na lista quem não treina com dados da API e diz por quanto tempo guarda. Tabela de provedores com a data da conferência, como a de preços. Pedir retenção zero quando a empresa oferecer. Nada de recursos que guardam do lado do provedor (arquivos enviados, conversas salvas; na OpenAI, `store: false`) | Etapa 21 |
| D7 | **Aviso antes de ligar provedor externo** | Ao escolher um provedor pago, a tela diz em linguagem simples o que vai para ele e por quanto tempo ele guarda, além da senha recente que a especificação já pede | Etapa 21 |
| D8 | **Embeddings só na conta do dono** | A busca por significado (etapa 17) só usa o Workers AI. Nunca um provedor externo, porque ela leria todo o conteúdo guardado | Etapa 17 |
| D9 | **Mesma regra para toda origem nova** | Telegram (14), MCP (18), agenda (19), eventos remotos (20) e monitor de sites (22) entram em `<data>` e passam pelo contrato D1 e pelo canário D2 | Em cada etapa |
| D10 | **Auditoria** | A etapa 25 confere D1 a D9 e roda o canário em todas as origens | Etapa 25 |

### O que isso não resolve

- O provedor externo vê o que recebe. A pseudonimização tira identificadores
  óbvios, mas não o sentido do texto ("minha consulta no cardiologista
  amanhã"). Por isso o perfil `external` manda menos coisa, e a marca D3
  existe.
- Retenção zero depende da empresa aprovar. O Zuri não promete o que não
  controla: a tela diz o prazo que o provedor declara.

## Mudanças nos prompts das etapas

- **Etapa 21:** a recomendação ao Pablo cita este plano e propõe dividir a
  etapa. **21a**, grátis: cadeia de provedores, disjuntor, modelo reserva do
  Workers AI e D1/D2 se ainda não estiverem prontos. **21b** ⚠️: Anthropic e
  OpenAI com D3 a D7. Nada é implementado sem a resposta do Pablo.
- **Etapa 17:** D8.
- **Etapa 25:** D10.

## Fontes

- [AI Gateway: Fallbacks](https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/)
- [AI Gateway: Universal Endpoint](https://developers.cloudflare.com/ai-gateway/usage/universal/) (aviso de descontinuação)
- [AI Gateway: Dynamic Routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [AI Gateway: Request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [AI Gateway: BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Secrets Store](https://developers.cloudflare.com/secrets-store/) (beta aberto)
- [Workers AI: data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [Anthropic: API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- [OpenAI: Your data](https://developers.openai.com/api/docs/guides/your-data)
- [Gemini API: preços](https://ai.google.dev/pricing) (linha "Used to improve our products" na camada grátis)
