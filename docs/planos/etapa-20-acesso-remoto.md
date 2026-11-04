# Plano · Etapa 20 · Acesso remoto e eventos

## 1. Resumo

Tokens pessoais `zur_pat_` (escopos `read`, `write` e `events`, 90 dias, só HMAC no banco) para clientes do lado do servidor (n8n, Home Assistant, scripts) e a rota `POST /api/remote/events`, que transforma um evento de fora num aviso da categoria **Eventos**. Tudo negado por padrão: um token só alcança a lista fechada de rotas, e um teste percorre todas as rotas registradas.

## 2. Contexto no sistema

- Portões em `apps/agent/src/index.ts` (1 a 4) e `apps/agent/src/api/app.ts` (5: CSRF e sessão). Hoje um `Authorization` qualquer cai na sessão e recebe 401 (`test/agent.test.ts`).
- Gancho do bloqueio já pronto: `RemoteTokenHook` em `apps/agent/src/auth/lockdown.ts` (`suspendAll`, `resumeAll`, `active`), chamado por `AuthService.enterLockdown`, `exitLockdown` e pelo login com código de recuperação. `/tokens` do bot (`telegram/security.ts`) só mostra a contagem.
- Central de avisos (`alerts/service.ts`): categoria `events` já existe na tabela e nas rotas padrão; falta o tipo de aviso e o limite próprio.
- Referência: Talorys `apps/agent/src/remote/{allowlist,middleware,tokens,routes,events}.ts` e `docs/remote-access.md`.
- Decisões que valem: `/api/flows/*` e `/api/crm/*` fora dos tokens (22a, 22b); no bloqueio nada externo roda; segredo por HMAC com `SESSION_SECRET`; passo extra (senha recente) para mexer em tokens (Regras de segurança, item 7).

## 3. Objetivo e critérios de aceite

1. Token `read` recebe 403 em toda rota de escrita (teste que percorre as rotas). → `remote-routes.test.ts`
2. Nenhum token (read, write, events) alcança `/api/auth*`, `/api/telegram*`, `/api/approvals*`, `/api/lockdown*`, `/api/actions*`, `/api/plans*`, `/api/flows*`, `/api/crm*`, `/api/remote/tokens*` nem outra rota fora da lista; o handler nunca roda (teste que percorre todas as rotas registradas). → `remote-routes.test.ts`
3. Token inválido, vencido, revogado, suspenso ou com o acesso remoto desligado recebe 401 e nunca cai para o cookie. → `remote-routes.test.ts`
4. O banco guarda só o HMAC; o token aparece uma vez na criação. → `remote-routes.test.ts`
5. 10 tentativas inválidas por rede em 15 min dão 429 mesmo com o token certo; 120 pedidos por minuto por token. → `remote-routes.test.ts`
6. `POST /api/remote/events` só com token `events`; 60 por hora e 100 por dia (429 + `Retry-After`); repetição de `source`+`id` em 24 h é descartada; `critical` recusado; título com a origem, numa linha, links desarmados; eventos usam no máximo metade do limite de cada canal; no máximo 3 insistem ao mesmo tempo. → `remote-events.test.ts`
7. Bloqueio suspende os tokens e sair do bloqueio devolve; troca de senha, recuperação e redefinição revogam todos. → `remote-routes.test.ts`, `auth-password-route.test.ts`
8. `/tokens` do bot lista os tokens com **Revogar** (um toque, alerta que só o app reconhece). → `telegram-lockdown.test.ts`
9. Tela Configurações › Segurança › **Acesso remoto**: ligar/desligar, criar (nome e escopo), copiar uma vez, revogar um e todos; estados vazio, carregando, erro; claro/escuro; teclado; axe. → e2e `acesso-remoto.spec.ts`

## 4. Escopo

Dentro: tokens, gate Bearer, allowlist, eventos, tela, `/tokens`, docs (`docs/acesso-remoto.md`, `docs/seguranca.md`, `docs/avisos.md`, `docs/telegram.md`), changelog, README.

Fora: busca por significado por token (gasta Neurons; fica para depois, com metade da cota como no Talorys); apagar memórias e automações por token (sem lixeira, ver 6); MCP como servidor (decisão: a Zuri é só cliente); gatilho de fluxo por evento remoto (fica com o gatilho por evento do CRM/agenda, fora da 20).

