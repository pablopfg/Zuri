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
   `apps/web/public/_headers` (um teste confere que os dois são iguais). Com o
   Turnstile ligado (as duas chaves), a CSP da interface acrescenta só
   `https://challenges.cloudflare.com` em `script-src` e `frame-src`, para o
   widget do login; desligado, nada de fora carrega. A API recebe uma CSP que
   não deixa nada carregar e `Cache-Control: no-store`.
5. **Autenticação**, dentro da API. Toda rota, menos `GET /api/health`,
   exige o cabeçalho `x-zuri-request: 1` e uma `Origin` (ou `Sec-Fetch-Site`)
   da própria origem; sem isso, 403 `CSRF_FAILED`. Depois, só
   `POST /api/auth/login` dispensa sessão; o resto exige o cookie
   `__Host-zuri_session` válido, ou responde 401 `UNAUTHORIZED`. Detalhes em
   [seguranca.md](seguranca.md).
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
Cloudflare (ou pelo deploy, na etapa 24). Grave `PUBLIC_URL`, os dois do Access
e a chave pública do Turnstile como **segredo** (texto cifrado), mesmo sem
serem secretos: o `wrangler deploy` apaga as variáveis comuns do painel que não
estão no `wrangler.jsonc`, e o Worker ficaria fora do ar com `NOT_CONFIGURED`.
Segredos sobrevivem ao deploy.

| Nome | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `PUBLIC_URL` | segredo | sim | Só a origem, em HTTPS, como `https://zuri.exemplo.com.br`, sem caminho nem parâmetros |
| `SESSION_SECRET` | segredo | sim | 48 caracteres aleatórios ou mais |
| `PASSWORD_PEPPER` | segredo | sim | 48 caracteres aleatórios ou mais |
| `OWNER_EMAIL` | segredo | sim | Um e-mail válido; o login compara por HMAC |
| `OWNER_PASSWORD` | segredo | até o 1º login* | 20 caracteres ou mais |
| `OWNER_PASSWORD_HASH` | segredo | não* | `pbkdf2$100000$<sal>$<hash>`, feito com o `PASSWORD_PEPPER` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | segredo | sim (fora do local) | Os dois, do widget do Turnstile; sem eles (ou com as chaves de teste) o login fica fechado com `NOT_CONFIGURED`. Passo a passo em `docs/configuracao-cloudflare.md` |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | segredo | não | Os dois ou nenhum |
| `DEFAULT_TIMEZONE`, `AGENT_NAME` | variável | sim | Já vêm no `wrangler.jsonc` |

\* Instalação sem instalador: grave `OWNER_PASSWORD`. O primeiro login com ela
exige a troca; o Zuri grava o hash da senha nova no banco e a sessão passa a
avisar (`removePlainPasswordSecret`) que o segredo pode ser apagado do painel.
Apagar o segredo depois disso não muda nada. Gravar uma senha nova no painel
(`OWNER_PASSWORD` ou `OWNER_PASSWORD_HASH` com outro valor) ou trocar o
`PASSWORD_PEPPER` é o jeito de redefinir a senha: o Zuri descarta a senha do
banco e encerra todas as sessões. Detalhes em [seguranca.md](seguranca.md).

O que acontece quando falta algo:

- `PUBLIC_URL` ausente ou malformado, ou só metade do Access: **toda**
  requisição recebe 503 `NOT_CONFIGURED`. O Worker não adivinha o host.
- Algum segredo obrigatório ausente ou curto, ou um `OWNER_PASSWORD_HASH`
  malformado: a interface abre, mas a API, inclusive `GET /api/health`, responde
  503 `NOT_CONFIGURED`, sem dizer qual valor falta. O log do Worker, na chamada
  do health check, lista só os **nomes** que faltam.
- Nenhuma senha (nem segredo nem hash no banco): o health check e o login
  respondem 503 `NOT_CONFIGURED`, e o log pede `OWNER_PASSWORD`.

## Modelo de dados

