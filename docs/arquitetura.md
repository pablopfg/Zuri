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
Cloudflare (ou pelo deploy, na etapa 24). Grave `PUBLIC_URL` e os dois do Access
como **segredo** (texto cifrado), mesmo sem serem secretos: o `wrangler deploy`
apaga as variáveis comuns do painel que não estão no `wrangler.jsonc`, e o
Worker ficaria fora do ar com `NOT_CONFIGURED`. Segredos sobrevivem ao deploy.

| Nome | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `PUBLIC_URL` | segredo | sim | Só a origem, em HTTPS, como `https://zuri.exemplo.com.br`, sem caminho nem parâmetros |
| `SESSION_SECRET` | segredo | sim | 48 caracteres ou mais |
| `PASSWORD_PEPPER` | segredo | sim | 48 caracteres ou mais |
| `OWNER_PASSWORD_HASH` | segredo | sim* | Não vazio (o formato é conferido na etapa 3) |
| `OWNER_PASSWORD` | segredo | sim* | 20 caracteres ou mais; só quando não há `OWNER_PASSWORD_HASH` |
| `OWNER_EMAIL` | segredo | sim | Um e-mail válido |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | segredo | não | Os dois ou nenhum |
| `DEFAULT_TIMEZONE`, `AGENT_NAME` | variável | sim | Já vêm no `wrangler.jsonc` |

\* Um dos dois: o hash, ou a senha em texto até o primeiro login trocá-la (etapa 3).

O que acontece quando falta algo:

- `PUBLIC_URL` ausente ou malformado, ou só metade do Access: **toda**
  requisição recebe 503 `NOT_CONFIGURED`. O Worker não adivinha o host.
- Algum segredo obrigatório ausente ou curto: a interface abre, mas a API,
  inclusive `GET /api/health`, responde 503 `NOT_CONFIGURED`, sem dizer qual
  valor falta.

## Modelo de dados

O banco é o SQLite do Durable Object `ZuriAgent`. As tabelas do Zuri começam
com `zur_` e nunca encostam nas `cf_agents_*` do Agents SDK. O banco é criado
sob demanda: a primeira requisição que precisa dele aplica as migrations
pendentes. `GET /api/health` não abre o banco.

As migrations ficam em `apps/agent/src/db/migrations.ts` e só crescem. Cada uma
roda numa transação junto com o aumento de versão em `zur_schema_version`; se
falhar, nada dela fica gravado e a próxima requisição tenta de novo. Um teste
recusa `DROP`, `DELETE FROM`, `RENAME` e qualquer menção a `cf_agents_`, e outro
fixa o hash de cada migration já mesclada, para ninguém editar uma antiga.

| Versão | Tabela | Para quê | Backup |
| --- | --- | --- | --- |
| — | `zur_schema_version` | Versão aplicada (uma linha) | não |
| 1 | `zur_settings` | Uma linha por configuração alterada, valor em JSON | só as chaves não sensíveis (etapa 23) |
| 1 | `zur_activity` | Registro de atividade: quando, o quê e detalhes sem segredos | não |

### Configurações

`SettingsRepository` (`apps/agent/src/db/settings.ts`) devolve as
configurações com os padrões preenchidos: idioma `pt-BR` e o fuso de
`DEFAULT_TIMEZONE` (`America/Sao_Paulo` se a variável faltar ou for inválida).
Só os campos alterados viram linha no banco. Um valor guardado que deixou de
ser válido é lido como o padrão. Mudança inválida volta como
`VALIDATION_FAILED`, com o nome dos campos e nunca o valor enviado, e cada
mudança real fica no registro de atividade (só os nomes dos campos).

Teto do banco: 900 MB, abaixo do limite de 1 GB por Durable Object com SQLite
no plano Free (FAQ de limites da Cloudflare, conferido em 31/10/2026; a conta
inteira tem 5 GB). `Database.size()` lê o tamanho; a recusa com
`STORAGE_LIMIT_REACHED` chega com os limites por tipo (etapa 23).

## Idiomas

Todo texto visível sai do catálogo em `packages/shared/i18n/{pt-BR,en}.ts`.
`t(locale, chave, params)` interpola `{nome}`; `plural(locale, base, n)` usa
`Intl.PluralRules` e as chaves `<base>.one` e `<base>.other`. Datas e valores
usam `formatDateTime` e `formatUsd` (`30/10/2026 às 15:16`, `US$ 1,25`).

Os erros da API saem no idioma das configurações quando passam pelo Durable
Object. As recusas dos portões do Worker (host, HTTPS, Access, configuração)
saem em pt-BR: elas acontecem antes de o objeto acordar, e acordá-lo só para
ler o idioma de uma requisição recusada não vale o custo.

O lint de i18n (`scripts/lint-i18n.ts`, roda no `npm run lint` e no job `i18n`)
falha com chave faltando num idioma, tradução vazia, chave sem uso e texto
visível escrito fora do catálogo: texto JSX, os atributos `title`,
`aria-label`, `placeholder` e `alt`, e os argumentos de `new AppError(...)`.
Exceções ficam em `i18n-ignore.json`, cada uma com arquivo, texto e motivo; uma
exceção que não corresponde a mais nada também faz o lint falhar.

## Observabilidade

Os Workers Logs ficam ligados, sem corpo de requisição e com a query string
removida (ela pode levar tokens de uso único). Os traces ficam desligados: a
partir de 1/12/2026 eles gastariam a cota diária gratuita de ingestão, a mesma
dos logs. O `wrangler`
não envia métricas de uso (`send_metrics: false`).

## Desenvolvimento local

O `npm run dev` monta a interface e sobe o Worker com `wrangler dev` em
`http://localhost:8787` (o próprio comando define `PUBLIC_URL`). Antes, crie um
`apps/agent/.dev.vars` (ignorado pelo Git) com os segredos de teste:

```ini
SESSION_SECRET=um-valor-local-qualquer-com-pelo-menos-48-caracteres-aqui
PASSWORD_PEPPER=outro-valor-local-com-pelo-menos-48-caracteres-tambem
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
