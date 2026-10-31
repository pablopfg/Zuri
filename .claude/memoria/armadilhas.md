# Armadilhas conhecidas

Erros fáceis de cometer neste repositório. Leia antes de mudar algo na área e
acrescente aqui cada armadilha nova que encontrar (sem dados pessoais).

## Cloudflare e Durable Object

- **`ctx.waitUntil` não serve para processar updates do Telegram**: o Worker
  tem um teto curto depois da resposta. O webhook responde 200 rápido e
  entrega o update ao Durable Object, que processa com `keepAliveWhile`.
- **50 subrequests por invocação** no plano Free. Laços que chamam Telegram,
  IA ou MCP precisam de orçamento contado e de parada antes do limite.
- **Neurons do Workers AI** acabam (10 mil por dia). Todo caminho de IA passa
  pelo contador diário; comandos do bot funcionam sem IA.
- **Teto do banco**: 900 MB por padrão. Gravações grandes checam o espaço
  antes; limpeza nunca apaga dado do dono sem aprovação.
- Não confie na memória para APIs da Cloudflare: use as skills do plugin
  `cloudflare` ou a documentação oficial. Confira a data de compatibilidade do
  `wrangler.jsonc`.

## Telegram

- Confira o cabeçalho `X-Telegram-Bot-Api-Secret-Token` com comparação em
  tempo constante **antes** de ler o corpo; limite o corpo a 64 KB.
- `update_id` repetido é normal (o Telegram reenvia): deduplique.
- `callback_data` tem no máximo 64 bytes: use `v1:<ação>:<id opaco>`, nunca
  dados do usuário.
- Só o `TELEGRAM_ADMIN_ID` manda comandos. Mensagem de outro chat é ignorada
  sem resposta que revele o bot.
- Texto vindo do Telegram é dado, nunca instrução: entra no prompt em bloco
  `<data>` neutralizado.
- Escape o texto para o `parse_mode` usado (ou envie sem `parse_mode`).

## Idiomas

- O app abre em pt-BR, mas testes do agente e e2e podem rodar em inglês por
  padrão. Teste que procura texto em português sem fixar o idioma está errado.
- Texto do servidor é gravado como chave e traduzido na exibição. Não grave
  texto já traduzido no banco.
- Plural com `Intl.PluralRules` (`.one`/`.other`), nunca `if (n === 1)`.

## Banco e migrations

- PRs em paralelo podem criar a mesma versão de migration. Ao trazer a
  `develop`, renumere a **sua** (nunca a já mesclada).
- Migration nunca é editada nem reordenada depois de mesclada.

## Skills externas

- As skills de terceiros têm prefixo (`mattpocock-skills:code-review`). Sem
  prefixo, `/code-review` é o comando nativo do Claude Code.
- Não troque o `sha` em `.claude/skills-externas/` sem ler o diff do pacote
  (passo a passo em `docs/agente/skills-externas.md`).
- `scroll-craft` pode gerar imagem e vídeo pagos pela kie.ai: o script está
  bloqueado nas permissões e só se libera com OK do Pablo.
- A auditoria completa da Cloudflare grava arquivos fora do repositório; nunca
  versione `findings.json`, `architecture.md` ou `coverage-ledger.json` dela.

## Permissões do agente

- Regra de `allow` com curinga em comando git (`Bash(git fetch*)`) libera
  `--upload-pack` (executa programa) e `--output` (grava arquivo). Libere só
  formas exatas e mantenha os `deny` de `.claude/settings.json`.
- Todo plugin, inclusive o oficial `cloudflare`, fica fixado por `sha` no
  catálogo local. Nada de marketplace sem ref.

## CI e rulesets

- Nome de check exigido no ruleset = nome do job (ou o `name:` dele, com a
  matriz expandida, como `analyze (actions)`). Mudou o job, mude o ruleset e o
  teste em `tests/repo/`.
- O check `source-branch` roda o workflow da branch do PR; quem mescla na
  `main` confere a origem.

## Testes

- Teste instável é bug: corrija a causa (relógio falso, espera por condição),
  nunca `retries`, `.skip` ou timeout maior.
- Fixe o relógio e o fuso (`America/Sao_Paulo`) em testes de agenda e
  recorrência; cubra a virada de dia e o horário de verão histórico.
- Dependências com versão exata; confira o `package-lock.json` no diff.

## Agents SDK

- A capability `mcp` do Agents SDK responde ao callback OAuth em
  `capabilityRunner.request`, **antes** do `onRequest` e do portão 5 (Hono).
  Na etapa do MCP, confira que o callback não escapa da autenticação e que
  `successRedirect`/`errorRedirect` nunca vêm de entrada do usuário.
