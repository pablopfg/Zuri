# Estratégia de testes e QA do Zuri

Este documento diz como o Zuri é testado. O agente atua como QA sênior em toda
etapa: escreve os testes junto com o código, revisa o próprio trabalho com o
subagente `qa-senior` e registra o resultado no PR.

## Princípios

1. **Cada critério de aceite tem teste automatizado.** A matriz de
   rastreabilidade no PR liga critério → teste → camada.
2. **Teste que falha antes, passa depois.** Para bug, primeiro o teste que
   reproduz.
3. **Determinismo.** Relógio, fuso, aleatoriedade e IA são simulados nos
   testes. Nada de rede real na CI.
4. **Teste instável é bug.** Nunca `.skip`, `.only`, `retries` ou timeout
   maior para esconder falha.
5. **Segurança é testada como comportamento**, não só revisada: cada achado de
   auditoria corrigido ganha um teste que falharia sem a correção.
6. **Nada é declarado pronto sem rodar nesta sessão.**

## Camadas

| Camada | Ferramenta | O que cobre | Quando roda |
| --- | --- | --- | --- |
| Unitário | Vitest | Funções puras: recorrência, i18n, schemas, criptografia, parsers do Telegram | Todo PR |
| Integração | Vitest + `@cloudflare/vitest-pool-workers` (workerd) | Rotas Hono, Durable Object, SQLite, migrations, alarmes, webhook do Telegram | Todo PR |
| Contrato da API | Vitest + schemas Zod | Formato de pedidos e respostas, códigos de erro do catálogo | Todo PR |
| E2E | Playwright (Chromium) | Fluxos do dono na interface: login, chat, tarefas, aprovações, configurações | Todo PR |
| Acessibilidade | `@axe-core/playwright` | Telas novas sem violação séria ou crítica | Todo PR que muda tela |
| i18n | Teste de cobertura + lint de texto | Chaves iguais em `pt-BR` e `en`, nada de texto solto | Todo PR |
| Segurança | Vitest (casos de abuso) | Autenticação, CSRF, sessão, webhook, aprovações, injeção de prompt, limites | Todo PR |
| Migrations | Vitest | Banco vazio e banco com dados de todas as versões anteriores sobem para a última | PR com migration |
| Desempenho | Vitest com orçamento | Subrequests por invocação, tamanho do bundle, consultas sem varredura completa | Etapas marcadas |

## Casos de borda obrigatórios (lista do QA)

Para cada entrada nova, pense e teste quando fizer sentido:

- vazio, só espaços, enorme (limite − 1, limite, limite + 1), Unicode e emoji,
  RTL, caracteres de controle, HTML e Markdown;
- repetido (idempotência), concorrente, fora de ordem, reenviado depois de
  falha;
- fuso `America/Sao_Paulo`, virada de dia, fim de mês, 29/02, horário de verão
  histórico;
- sem permissão, sessão vencida, CSRF ausente, origem errada, dono bloqueado;
- cota de IA esgotada, Workers AI fora do ar, Telegram respondendo 429 ou 5xx,
  e-mail recusado;
- conteúdo com tentativa de injeção de prompt (em nota, memória, mensagem do
  Telegram, resultado de MCP);
- banco perto do teto.

## Testes específicos do bot do Telegram

- webhook sem o cabeçalho secreto ou com valor errado → 401, sem processar;
- corpo acima de 64 KB → recusado;
- `update_id` repetido → processado uma vez;
- mensagem de chat que não é o `TELEGRAM_ADMIN_ID` → ignorada;
- `callback_data` adulterado, vencido ou de outra versão → recusado;
- aprovação: token de uso único, vencimento, reuso, hash do alvo mudado,
  passkey sem verificação de usuário, código de e-mail errado (limite de
  tentativas);
- trava de leitura depois de 12 h; `/bloquear` e saída por código de
  recuperação;
- reconhecimento cruzado de alerta de segurança entre web e bot.

## Ciclo do QA em cada etapa

1. Ler os critérios de aceite da etapa e montar a matriz antes de codar.
2. Escrever os testes junto com o código.
3. Rodar a skill `verificar`.
4. Rodar a skill `revisao-qa` (inclui o subagente `qa-senior` sem as suas
   conclusões) e corrigir o que for confirmado.
5. Rodar a skill `auditoria-seguranca` e corrigir com teste.
6. Rodar a suíte completa (`npm test` e `npm run test:e2e`) e registrar no PR.

## Critério de pronto

Etapa pronta = critérios de aceite cobertos, CI verde, auditoria sem achado
alto ou médio aberto, relatório de QA e de segurança no PR, changelog e
documentação atualizados.
