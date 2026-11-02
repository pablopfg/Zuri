# Skills externas do agente

O agente do Zuri usa, além das skills do próprio repositório (`.claude/skills/`),
o plugin oficial `cloudflare` e sete pacotes de skills de terceiros. Todos se
instalam sozinhos no início de cada sessão do Claude Code e entram no fluxo das
etapas sem ninguém precisar chamá-los.

## Como a instalação funciona

| Peça | Papel |
| --- | --- |
| `.claude/skills-externas/.claude-plugin/marketplace.json` | Catálogo local, com cada pacote fixado num commit (`sha`) que foi lido e revisado |
| `.claude/settings.json` | Registra o catálogo (`extraKnownMarketplaces`), liga os plugins (`enabledPlugins`) e roda o instalador no início da sessão (`hooks.SessionStart`) |
| `scripts/instalar-skills.sh` | Idempotente: registra os catálogos, instala o que falta, atualiza para o commit fixado. Leva uns 15 s numa máquina nova e não suja o repositório |

Testado no Claude Code 2.1.314 numa máquina zerada (e no 2.1.316 depois dos
três pacotes de 02/11/2026): os plugins carregam e
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
| `cloudflare` | `cloudflare/skills` | `86505e44` | Apache-2.0 | `workers-best-practices`, `durable-objects`, `agents-sdk`, `wrangler` e outras, e o servidor MCP `mcp.cloudflare.com` | Plugin oficial da Cloudflare, fixado como os demais desde a etapa 0 (antes seguia o ramo padrão e se atualizava sozinho) |
| `impeccable` | `pbakaus/impeccable` (pasta `plugin`) | `e89e3ada` | Apache-2.0 | `impeccable` com 24 comandos de design (`critique`, `audit`, `polish`, `harden`, `adapt`, `clarify`, `layout`, `typeset`…), 4 subagentes e um detector de 62 regras | Traz hooks (veja abaixo). O detector é um binário Rust baixado uma vez das releases do GitHub e conferido contra o SHA-256 gravado no commit fixado. Nenhuma chamada ao site do impeccable (telemetria, checagem de versão e sorteio de direção visual cortados) |
| `frontend-design` | `anthropics/skills` (pasta `skills/frontend-design`) | `ca45fc49` | Apache-2.0 | `frontend-design` (direção visual intencional, sem cara de modelo pronto) | Só instruções em Markdown |
| `ponytail` | `DietrichGebert/ponytail` (pasta `skills`) | `96608e07` | MIT | `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt` | Só as skills em Markdown. Os hooks do pacote (modo sempre ligado, painel de custos que grava em `~/.config` e webhook opcional) ficam de fora porque a pasta `skills` não os inclui |

Só o `impeccable` traz hooks e agentes (conferido com `claude plugin details`);
nenhum pacote traz servidor MCP.

### Os hooks do impeccable

| Hook | Quando roda | O que faz |
| --- | --- | --- |
| `SessionStart` | Início da sessão (limite de 5 s) | Prepara o detector |
| `PostToolUse` em `Edit` e `Write` | Depois de cada edição de `.tsx`, `.ts`, `.css` e `.html` (limite de 5 s) | Roda as regras imediatas do detector (contraste, texto estourando, gradiente em texto, brilho, desvio do sistema de design) no arquivo editado e devolve os achados ao agente |
| `Stop` | Fim de cada turno (limite de 30 s) | Passada completa nas telas mexidas na sessão, sem repetir o que já foi avisado |

Tudo roda local, sem modelo de IA e sem chave. O que o detector manda ao
agente é dado, não ordem: achado real se corrige; falso positivo ganha
exceção estreita com o motivo, de preferência um comentário
`impeccable-disable-next-line <regra> -- <motivo>` na linha (como o da citação
em `apps/web/src/styles.css`). Exceção para um arquivo ou regra inteira só com
OK do Pablo.