O banco é o SQLite do Durable Object `ZuriAgent`. As tabelas do Zuri começam
com `zur_` e nunca encostam nas `cf_agents_*` do Agents SDK. O banco é criado
sob demanda: a primeira requisição que precisa dele aplica as migrations
pendentes. `GET /api/health` não abre o banco enquanto houver um segredo de senha; sem nenhum, ele confere se há uma senha guardada.

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
| 2 | `zur_sessions` | Sessões do navegador; o id é `HMAC(SESSION_SECRET, token)`, o token só existe no cookie | não |
| 2 | `zur_login_attempts` | Tentativas de senha por rede (IPv4 ou /64 do IPv6), para o limite de força bruta | não |
| 2 | `zur_auth_events` | Atividade de acesso por 90 dias, com `alert_pending` para a etapa 11 | não |
| 2 | `zur_auth_events_daily` | Contagens diárias por tipo e país, sem IP, por 1 ano | não |
| 2 | `zur_devices` | `HMAC` do cookie de aparelho (até 50), para reconhecer um navegador já visto | não |
| 3 | `zur_mfa_secrets` | Segredo TOTP cifrado (AES-GCM), um ativo e um pendente, último passo aceito | não |
| 3 | `zur_recovery_codes` | SHA-256 dos códigos de recuperação ainda não usados | não |
| 3 | `zur_passkeys` | Chave pública, contador e host (`rp_id`) de cada passkey | não |
| 3 | `zur_mfa_challenges` | Logins à espera do segundo passo; id é `HMAC(SESSION_SECRET, cookie)` | não |
| 4 | `zur_projects` | Projetos: nome, descrição, situação | sim (etapa 23) |
| 4 | `zur_tasks` | Tarefas: título, descrição, situação, prioridade, prazo em UTC, projeto | sim (etapa 23) |
| 4 | `zur_notes` | Notas em Markdown, com o índice de texto completo `zur_notes_fts` (FTS5, mantido por gatilhos) | sim (etapa 23) |
| 4 | `zur_trash` | Cópia em JSON do que foi apagado, por 30 dias, com quem apagou e o tamanho | não |
| 4 | `zur_counts` | Contagem de linhas por tipo, mantida por gatilhos, para conferir limites lendo uma linha só | não |
| 5 | índice `zur_tasks_board` | A ordem da lista de tarefas, para "Todas" e "Próximas" lerem uma página e não a tabela inteira | — |
| 6 | `zur_memories` | Memórias: texto, categoria, origem, estado, `superseded_by`, `valid_from`, `valid_until`, `dedupe_key`; índice FTS5 `zur_memories_fts` (gatilhos) e contadores por estado em `zur_counts` | sim (etapa 23) |
| 6 | `zur_memory_reviews` | Revisões pendentes entre duas memórias (um par por vez, até 500) | não |

Valores internos do servidor também ficam em `zur_settings`, com chaves
`auth_*` (o hash da senha trocada no app, a impressão digital dos segredos,
quando a limpeza rodou). O `SettingsRepository` não lê essas chaves e o backup
(etapa 23) usa uma lista positiva, então elas nunca saem do banco.

### Configurações

`SettingsRepository` (`apps/agent/src/db/settings.ts`) devolve as
configurações com os padrões preenchidos: idioma `pt-BR` e o fuso de
`DEFAULT_TIMEZONE` (`America/Sao_Paulo` se a variável faltar ou for inválida)
e a saída automática de 30 min sem uso, 5 min sem aba aberta e 6 h no máximo
(faixas de 5 a 60 min, 3 a 15 min e 1 a 24 h).
Só os campos alterados viram linha no banco. Um valor guardado que deixou de
ser válido é lido como o padrão. Mudança inválida volta como
`VALIDATION_FAILED`, com o nome dos campos e nunca o valor enviado, e cada
mudança real fica no registro de atividade (só os nomes dos campos).

A interface lê e muda as configurações por `GET` e `PATCH /api/settings`
(sessão e CSRF). Mudar a saída automática pede a senha digitada nos últimos 15
minutos, porque uma sessão mais longa vale mais para quem rouba o cookie;
idioma e fuso, não.

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

## Orçamento de duração do Durable Object

O plano Free dá 13.000 GB-s de duração de Durable Object por dia, a 128 MB por
objeto. Pela documentação da Cloudflare, um objeto sem requisição entra em
hibernação depois de 10 s e, enquanto hibernável, não conta duração. Só fica na
memória (e cobrando) quem tem `setTimeout`/`setInterval` pendente, `fetch` ou
`waitUntil` sem terminar ou WebSocket padrão; o Zuri não usa nada disso (regra
P5 de `.claude/rules/performance.md`). A conta real é o tempo de trabalho: uns
50 ms por requisição e o tempo de cada turno de chat em streaming.

