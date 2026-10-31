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
