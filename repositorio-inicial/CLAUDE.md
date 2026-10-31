@AGENTS.md

## Específico do Claude Code

- Regras por área em `.claude/rules/`: carregam sozinhas quando você abre um arquivo do caminho correspondente. Releia a regra antes de mudar a área.
- Skills do projeto (`.claude/skills/`):
  - `/iniciar-etapa`: lê a etapa na especificação, confere dependências e monta o plano.
  - `/verificar`: typecheck, lint e testes, com resumo das falhas.
  - `/revisao-qa`: revisão de QA sênior com matriz de rastreabilidade.
  - `/auditoria-seguranca`: auditoria independente obrigatória ao fim de cada ajuste.
  - `/preparar-pr`: título, changelog e descrição do PR em pt-BR.
  - `/proxima-etapa`: confere as travas, atualiza o progresso, mescla quando permitido e passa o bastão para uma conversa nova.
  - `/nova-migration` e `/nova-ferramenta`: passo a passo seguro das duas mudanças mais delicadas.
- Subagentes (`.claude/agents/`): `qa-senior`, `auditor-seguranca`, `revisor-cloudflare` e `verificador`. Eles não editam código, só relatam. Passe a eles o escopo, nunca as suas conclusões.
- Skills externas (instaladas sozinhas no início da sessão por `scripts/instalar-skills.sh`, fixadas por commit em `.claude/skills-externas/`). Use sem esperar pedido:
  - `mattpocock-skills:codebase-design` e `domain-modeling` no plano; `tdd` na implementação; `diagnosing-bugs` em qualquer falha; `code-review` na revisão de QA; `writing-for-agents` ao editar skills, `AGENTS.md` ou `CLAUDE.md`; `handoff` só para alimentar `progresso.md`.
  - `cloudflare-security-audit:security-audit` na auditoria (modo orientação sempre; completo nas etapas 3, 4, 12, 16, 18, 20 e 25).
  - `humanizer:humanizer` na passada final de todo texto para pessoas (PR, changelog, docs, mensagens), sem mudar fatos nem termos técnicos.
  - `nateherk-design:scroll-craft` só se o Pablo pedir uma página de apresentação; geração pela kie.ai está bloqueada (custo).
  - As regras do repositório vencem as skills externas. Tabela completa, revisão de segurança e como atualizar: `docs/agente/skills-externas.md`.
- Comandos nativos úteis: `/code-review`, `/security-review` e `/simplify`.
- O plugin oficial `cloudflare` (marketplace `cloudflare/skills`) está declarado em `.claude/settings.json`. Prefira as skills dele (`workers-best-practices`, `durable-objects`, `agents-sdk`, `wrangler`) a lembrar APIs da Cloudflare de memória. O servidor MCP da Cloudflare só serve para consultar documentação e o estado da conta; nunca para deploy, mudar recursos ou ler segredos sem pedido do dono.
- Memória versionada: `.claude/memoria/`. Decisão nova do dono vai para `decisoes.md` (sem dados pessoais, domínio ou segredos); erro que você cometeu e corrigiu vai para `armadilhas.md`; o estado das etapas fica em `progresso.md`, que substitui o histórico das conversas anteriores.

## Agent skills

### Issue tracker

Etapas em `docs/especificacao.md`, estado em `.claude/memoria/progresso.md`, bugs em issues do GitHub. See `docs/agents/issue-tracker.md`.

### Domain docs

Contexto único: glossário em `.claude/memoria/glossario.md`, ADRs em `docs/adr/`. See `docs/agents/domain.md`.

## Local

- Preferências locais em `CLAUDE.local.md` ou `.claude/settings.local.json`, ambos ignorados pelo Git.
