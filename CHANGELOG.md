# Changelog

Todas as mudanças visíveis do Zuri ficam aqui, em pt-BR. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem
o [SemVer](https://semver.org/lang/pt-BR/). Cada PR escreve a sua entrada em
"Não lançado"; a release copia a seção para a versão.

## Não lançado

### Adicionado

- Repositório preparado: monorepo com npm workspaces (`apps/agent`,
  `apps/web`, `packages/shared`), TypeScript estrito, Biome, Vitest,
  Playwright e o catálogo inicial de traduções em pt-BR e en.
- Integração contínua em todo PR (typecheck, lint, testes, i18n, build, e2e e
  `npm audit`), CodeQL, Dependabot e rulesets para a `develop` e a `main`.
- `LICENSE` (MIT), `NOTICE.md`, `SECURITY.md` e `CONTRIBUTING.md`.
- Worker único com o Durable Object do agente, que serve a interface e a API
  e passa toda requisição pelos portões de segurança: host permitido, HTTP
  para HTTPS, Cloudflare Access opcional, cabeçalhos de segurança e
  autenticação. `GET /api/health` responde se o Zuri está no ar e
  configurado, sem nenhum dado.
- Erros da API no formato `{ code, message }`, com o texto em pt-BR.
- Banco do agente criado sob demanda, com migrations só de acréscimo, e as
  configurações de idioma (`pt-BR` ou `en`) e fuso (`America/Sao_Paulo` por
  padrão). Os erros da API passam a sair no idioma escolhido.
- Formatação de datas e valores no padrão brasileiro ("30/10/2026 às 15:16",
  "US$ 1,25") e plural pelas regras de cada idioma.
- Lint de i18n no `npm run lint` e na CI: falha com texto visível fora do
  catálogo, chave sem tradução ou chave sem uso.
- Login com e-mail e senha (`POST /api/auth/login`), sessão
  (`GET /api/auth/session`), sinal de aba aberta (`POST /api/auth/heartbeat`),
  saída (`POST /api/auth/logout`), confirmação de senha para ações sensíveis
  (`POST /api/auth/confirm`) e troca de senha (`POST /api/auth/password`).
- Saída automática depois de 30 min sem uso, 5 min sem aba aberta ou 6 h no
  total.
- Atividade de acesso por 90 dias (depois, contagens diárias por um ano), com
  os eventos que viram alerta guardados para a central de avisos.

### Segurança

- Conexões WebSocket e caminhos de sub-agente são recusados, e os cabeçalhos
  internos do Agents SDK são removidos antes de chegar ao agente.
- Sem `PUBLIC_URL` válido, o Worker recusa tudo com `NOT_CONFIGURED` em vez de
  atender qualquer host.
- Senha com PBKDF2-SHA-256 (100.000 iterações) e pepper; política de 15+
  caracteres em que partes previsíveis não contam, conferência no Have I Been
  Pwned por k-anonimato com falha fechada, e troca exigida quando a senha atual
  é fraca.
- Sessões em cookie `__Host-zuri_session` (`HttpOnly`, `Secure`,
  `SameSite=Strict`), guardadas só como HMAC; CSRF por cabeçalho e origem em
  toda rota da API.
- Força bruta: 3 falhas por rede em 15 min, limite reduzido num ataque
  distribuído, Turnstile adaptativo opcional depois de 1 falha da rede ou 10 no
  total, sempre antes do PBKDF2 e com falha fechada.
- Redefinir a senha pelo painel da Cloudflare vale já na primeira requisição
  depois do deploy: a senha antiga não entra nem uma vez.
- Durante um ataque distribuído, cada recusa custa quase nenhuma leitura ou
  gravação no banco, para o atacante não esgotar as cotas diárias do plano
  Free. Navegadores que já entraram continuam podendo entrar. Recomendado:
  uma regra gratuita de rate limiting do WAF em `/api/auth/*`
  (`docs/seguranca.md`).

### Atualização

- Novos valores no painel da Cloudflare: a variável `PUBLIC_URL` e os segredos
  `SESSION_SECRET`, `PASSWORD_PEPPER`, `OWNER_PASSWORD_HASH` e `OWNER_EMAIL`.
  Opcionais: `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`. Detalhes em
  `docs/arquitetura.md`.
- Migration 1 do banco (`zur_settings`, `zur_activity` e
  `zur_schema_version`), aplicada sozinha na primeira requisição. Nada a fazer.
- `OWNER_PASSWORD_HASH` deixou de ser obrigatório: na instalação sem
  instalador, grave `OWNER_PASSWORD` (20+ caracteres); o primeiro login pede a
  troca e, depois dela, o segredo pode ser apagado do painel. Um
  `OWNER_PASSWORD_HASH` presente precisa estar no formato
  `pbkdf2$100000$<sal>$<hash>`. Opcionais novos: `TURNSTILE_SITE_KEY` e
  `TURNSTILE_SECRET_KEY` (grave os dois como segredo).
- Migration 2 do banco (`zur_sessions`, `zur_login_attempts`,
  `zur_auth_events`, `zur_auth_events_daily` e `zur_devices`), aplicada
  sozinha. Nada a fazer.
