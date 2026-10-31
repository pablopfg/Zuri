# Memória inicial do projeto Zuri

Fatos e decisões já tomados pelo Pablo. O agente não pergunta de novo nada daqui. Decisões novas são acrescentadas no fim, com data, no mesmo PR em que passam a valer (sem dados pessoais, domínio ou segredos). No repositório, este arquivo vive em `.claude/memoria/decisoes.md`.

## Quem é quem

- **Pablo** é o dono do produto e o único usuário. Escreve e lê em português do Brasil.
- O **agente** (Claude) é engenheiro principal e QA sênior do repositório.

## Produto

- **Nome:** Zuri (decidido em 30/10/2026). Nomes técnicos: tabelas `zur_`, tokens `zur_pat_`, cookies `__Host-zuri_*`, variáveis `ZURI_*`, pacotes `@zuri/*`.
- **O que é:** assistente pessoal de IA de dono único, gratuito e de código aberto, que roda na conta Cloudflare do dono. Herda todas as funções do Talorys/Axis (`pablopfg/talorys`) e acrescenta um bot do Telegram de administração.
- **Referência:** Talorys, branch `develop`, público, licença MIT. Ler, entender e reescrever limpo; trechos reaproveitados exigem o aviso de copyright em `NOTICE.md`.
- **Fora do escopo:** mais de um usuário, WhatsApp, Chatwoot, atendimento a terceiros, telemetria.

## Decisões tomadas

| Data | Decisão |
| --- | --- |
| 30/10/2026 | Nome: Zuri. |
| 30/10/2026 | Aprovações pelo bot do Telegram são permitidas, confirmadas por passkey (principal, página `/aprovar` com token de uso único) ou código de 6 dígitos por e-mail (reserva). Sem TOTP no bot. Lista "nunca pelo bot" na especificação. |
| 30/10/2026 | Especificação auditada por auditor independente; as correções (reconhecimento cruzado de alertas de segurança, trava de leitura do bot, bloqueio com saída por código de recuperação, processamento no Durable Object, prévia montada pelo servidor, webhook registrado pelo Worker) já estão na especificação. |
| 30/10/2026 | Modo contínuo: o agente mescla sozinho na `develop` quando CI, QA e auditoria passam e segue para a próxima etapa numa conversa nova, sem pausa por fase. Para só nos bloqueios (algo que o Pablo fornece, etapa 21, decisão de produto, custo, falha persistente, achado de segurança). `main`, release e deploy continuam com o Pablo. O ruleset da `develop` exige CI verde e não exige aprovação humana. |
| 31/10/2026 | Skills externas instaladas e usadas automaticamente: `mattpocock/skills`, `nateherkai/scroll-craft`, `cloudflare/security-audit-skill` e `blader/humanizer`, fixadas por commit em `.claude/skills-externas/` e instaladas por `scripts/instalar-skills.sh` no início de cada sessão. Atualização só por PR, depois de ler o diff. Geração paga de imagens do scroll-craft (kie.ai) bloqueada sem OK. |
| 31/10/2026 | Identidade visual "Sinal": um i cujo pingo é uma luz verde (`#22c55e`) sobre tinta (`#0b0f19`); o verde é o único destaque e significa "trabalhando". Escolhida entre 17 opções. |
| 31/10/2026 | Telas depois do login seguem a UI do Talorys como referência: barra lateral de altura total (marca e avisos no topo, seções no meio, Configurações e Sair no pé), barra superior e navegação inferior no celular, `PageHeader` em cada página, lembrete de 2FA enquanto estiver desligada. Telas novas entram como seção da barra lateral. A identidade continua a "Sinal". |
| 31/10/2026 | Rigor de QA para produção: toda etapa cumpre os "Portões obrigatórios" e as "Exigências por área" de `docs/qa/estrategia-de-testes.md` (limites exatos, corpos e consultas hostis, concorrência, horário de verão, fuso do aparelho, XSS, senha recente, prova de que o teste pega a falha). Cobertura com pisos na CI que só sobem; Lighthouse na CI (acessibilidade e boas práticas ≥ 95); ruleset exige branch atualizada com a `develop` antes de mesclar. |
| 31/10/2026 | Padrão de qualidade da interface: UI/UX moderna, funcional, muito bonita e sem erros. Toda tela nova passa por revisão de UX (vazio, carregando, erro, teclado, leitor de tela, celular e computador, claro e escuro), tem capturas antes de fechar e e2e dos fluxos. |
| 31/10/2026 | Performance e cotas do plano Free em toda etapa: o sistema deve ser o mais rápido possível e caber com folga nas cotas gratuitas (Workers, Durable Objects com SQLite, Workers AI). Toda etapa segue `.claude/rules/performance.md` (regras P1 a P14), mede o custo das rotas em `free-tier-budget.test.ts` e traz no PR a tabela "Custo no plano Free". Orçamento em `docs/arquitetura/orcamento-free-tier.md`. |
| 31/10/2026 | Login: verificação contra robôs (Cloudflare Turnstile) em toda tentativa, visível na tela de login, obrigatória fora do ambiente local (sem chaves o login fica fechado); chaves de teste só no local. As tentativas de login ficam registradas com IP, lugar, rede e navegador na página "Acessos" (barra lateral; no celular, por Configurações > Segurança). |

## Padrões em vigor até o Pablo dizer outra coisa

| Nº | Assunto | Padrão |
| --- | --- | --- |
| N2 | Repositório | Público, sem nada sensível |
| N4 | Fotos e documentos enviados ao bot | Não guardar; a legenda vira nota |
| N5 | Leitura de imagens por IA | Desligada |
| N6 | Mini App do Telegram | Não fazer agora |
| N7 | Modelos pagos (Anthropic, OpenAI) | Não implementar sem OK |
| N8 | Idiomas | pt-BR (padrão) e en |
| N9 | Grupo de avisos no Telegram | Opcional |
| N10 | Trava de leitura do bot | Ligada, 12 h |
| N11 | `TELEGRAM_ADMIN_ID` | Obrigatório para comandos de segurança e aprovações |
| N12 | Teto do banco | 900 MB (confirmar o limite vigente do plano Free) |

## Preferências de trabalho do Pablo

- PRs, commits, changelog, releases e documentação em pt-BR; prefixo Conventional Commits em inglês.
- Um PR por entrega, sempre para `develop`. Conflitos são resolvidos pelo agente sem esperar pedido.
- Ao fim de cada ajuste: auditoria de segurança independente, correções, testes de tudo, e só então pronto.
- Máxima segurança sem prejudicar desempenho e usabilidade.
- Deploy feito pelo GitHub Actions, com o máximo possível pelo navegador (sem terminal para o Pablo).
- Fuso padrão `America/Sao_Paulo`.
- Recursos que podem gerar custo só com OK explícito.
- Lixeira: apagar de vez e esvaziar pedem só a confirmação na tela, sem senha digitada de novo (31/10/2026, etapa 6).