## 5. Como funciona para o Pablo

### Fluxo 1 · Criar um token

Configurações › Segurança › Acesso remoto → liga a chave (pede a senha se faz mais de 15 min) → nome + escopo (`Só ler`, `Ler e escrever`, `Só eventos`) → **Gerar token** → diálogo com o token, aviso de que aparece uma vez, botão **Copiar** e exemplo de `curl` → alerta de segurança em todos os canais.

### Fluxo 2 · Revogar

Na lista: **Revogar** (confirmação) ou **Revogar todos**. Pelo bot: `/tokens` → **Revogar** no token.

### Fluxo 3 · Evento do n8n

Nó HTTP Request com `Authorization: Bearer zur_pat_…` → `POST /api/remote/events` → aviso "n8n: Backup falhou" na central (categoria Eventos).

### Textos visíveis

Chaves `web.remote.*` em `pt-BR-security.ts` (tela) e `en.ts`; `telegram.seg.tokens.*`, `notice.remote.event.title`, `notice.security.remote_*` em `pt-BR-server.ts`; rótulos do registro de acessos `web.activity.kind.remote_*`.

## 6. Regras de negócio e limites

| Regra | Valor | No limite |
| --- | --- | --- |
| Tokens | até 20 | 409 `CONFLICT` |
| Validade | 90 dias | 401 depois |
| Nome | 1 a 64, único sem caixa | 400 / 409 |
| Pedidos por token | 120 por 60 s (memória do objeto) | 429 + `Retry-After` |
| Bearer inválido | 10 por rede em 15 min | 429 + `Retry-After`, mesmo com token certo |
| Eventos | 60/h e 100/dia, todos os tokens | 429 + `Retry-After` |
| Corpo do evento | 2 KB; título 1–120, corpo ≤ 1.000 | 400 |
| Eventos nos canais | metade do limite por hora e por dia de cada canal | fica só no app (`channel_limit`) |
| Eventos insistindo | 3 | os outros saem uma vez |

Rotas permitidas (caminho comparado como chegou, `:id` = UUID; `HEAD` = `GET`):

| Escopo | Rotas |
| --- | --- |
| `read` | `GET /api/health`, `GET /api/tasks`, `/api/tasks/counts`, `/api/tasks/:id`, `/api/notes`, `/api/notes/:id`, `/api/projects`, `/api/memories`, `/api/memories/:id`, `/api/automations`, `/api/automations/:id` |
| `write` | o de `read` + `POST /api/tasks`, `PATCH`/`DELETE /api/tasks/:id`, `POST /api/notes`, `PATCH`/`DELETE /api/notes/:id`, `POST /api/memories`, `PATCH /api/memories/:id`, `POST /api/automations`, `PATCH /api/automations/:id` |
| `events` | só `POST /api/remote/events` (nenhum outro token nem a sessão chega a ela) |

- Tarefas e notas apagadas por token vão para a lixeira (30 dias). Memórias e automações não se apagam por token (a memória não tem lixeira; a automação pode ser pausada com `PATCH {enabled:false}`): decisão técnica de segurança, reversível depois.
- Automações por token: só `reminder` e `task_digest`. Criar ou mudar uma `agent_prompt` dá 403 (o modelo e as ferramentas não ficam ao alcance de um token vazado).
- Acesso remoto desligado por padrão; desligar suspende todos (401) e mantém a lista; ligar pede senha recente e gera alerta.

## 7. Desenho técnico

### Arquivos

- `packages/shared/src/remote.ts` (tipos, constantes e schemas Zod marcados `/* @__PURE__ */`, fora do JS inicial).
- `apps/agent/src/remote/allowlist.ts` (função pura), `tokens.ts` (`RemoteTokens`: criar, validar, listar, revogar, suspender, limites), `events.ts` (`RemoteEvents`).
- `apps/agent/src/api/remote.ts` (porteiro Bearer, rotas de administração e de eventos); `app.ts` registra o gate antes de tudo e pula CSRF/sessão só para o chamador validado.
- `apps/agent/src/alerts/service.ts`: tipo `remote.event`, metade do limite para ele, teto de 3 insistindo.
- `apps/agent/src/telegram/security.ts`: `/tokens` com Revogar.
- `apps/web/src/components/security/RemoteAccessCard.tsx` dentro do chunk de Configurações.

