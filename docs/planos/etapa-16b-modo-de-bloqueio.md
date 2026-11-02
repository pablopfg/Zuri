# Plano · Etapa 16b, comandos de segurança e modo de bloqueio

Situação: aprovado em 02/11/2026 (modo contínuo; sem perguntas ao Pablo, seção 14)
Origem: etapa 16 da especificação ("Aprovações seguras e modo de bloqueio"), segunda metade; divisão em `docs/planos/etapa-16-aprovacoes-telegram.md`
Dependências: etapas 4 (2FA e códigos de recuperação), 10 (rotinas), 11 (avisos e alertas), 12 a 15b (bot) e 16a (aprovações pelo bot, PR #93), todas mescladas

## 1. Resumo

O pacote de emergência do bot. Seis comandos novos (`/acessos`, `/sessoes`, `/encerrar_sessoes`, `/tokens`, `/pausar_rotinas`, `/bloquear`), o modo de bloqueio com a tela **Sair do bloqueio** no app e o reconhecimento no app, com senha recente, dos alertas de segurança que o bot causou. Nenhum comando usa IA, e `/bloquear` funciona com a IA fora do ar. Sem migration: o estado do bloqueio fica em `zur_settings`.

## 2. Contexto no sistema

- Bot: `apps/agent/src/telegram/service.ts` (`#fromOwner`, `#command`, `#onCommandButton`, `#confirmations`), `callbacks.ts` (`CommandButtons`, `COMMAND_ACTIONS`), `commands.ts` (`OPEN_COMMANDS`, `withoutButton`), menu versão 4.
- Login: `apps/agent/src/auth/service.ts` (`login`, `completeMfa`, `completePasskey`, `openSession`, `requireRecentAuth`, janela de 15 min), `auth/mfa.ts` (`TwoStep.verify`), `auth/sessions.ts`.
- Rotinas: `apps/agent/src/automations/executor.ts` (`routine`, problemas de execução).
- Alertas: `apps/agent/src/alerts/security.ts` (`BOT_CAUSED`), `alerts/service.ts` (`respondOutOfBand` devolve `app_only` para alerta de origem `bot`).
- Interface: `apps/web/src/App.tsx` (telas que travam o app), `PasswordChangePage.tsx` (chunk sob demanda), `NoticesPanel.tsx`, `ApprovePage.tsx`.
- Contrato: especificação, "Comandos", "Modo de bloqueio", "Avisos" ("Reconhecimento cruzado") e o aceite da etapa 16.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | `/acessos` mostra os 10 eventos mais novos com cidade, país, rede resumida (`a.b.x.x`) e aparelho; nunca o IP inteiro | especificação |
| CA2 | `/sessoes` lista as sessões web com **Encerrar n**; o botão encerra só aquela e sai da lista | especificação |
| CA3 | `/encerrar_sessoes`, `/pausar_rotinas` e `/bloquear` pedem confirmação por botão (sem passkey nem e-mail) e nunca pedem destravamento; Cancelar não faz nada; cada botão age uma vez | especificação, decisão da 16a |
| CA4 | `/tokens` mostra o estado vazio até a etapa 20; o bloqueio deixa o gancho de suspender e devolver tokens pronto | especificação, nota da 16a |
| CA5 | `/pausar_rotinas` pausa as rotinas com IA e as sentinelas; lembretes continuam | especificação |
| CA6 | `/bloquear` funciona com a IA fora do ar: numa transação encerra as sessões, suspende os tokens, grava `lockdown_until` e `lockdown_source`; rotinas com IA param enquanto durar | aceite |
| CA7 | Durante o bloqueio o bot só responde a `/status`, `/avisos` e `/ajuda`; recusa conversa, aprovação (botão, `/aprovar`, código por e-mail e a página `/aprovar`) e destravamento | especificação, nota da 16a |
| CA8 | A API recusa tudo com 423 `LOCKDOWN_ACTIVE`, exceto sessão, sair, confirmar senha, `GET /api/lockdown`, `POST /api/lockdown/exit`, configurações e desvincular o Telegram | especificação |
| CA9 | Primeira hora: login só com senha + código de recuperação, e esse login sai do bloqueio; código do app e passkey recusados sem gastar tentativa | aceite |
| CA10 | Depois da primeira hora: senha + 2FA, e o app abre direto em **Sair do bloqueio**, que mostra a origem e pede o código (do app ou de recuperação) com senha recente | especificação |
| CA11 | **Não fui eu: desvincular o Telegram** desvincula na hora, sem sair do bloqueio | especificação |
| CA12 | Rebloqueio pelo mesmo vínculo até 24 h depois de sair suspende o vínculo até o dono reconfirmar no app | aceite |
| CA13 | Os alertas de `/bloquear`, `/encerrar_sessoes` e `/pausar_rotinas` vão a todos os canais, não se reconhecem pelo bot e, no app, só com **Confirmar que vi** e senha digitada nos últimos 15 min; alerta da web não tem esse botão | aceite, "Reconhecimento cruzado" |
| CA14 | Menu do bot versão 5 com os seis comandos; `/ajuda` explica a emergência | especificação |

## 4. Escopo

**Entra:** os seis comandos, `TelegramSecurity`, o estado do bloqueio (`Lockdown`), as recusas no bot, na API e no login, `GET /api/lockdown` e `POST /api/lockdown/exit`, a tela **Sair do bloqueio**, **Confirmar que vi** na central de avisos, o estado "bloqueio" na página `/aprovar` e na lista de execuções de rotinas, eventos de Acessos novos, docs, README e changelog.

**Fica fora:** tokens remotos e o botão Revogar de `/tokens` (etapa 20, que liga os tokens ao `RemoteTokenHook`); pausar workflows e chamadas MCP (etapas 18 e 22, que consultam `auth.lockdown.active()` como o executor de rotinas).

## 5. Como funciona para o Pablo

1. Perdeu o celular ou viu acesso estranho: manda `/bloquear` no bot e toca **Bloquear agora**. Todas as sessões do app caem, as rotinas com IA param e chega alerta no e-mail, no aparelho e no Telegram.
2. Na primeira hora, para entrar no app ele usa a senha e um código de recuperação; esse login já desliga o bloqueio.
3. Depois de uma hora, entra com a senha e o código do aplicativo. O app abre em **Sair do bloqueio**, com "Ligado pelo Telegram em …". Ele confirma com o código e o app volta ao normal.
4. Se não foi ele: **Não fui eu: desvincular o Telegram**. O bot para de ouvir aquela conta na hora.
5. Na central de avisos, o alerta do bot mostra **Confirmar que vi**. Tocar pede a senha se ela não foi digitada nos últimos 15 min, e o alerta para de insistir.

Textos novos em `telegram.seg.*`, `telegram.bloqueio.*`, `auth.lockdown.*`, `web.lockdown.*` (em `pt-BR-setup.ts`), `web.notices.acknowledge*` e `web.approve.lockdown*`, com en no catálogo.

## 6. Regras de negócio e limites

- Botões das confirmações e de **Encerrar n**: 10 min, uso único (`CommandButtons`).
- `/acessos`: 10 eventos; `/sessoes`: sessões vivas, uso mais recente primeiro.
- Primeira hora: `LOCKDOWN_STRICT_MS` = 1 h; rebloqueio: `LOCKDOWN_RELOCK_MS` = 24 h.
- Durante o bloqueio, tudo que chega ao bot conta nos 60 comandos por hora; toques em botões respondem "bloqueio ligado".
- O alerta de cada comando sai uma vez por ação (sem duplicar em toques repetidos).

## 7. Desenho técnico

### Arquivos

- `packages/shared/src/lockdown.ts`: constantes, `lockdownStatusSchema`, `lockdownExitSchema` (`{totp}` | `{recoveryCode}` | `{}`).
- `apps/agent/src/auth/lockdown.ts`: `Lockdown` (`info`, `active`, `strict`, `mark`, `clear`) e `RemoteTokenHook` com `NO_REMOTE_TOKENS`.
- `apps/agent/src/auth/service.ts`: recusas no login, `enterLockdown`, `exitLockdown`, `lockdownStatus`, `openSessions`, `endSessions`.
- `apps/agent/src/telegram/security.ts`: `TelegramSecurity` (comandos e botões), `maskAddress`.
- `apps/agent/src/telegram/service.ts`: `#duringLockdown`, roteamento dos comandos e botões de segurança, suspensão do vínculo no rebloqueio, recusa das aprovações.
- `apps/agent/src/alerts/service.ts`: `acknowledgeInApp`; `Notice.ackInApp`.
- `apps/web/src/pages/LockdownPage.tsx` (no chunk de `PasswordChangePage`), `NoticesPanel.tsx`, `ApprovePage.tsx`.

### Rotas e contratos

- `GET /api/lockdown` → `{ lockdown: { since, strictUntil, source, relock } | null, needsCode }`.
- `POST /api/lockdown/exit` (corpo até 1 KiB) → 204; 403 `RECENT_AUTH_REQUIRED`, 409 `CONFLICT` sem bloqueio, 400 `VALIDATION_FAILED` sem código com 2FA ligada, 401 código errado.
- `POST /api/notices/:id/acknowledge` → aviso; senha recente; 409 `CONFLICT` para aviso que não é alerta do bot.
- 423 `LOCKDOWN_ACTIVE` nas demais rotas e no login da primeira hora; `SessionState.lockdown`.

### Banco

Sem migration (18 continua livre). Chaves em `zur_settings`: `lockdown_until` (fim da primeira hora; o bloqueio está ligado enquanto existir), `lockdown_source` (`telegram:<vínculo>`, com `|relock` no rebloqueio; fica depois da saída para conferir o rebloqueio), `lockdown_exited_at`.

### Ferramentas do agente

Nenhuma nova. Os comandos são do bot, fora do loop do modelo.

### Agendamentos, IA e integrações externas

O executor pula rotinas com IA durante o bloqueio (problema `lockdown`, visível na lista de execuções) e elas voltam sozinhas ao sair. Nenhuma chamada de IA nos comandos.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Subrequisições num comando | 1 (sendMessage) | 3 (toque: answer, edit, send) | 50 | `docs/arquitetura/orcamento-free-tier.md` |
| Linhas lidas | `/acessos` 10, `/sessoes` ≤ sessões vivas | — | — | idem |
| Neurons | 0 | 0 | — | sem IA |
| E-mail | 1 alerta por ação | cota diária de avisos | — | etapa 11 |
| JS inicial | +31 B (campo `lockdown` na sessão) | — | 139.076 B de 139.100 | CI |

Nada pago.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Quem tomou o Telegram trava o dono para sempre | rebloqueio em 24 h suspende o vínculo; login por código de recuperação sai na hora | `telegram-lockdown.test.ts`, `auth-lockdown.test.ts` |
| Quem tomou o Telegram usa o bloqueio para aprovar ou ler | bot só responde `/status`, `/avisos`, `/ajuda`; aprovações e destravamento recusados | `telegram-lockdown.test.ts` |
| Quem tem a senha e o app autenticador entra na primeira hora | só código de recuperação; código do app e passkey recusados | `auth-lockdown.test.ts` |
| Sessão roubada sai do bloqueio | sair pede senha recente e código quando a 2FA está ligada | `auth-lockdown.test.ts` |
| Alerta do bot calado pelo próprio bot | `respondOutOfBand` devolve `app_only`; no app só com senha recente | `telegram-lockdown.test.ts` |
| IP do dono no Telegram | `maskAddress`; texto passa por `disarm()` | `telegram-lockdown.test.ts` |
| Botão adivinhado ou repetido | id opaco de 16 caracteres, uso único, 10 min | `telegram-lockdown.test.ts` |

Auditoria completa (`cloudflare-security-audit:security-audit`, etapa 16), `auditor-seguranca` e `/security-review`.

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1 | 12 eventos viram 10 linhas com rede resumida; `maskAddress` IPv4/IPv6 | integração/unidade | `apps/agent/test/telegram-lockdown.test.ts` |
| CA2 | Encerrar 1 encerra uma sessão, sai da lista, segundo toque "já feito" | integração | idem |
| CA3 | os três comandos com leitura travada; Cancelar; confirmação age uma vez | integração | idem |
| CA4 | `/tokens` vazio; trava de leitura | integração | idem |
| CA5 | rotinas com IA e sentinela pausadas, lembrete ativo | integração | idem |
| CA6 | `/bloquear` com a IA fora do ar; executor pula rotina com IA e roda lembrete | integração | idem |
| CA7 | bot recusa conversa, `/aprovar`, botões, código; página `/aprovar` 423 | integração/e2e | idem, `tests/e2e/approve.spec.ts` |
| CA8 | API 423 fora da lista | integração | `telegram-lockdown.test.ts` |
| CA9 | login sem 2FA recusado; passkey e código do app recusados sem gastar tentativa; código de recuperação entra e sai | integração | `apps/agent/test/auth-lockdown.test.ts` |
| CA10 | depois da hora, 2FA entra e o bloqueio fica; sair com código errado, certo, sem código, sem senha recente | integração/e2e | idem, `tests/e2e/lockdown.spec.ts` |
| CA11 | Não fui eu desvincula (com pedido de senha) | integração/e2e | `telegram-lockdown.test.ts`, `lockdown.spec.ts` |
| CA12 | rebloqueio suspende o vínculo; outro vínculo ou 24 h depois não | integração | os dois arquivos do agente |
| CA13 | alerta em e-mail, push e Telegram; Feito do bot recusado; Confirmar que vi com senha recente; alerta da web 409 | integração/e2e | `telegram-lockdown.test.ts`, `lockdown.spec.ts` |
| CA14 | menu v5 | integração | `telegram-routes.test.ts` |

## 11. Entrega

- **Capturas:** tela **Sair do bloqueio** e alerta do bot na central, computador e celular, claro e escuro.
- **Docs:** `docs/telegram.md`, `docs/seguranca.md`, `docs/especificacao.md`, `.claude/memoria/progresso.md`, README.
- **Changelog:** `changelog/nao-lancado/etapa-16b-modo-de-bloqueio.md` com `<!-- versao: minor -->`.
- **Instalação e portabilidade:** nada novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Dono sem 2FA bloqueado na primeira hora | média | não entra por 1 h | mensagem do login explica; a tela de sair pede só senha recente depois |
| Dono sem códigos de recuperação | baixa | espera 1 h | texto do `/bloquear` avisa da primeira hora |
| Pacote inicial no limite | média | CI | tela no chunk que já trava o app; textos em `pt-BR-setup` |

## 13. Suposições

- `lockdown_until` guarda o fim da primeira hora; o bloqueio está ligado enquanto a chave existir (sai só pelo app ou pelo login com código de recuperação).
- Rotinas com IA ficam puladas durante o bloqueio, sem mudar de estado, e voltam sozinhas ao sair; `/pausar_rotinas` é que pausa de fato.
- Sem 2FA, sair do bloqueio pede só a senha recente (passkey só existe com a 2FA ligada).
- Senha recente é a janela de 15 min que já existe (senha ou código do app).
- Toques nos avisos do Telegram durante o bloqueio, no chat privado e no grupo, respondem "bloqueio ligado" sem agir; um código digitado no bloqueio é apagado sem ser conferido.
- Confirmar e Cancelar de uma pergunta apontam para o mesmo alvo: o primeiro toque gasta os dois.
- O bloqueio vem antes da troca de senha obrigatória e da configuração do segundo passo: elas aparecem depois da saída.
- Na primeira hora, sair pela tela também só aceita código de recuperação (uma sessão aberta numa corrida com `/bloquear` não sai com o código do app).
- `/bloquear` interrompe os turnos de conversa em andamento; o rebloqueio suspende o vínculo na mesma transação.
- `/bloquear` conta nos 60 comandos por hora, como todo o resto (risco aceito: estourar o limite de propósito exige a conta do Telegram, e o app continua tendo as mesmas ações).
- Os alertas dos três comandos insistem como os outros alertas de segurança causados pelo bot.

## 14. Entrevista com o Pablo

Sem perguntas: tudo coberto pela especificação ("Modo de bloqueio", "Reconhecimento cruzado"), pela decisão N11 e pelas notas da 16a.

### Perguntas abertas

- Nenhuma.
