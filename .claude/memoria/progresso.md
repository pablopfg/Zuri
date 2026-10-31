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

## Últimas etapas (detalhe)

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

### Etapa 2 · Banco, configurações e i18n
- Entregou: `apps/agent/src/db/{database,migrations,settings,activity}.ts`, `ZuriAgent.store` (banco aberto e migrado no primeiro uso; falha não fica em cache), `packages/shared/src/{settings,format}.ts`, `plural()`/`createTranslator()` no i18n, `scripts/lint-i18n.ts` + `i18n-ignore.json` (no `npm run lint` e no job `i18n`).
- Migrations: versão 1 (`zur_settings` chave/valor JSON, `zur_activity`); `zur_schema_version` criada pelo `migrate()`. Teste fixa o sha256 de cada migration mesclada: migration nova = linha nova em `PINNED`.
- Decisões técnicas: parser do lint é `rolldown/parseAst` (TypeScript 7 não tem API JS; rolldown 1.2.16 já vinha com o Vite, agora devDependency explícita); fuso padrão vem de `DEFAULT_TIMEZONE` se válido; recusas dos portões do Worker ficam em pt-BR (não acordam o DO); sem rota de configurações ainda (precisa de sessão, etapa 3/5); limite do plano Free conferido em 31/10/2026: 1 GB por DO, 5 GB por conta, teto de 900 MB mantido.
- Atenção para a próxima: erros dentro do DO já saem no idioma das configurações via `errorResponse(error, locale)`; `Database.run` devolve `rowsWritten` (conta índices, não use como "linhas afetadas"); a checagem de 900 MB e a retenção de `zur_activity` ainda não existem (etapa 23, ou antes se uma rota gravar muito); a allowlist do backup de `zur_settings` deve ser positiva.

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

- Nada no momento. Rulesets da `develop` e da `main` conferidos ativos pela API em 31/10/2026.

## Próxima etapa

- Número e nome: 5 · Casca da interface (fecha a fase A: mandar resumo de fase)
- Dependências mescladas: sim (etapa 4, #9)
- Precisa de algo do Pablo antes: não
