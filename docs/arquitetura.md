# Arquitetura

O Zuri roda inteiro num **único Worker** da Cloudflare. Ele serve a interface
web e a API, e guarda todos os dados num **único Durable Object** com SQLite,
criado com o Agents SDK. Não há D1, KV nem R2: tudo cabe no plano gratuito e a
autorização fica num ponto só.

| Peça | Onde fica | Para quê |
| --- | --- | --- |
| Worker | `apps/agent/src/index.ts` | Recebe toda requisição e aplica os portões |
| Durable Object `ZuriAgent` | `apps/agent/src/agent/zuri-agent.ts` | O agente e o banco, numa instância só |
| API | `apps/agent/src/api/app.ts` | App Hono que roda dentro do Durable Object |
| Interface | `apps/web` (binding `ASSETS`) | PWA servida pelo mesmo Worker |
| Configuração | `apps/agent/wrangler.jsonc` | Bindings, migrations e observabilidade |

## Portões de toda requisição

Com `run_worker_first: true`, a interface também passa pelo Worker antes de
chegar aos arquivos estáticos. Os portões rodam nesta ordem:

1. **Host permitido.** Só o host de `PUBLIC_URL` é atendido. Qualquer outro
   nome, inclusive `*.workers.dev` e endereços de preview, recebe 403
   `HOST_NOT_ALLOWED`. O `wrangler.jsonc` já deixa `workers_dev` e
   `preview_urls` desligados.
2. **HTTP para HTTPS.** GET ou HEAD anônimo em HTTP recebe 301 para o mesmo
   endereço em HTTPS. Pedido com corpo ou com credencial (cookie na API,
   `Authorization` ou o cabeçalho secreto do Telegram) recebe 403: o dado já
   passou em texto aberto, e um redirecionamento esconderia o vazamento.
3. **Cloudflare Access**, quando `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` estão
   definidos. O Worker confere a assinatura do token `Cf-Access-Jwt-Assertion`,
   o público, o emissor e a validade. A única exceção é o webhook do Telegram
   (`POST /api/telegram/webhook`), que passa só com o cabeçalho secreto certo
   e sem cookie nem `Authorization`.
4. **Cabeçalhos de segurança** em toda resposta. A interface recebe CSP
   estrita, HSTS, `frame-ancestors 'none'` e `Permissions-Policy`, os mesmos de
   `apps/web/public/_headers` (um teste confere que os dois são iguais). A API
   recebe uma CSP que não deixa nada carregar e `Cache-Control: no-store`.
5. **Autenticação**, dentro da API. Só as rotas registradas antes do
   middleware de credencial são públicas (hoje, só `GET /api/health`). As
   sessões chegam na etapa 3; até lá, toda outra rota responde 401
   `UNAUTHORIZED`.
6. **Repasse ao Durable Object** de nome fixo (`AGENT_INSTANCE_NAME`, em
   `packages/shared`). Nenhuma rota, cabeçalho ou parâmetro escolhe outra
   instância. Os cabeçalhos internos do Agents SDK (`x-agents-*`,
   `x-cf-agents-*` e parecidos) são removidos antes do repasse, e caminhos de
   sub-agente (`/sub/…`) recebem 404.

Conexões WebSocket são recusadas com 403 em qualquer caminho, no Worker e
também no Durable Object.

Erros saem sempre no formato `{ code, message, details? }`, com o texto do
catálogo de traduções. Uma falha inesperada vira `INTERNAL_ERROR` (500), sem
stack trace na resposta, e o log registra só o nome do erro.

## Configuração

Nada pessoal fica no repositório. Os valores abaixo são definidos no painel da
Cloudflare (ou pelo deploy, na etapa 24).

| Nome | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `PUBLIC_URL` | variável | sim | Só a origem, em HTTPS, como `https://zuri.exemplo.com.br`, sem caminho nem parâmetros |
| `SESSION_SECRET` | segredo | sim | 32 caracteres ou mais |
| `PASSWORD_PEPPER` | segredo | sim | 32 caracteres ou mais |
| `OWNER_PASSWORD_HASH` | segredo | sim | Não vazio (o formato é conferido na etapa 3) |
| `OWNER_EMAIL` | segredo | sim | Um e-mail válido |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | variável | não | Os dois ou nenhum |
| `DEFAULT_TIMEZONE`, `AGENT_NAME` | variável | sim | Já vêm no `wrangler.jsonc` |

O que acontece quando falta algo:

- `PUBLIC_URL` ausente ou malformado, ou só metade do Access: **toda**
  requisição recebe 503 `NOT_CONFIGURED`. O Worker não adivinha o host.
- Algum segredo obrigatório ausente ou curto: a interface abre, mas a API,
  inclusive `GET /api/health`, responde 503 `NOT_CONFIGURED`, sem dizer qual
  valor falta.

## Observabilidade

Os Workers Logs ficam ligados, sem corpo de requisição e com a query string
removida (ela pode levar tokens de uso único). Os traces ficam desligados,
porque passam a contar como uso cobrado a partir de 1/12/2026. O `wrangler`
não envia métricas de uso (`send_metrics: false`).

## Desenvolvimento local

O `npm run dev` monta a interface e sobe o Worker com `wrangler dev` em
`http://localhost:8787` (o próprio comando define `PUBLIC_URL`). Antes, crie um
`apps/agent/.dev.vars` (ignorado pelo Git) com os segredos de teste:

```ini
SESSION_SECRET=um-valor-local-com-pelo-menos-32-caracteres
PASSWORD_PEPPER=outro-valor-local-com-pelo-menos-32-caracteres
OWNER_PASSWORD_HASH=provisorio
OWNER_EMAIL=dono@exemplo.com.br
```

HTTP só é aceito quando `PUBLIC_URL` aponta para `localhost`, `127.0.0.1` ou
`[::1]`. Em qualquer outro host, o Worker exige HTTPS.

Os testes e2e sobem o mesmo Worker com os valores de `tests/e2e/worker.env`,
de modo que cada teste de tela também passa pelos portões.

## Tipos

Os tipos dos bindings e do runtime vêm de `wrangler types`
(`apps/agent/worker-configuration.d.ts`). Mudou o `wrangler.jsonc`, rode
`npm run types -w @zuri/agent`; o `npm run typecheck` falha se o arquivo
estiver desatualizado.
