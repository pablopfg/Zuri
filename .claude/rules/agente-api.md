---
paths:
  - "apps/agent/src/api/**"
  - "apps/agent/src/auth/**"
---

# API e autenticação

- Rotas seguem a tabela "Contrato da API" da especificação; rota nova entra na tabela no mesmo PR.
- Toda rota de sessão exige cookie `__Host-` + CSRF; ação sensível exige senha recente (15 min).
- Tokens remotos só alcançam a lista permitida por escopo; nunca `/api/auth*`, `/api/telegram*`, `/api/approvals*`, `/api/lockdown*`. Um teste percorre todas as rotas registradas.
- Erros no formato `{ code, message, details? }`, com os códigos da especificação; nunca stack trace na resposta.
- Limites de tamanho em todo corpo, lista e string. Limitadores por rede nas rotas de login, recuperação e aprovação.
- Nunca registre senha, código, token, e-mail digitado errado ou corpo de requisição.
- Rota nova: o teste que percorre `app.routes` (`auth-password-route.test.ts`) já a cobre na troca de senha obrigatória; rota pública nova vai para a lista `PUBLIC` dele. Ação sensível nova entra no teste de senha recente (14:50 passa, 15:00 falha, nada gravado quando recusa).
- Texto guardado: schemas com `line()`/`text()` de `packages/shared/src/productivity.ts` (sem controle, sem surrogate solto, em NFC). Busca literal compara `foldSearch(q)` com `foldedColumn(col)`, nunca `lower()` puro (o SQLite só dobra A–Z).