- Use `env.AGENT.getByName(...)` para repassar requisições: `getAgentByName`
  faz uma RPC extra por chamada, e cada uma conta nas requisições de Durable
  Object do plano Free.
- Nenhum código fora de `gates/access.ts` lê cabeçalhos `cf-access-*`; o Worker
  os remove antes do repasse ao Durable Object.

## Logs

- Os invocation logs estão ligados. Antes da etapa 12, confira num log real do
  painel se cabeçalhos como `x-telegram-bot-api-secret-token` aparecem; se
  aparecerem, desligue `invocation_logs` ou torne o segredo rotacionável.

## Segredos no `wrangler dev`

- Com `secrets.required` no `wrangler.jsonc`, o `wrangler dev` só carrega do
  `--env-file`/`.dev.vars` os segredos listados ali. Um segredo opcional (como
  `OWNER_PASSWORD_HASH`) vai por `--var NOME:valor` (veja `playwright.config.ts`).
  Tirar um segredo de `secrets.required` faz ele sumir do servidor do e2e e do
  Lighthouse sem erro nenhum, só o health em 503 até o tempo acabar: passe-o
  por `--var` no mesmo PR (aconteceu com `OWNER_EMAIL` no primeiro acesso).
- "Can't read from request stream after response has been sent" aparece no log
  do `wrangler dev` quando a API recusa um pedido com corpo antes de lê-lo
  (CSRF, sem sessão). Já existia antes da etapa 3, não afeta a resposta e
  cancelar o corpo não resolve. Não é falha de teste.

## Limitador de login

- A contagem global de recusas fica na memória do `LoginLimiter` (carregada uma
  vez por objeto). Em teste, linhas gravadas direto em `zur_login_attempts`
  depois do primeiro uso não são vistas: grave antes, ou use `rebuild()` para
  um serviço novo.
- Leia o estado do banco (`sync`) **antes** de ler a fonte da senha; ler antes
  deixou a senha antiga entrar uma vez depois de uma redefinição (SEC-3-01).

## Concorrência no Durable Object

- Um `await` (WebCrypto, verificação de passkey) deixa outro pedido entrar.
  Contagens que limitam tentativas precisam ser reservadas **antes** do
  `await` e devolvidas depois, e o que foi checado antes (senha, sessão)
  reconferido dentro do `transactionSync` (QA-4-01, CF-4-01, CF-4-02).
- Pedido recusado por limite não pode gravar uma linha a cada vez: dobre na
  atividade (`FOLDED_KINDS`) ou devolva o estado já guardado (SEC-4-01, cota de
  gravações do plano Free).

## Git com subagentes

- Nunca `git add -A`: os auditores deixam testes `tmp-audit-*.test.ts` no
  worktree. Adicione caminhos explícitos.

## SQLite do Durable Object

- Um padrão de `LIKE` ou `GLOB` passa de 50 bytes e a consulta falha (500),
  mas só quando a tabela tem linhas; em teste com tabela vazia passa. Para
  busca literal use `instr(<searchColumn(coluna, q)>, ?)` com `q = foldSearch(texto)`
  (`productivity/search.ts`), como na etapa 6 (CF-6-01).
- `lower()` do SQLite só dobra A–Z: `lower('Água')` continua `Água`, e "água"
  não achava "Água". Por isso `foldedColumn` troca as maiúsculas acentuadas
  latinas antes do `lower()`, mas só quando a busca tem acento: as 30 trocas
  por linha custam cerca de 20 vezes mais CPU numa tabela grande.
- Texto gravado em NFD antes de 31/10/2026 só é achado por busca com acento
  depois de editado (a busca vai em NFC). Navegadores mandam NFC, então é raro.
- O SQLite guarda UTF-8: um surrogate solto vira U+FFFD sem aviso. Os schemas de
  texto recusam surrogate solto e guardam em NFC.
- Sem `ANALYZE`, o planejador prefere um índice `(status, due_at)` a um índice
  parcial e ordena tudo. Confira `EXPLAIN QUERY PLAN` e `rowsRead` com algumas
  mil linhas antes de confiar num índice novo (CF-6-03).
- `packages/shared` é marcado `sideEffects` (só `zod-config.ts` fica) para o
  bundler cortar schemas que a interface não usa. Com isso, a ordem dos
  imports do `index.ts` deixa de valer: todo arquivo que cria schema Zod
  importa `./zod-config.ts` primeiro, senão o Zod testa `new Function` e a
  CSP registra uma violação (`polish.spec.ts`).