Configuração compartilhada em `.impeccable/config.json` (versionado):
`telemetry: false`, `updateCheck: false` e o hook ligado em modo silencioso
(só fala quando acha algo). O `.claude/settings.json` também define
`IMPECCABLE_NO_TELEMETRY` e `IMPECCABLE_NO_UPDATE_CHECK`, para valer mesmo se
alguém apagar o arquivo de configuração. O fluxo de tela nova sorteia uma
direção visual em `impeccable.style/api/roll` mesmo com a telemetria
desligada; por isso `IMPECCABLE_API_URL` aponta para uma porta local fechada
(`127.0.0.1:9`), e o impeccable segue sem o sorteio. O hash do binário só é
conferido no download e no cache por versão (`~/.impeccable/bin/<versão>`):
não ponha outro `impeccable` no PATH nem em `~/.impeccable/bin/impeccable`,
nem defina `IMPECCABLE_BIN`. Caches e sessões do modo `live` ficam
fora do Git (`.gitignore`).

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
| Implementação de qualquer código | `ponytail:ponytail` (nível `full`) | A menor mudança completa: reaproveita o que o repositório já tem, nenhuma abstração, opção ou dependência que ninguém pediu. Atalho com limite conhecido leva o comentário `shortcut: <limite>, <quando trocar>` |
| Plano de tela nova ou redesenho de tela | `frontend-design:frontend-design` | Plano visual curto (cor, tipo, layout, princípio) dentro da identidade N · Sinal e de `docs/interface.md`, revisado contra os padrões genéricos antes de codar |
| Mexeu em tela (`apps/web`) | hooks do `impeccable` | Sozinhos: achados do detector a cada edição e no fim do turno |
| Antes das capturas do PR de tela | `impeccable:impeccable` com `polish`, `harden` e `adapt` na tela mexida | Acabamento, estados de erro e vazio, textos longos, celular. Em app de trabalho (modo Operate do impeccable) a ambição aparece como precisão, não como enfeite |
| Revisão de QA de PR com tela | `impeccable:impeccable` com `critique` e `audit` na tela mexida | Nota por heurística de usabilidade e relatório técnico P0 a P3 (acessibilidade, desempenho, tema, responsivo). P0 e P1 se corrigem no PR |
| Revisão de QA de todo PR | `ponytail:ponytail-review` | Terceiro eixo, ao lado do `/code-review` e do `mattpocock-skills:code-review`: código que sobra, duplicado ou sem teste. Só relata |
| Fim de fase ou pedido de faxina | `ponytail:ponytail-audit` e `ponytail:ponytail-debt` | Relatório do repositório inteiro e lista dos `shortcut:` pendentes. Não mudam código |

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
7. O `ponytail` corta código, nunca dever: testes de cada critério de aceite
   (inclusive de mudança pequena), validação com Zod, segurança,
   acessibilidade, i18n, capturas, README, CHANGELOG e docs continuam
   obrigatórios. "Mudança trivial não precisa de teste" não vale aqui.
8. A identidade visual do Zuri (N · Sinal, `docs/interface.md`, inspiração
   Talorys) é o briefing fixo do `impeccable` e do `frontend-design`. Os dois
   refinam dentro dela; trocar a identidade é decisão do Pablo. Comandos que
   mudam o tom da tela inteira (`bolder`, `overdrive`, `delight`, `colorize`) e
   o fluxo de tela nova do impeccable (`shape`, `init`, cartões de decisão,
   `live`, `generate`) só com pedido do Pablo.
9. O `impeccable` não gera imagem paga. Se um fluxo dele pedir imagem gerada
   por serviço de fora, pare e pergunte (custo).
10. O `impeccable init` e o `document` gravam em `docs/PRODUCT.md` e
    `docs/DESIGN.md`, nunca na raiz (o impeccable também procura em `docs/`).
    Os dois nascem a partir de `docs/especificacao.md`, `.claude/memoria/decisoes.md`
    e `docs/interface.md`, num PR próprio, quando o Pablo pedir. Até lá, os
    comandos de refinamento usam o código atual como referência, que é o
    comportamento padrão do impeccable.

