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
- Push feito com o `GITHUB_TOKEN` não dispara `pull_request`: a PR ficaria sem
  os checks exigidos. O `update-prs.yml` dispara `ci.yml` e `codeql.yml` por
  `workflow_dispatch` na branch. O mesmo token também não pode enviar mudança
  em `.github/workflows/`; nesse caso ele só comenta na PR.
- O `update-prs.yml` pode enviar um commit de merge para a sua branch a
  qualquer momento. Faça `git pull --no-rebase origin <branch>` antes de cada
  push; nunca force push para "limpar" esse commit.
- Runner fixo: todo job usa `runs-on: ubuntu-26.04` (o teste em
  `tests/repo/workflows.test.ts` barra `ubuntu-latest`). O `ubuntu-latest`
  migra de 24.04 para 26.04 entre 19/10 e 19/11/2026 (actions/runner-images
  #14748) e mostrava um aviso em cada job. Escolhemos 26.04 e não 24.04 porque
  o Playwright 1.64.1 já trata o 26.04 como plataforma oficial (dependências
  do `install --with-deps` próprias) e porque fixar em 24.04 só adiaria a
  troca. No 26.04 o `sudo` é o sudo-rs: evite `sudo -E` (use
  `--preserve-env=VAR`). Se algo quebrar só no 26.04, volte para
  `ubuntu-24.04` na mesma constante do teste.
- O GitHub ignora `merge=union` e drivers do `.gitattributes` no botão de
  merge e no cálculo de conflito. Por isso a resolução de acréscimos fica no
  script, e não no `.gitattributes`.

## Testes

- Teste instável é bug: corrija a causa (relógio falso, espera por condição),
  nunca `retries`, `.skip` ou timeout maior.
- Fixe o relógio e o fuso (`America/Sao_Paulo`) em testes de agenda e
  recorrência; cubra a virada de dia e o horário de verão histórico.
- Dependências com versão exata; confira o `package-lock.json` no diff.

- O mundo de teste (`test/chat-world.ts`) precisa passar o mesmo relógio falso
  a todo serviço que olha a hora (`Productivity`, `AutomationService`...). Na
  etapa 10, o `Productivity` sem `clock` usava a hora real: o teste do resumo
  passou num dia e falhou dois dias depois.
- `fsModuleCache: false` precisa ficar em `apps/agent/vitest.config.ts`. Sem
  ele a cobertura do agente cai abaixo do piso de 99% sem nenhum teste mudar
  (etapa 14).
- Ids de `zur_auth_events` voltam a ser usados depois de apagar linhas num
  teste; a chave de deduplicação dos alertas (`zur_alert_keys`) usa o id, então
  um alerta novo some calado. Limpe as duas tabelas juntas (etapa 15a).
- Alerta de segurança gerado dentro de uma atualização do bot só sai em
  `flushSecurityAlerts`. Sem o hook `afterUpdate` do `TelegramService`, ele
  esperava a próxima requisição do app (etapa 15a).
- Em e2e, `page.goto("/rota#token")` estando já em `/rota` só troca o hash, sem
  recarregar. Passe por `about:blank` antes.

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
- O mesmo vale para módulos que importam o roteador: `RequireSession.tsx`
  (`FullScreen`, `SessionChecking`) traz `react-router` junto. Uma tela sob
  demanda que importava um deles separou o roteador em `components-*.js` e
  subiu o JS inicial em 1,5 KB. As telas de primeiro acesso e de trocar a
  senha desenham o próprio `<main>` e recebem `go` por propriedade.
  Lembrete: um `lazy()` sem uso continua no pacote (a chamada não é pura), então
  para medir tire a declaração inteira, não só o uso.
- `/* @__PURE__ */` deixa o bundler apagar a chamada, mas não os argumentos
  dela. Na etapa 11, `z.partialRecord(z.enum(...), z.array(...).transform(...))`
  em `alerts.ts` (importado por `settings.ts`, que está no pacote inicial)
  deixou os argumentos no pacote e trouxe o Zod clássico para a tela de
  Configurações, com +3,2 kB no JS inicial. A saída foi construir o schema
  dentro de uma função marcada: `/* @__PURE__ */ (() => z.partialRecord(...))()`.
- Tudo o que uma tela sob demanda usa de um módulo do `packages/shared` que o
  pacote inicial também importa vai para o chunk inicial (`i18n-*.js`), mesmo
  que só a tela use. Na 11b, dois tipos novos de evento de acesso em `auth.ts`
  passaram o teto em 0,06 kB. A saída foi mover a atividade de acesso para um
  módulo próprio (`auth-activity.ts`), que só as telas de segurança importam: o
  bundler o pôs num chunk sob demanda e o JS inicial caiu 0,4 kB. Para medir
  em bytes, some o gzip nível 9 dos arquivos do `index.html` (o script de
  orçamento arredonda para 0,1 kB).
- Uma tela sob demanda que importa um módulo do pacote inicial que importa
  `ui.tsx` (o `Logo.tsx` importava `cn`) separou `ui.tsx` em `ui-*.js` e subiu
  o JS inicial em 1,1 KB, mas só junto com outra tela sob demanda (o
  `Greeting`). Por isso o `Logo` não importa nada de `ui.tsx`. Para achar a
  causa: troque o conteúdo da tela por imports isolados e meça cada um.
- Um `import` de `react-router` numa tela sob demanda que ainda não o usava
  (a Memória, ou o componente da paleta) separou o roteador num pedaço próprio
  (`hooks-*.js`) e subiu o JS inicial em 1,5 KB. A paleta recebe o `navigate`
  do `AppShell` por propriedade, e a Memória recebe a busca pedida pela paleta
  por `askMemorySearch` em `lib/palette.ts`, sem o roteador.
- Etapa 10: cada pedaço novo dividido entre telas sob demanda (um ícone usado
  por duas telas, um módulo `lib/` comum, `dates.ts` da shared) põe o nome do
  arquivo na lista de pré-carga do pacote inicial: uns 25 bytes a mais cada.
  Use nas telas novas ícones que só elas usam (ou os que o inicial já tem, como
  `Clock`), e passe pedidos da paleta a uma tela por endereço (`#...`) ou
  evento do `window`, sem módulo comum. Textos do `ptBRCore` usados só por
  telas sob demanda vão para o catálogo da tela (`pt-BR-markdown.ts`,
  `pt-BR-settings.ts`). No `join` do catálogo, passe cada parte como argumento
  próprio: `{ ...a, ...b }` dentro da chamada `/* @__PURE__ */` impediu o
  descarte e levou o catálogo inteiro para o inicial (+11 KB). Meça com 3
  casas (`toFixed(3)` numa cópia do `check-bundle-size.ts`).
- Etapa 17: o `RefreshCw` do cartão da busca semântica também estava na Memória
  e virou pedaço comum (+21 bytes). A PR passou com 1 byte de sobra, e a PR
  automática de versão (0.23.0) estourou o teto só porque o número da versão
  mudou. Antes de abrir a PR, confira o total exato em bytes e deixe pelo menos
  20 bytes de folga. Ícone já usado em outra tela sob demanda conta como
  pedaço novo; troque por um do inicial (`RotateCw`, `Clock`).
- 03/11: a develop chegou a 3 bytes do teto e a PR de versão 0.24.0 estourou.
  A folga voltou (926 bytes) tirando do inicial o que quase nunca aparece: o
  formulário da confirmação de senha (`ReauthDialog.tsx`, o `ConfirmDialog` só
  escuta), o aviso de duas etapas (o `AppShell` só o carrega com o 2FA
  desligado), `shortcutLabel` fora de `lib/palette.ts` (um import do `AppShell`
  levava o módulo inteiro) e os textos das seções e do tema para catálogos sob
  demanda. Deixar a `LoginPage` ou a `NotFoundPage` sob demanda dividiu o
  pacote inicial em vários pedaços (com a `NotFoundPage`, o total ainda subiu
  400 bytes): não é o caminho.
- O axe rodando no meio da animação de entrada (opacidade baixa) acusa
  contraste falso. `expectAccessible` espera as animações finitas terminarem.

## Navegador e CSP

- O Zod testa `new Function("")` na primeira validação para decidir se compila
  validadores rápidos. Com a CSP sem `unsafe-eval`, isso gera uma violação da
  CSP em toda página (o Lighthouse marca em "inspector issues"). O
  `packages/shared` liga `z.config({ jitless: true })` em `zod-config.ts`, que
  todo arquivo com schema importa primeiro (veja acima). `tests/e2e/csp.spec.ts`
  pega a volta.
- Pedido recusado antes de ler o corpo (CSRF, sem sessão) fazia o workerd
  registrar "Can't read from request stream after response has been sent". O
  erro nasce no Worker: o fluxo do corpo repassado ao objeto continua sendo lido
  depois que a resposta saiu. Cancelar o corpo no objeto não resolve, e repassar
  por um fluxo próprio também não (cortar o fluxo derruba a resposta do objeto;
  deixar aberto gera `Uncaught undefined` com corpo em partes). A saída é
  `withBodyRead` (`src/gates/body.ts`): o Worker lê o corpo inteiro antes de
  repassar, com teto por caminho (`bodyLimitFor`: clipe de voz só em
  `/api/transcribe`, o tamanho de uma nota nas demais). Rota nova com limite
  maior que esse precisa subir o teto e o teste de `body-read.test.ts`. O e2e falha se o Worker logar
  `Uncaught` (`tests/e2e/worker-log.ts`). Arquivo de entrada do Worker
  (`src/index.ts`) não pode exportar constante: o workerd recusa subir.
- No `wrangler dev`, corpo de vários MB recusado antes de chegar todo faz o
  ProxyWorker do wrangler registrar "Network connection lost" e responder 500.
  É do servidor de desenvolvimento e já acontecia antes; não é o Worker.

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
  a IA simulada (PUBLIC_URL de loopback). O aviso "AI bindings always access
  remote resources" continua: só some com `remote: true`, que faria o
  `wrangler dev` sem `--local` usar a IA da conta (gasta Neurons). Com `--local`
  nada chega à Cloudflare.
- O e2e e o Lighthouse precisam de Node 26 e de
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-*/chrome-linux*/chrome`.
- O Biome lê a pasta `coverage/` se ela existir; ela está fora do lint em
  `biome.json`.
- `String.prototype.trim()` também tira U+FEFF. Um teste de caractere
  invisível com o caractere no fim passa pelo `trim` do schema e não testa
  nada: ponha o caractere no meio do texto.
- Desde os cumprimentos (PR #34) o título do Início é "Bom dia/Boa tarde/Boa
  noite…", não "Olá!": no e2e use `/^(Bom dia|Boa tarde|Boa noite)/`.
- Rebuildar a interface (`npm run build -w @zuri/web`) com o `wrangler dev`
  do e2e no ar faz o servidor responder 404 em tudo até reiniciar: ele perde a
  pasta `apps/web/dist` recriada. Pare o servidor antes de gerar capturas do
  "antes" e suba de novo depois.
- Depois da PR da versão no app (02/11/2026) o JavaScript inicial ficou em
  138.986 bytes, colado no teto de 139 kB. Texto novo no primeiro carregamento
  vai para um `pt-BR-<tela>.ts` com `addMessages` ou tira bytes de outro lugar.
- Constante de `packages/shared` que a interface importa não pode morar num
  módulo que monta esquema Zod (nem que só importe `zod-config.ts` ou `line()`
  de `productivity.ts`): na etapa 18 isso levou 5,9 kB de Zod para o JS
  inicial, mesmo com a tela lazy. Constantes e tipos num arquivo sem Zod
  (`mcp.ts`), esquemas em outro (`mcp-schemas.ts`); confira com
  `node scripts/check-bundle-size.ts` depois do build.
- `new Request(input, init)` consome o corpo de um `Request` passado como
  `input`: num fetch de teste que só lê a URL e repassa `input`/`init`, o
  servidor recebe o corpo vazio. Monte o `Request` uma vez e repasse ele.
- CHECK numa coluna acrescentada por ALTER TABLE em zur_mcp_tools fez cada INSERT do catálogo ler 3 linhas em vez de 1 (free-tier-budget, MCP 100 ferramentas: 436 > 260). Validar o valor no código (03/11/2026, autonomia MCP).
- Animação que começa em `opacity: 0` numa tela inteira tira o texto dela do
  LCP: o Chrome ignora texto pintado transparente e não reconsidera depois.
  No primeiro acesso isso deixou a página sem candidato e o Lighthouse falhava
  com `LanternError: NO_LCP` (nota 0, "failing: none") em parte das execuções.
  O `rise` começa em 0.01 (teste em `apps/web/test/motion.test.ts`); não volte
  para 0 nem crie outra entrada de tela que comece invisível (03/11/2026).
- `<dialog>` modal aberto e fechado num `useEffect` com o conteúdo condicional
  (`{open && …}`): quando o `open` muda num render não urgente (o `useBlocker`
  do React Router roda numa transição), o React tira o conteúdo e só depois
  roda o efeito. Nesse intervalo o modal está aberto e vazio: o Playwright o vê
  como fechado (sem nome), mas a página de trás segue inerte e engole teclas
  (#146, `Ctrl+S` das notas no celular). Abra e feche no `useLayoutEffect`,
  como o `Dialog` de `ui.tsx` (03/11/2026).
