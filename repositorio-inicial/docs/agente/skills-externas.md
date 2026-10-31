# Skills externas do agente

O agente do Zuri usa, além das skills do próprio repositório (`.claude/skills/`),
o plugin oficial `cloudflare` e quatro pacotes de skills de terceiros. Todos se
instalam sozinhos no início de cada sessão do Claude Code e entram no fluxo das
etapas sem ninguém precisar chamá-los.

## Como a instalação funciona

| Peça | Papel |
| --- | --- |
| `.claude/skills-externas/.claude-plugin/marketplace.json` | Catálogo local, com cada pacote fixado num commit (`sha`) que foi lido e revisado |
| `.claude/settings.json` | Registra o catálogo (`extraKnownMarketplaces`), liga os plugins (`enabledPlugins`) e roda o instalador no início da sessão (`hooks.SessionStart`) |
| `scripts/instalar-skills.sh` | Idempotente: registra os catálogos, instala o que falta, atualiza para o commit fixado. Leva uns 15 s numa máquina nova e não suja o repositório |

Testado no Claude Code 2.1.314 numa máquina zerada: os cinco plugins carregam e
as skills aparecem com prefixo (`mattpocock-skills:tdd`, `humanizer:humanizer`,
etc.). O prefixo evita choque de nome com as skills do projeto e com os
comandos nativos (`/code-review`).

Em ambiente de nuvem do Claude Code, o hook já resolve. Se quiser ganhar os
15 s, ponha `bash scripts/instalar-skills.sh` no script de setup do ambiente.

## Pacotes, versões e revisão de segurança

| Plugin | Origem | Commit fixado | Licença | O que tem | Revisão |
| --- | --- | --- | --- | --- | --- |
| `mattpocock-skills` | `mattpocock/skills` | `a496f551` | MIT | 27 skills de engenharia (TDD, diagnóstico, design, domínio, code review, grilling) | Só instruções em Markdown; sem hooks, MCP ou scripts executados sozinhos |
| `nateherk-design` | `nateherkai/scroll-craft` | `75d81f74` | MIT | `scroll-craft` (páginas de apresentação com rolagem) | Scripts Node locais (servidor e capturas em localhost). `kie.mjs` chama a API paga kie.ai: **bloqueado** em `permissions.deny` |
| `cloudflare-security-audit` | `cloudflare/security-audit-skill` | `c1c8a8c1` | MIT | `security-audit` (auditoria em 6 fases com validação independente) | Só leitura de código; executa código do alvo apenas em sandbox; resultados fora do repositório |
| `humanizer` | `blader/humanizer` | `0ef9fe5b` | MIT | `humanizer` (tira marcas de escrita de IA) | Só instruções em Markdown |
| `cloudflare` | `cloudflare/skills` | ramo padrão | Apache-2.0 | `workers-best-practices`, `durable-objects`, `agents-sdk`, `wrangler` e outras | Plugin oficial da Cloudflare |

Nenhum pacote traz hooks, servidores MCP ou agentes (conferido com
`claude plugin details`).

## Quando cada skill entra (uso automático)