### Rotas e contratos

| Rota | Auth | Resposta |
| --- | --- | --- |
| `GET /api/remote` | sessão | `{enabled, tokens, max}` |
| `PATCH /api/remote` | sessão + senha recente para ligar | `{enabled}` |
| `POST /api/remote/tokens` | sessão + senha recente | 201 `{token: {…, secret}}` uma vez |
| `DELETE /api/remote/tokens/:id`, `DELETE /api/remote/tokens` | sessão | 204 / `{revoked}` |
| `POST /api/remote/events` | Bearer `events` | 201 `{event, duplicate:false}`, 200 `{event:null, duplicate:true}` |

Ordem no gate: `Authorization` presente → limite de falhas da rede → token válido (ligado, não suspenso, não vencido, sem bloqueio) → 401 `UNAUTHORIZED` (nunca o cookie) → escopo e allowlist → 403 `FORBIDDEN` → limite por token → handler, sem CSRF nem sessão.

### Banco

Migration 28 `remote_access`: `zur_remote_tokens(id, name, token_hash UNIQUE, hint, scope CHECK, created_at, expires_at, last_used_at, suspended)` e `zur_remote_failures(network, at)`. Estado ligado/desligado e janela de eventos em `zur_settings` (InternalState). Nada disso entra no backup.

### Ferramentas do agente

Nenhuma. O agente não cria nem lê tokens.

### Agendamentos, IA e integrações externas

Nenhum. Os eventos não chamam IA nem saem para a rede (só os canais de aviso já existentes).

## 8. Custo e cotas do plano Free

Sem recurso novo. Cada pedido remoto é um pedido ao Worker e ao objeto (100 mil/dia no Free); o teto de 120 por minuto por token e 20 tokens limita o pior caso, e a validação faz 1 SELECT por pedido (gravação de `last_used_at` no máximo 1 vez por minuto). Eventos: até 100 avisos/dia, metade do limite de canal. Zero Neurons (busca semântica fora).

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Token vazado do banco | só HMAC(`SESSION_SECRET`, token) | `remote-routes` |
| Token alcança rota sensível | default deny + segmentos negados + teste que percorre todas as rotas | `remote-routes` |
| Bearer ruim cai no cookie | gate falha fechado | `remote-routes` |
| Força bruta de token | 10 falhas por rede/15 min, 256 bits de entropia | `remote-routes` |
| CSRF com Bearer | CORS fechado; Bearer não vai sozinho pelo navegador | — |
| Evento se passa pela Zuri | título com a origem; origem com "zuri" ou o nome da agente vira `remote` | `remote-events` |
| Evento com link/HTML | links desarmados, uma linha, texto puro na central | `remote-events` |
| Evento inunda o dono | 60/h, 100/dia, metade do canal, 3 insistindo, nunca crítico | `remote-events` |
| Token cria rotina com IA | 403 para `agent_prompt` | `remote-routes` |
| Bloqueio | suspende tokens; volta ao sair | `remote-routes` |
| Log | nunca token, corpo ou query; só nome e prefixo do id | `log.test` existente |

## 10. Testes

Unitário (allowlist, schemas), integração no workerd (gate, rotas, eventos, bloqueio, troca de senha, bot), contrato (códigos de erro), e2e da tela com axe, i18n pelo lint.

## 11. Entrega

Um PR `feat(remote): adiciona tokens de acesso remoto e eventos de entrada (etapa 20)` para a `develop`, fragmento `changelog/nao-lancado/acesso-remoto.md` com `<!-- versao: minor -->` e `### Atualização` (migration 28), README.

## 12. Riscos

- Teto do JS inicial: a tela fica no chunk de Configurações; textos novos em `pt-BR-security.ts` (carregado com a tela).
- Contador por token em memória zera quando o objeto reinicia (aceito, como no Talorys).

## 13. Suposições

- Com o Cloudflare Access ligado, o cliente remoto usa um service token do Access (documentado); não há bypass do Access para Bearer.

## 14. Entrevista com o Pablo

Nada bloqueia: escopos, limites e rotas seguem a especificação e o Talorys. As escolhas mais restritivas (sem apagar memórias/automações e sem busca por significado por token) ficam registradas no PR e podem ser abertas depois.

### Perguntas abertas

Nenhuma.
