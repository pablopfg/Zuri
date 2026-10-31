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
7. **Teste que não pega a falha não conta.** Para cada controle de segurança e
   cada correção, quebre o código de propósito (tire a checagem, troque a
   condição) e veja o teste ficar vermelho. Asserção como `not.toThrow`,
   `toBeDefined` ou "status 200" sozinha não prova o comportamento: confira o
   resultado.
8. **A cobertura só sobe.** Os pisos ficam em `vitest.config.ts` e a CI falha
   abaixo deles. Quem sobe a cobertura sobe o piso no mesmo PR.

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
| Lighthouse | `lighthouse` via Playwright (`npm run test:lighthouse`) | Entrar, Início, Tarefas, Notas e Configurações: acessibilidade ≥ 95, boas práticas ≥ 95, desempenho ≥ 60 | Todo PR (job `lighthouse`) |
| CSP | Playwright (`csp.spec.ts`) | Nenhuma página dispara violação da CSP | Todo PR |
| Cobertura | Istanbul (`npm run test:coverage`) | Pisos por área: agente, shared e `apps/web/src/lib` | Todo PR (job `test`) |

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

## Exigências por área (valem para toda etapa)

Cada item vira teste quando a etapa toca a área. A revisão de QA confere um por
um.

- **Rotas novas.** Entram sozinhas no teste que percorre `app.routes`
  (`auth-password-route.test.ts`): toda rota com sessão é bloqueada pela troca de
  senha obrigatória. Rota pública nova precisa ser posta na lista `PUBLIC` de
  propósito. Toda rota também tem: sem sessão → 401, sem CSRF → 403, corpo acima
  do limite → 400 `bodyTooLarge`, campo desconhecido → 400, id que não é do
  servidor → 404, e o código de erro do catálogo.
- **Limites.** Para cada constante de tamanho, quantidade ou tempo da seção
  "Contratos": n−1 e n passam, n+1 falha. Tempo com relógio falso no
  milissegundo da borda.
- **Corpos hostis.** JSON quebrado, vazio, `null`, lista, UTF-8 inválido,
  surrogate solto, NUL e caracteres de controle, corpo enviado em pedaços sem
  `Content-Length` e `Content-Length` mentiroso (`http-hardening.test.ts`).
- **Consulta (query string).** Número que não é inteiro, negativo, zero, acima
  do teto, valor repetido, caixa trocada em enum, busca no limite e acima dele,
  NUL, emoji, RTL, caractere invisível e tentativa de SQL.
- **Busca.** Sintaxe de FTS5 digitada (aspas, `*`, `^`, `-`, parênteses,
  `col:`, `NEAR`) não quebra **e** ainda acha o que as palavras dizem.
  Maiúsculas acentuadas ("Água" e "água") se acham nos dois sentidos.
- **Concorrência.** Duas chamadas iguais ao mesmo tempo (`Promise.all`):
  restaurar, apagar, criar no último lugar, confirmar código, aprovar. Uma vence,
  a outra recebe o erro certo, e os contadores continuam verdadeiros.
- **Datas.** Fuso `America/Sao_Paulo` e um fuso com horário de verão em vigor
  (New York): dia de 23 h e de 25 h, virada de dia e de mês, 29/02, anos-limite
  (2000 e 2199 passam, 1999 e 2200 falham). No e2e, o aparelho num fuso diferente
  do dono (`Asia/Tokyo`) e o relógio da página congelado (`page.clock`) sempre que
  o teste calcula "hoje".
- **Sessão no navegador.** Aba que volta do segundo plano não encerra a sessão
  em uso em outra aba (`session-background.spec.ts`); aviso, renovação e saída
  em todas as abas.
- **Conteúdo do dono na tela.** Markdown e qualquer texto guardado passam pelo
  teste de XSS (`markdown.test.tsx`): `javascript:` em todas as grafias,
  `data:`, `vbscript:`, link relativo e de protocolo relativo, link por
  referência, autolink, HTML cru, imagem remota.
- **Segurança de sessão e conta.** Toda ação sensível nova entra no teste de
  senha recente (15 min: 14:50 passa, 15:00 falha) e não grava nada quando
  recusada. Cookie de aparelho nunca dispensa o 2FA. Cabeçalhos de IP forjados
  (`X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`) não mudam a rede contada.
- **Interface.** Tela nova entra no `a11y.spec.ts` (claro e escuro), no
  `csp.spec.ts` e, se for uma tela principal, no `lighthouse.spec.ts`.

## Portões obrigatórios de cada etapa

Uma etapa só é mesclada com todos estes itens no PR, com o resultado real:

1. `npm run typecheck`, `npm run lint` e `npm run i18n` verdes.
2. `npm run test:coverage` verde, sem baixar nenhum piso (e com o piso subido se
   a cobertura subiu).
3. `npm run test:e2e` e `npm run test:lighthouse` verdes.
4. `npm audit --audit-level=high` sem nada novo.
5. Matriz de rastreabilidade: cada critério de aceite → `arquivo › teste`, sem
   "SEM TESTE".
6. Lista das "Exigências por área" acima que a etapa tocou, com o teste de cada
   uma.
7. Prova de que os testes de segurança novos pegam a falha (o código quebrado
   de propósito e o teste vermelho), citada no relatório de QA.
8. Revisão independente do `qa-senior` e auditoria do `auditor-seguranca`, com
   todo achado alto ou médio corrigido com teste ou levado ao Pablo.
9. Nenhum `.skip`, `.only`, `retries`, `waitForTimeout` ou timeout aumentado.

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
3. Rodar a skill `verificar` (inclui cobertura, e2e e Lighthouse antes do PR).
4. Rodar a skill `revisao-qa` (inclui o subagente `qa-senior` sem as suas
   conclusões) e corrigir o que for confirmado.
5. Rodar a skill `auditoria-seguranca` e corrigir com teste.
6. Rodar a suíte completa (`npm test` e `npm run test:e2e`) e registrar no PR.

## Critério de pronto

Etapa pronta = os portões obrigatórios acima cumpridos, CI verde (inclusive
`lighthouse` e os pisos de cobertura), auditoria sem achado alto ou médio
aberto, relatório de QA e de segurança no PR, changelog e documentação
atualizados.