| Momento do fluxo | Skill | Como |
| --- | --- | --- |
| Plano da etapa (`iniciar-etapa`) | `mattpocock-skills:codebase-design` | Desenhar módulos profundos e onde ficam as fronteiras antes de codar |
| Plano da etapa | `mattpocock-skills:domain-modeling` | Termos novos vão para `.claude/memoria/glossario.md`; decisão de arquitetura vira ADR em `docs/adr/` |
| Implementação | `mattpocock-skills:tdd` | Vermelho, verde, refatorar: o teste do critério de aceite nasce antes do código |
| Teste ou CI falhando, bug, lentidão | `mattpocock-skills:diagnosing-bugs` | Laço de diagnóstico antes de mexer no código |
| Dúvida de API externa (Cloudflare, Telegram, WebAuthn) | `mattpocock-skills:research` e as skills `cloudflare:*` | Fontes primárias; o resultado vai para `docs/pesquisa/` só se for útil para etapas futuras |
| Pergunta de UI que pede protótipo (etapa 5 e telas novas) | `mattpocock-skills:prototype` | Protótipo descartável, nunca mesclado |
| Revisão de QA (`revisao-qa`) | `mattpocock-skills:code-review` | Dois eixos em paralelo: padrões do repositório e aderência à etapa da especificação |
| Auditoria (`auditoria-seguranca`) | `cloudflare-security-audit:security-audit` | Modo orientação em toda etapa; auditoria completa nas etapas 3, 4, 12, 16, 18, 20 e 25 |
| Texto para pessoas (PR, changelog, docs, mensagens ao Pablo) | `humanizer:humanizer` | Uma passada final no texto em pt-BR, sem mudar fatos, termos técnicos nem nomes do código |
| Editar `AGENTS.md`, `CLAUDE.md` ou skills | `mattpocock-skills:writing-for-agents` | Instruções curtas e verificáveis |
| Conversa longa no meio da etapa | `mattpocock-skills:handoff` | O resumo vai para `.claude/memoria/progresso.md`, nunca para um arquivo novo |
| Página de apresentação do Zuri (só se o Pablo pedir) | `nateherk-design:scroll-craft` | Com imagens próprias; nunca gerar imagem ou vídeo pela kie.ai sem OK do Pablo (custo) |

### Regras de precedência

1. As regras do repositório (`AGENTS.md`, `.claude/rules/`, especificação) vencem
   qualquer skill externa.
2. `preparar-pr` é dona do PR: o modelo, o pt-BR e o changelog vêm dela. A
   `mattpocock-skills:pr` só serve de guia de clareza.
3. `progresso.md` é a passagem de bastão. A `handoff` alimenta esse arquivo.
4. O `/code-review` nativo e o `mattpocock-skills:code-review` se somam: o
   nativo procura bugs, o outro confere padrões e especificação.
5. A interface do Zuri é um app de trabalho, não uma página de rolagem: o
   `scroll-craft` não entra nas telas do app.
6. `mattpocock-skills:wizard` gera assistentes de terminal; o Pablo prefere o
   navegador, então os guias para ele continuam em `docs/` com passos pelo painel.

### Skills que só o Pablo chama

Estas skills têm `disable-model-invocation` e ficam disponíveis como comando:
`/mattpocock-skills:grill-me`, `grill-with-docs`, `to-spec`, `to-tickets`,
`wayfinder`, `triage`, `retro`, `teach`, `to-questionnaire`, `wait-what`,
`improve-codebase-architecture`, `implement`, `implement-spec`, `ask-matt` e
`setup-matt-pocock-skills`. A configuração que a última faria já está pronta em
`docs/agents/`.

## Custo de contexto

Cada sessão carrega só o nome e a descrição das skills (cerca de 25 linhas no
total); o conteúdo de uma skill só entra quando ela é usada. A auditoria
completa da Cloudflare abre vários subagentes, por isso roda só nas etapas
sensíveis.

## Como atualizar um pacote

Nunca troque o `sha` sem ler o que mudou.

1. Clone o repositório do pacote fora do Zuri e rode
   `git log --oneline <sha-atual>..HEAD` e `git diff <sha-atual> HEAD`.
2. Confira: nenhum hook, servidor MCP, script que rode sozinho, chamada de rede
   nova, pedido de segredo ou instrução que contrarie as regras do Zuri.
3. Troque o `sha` em `.claude/skills-externas/.claude-plugin/marketplace.json`,
   atualize a tabela acima e abra um PR `chore(agente): atualiza <pacote>` com o
   resumo do diff revisado.
4. Para remover um pacote, tire a entrada do catálogo, do `enabledPlugins` e da
   lista em `scripts/instalar-skills.sh`.