O heartbeat da interface (uma batida por minuto, de uma aba só, mesmo com
várias abertas) acorda o objeto uma vez por minuto. Com hibernação, 12 h de app
aberto custam menos de 10 GB-s de batidas. Se algo impedir a hibernação, o
objeto fica carregado a sessão inteira:

| Situação sem hibernação | Tempo carregado | Duração estimada |
| --- | --- | --- |
| Uso contínuo até o máximo padrão (6 h) | 6 h | cerca de 2.700 GB-s (21%) |
| Uso contínuo até o máximo permitido (24 h) | 24 h | cerca de 11.000 GB-s (85%) |

O intervalo da batida não pode passar do limite mínimo de presença (3 min).
Confira a duração real no painel da Cloudflare depois do primeiro deploy e de
cada etapa com Workflows ou alarmes. Se apertar, a saída é diminuir o máximo da
sessão, não espaçar a batida. O orçamento de todas as cotas fica em
[arquitetura/orcamento-free-tier.md](arquitetura/orcamento-free-tier.md).

## Observabilidade

Os Workers Logs ficam ligados, sem corpo de requisição e com a query string
removida (ela pode levar tokens de uso único). Os traces ficam desligados: a
partir de 1/12/2026 eles gastariam a cota diária gratuita de ingestão, a mesma
dos logs. O `wrangler`
não envia métricas de uso (`send_metrics: false`).

O código do Worker escreve nos logs só por `apps/agent/src/log.ts`. Toda linha
tem o mesmo formato: `level`, `event` (lista fechada, como `unhandled_error` e
`ai_error`), e quando houver `code` (o código da API), `route` (`POST
/api/tasks/:id`, com ids trocados por `:id` e sem query string), `requestId`
(o `cf-ray` da requisição, que a Cloudflare também devolve no cabeçalho
`cf-ray` da resposta), `error` (só o nome do erro) e `secrets` (nomes de
configurações faltando). Valores fora do formato esperado são descartados. Para
achar um erro no painel da Cloudflare, filtre por `event` ou pelo `cf-ray`. Um
teste falha se outro arquivo de `src/` chamar `console` direto. O plano
completo de monitoramento está em
[planos/observabilidade.md](planos/observabilidade.md).

## Desenvolvimento local

O `npm run dev` monta a interface e sobe o Worker com `wrangler dev` em
`http://localhost:8787` (o próprio comando define `PUBLIC_URL`). Antes, crie um
`apps/agent/.dev.vars` (ignorado pelo Git) com os segredos de teste:

```ini
SESSION_SECRET=um-valor-local-qualquer-com-pelo-menos-48-caracteres-aqui
PASSWORD_PEPPER=outro-valor-local-com-pelo-menos-48-caracteres-tambem
OWNER_EMAIL=dono@exemplo.com.br
```

O `wrangler dev` só lê do `.dev.vars` os segredos que o `wrangler.jsonc` lista
como obrigatórios, e a senha não está entre eles (depois do primeiro login ela
mora no banco). Passe uma senha local como variável:

```sh
npm run dev -w @zuri/agent -- --var "OWNER_PASSWORD:uma senha local com vinte ou mais"
```

Em `http://localhost` os cookies saem sem o prefixo `__Host-` e sem `Secure`
(`zuri_session`, `zuri_device`); em HTTPS são sempre os `__Host-`.

HTTP só é aceito quando `PUBLIC_URL` aponta para `localhost`, `127.0.0.1` ou
`[::1]`. Em qualquer outro host, o Worker exige HTTPS.

Os testes e2e sobem o mesmo Worker com os valores de `tests/e2e/worker.env`
(e o hash da senha de teste por `--var`, no `playwright.config.ts`), de modo
que cada teste de tela também passa pelos portões.

## Tipos

Os tipos dos bindings e do runtime vêm de `wrangler types`
(`apps/agent/worker-configuration.d.ts`). Mudou o `wrangler.jsonc`, rode
`npm run types -w @zuri/agent`; o `npm run typecheck` falha se o arquivo
estiver desatualizado.
