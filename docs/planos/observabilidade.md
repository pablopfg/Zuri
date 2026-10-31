# Logs e monitoramento em produção: plano

Situação: plano. Nada aqui foi implementado.
Escrito em 31/10/2026, a partir da pergunta do Pablo: "como vamos acompanhar
erros, falhas, bugs e comportamentos inadequados quando estiver em produção?"

## O que já existe na `develop`

| Peça | Onde | O que faz | Limite |
| --- | --- | --- | --- |
| Workers Logs | `apps/agent/wrangler.jsonc` (`observability`) | Guarda um evento por requisição (rota, status, duração, CPU) e as linhas de `console.*`. Sem corpo de requisição, sem query string. Traces desligados. | Plano Free: 200.000 eventos por dia, **3 dias** de retenção. Só se vê no painel da Cloudflare. |
| Logs estruturados de erro | `http/errors.ts`, `ai/provider.ts`, `agent/zuri-agent.ts`, `index.ts` | Erro inesperado vira `INTERNAL_ERROR` para o cliente e uma linha JSON no log com só o **nome** do erro (a mensagem pode citar dados). Avisos de configuração faltando dizem o nome do segredo, nunca o valor. | São 7 pontos no total. Não há contador nem identificador de requisição. |
| Atividade de acesso | `auth/events.ts`, tabela `zur_auth_events`, página `/acessos` | Logins, 2FA, passkeys e sessões com rede, cidade e aparelho. 90 dias detalhados, 1 ano agregado. Eventos que pedem alerta ficam com `alert_pending`. | Só cobre segurança de acesso. Os alertas ainda não saem (canal chega na etapa 11). |
| Uso de IA | `ai/usage.ts`, aba Configurações > IA | Neurons por dia e por modelo, teto de 9.000. | Não registra falhas da IA, só o consumo. |
| `GET /api/health` | `index.ts` | 200 ou 503 `NOT_CONFIGURED` quando falta segredo. | Ninguém consulta sozinho. |
| CI | `.github/workflows` | Typecheck, lint, testes com cobertura mínima, e2e, Lighthouse, CodeQL, Dependabot. | Pega erro antes do deploy, não depois. |

Diagnóstico honesto: hoje o Zuri **registra** erros, mas ninguém fica
**sabendo** deles. Os logs somem em 3 dias, só aparecem no painel da
Cloudflare e nada avisa o dono quando algo dá errado. Erros da interface
(tela que quebra no navegador) não chegam ao servidor. Não há Sentry nem
outro serviço de fora, e isso é de propósito (regras 2 e 7).

## O que a especificação já prevê

Nenhuma etapa é só de observabilidade, mas várias peças estão espalhadas:

- **Etapa 11** (central de avisos): `AlertService.raise()` com deduplicação e
  limites por canal, vigias a cada 15 minutos, entrega dos alertas pendentes
  desde a etapa 3.
- **Etapa 13** (avisos no Telegram): o mesmo `AlertService` passa a entregar no
  Telegram; alertas de segurança sempre no chat privado.
- **Etapa 15** (comandos do bot): `/status` com "versão, saúde do Worker, IA
  disponível, monitores, MCP sem login, idade do backup".
- **Etapa 10**: execuções de automações registradas, com histórico na tela.
- **Etapa 24**: lista de documentos com `docs/solucao-de-problemas.md`.

Falta o elo do meio: um registro próprio de falhas que dure mais que 3 dias,
uma tela onde o dono veja esse registro e a regra de quando uma falha vira
alerta.

## Recomendação

Tudo abaixo cabe no plano gratuito e não usa serviço de fora.

### 1. Continuar com o Workers Logs como está

Ele é o "log bruto" para investigar um caso com até 3 dias. Nada a ligar.
Ajustes pequenos:

- Toda linha de log ganha o mesmo formato: `{ level, event, code, route,
  requestId }`. O `requestId` é o `cf-ray` da requisição, que também volta na
  resposta de erro (`details.ref`), para o dono achar a linha certa no painel.
- Lista fechada do que nunca entra em log (regra 2 e "Nada sensível em log" da
  especificação): IP, e-mail, nome, ids do Telegram, tokens, códigos, senha,
  texto de mensagem, nota, memória ou resposta da IA. Um teste falha se um
  `console.*` receber algo fora dos campos permitidos.
