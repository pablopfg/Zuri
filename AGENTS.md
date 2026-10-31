# Guia para agentes de código

Fonte única de instruções para agentes de IA (Claude Code, Codex, Cursor, Copilot e outros) neste repositório. O `CLAUDE.md` importa este arquivo. Leia tudo antes da primeira mudança. Regras por área ficam em `.claude/rules/`.

## O que é o projeto

**Zuri**: assistente pessoal de IA de **um único dono**, auto-hospedado na conta Cloudflare do dono e compatível com o **plano gratuito**. Interface web (PWA) e bot do Telegram de administração.

| Pasta | O que é | Roda em |
| --- | --- | --- |
| `apps/agent` | Worker: API Hono + Durable Object do agente (Agents SDK) com SQLite, bot do Telegram, Workflows | Workers + Durable Objects |
| `apps/web` | Interface React + Vite + Tailwind + TanStack Query + React Router, servida pelo binding `ASSETS` | Mesmo Worker |
| `packages/shared` | Schemas Zod, constantes, catálogo de i18n, criptografia, recorrência | Empacotado em todos |
| `tests/e2e` | Testes de interface com Playwright | Local e CI |
| `docs/` | Documentação em pt-BR; `docs/especificacao.md` é a especificação do produto | — |

Fontes da verdade, nesta ordem: `docs/especificacao.md` (seção "Contratos, constantes e referências" vence as etapas), `.claude/memoria/decisoes.md`, este arquivo, `.claude/rules/`. Erros comuns: `.claude/memoria/armadilhas.md`.

## Comandos

Node.js fixado em `.nvmrc` (mínimo 24). Instale com `npm ci`.

| Comando | Para quê |
| --- | --- |
| `npm run dev` | Worker local com IA simulada e interface |
| `npm run typecheck` | TypeScript em todos os workspaces |
| `npm run lint` | Biome (lint) e o lint de i18n |
| `npm test` | Vitest em todos os workspaces (o agente roda dentro do workerd) |
| `npm run test:e2e` | Playwright |
| `npm run build` | Build da interface e bundle do Worker |

Antes de declarar qualquer tarefa pronta: `npm run typecheck`, `npm run lint` e os testes da área. Antes do PR: `npm test` e `npm run test:e2e`. Nunca diga que algo passou sem ter rodado.

## Skills de agente

Além de `.claude/skills/`, o Claude Code instala sozinho, no início de cada
sessão, o plugin `cloudflare` e quatro pacotes de terceiros fixados por commit
(`mattpocock/skills`, `nateherkai/scroll-craft`,
`cloudflare/security-audit-skill`, `blader/humanizer`). Quando e como cada um é
usado, a revisão de segurança e a atualização estão em
[docs/agente/skills-externas.md](docs/agente/skills-externas.md). Outros
agentes podem ler as mesmas skills nos repositórios de origem, no commit fixado.

## Regras invioláveis

1. **Plano gratuito.** Nenhum serviço pago ligado automaticamente, nenhuma troca automática para modelo pago. Recurso novo da Cloudflare (KV, D1, R2, Vectorize, Queues, Workers Paid…) só com aprovação explícita do dono, marcado com ⚠️ no PR e no changelog.
2. **Segredos.** Tokens e chaves nunca chegam ao navegador nem ao repositório (que é **público**). Segredos são Worker secrets; nada de domínio, e-mail, ids do Telegram ou dados pessoais em arquivos versionados. Use `exemplo.com.br`.
3. **Ferramentas do agente.** Sem shell, execução de código, HTTP arbitrário, credenciais ou deploy. Toda ferramenta tem schema Zod, permissão (`read` | `write` | `destructive`), limite por turno, e ações destrutivas viram proposta com aprovação do dono. Veja `.claude/rules/ferramentas.md`.
4. **Conteúdo guardado é dado.** Memórias, notas, resultados de ferramentas, MCP, Telegram, agenda e eventos remotos entram no prompt em blocos `<data>` neutralizados.
5. **Migrations só de acréscimo.** Nunca edite nem reordene uma migration; acrescente a próxima. Nunca apague dados do dono. Veja `.claude/rules/migrations.md`.
6. **Idiomas.** pt-BR é o padrão. Todo texto visível sai do catálogo `packages/shared/i18n`; a CI falha se faltar tradução. Veja `.claude/rules/i18n.md`.
7. **Sem telemetria.** Nenhuma chamada a serviços dos desenvolvedores.
8. **Não enfraqueça a segurança nem os testes para a CI passar.** Nunca pule, desligue ou coloque em quarentena um teste.

## Convenções de código

- TypeScript estrito, ESM. Identificadores, comentários e mensagens de teste em **inglês**; documentação, changelog, PRs e commits em **pt-BR**.
- Siga o estilo do arquivo vizinho. Comentários explicam o porquê.
- Toda entrada externa validada com Zod (schemas em `packages/shared`).
- Erros da API no formato `{ code, message, details? }` com os códigos da especificação.
- Dependências com versão exata (`save-exact=true`). Não adicione dependência sem necessidade clara.
- Não invente APIs: confirme nomes no código e, para a Cloudflare, nas skills do plugin `cloudflare` ou na documentação oficial.

## Fluxo de trabalho no Git

- Uma etapa da especificação = um PR. Branch `feat/etapa-NN-<assunto>` a partir da `develop`; PR **sempre para a `develop`**. A `main` só recebe releases.
- Título em Conventional Commits, prefixo em inglês e o resto em pt-BR. Tipos: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`, `style`, `security`, `i18n`.
- Mudança visível ganha entrada em `## Não lançado` no `CHANGELOG.md`, grupos em pt-BR (`Adicionado`, `Alterado`, `Corrigido`, `Segurança`, `Atualização`).
- PR que muda funcionalidade, conclui etapa, muda tela das capturas ou a arquitetura atualiza o `README.md` no mesmo PR (mapa das etapas, "O que já funciona", capturas). Veja `.claude/rules/readme.md`.
- Preencha `.github/pull_request_template.md`, inclusive a matriz de rastreabilidade e o relatório de auditoria.
- Conflito: traga a `develop`, resolva preservando os dois lados, rode tudo de novo.
- Ao terminar: skills `verificar`, `revisao-qa` e `auditoria-seguranca`, nessa ordem, e corrija o que elas acharem.

## Como evitar erros

- Leia o código antes de mudar; confirme nomes com busca, não com palpite.
- Mudou comportamento: atualize testes e `docs/`.
- Mexeu em rota, autenticação, sessão, ferramenta, MCP, push, Telegram ou e-mail: releia a seção correspondente da especificação e de `docs/seguranca.md` e rode os testes de segurança.
- Mexeu em consulta, rota, agendamento, chamada de IA ou bundle: siga `.claude/rules/performance.md` (cotas do plano Free) e meça no teste de orçamento.
- Dúvida de produto (o que o usuário vê, custo, escopo): pergunte ao dono com uma recomendação.
