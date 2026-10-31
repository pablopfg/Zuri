## O que muda

<!-- O que este PR faz e por quê, em pt-BR. -->

## Etapa

<!-- Número e nome da etapa da especificação (docs/especificacao.md), e as dependências já mescladas. -->

## Matriz de rastreabilidade

<!-- Cada critério de aceite da etapa ligado a pelo menos um teste automatizado. -->

| Critério de aceite | Teste(s) | Camada | Situação |
| --- | --- | --- | --- |
|  |  | unitário / integração / contrato / e2e / segurança / a11y |  |

## QA

<!-- Relatório da skill revisao-qa e do subagente qa-senior: casos de borda cobertos, regressão, testes exploratórios, riscos que ficaram. -->

## Segurança

<!-- Relatório da skill auditoria-seguranca: achados, severidade, correção e teste de cada um. Escreva "nenhum achado" só se a auditoria rodou. -->

## Custo no plano Free

<!-- Regras de .claude/rules/performance.md (P1 a P14). O que muda em cada cota, com a medida de free-tier-budget.test.ts antes e depois. "Não muda" quando nada lê ou grava o banco, nem chama IA, nem cria agendamento. -->

| Cota | Antes | Depois | Como medi |
| --- | --- | --- | --- |
|  |  |  |  |

## Como foi testado

<!-- Comandos rodados nesta sessão e o resultado real (typecheck, lint, testes, e2e). -->

## Checklist

- [ ] O título segue o Conventional Commits (`feat(bot): …`, `fix(auth): …`), com o texto em pt-BR
- [ ] `CHANGELOG.md` atualizado em "Não lançado", ou o rótulo `sem-changelog` foi adicionado
- [ ] `README.md` atualizado (mapa das etapas, funcionalidades, capturas) quando o PR muda funcionalidade, etapa, tela ou arquitetura
- [ ] Migrations só de acréscimo; migrations e segredos novos descritos no grupo "Atualização"
- [ ] Itens que podem sair do plano gratuito da Cloudflare marcados com ⚠️ e aprovados pelo dono
- [ ] Nenhum segredo, domínio real, e-mail ou id do Telegram nos arquivos
- [ ] Todo texto novo está em `pt-BR` e `en`
- [ ] `npm run typecheck`, `npm run lint`, `npm test` e `npm run test:e2e` passam
- [ ] Decisões novas do dono registradas em `.claude/memoria/decisoes.md`
