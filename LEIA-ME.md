# Pacote do Zuri: como começar

Esta pasta tem tudo para criar o projeto do **Zuri** no Claude e entregar ao agente as instruções, o contexto e a memória de que ele precisa para construir o sistema num repositório novo do GitHub, atuando como desenvolvedor e QA sênior.

Versão 1.0 · 30/10/2026 · baseada na especificação revisada e auditada.

## O que tem aqui

| Arquivo ou pasta | Para quê | Onde vai |
| --- | --- | --- |
| `LEIA-ME.md` | Este passo a passo | Só para você |
| `01-instrucoes-do-projeto.md` | Instruções permanentes do agente (papel, regras, fluxo de trabalho, QA, segurança) | Campo **Instruções** do projeto no Claude |
| `02-memoria-inicial.md` | Fatos e decisões já tomadas, que o agente não deve perguntar de novo | Arquivo de conhecimento do projeto e, depois, `.claude/memoria/decisoes.md` no repositório |
| `03-especificacao-zuri.md` | A especificação completa: escopo, arquitetura, contratos, 26 etapas, bot do Telegram, testes | Arquivo de conhecimento do projeto e `docs/especificacao.md` no repositório |
| `04-primeiro-prompt.md` | A primeira mensagem para o agente começar (etapa 0) | Primeira mensagem no projeto |
| `05-prompts-das-etapas.md` | Um prompt pronto para cada etapa seguinte (1 a 25, também copiado em `repositorio-inicial/docs/agente/`), a ordem, o que pode rodar em paralelo, o que você precisa fornecer antes e prompts de manutenção | Só se quiser rodar uma etapa à mão; o modo contínuo já os usa sozinho |
| `06-modo-continuo.md` | Como o agente avança sozinho entre as etapas, quando ele para, como economiza tokens e o que configurar | Só para você |
| `repositorio-inicial/` | Arquivos que o agente coloca no repositório na etapa 0: `README.md` (com logo provisório), `AGENTS.md`, `CLAUDE.md`, `.claude/` (regras, skills, subagentes, memória, permissões), modelo de PR e a estratégia de QA | Raiz do repositório novo |
| `zuri-pacote.zip` | Tudo acima num único arquivo | Para guardar ou enviar |

A pasta `repositorio-inicial/.claude/` começa com ponto e pode ficar oculta no seu computador. No macOS, use Cmd + Shift + . no Finder para ver.

## Passo a passo

1. **Crie o repositório no GitHub.** Nome sugerido: `zuri`. Recomendo público (decisão N2 da especificação), vazio, sem README. Depois crie a branch `develop` e deixe-a como padrão.
2. **Dê acesso ao Claude.** Instale o app do Claude no repositório (https://github.com/apps/claude/installations/select_target) e confira a conexão em https://claude.ai/connect-github.
3. **Crie o projeto no Claude** com o nome "Zuri".
4. **Cole as instruções.** Copie todo o conteúdo de `01-instrucoes-do-projeto.md` para o campo de instruções do projeto.
5. **Adicione o repositório** `zuri` nas configurações do projeto (recursos/repositórios).
6. **Anexe o conhecimento.** Envie `02-memoria-inicial.md` e `03-especificacao-zuri.md` como arquivos do projeto. Se puder, envie também a pasta `repositorio-inicial/` (ou o `.zip`), para o agente copiar os arquivos na etapa 0.
7. **Comece.** Envie o conteúdo de `04-primeiro-prompt.md` como primeira mensagem.
8. **Libere o modo contínuo.** Na etapa 0, importe os rulesets que o agente mandar e confirme a ele. A partir daí ele mescla na `develop` e segue sozinho, etapa por etapa, parando só quando precisar de você (veja `06-modo-continuo.md`).
9. **Acompanhe por PR.** Cada etapa vira um PR para `develop` com o relatório de QA e de segurança no corpo, mesclado pelo agente quando tudo passa. A release para a `main` continua sendo sua.

## Skills externas

O repositório já vem com as skills de `mattpocock/skills`, `nateherkai/scroll-craft`, `cloudflare/security-audit-skill` e `blader/humanizer`, além do plugin oficial da Cloudflare. Elas se instalam sozinhas a cada sessão do agente, fixadas num commit revisado, e entram no fluxo de cada etapa sem você pedir. Você não precisa fazer nada. Opcional: no ambiente de nuvem do Claude Code, ponha `bash scripts/instalar-skills.sh` no script de setup para a sessão começar uns 15 s mais rápido. Detalhes em `repositorio-inicial/docs/agente/skills-externas.md`.

## O que você vai precisar fornecer depois (nunca no repositório)

| Quando | O quê | Onde fica |
| --- | --- | --- |
| Etapa 24 (primeiro deploy) | Conta Cloudflare, token de API e id da conta | Ambiente `production` do GitHub |
| Etapa 24 | `SESSION_SECRET`, `PASSWORD_PEPPER`, `OWNER_EMAIL`, `OWNER_PASSWORD` | Segredos do Worker, pelo painel da Cloudflare |
| Etapa 12 | Bot criado no @BotFather, `TELEGRAM_BOT_TOKEN` e o seu `TELEGRAM_ADMIN_ID` | Segredos do Worker |
| Etapas 4 e 11 | Domínio próprio na Cloudflare e Email Routing com o seu e-mail verificado | Painel da Cloudflare |
| Etapa 19 | Cliente OAuth gratuito do Google | Segredos do Worker |
| Etapa 21 | Só se você aprovar modelos pagos: chaves da Anthropic ou OpenAI | Segredos do Worker |

## Decisões que ainda têm padrão (pode responder quando quiser)

N2 repositório público, N4 não guardar fotos, N5 sem leitura de imagens, N6 sem Mini App por enquanto, N7 sem modelos pagos, N8 pt-BR e en, N9 grupo de avisos opcional, N10 trava de leitura do bot de 12 h, N11 `TELEGRAM_ADMIN_ID` obrigatório, N12 teto do banco de 900 MB. O agente segue esses padrões se você não disser nada.
