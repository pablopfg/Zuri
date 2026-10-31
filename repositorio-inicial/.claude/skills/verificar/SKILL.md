---
name: verificar
description: Roda typecheck, lint e os testes certos para as mudanças atuais do Zuri e resume as falhas. Use antes de dizer que uma tarefa está pronta e antes de abrir PR.
---

# Verificar as mudanças

1. Veja o que mudou: `git status --short` e `git diff --stat origin/develop...HEAD`.
2. Rode `npm run typecheck` e `npm run lint` (inclui o lint de i18n). Corrija antes de seguir.
3. Rode os testes da área tocada:

   | Mudou | Rode |
   | --- | --- |
   | `apps/agent/**` | `npm test -w @zuri/agent` (um arquivo: `-- test/<nome>.test.ts`) |
   | `apps/web/**` | `npm test -w @zuri/web` |
   | `packages/shared/**` | `npm test -w @zuri/shared`, depois web e agente |
   | Interface, rotas, sessão ou bot | `npm run test:e2e` |

4. Antes do PR, a suíte completa: `npm test` e `npm run test:e2e`, mais `npm audit --audit-level=high`.
5. Se algo falhar e a causa não for óbvia, use `mattpocock-skills:diagnosing-bugs` antes de mexer no código.
6. Relate os comandos que rodaram e o que falhou. Nunca diga que passou sem ter rodado nesta sessão; se algo não pôde rodar, diga o quê e por quê.

Se `node_modules` não existir, rode `npm ci` antes. Para uma checagem sem viés, use o subagente `verificador`.
