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