- Nada de `console.log` no caminho comum (P10 continua valendo).

### 2. Registro próprio de falhas no SQLite (aba "Diagnóstico")

Tabela nova `zur_diagnostics`, uma linha por **tipo** de falha, não por
ocorrência:

| Coluna | Exemplo |
| --- | --- |
| `fingerprint` | `api:POST /api/chat:INTERNAL_ERROR:TypeError` |
| `source` | `api`, `ai`, `agendamento`, `interface`, `telegram`, `mcp` |
| `code` e `error_name` | `SERVICE_UNAVAILABLE`, `TimeoutError` |
| `count_total`, `count_today` | 14, 3 |
| `first_at`, `last_at` | datas |
| `last_ref` | o `cf-ray` da última vez |
| `release` | versão do Worker que estava no ar |

- Repetir a mesma falha só soma o contador (um `UPSERT`), então mil erros
  iguais custam uma linha. Teto de 200 tipos; os mais antigos saem primeiro.
  Guarda 30 dias.
- Erros da interface entram por `POST /api/diagnostics/client` (sessão +
  CSRF, no máximo 20 por hora), só com nome do erro, rota da tela e versão.
  Sem mensagem, sem pilha completa.
- Em Configurações aparece a aba **Diagnóstico** com: estado geral (tudo certo
  / atenção / falhando), falhas das últimas 24 h e dos últimos 30 dias,
  quando aconteceu pela última vez e o código para procurar no painel da
  Cloudflare. Botão "Marcar como resolvido" zera o contador do dia.
- Também conta o que não é erro de código mas é comportamento estranho:
  IA recusando por limite, IA fora do ar, automação que falhou, ferramenta
  recusada pela validação, proposta destrutiva recusada, webhook do Telegram
  com assinatura errada.

### 3. Alertas pela central de avisos e pelo Telegram

Usam o `AlertService` da etapa 11, que já tem deduplicação e limite por canal:

| Situação | Prioridade |
| --- | --- |
| Mesma falha 5 vezes em 15 min, ou 20 no dia | alta |
| Falha nova que nunca tinha acontecido nesta versão | média |
| IA chegou a 80% e a 100% do teto de 9.000 Neurons | média / alta |
| Ataques: os alertas de segurança que já existem (login, 2FA, Turnstile) | crítica, sempre no privado |
| `/api/health` falhando na vigia de 15 min | crítica |
| Automação falhou 3 vezes seguidas | média |

No máximo um alerta por tipo de falha por dia. O texto do alerta diz o que
aconteceu e onde ver, sem dado pessoal. No Telegram, o `/status` da etapa 15
passa a mostrar o resumo da aba Diagnóstico.

### 4. O que **não** recomendo agora

- **Sentry** (tem plano grátis): manda pilhas de erro para um serviço de
  fora, que podem levar trechos de dados do dono. Contraria o espírito das
  regras 2 e 7 e o registro próprio cobre o caso de um dono só.
- ⚠️ **Tail Workers e Logpush**: pedem o plano Workers Paid. Só com OK do
  Pablo.
- **Traces**: continuam desligados (P10); a partir de 1/12/2026 gastariam a
  mesma cota dos logs.

## Custo no plano Free

- Workers Logs: sem mudança (o evento por requisição já existe).
- SQLite: uma escrita por falha (o `UPSERT`), zero quando nada falha. Leitura só
  ao abrir a aba ou rodar `/status`.
- Vigia de saúde: entra no alarme único de 15 min da etapa 11 (P8), sem alarme
  novo.
- JavaScript inicial: a aba carrega sob demanda; o envio de erro da interface
  pesa menos de 1 kB.

## Onde encaixa nas etapas

| Parte | Etapa |
| --- | --- |
| Formato único de log, `requestId` e teste de campos proibidos | PR próprio pequeno, já, antes da etapa 10 |
| Tabela `zur_diagnostics`, registro dos erros do servidor e da interface, aba Diagnóstico | Junto da etapa 11 (o alerta depende dela) |
| Regras de alerta acima | Etapa 11; o Telegram herda na 13 |
| `/status` com o resumo | Etapa 15 |
| Falhas de MCP e do monitor de sites | Etapas 18 e 22 usam o mesmo registro |
| "Como investigar um erro" em `docs/solucao-de-problemas.md` | Etapa 24 |