### Skills que só o Pablo chama

Estas skills têm `disable-model-invocation` e ficam disponíveis como comando:
`/mattpocock-skills:grill-me`, `grill-with-docs`, `to-spec`, `to-tickets`,
`wayfinder`, `triage`, `retro`, `teach`, `to-questionnaire`, `wait-what`,
`improve-codebase-architecture`, `implement`, `implement-spec`, `ask-matt` e
`setup-matt-pocock-skills`. A configuração que a última faria já está pronta em
`docs/agents/`.

## Pacotes avaliados e não instalados

Avaliados em 02/11/2026, a pedido do Pablo, junto com os três acima.

| Pacote | O que é | Por que ficou de fora |
| --- | --- | --- |
| `tester-army/e2e` (Apache-2.0) | Framework de e2e em que um agente de IA dirige o app (`agent.act`, `agent.assert`), com skills para escrever testes, migrar suítes e caçar bugs | A skill só funciona com o pacote `e2e` instalado como dependência e um modelo de IA configurado (chave de API ou assinatura). Os passos de agente não são determinísticos, o que bate de frente com "teste instável é bug", e a suíte Playwright já cobre a interface. Reavaliar só se o Pablo quiser uma rodada de caça a bugs com IA, como dependência de desenvolvimento e com OK de custo ⚠ |
| `CyberStrikeus/CyberStrike` (AGPL-3.0) | Agente de pentest ofensivo com TUI própria, mais de 7.600 skills (pós-exploração, Kerberos, nuvem) e conexão a um provedor de IA | Não é plugin do Claude Code: é outro agente, instalado com `npm i -g` e com chave de API própria. As configurações do próprio repositório liberam qualquer comando (`Bash(*)`). Teste ofensivo contra o Zuri publicado mexe na conta de produção, o que é decisão do Pablo. A auditoria já usa `cloudflare-security-audit`; a lista OWASP LLM Top 10 do pacote serve só de leitura |
| `TestSprite/testsprite-cli` (Apache-2.0) | CLI de um serviço de testes na nuvem: gera e roda testes contra o app por um túnel | Exige conta e chave de API, gasta créditos a cada geração e execução e manda o app e o PRD para fora. Fere o plano gratuito e a regra de dados. Só com OK explícito do Pablo ⚠ |

O `nateherkai/scroll-craft` já estava instalado; o commit fixado (`75d81f74`)
ainda era o último do repositório em 02/11/2026.

## Custo de contexto

Cada sessão carrega só o nome e a descrição das skills (cerca de 35 linhas no
total); o conteúdo de uma skill só entra quando ela é usada. A auditoria
completa da Cloudflare abre vários subagentes, por isso roda só nas etapas
sensíveis.

## Como atualizar um pacote

Nunca troque o `sha` sem ler o que mudou.

1. Clone o repositório do pacote fora do Zuri e rode
   `git log --oneline <sha-atual>..HEAD` e `git diff <sha-atual> HEAD`.
2. Confira: nenhum hook, servidor MCP, script que rode sozinho, chamada de rede
   nova, pedido de segredo ou instrução que contrarie as regras do Zuri. No
   `impeccable`, os hooks já existem: confira o que mudou neles, no lançador
   `skills/impeccable/scripts/impeccable` e em `engine-checksums.txt` (versão
   e SHA-256 do binário), e se a telemetria continua desligável.
3. Troque o `sha` em `.claude/skills-externas/.claude-plugin/marketplace.json`,
   atualize a tabela acima e abra um PR `chore(agente): atualiza <pacote>` com o
   resumo do diff revisado.
4. Para remover um pacote, tire a entrada do catálogo, do `enabledPlugins` e da
   lista em `scripts/instalar-skills.sh`.
