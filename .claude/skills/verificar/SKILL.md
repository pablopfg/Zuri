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

4. Antes do PR, a suíte completa, como a CI roda:
   - `npm run test:coverage` (todos os testes e os pisos de cobertura de `vitest.config.ts`; abaixo do piso falha);
   - `npm run test:e2e` e `npm run test:lighthouse` (acessibilidade e boas práticas ≥ 95);
   - `npm run i18n` e `npm audit --audit-level=high`.
   No ambiente de nuvem, o e2e precisa de Node 26 e de `PLAYWRIGHT_CHROMIUM_EXECUTABLE` apontando para o Chromium pré-instalado (`/opt/pw-browsers/chromium-*/chrome-linux*/chrome`).
5. Se algo falhar e a causa não for óbvia, use `mattpocock-skills:diagnosing-bugs` antes de mexer no código.
6. Procure no diff `.skip`, `.only`, `retries`, `waitForTimeout` e timeout aumentado: nenhum entra.
7. Relate os comandos que rodaram, os números (testes, cobertura, notas do Lighthouse) e o que falhou. Nunca diga que passou sem ter rodado nesta sessão; se algo não pôde rodar, diga o quê e por quê.

Se `node_modules` não existir, rode `npm ci` antes. Para uma checagem sem viés, use o subagente `verificador`.
