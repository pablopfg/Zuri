# Progresso das etapas

Passagem de bastão entre conversas. Cada etapa começa numa conversa nova e lê
este arquivo **em vez** do histórico das anteriores. Atualize no mesmo PR da
etapa, antes de mesclar. Mantenha curto (até ~80 linhas): só as 3 últimas
etapas ficam detalhadas; as mais antigas viram uma linha na tabela.

## Modo contínuo

- Situação: ligado
- Avanço: mescla sozinho na `develop`, sem pausa por fase (decisão do Pablo, 30/10/2026)
- Pausado por:

## Etapas

| Etapa | Situação | PR | Resumo em uma linha |
| --- | --- | --- | --- |
| 0 | mesclada (31/10/2026) | #1 | Monorepo, CI, CodeQL, rulesets, Dependabot |
| 1 | mesclada (31/10/2026) | #6 | Worker único, Durable Object `ZuriAgent` e os seis portões |
| 2 | mesclada (31/10/2026) | #7 | Migration 1, configurações (idioma e fuso), erros no idioma do dono, lint de i18n |
| 3 | mesclada (31/10/2026) | #8 | Login, sessões, CSRF, força bruta, Turnstile adaptativo, atividade de acesso |
| 4 | mesclada (31/10/2026) | #9 | 2FA TOTP, códigos de recuperação, desafio em cookie, passkeys reutilizáveis |
| 5 | mesclada (31/10/2026) | #10 | Casca da interface: login com 2FA, guarda de sessão, configurações, PWA (fecha a fase A) |

## Últimas etapas (detalhe)

### Etapa 5 · Casca da interface
- Entregou: `apps/web` em React (rotas `/entrar`, `/`, `/configuracoes/:tab` com 6 abas, 404), `lib/{api,activity,deadlines,next,i18n,theme}.ts`, `hooks/session.tsx`, `SessionGuard` (aviso 2 min antes, heartbeat único por Web Locks, saída em todas as abas), telas de 2FA, passkeys, limites de sessão e atividade. API: `GET`/`PATCH /api/settings`, `GET /api/auth/activity`. PWA sem cache no service worker. Docs: `docs/interface.md`.
- Migrations: nenhuma.
- Decisões técnicas: `x-zuri-activity` só em POST/PATCH/DELETE até 10 s após toque ou tecla; CSP do Turnstile em todas as páginas quando ligado (SPA; documentado em `seguranca.md`); identidade "Brisa" (opção A) aplicada enquanto o Pablo não escolhe; orçamento de duração do DO em `arquitetura.md` (6 h de uso ≈ 21% da cota diária).
- Ficou para depois: Lighthouse na CI (medido à mão: 100); e2e da aba que volta do fundo (`SETTLE_MS`).
- Atenção para a próxima: todo texto pelo catálogo com chave literal (`lint-i18n`); e2e roda contra `wrangler dev` com estado novo por execução (`.wrangler/e2e`); login tem limite de 3 falhas por rede em 15 min, então e2e não deve errar senha à toa; telas novas entram no `a11y.spec.ts`.