## Pacote da interface

- Uma tela nova sob demanda pode fazer o rolldown dividir o pacote inicial em
  pedaços (`ui-*.js`, `useQuery-*.js`), e o JS inicial sobe de 2 a 11 KB sem
  código novo no começo. Na etapa 7, duas coisas fizeram isso: schemas de
  `packages/shared/src/memory.ts` sem `/* @__PURE__ */` (levaram o zod
  clássico para a tela) e `hooks/settings.ts` usado por duas telas sob demanda
  (virou um pedaço comum que o pedaço de entrada importava). Corrigir os dois
  baixou de 151 para 142,4 KB, mas ainda sobram `ui-*.js` e `useQuery-*.js`
  divididos, sem causa achada: uma tela de teste que só importa `cn` de
  `ui.tsx` já divide a develop. As opções do rolldown (`chunkOptimization`,
  `strictExecutionOrder`, `preserveEntrySignatures`, grupos em
  `codeSplitting`) não resolveram. Rode `npm run size` a cada import novo e
  compare a lista de arquivos com a da develop.
- O bundler põe cada módulo inteiro num pedaço só. Um módulo de
  `packages/shared` que o pacote inicial importa (como `settings.ts`, por causa
  de `isTimeZone`) leva para o primeiro carregamento tudo o que uma tela sob
  demanda usar dele ou dos módulos que ele importa. Na etapa 8, isso pôs 0,7 KB
  da aba IA no `ui-*.js`. A saída foi separar: `time-zone.ts` (o que o
  início precisa), `ai-limits.ts` (o mínimo das configurações) e `ai.ts` (o
  resto, só na tela). Também `formatUsd` de `format.ts` entrou no inicial ao
  ser usado só pela aba: formate na própria tela.
- Um `import` de `react-router` numa tela sob demanda que ainda não o usava
  (a Memória, ou o componente da paleta) separou o roteador num pedaço próprio
  (`hooks-*.js`) e subiu o JS inicial em 1,5 KB. A paleta recebe o `navigate`
  do `AppShell` por propriedade, e a Memória recebe a busca pedida pela paleta
  por `askMemorySearch` em `lib/palette.ts`, sem o roteador.
- O axe rodando no meio da animação de entrada (opacidade baixa) acusa
  contraste falso. `expectAccessible` espera as animações finitas terminarem.

## Navegador e CSP

- O Zod testa `new Function("")` na primeira validação para decidir se compila
  validadores rápidos. Com a CSP sem `unsafe-eval`, isso gera uma violação da
  CSP em toda página (o Lighthouse marca em "inspector issues"). O
  `packages/shared` liga `z.config({ jitless: true })` em `zod-config.ts`, que
  todo arquivo com schema importa primeiro (veja acima). `tests/e2e/csp.spec.ts`
  pega a volta.
- Pedido recusado antes de ler o corpo (CSRF, sem sessão) faz o workerd
  registrar "Can't read from request stream after response has been sent" no
  `wrangler dev`. Não afeta a resposta; cancelar o corpo no objeto não resolve
  (o erro nasce no Worker, que repassa o fluxo). Fica para investigar.

- `response.finished()` do Playwright não termina numa resposta em SSE que o
  navegador lê aos poucos: o teste trava até o tempo limite. Espere o estado da
  tela (o botão Parar sumir, nenhum `[aria-busy=true]`), não o fim da resposta.
- `role="log"` direto num `<ol>` tira a semântica de lista e o axe acusa
  "listitem". Ponha o `role="log"` numa `div` em volta da lista.
- O `request.signal` não avisa o Durable Object quando a aba fecha: sem os
  flags `enable_request_signal` e `request_signal_passthrough`, o sinal nunca
  dispara. O chat descobre a aba fechada pela escrita que falha, e manda um
  `: ping` a cada 5 s para isso valer também nos passos sem texto.
- `test.use({ launchOptions })` não vale dentro de um `describe`: um teste que
  precisa de outro navegador (microfone falso) vai para um arquivo próprio.

## Ambiente de nuvem

- Com o binding `ai` no `wrangler.jsonc`, `wrangler dev` sem `--local` tenta
  abrir uma sessão remota e falha sem `CLOUDFLARE_API_TOKEN`. `npm run dev` e o
  servidor do e2e usam `--local`: o binding fica "not supported" e o agente usa
  a IA simulada (PUBLIC_URL de loopback).
- O e2e e o Lighthouse precisam de Node 26 e de
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-*/chrome-linux*/chrome`.
- O Biome lê a pasta `coverage/` se ela existir; ela está fora do lint em
  `biome.json`.