### Etapa 4 · 2FA e passkeys
- Entregou: `packages/shared/src/{totp,passkeys}.ts`, `apps/agent/src/auth/{mfa,passkeys}.ts` (`TwoStep`, `Passkeys`), fluxo em `service.ts` (`login` devolve `SignedIn | MfaPending`; `completeMfa`, `completePasskey`, gestão), rotas `/api/auth/mfa*` e `/api/auth/passkeys*`, cookie `__Host-zuri_mfa`. Docs: `docs/seguranca.md`.
- Migrations: versão 3 (`zur_mfa_secrets`, `zur_recovery_codes`, `zur_passkeys`, `zur_mfa_challenges`).
- Decisões técnicas: `@simplewebauthn/server` 14.0.3; rpId e origem sempre do `PUBLIC_URL`; segredo TOTP selado com chave HKDF do `PASSWORD_PEPPER` (pepper novo desliga o 2FA); `confirm` aceita `{totp}`; recusa pela pausa vira `login_rate_limited` dobrado (motivo `mfa_code`/`mfa_passkey`).
- Reutilizável na etapa 16: `Passkeys.authenticationOptions(rp, "required")` e `verifyAssertion(response, { challenge, rp, userVerification: "required" })`; quem chama guarda o desafio (`zur_telegram_approvals.webauthn_challenge`).
- Ficou para depois: tela de 2FA/passkeys e `@simplewebauthn/browser` (etapa 5); entrega dos alertas (etapa 11).
- Perguntas abertas para o Pablo (não travam): ligar o 2FA e adicionar passkey devem pedir a senha digitada de novo, em vez de valer o login dos últimos 15 min? Repetir o alerta de ataque lento ao TOTP?
- Atenção para a próxima: no DO, todo `await` abre a porta para outro pedido; reserve estado antes do `await` e reconfira dentro de `transactionSync` (veja `armadilhas.md`). A tela trata `200 {mfaRequired}` no login e `details.mfa` (`retry`/`expired`).

### Etapa 3 · Login e sessões
- Entregou: `packages/shared/src/{crypto,password,auth}.ts`, `apps/agent/src/auth/` (`service`, `sessions`, `login-limiter`, `events`, `client`, `turnstile`), `src/api/{app,http}.ts` (rotas `/api/auth/*`, CSRF, trava `PASSWORD_CHANGE_REQUIRED`), `src/db/internal-state.ts`. Doc: `docs/seguranca.md`.
- Migrations: versão 2 (`zur_sessions`, `zur_login_attempts`, `zur_auth_events`, `zur_auth_events_daily`, `zur_devices`).
- Decisões técnicas: senha em `OWNER_PASSWORD_HASH` ou `OWNER_PASSWORD` (opcionais; o `secrets.required` lista só `SESSION_SECRET`, `OWNER_EMAIL`, `PASSWORD_PEPPER`); redefinição pelo painel por impressão digital dos segredos; contagem global de recusas em memória do DO (custo no plano Free); `zur_login_attempts.outcome` 0 falha, 1 sucesso, 2 Turnstile recusado, 3 falha sob confiança de cookie; um acerto não zera as falhas (regra literal, decisão aberta para o Pablo no PR).
- Ficou para depois: TOTP no `confirm` (etapa 4, hoje 400); entrega dos `alert_pending` (etapa 11); tela de atividade (etapa 5); regra de rate limiting do WAF no guia (etapa 24).
- Atenção para a próxima: rota nova sensível chama `auth.requireRecentAuth(session)`; todo pedido da API precisa de `x-zuri-request: 1`; testes que gravam direto em `zur_login_attempts` precisam de `rebuild()` (veja `armadilhas.md`).

<!-- Modelo, até 10 linhas por etapa:
### Etapa NN · <nome>
- Entregou: arquivos/rotas/tabelas principais.
- Migrations: versão N (o quê).
- Decisões técnicas tomadas: ...
- Ficou para depois: ...
- Riscos ou dívidas: ...
- Atenção para a próxima: ...
-->

## Esperando o Pablo

<!-- Itens "▶ Antes, você fornece" das próximas etapas e perguntas abertas. -->

- Não travam: escolha da identidade visual (opções A, B ou C da etapa 5; A aplicada; trocar mexe em `styles.css`, `Logo.tsx`, `favicon.svg` e ícones via `scripts/gerar-icones.ts`). Perguntas abertas da etapa 4 (senha digitada de novo para ligar 2FA/passkey; repetir alerta de ataque lento ao TOTP) e da etapa 3 (acerto não zera falhas).
- Rulesets da `develop` e da `main` conferidos ativos pela API em 31/10/2026.

## Próxima etapa

- Número e nome: 6 · Tarefas, notas e projetos (paralela com 7 e 8; uma de cada vez no modo contínuo)
- Dependências mescladas: sim (etapa 5, #10)
- Precisa de algo do Pablo antes: não
