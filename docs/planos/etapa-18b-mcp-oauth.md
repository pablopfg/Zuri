# Plano · Etapa 18b: login OAuth, triagem por significado e aprovação pelo bot

Situação: implementado (PR da etapa 18b)
Origem: etapa 18 da especificação, segunda metade (divisão em `docs/planos/mcp.md`, seção "Entrega")
Dependências: etapa 18a mesclada (#105); etapa 17 (busca por significado, #99); etapa 16a (aprovações pelo bot, #93)

## 1. Resumo

A 18a ligou servidores MCP sem acesso ou com token fixo. A 18b fecha a etapa
com três peças: o login OAuth (PKCE e registro dinâmico) para serviços que só
aceitam conta, a triagem das ferramentas pelo significado da mensagem quando a
busca por significado está ligada, e a aprovação das chamadas externas pelo
bot do Telegram. O Pablo ganha o botão "Entrar no serviço" em Integrações, a
Zuri passa a achar a ferramenta certa mesmo sem palavra em comum, e as
propostas de chamada externa chegam ao bot com os argumentos exatos.

## 2. Contexto no sistema

- Cliente MCP da 18a: `apps/agent/src/mcp/` (`service.ts`, `session.ts`,
  `guarded-fetch.ts`, `repository.ts`, `triage.ts`, `agent.ts`), tabelas
  `zur_mcp_servers` e `zur_mcp_tools` (migration 18).
- SDK `@modelcontextprotocol/client` 2.3.1: `OAuthClientProvider`,
  `StreamableHTTPClientTransport({ authProvider })` e `finishAuth()`. O `auth()`
  do SDK usa o fetch do transporte, então todo pedido de OAuth passa pelo
  `guardedFetch`.
- Busca por significado (etapa 17): `apps/agent/src/semantic/` (vetores int8,
  `cosineInt8`, piso do modelo, fatia de Neurons da indexação).
- Aprovações pelo bot (etapa 16a): `apps/agent/src/telegram/approvals.ts`.
- Decisões: MCP só cliente (etapa 18; `docs/planos/mcp.md`); "Usar sem
  perguntar" só para ferramentas de consulta (18a, pendente de confirmação do
  Pablo); conteúdo de terceiros é dado.
- Talorys: não usado nesta etapa.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Servidor com "Entrar com a conta do serviço" faz login OAuth com PKCE S256, registro dinâmico (cliente público) e `resource` | especificação |
| CA2 | Tokens, cliente registrado e verificador ficam cifrados com `MCP_CREDENTIAL_KEY`; nada volta à interface nem ao log | especificação |
| CA3 | O `state` vale 10 minutos e uma vez só; a volta do login pede a senha digitada agora e gera aviso | plano (novo) |
| CA4 | O token de acesso nunca vai para outra origem; o servidor de login passa pelas regras de SSRF | plano (novo) |
| CA5 | Um turno de conversa ou rotina nunca começa um login; servidor sem login fica "Entrar de novo" e não pausa | plano (novo) |
| CA6 | Renovar o token não anula propostas abertas (hash preso à hora do login) | plano (novo) |
| CA7 | Com a busca por significado ligada, a triagem soma pontos pelo significado; vetores feitos no alarme, sem chamada a mais por turno | especificação |
| CA8 | Desligada, em bloqueio ou sem vetor atual, a triagem segue só por palavras | plano (novo) |
| CA9 | Chamadas externas se aprovam pelo bot com prévia do servidor e os argumentos exatos; mudou algo, não aprova | especificação |
| CA10 | Argumentos com mais de 600 caracteres só pela passkey; resposta volta como citação desarmada, cortada em 600 | plano (novo) |
| CA11 | `/status` avisa quantos servidores esperam login | plano (novo) |

## 4. Escopo

**Entra:** login OAuth, rota de volta, botão e estados na tela de Integrações,
triagem por significado, aprovação de `mcp_call` pelo bot e pela página
`/aprovar`, `/status`, simulação local do servidor de login, migration 19,
docs.

**Fica fora (e onde vai parar):**

- Cliente OAuth confidencial (com segredo) → não faremos: o segredo teria de
  ficar guardado por servidor e os serviços MCP aceitam cliente público.
- `find_tools` por significado → fica por palavras (cada busca seria uma
  chamada de modelo a mais no turno).
- Token por ferramenta de rotina → etapa 20 (`RemoteTokenHook`).

## 5. Como funciona para o Pablo

### Fluxo 1 · Entrar no serviço

1. Integrações › Adicionar servidor › Acesso "Entrar com a conta do serviço
   (OAuth)" (desligado sem a chave de credenciais). Salva com a senha.
2. A Zuri descobre o servidor de login, registra o app e mostra o botão
   **Entrar no serviço** (link de 10 minutos) com a dica.
3. O Pablo entra na página do serviço e volta para `/configuracoes/integracoes`;
   a tela tira os parâmetros da barra, mostra "Terminando o login…", pede a
   senha se ela não for recente e mostra "Pronto, a Zuri entrou na conta do
   serviço." O servidor conecta e lista as ferramentas.
4. Erro ou link vencido: toast "O login não terminou…" e o botão de novo.
   Teclado e leitor de tela: o botão é um link comum com nome; o estado é uma
   linha `role="status"`. Claro, escuro e celular seguem o cartão da 18a.

### Fluxo 2 · Aprovar pelo bot

1. A Zuri propõe uma chamada externa numa conversa do Telegram ou do app.
2. O cartão do bot mostra "usar a ferramenta externa", a ferramenta e o
   servidor, e "O que vai para o serviço:" com os argumentos.
3. **Aprovar** pede passkey ou código por e-mail (como na 16a). Feito, a
   resposta do serviço aparece como citação.

### Textos visíveis

| Chave | pt-BR | en | Onde aparece |
| --- | --- | --- | --- |
| `web.integrations.auth.oauth` | Entrar com a conta do serviço (OAuth) | Sign in with the service's account (OAuth) | formulário |
| `web.integrations.oauthHint` | Ao salvar, a Zuri prepara o login e mostra o botão Entrar no serviço. | When you save, Zuri prepares the sign-in and shows the Sign in to the service button. | formulário |
| `web.integrations.signin` | Entrar no serviço | Sign in to the service | cartão |
| `web.integrations.signinHint` | Você vai para a página do serviço e volta para cá quando terminar. O link vale 10 minutos. | You go to the service's page… | cartão |
| `web.integrations.signinFinishing` | Terminando o login no serviço… | Finishing the sign-in to the service… | status |
| `web.integrations.signedIn` | Pronto, a Zuri entrou na conta do serviço. | Done, Zuri is signed in to the service. | toast |
| `web.integrations.signinFailed` | O login não terminou. Tente de novo pelo botão Entrar no serviço. | The sign-in didn't finish… | toast |
| `web.integrations.problem.signin` | Falta entrar na conta do serviço para a Zuri usar este servidor. | Sign in to the service so Zuri can use this server. | cartão |
| `web.integrations.problem.oauth` | O login no serviço não deu certo. Tente de novo; se repetir, o serviço pode não aceitar apps novos. | Signing in to the service didn't work… | cartão |
| `error.mcpSignInExpired` | Esse login venceu ou já foi usado. Comece de novo em Configurações › Integrações. | This sign-in expired or was already used… | erro da API |
| `web.approve.action.mcp_call` | Usar uma ferramenta externa | Use an external tool | `/aprovar` |
| `web.approve.preview.sent` | O que vai para o serviço | What goes to the service | `/aprovar` |
| `telegram.aprovar.acao.mcp_call` | usar a ferramenta externa | use the external tool | bot |
| `telegram.aprovar.enviado` | O que vai para o serviço: | What goes to the service: | bot |
| `telegram.aprovar.resposta` | Resposta do serviço (conteúdo de fora, só para ler): | The service's answer (outside content, for reading only): | bot |
| `telegram.cmd.status.mcpSemLogin` | Serviços externos esperando você entrar na conta: {n}. Veja em Configurações › Integrações. | External services waiting for you to sign in: {n}… | `/status` |

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Validade do `state` | 10 min (`MCP_LIMITS.oauthStateMs`) | vencido ou gasto: recusa | 400 `VALIDATION_FAILED` (`error.mcpSignInExpired`) |
| Corpo da volta do login | 8 KB; `code` ≤ 2.048, `error` ≤ 200 | maior: recusa | 413 / 400 |
| Formato do `state` | `<uuid>.<32 bytes base64url>` | outro: recusa | 400 |
| Senha recente na volta | a da 18a | sem ela | 403 `RECENT_AUTH_REQUIRED` |
| Subrequisições na aprovação pelo bot | 12 | passa: a chamada falha sem repetir | — |
| Argumentos no cartão do bot | 600 caracteres | mais: só passkey | — |
| Resposta no bot | 600 caracteres | corta e diz quanto ficou de fora | — |
| Pontos por significado | 3 no piso, até 6 | abaixo do piso: 0 | — |
| Espera após falha de vetores | 15 min | — | — |
| Prazo da chamada de vetores | 30 s, fatia de Neurons da indexação | — | — |

Concorrência: as gravações do registro OAuth de um servidor são em fila
(`#saving`); duas voltas de login com o mesmo `state` deixam só a primeira
passar, porque o `state` é gasto antes de trocar o código.

## 7. Desenho técnico

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `apps/agent/src/mcp/oauth.ts` | cria | `ZuriOAuthProvider` e o registro OAuth |
| `apps/agent/src/mcp/meaning.ts` | cria | vetores das ferramentas e notas por significado |
| `apps/agent/src/mcp/dev-oauth.ts` | cria | servidor de login simulado |
| `apps/agent/src/mcp/service.ts`, `session.ts`, `guarded-fetch.ts`, `repository.ts`, `triage.ts`, `agent.ts` | muda | login, origem do login, notas, orçamento |
| `apps/agent/src/api/mcp.ts` | muda | `POST /mcp/oauth/callback` |
| `apps/agent/src/telegram/approvals.ts`, `service.ts`, `commands.ts` | muda | `mcp_call` no bot e `/status` |
| `apps/agent/src/semantic/service.ts` | muda | `known()`: vetor da mensagem já feito |
| `apps/web/src/pages/settings/IntegrationsTab.tsx`, `ApprovePage.tsx` | muda | botão, volta do login, prévia |
| `packages/shared/src/mcp.ts`, `mcp-schemas.ts`, `telegram.ts`, i18n | muda | contratos e textos |

### Rotas e contratos

`POST /api/mcp/oauth/callback`: sessão do dono, senha recente, corpo
`mcpOAuthCallbackSchema` (estrito), resposta `{ server }` com
`Cache-Control: no-store`. `McpServerInfo.authorizeUrl` mostra o link enquanto
vale.

### Banco

Migration 19 `mcp_oauth_and_meaning`, só `ALTER TABLE ADD COLUMN`:
`zur_mcp_servers.authorize_url`, `authorize_expires`, `signed_in_at`;
`zur_mcp_tools.embedding` (BLOB int8), `embedding_scale`, `embedding_key`. Até
50 ferramentas ligadas × 256 a 768 bytes.

### Ferramentas do agente

Nenhuma nova. `mcp_call` ganha aprovação pelo bot; `find_tools` não muda.

### Agendamentos, IA e integrações externas

O alarme compartilhado chama `mcp.meaning.tick()` depois do `semantic.tick()`:
uma chamada de embeddings por rodada para as ferramentas sem vetor atual. O
turno usa `semantic.known(message)` (vetor que a busca de memórias já fez).

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Neurons (vetores) | 1 chamada quando uma ferramenta muda | 1 por 15 min em falha | fatia da indexação | `SEMANTIC_LIMITS.indexNeuronShare` |
| Neurons por turno | 0 a mais | 0 a mais | — | `semantic.known()` |
| Subrequisições no login | ~6 (metadados, registro, token, DNS) | 24 no app | 50 do Free | `MCP_SUBREQUEST_BUDGET` |
| SQLite | 1 escrita por vetor e por login | — | — | migration 19 |
| JS inicial | 0 B (tela de Integrações é lazy) | — | ver PR | `scripts/orcamento-do-bundle` |

Nenhum recurso pago.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Token enviado a outra origem | `Authorization`/DPoP tirados fora da origem cadastrada | `mcp-units.test.ts` |
| SSRF pelo servidor de login | origem do login conferida (https, DNS, IP público), uma vez por turno | `mcp-oauth.test.ts` |
| CSRF / login trocado | `state` de 32 bytes, 10 min, uso único, gasto antes do código; senha recente | `mcp-oauth.test.ts`, `mcp-routes` |
| Emissor falso | o SDK confere o `issuer` (RFC 8414/9207) | `mcp-oauth.test.ts` |
| Turno abrindo login | provedor não interativo lança `signin` | `mcp-oauth.test.ts` |
| Resposta do serviço como ordem | citação desarmada no bot; `<data>` no prompt | `telegram-approvals.test.ts` |
| Aprovação de algo que mudou | hash conferido na prévia e na execução | `telegram-approvals.test.ts` |

Auditoria completa (etapa 18 está na lista).

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1–CA6 | login completo, `state` vencido/gasto, sem chave, origem do login, renovação | integração | `apps/agent/test/mcp-oauth.test.ts` |
| CA4 | cabeçalhos fora da origem | unitário | `apps/agent/test/mcp-units.test.ts` |
| CA7–CA8 | vetores no alarme, chave, falha e espera, reaproveitar vetor | integração | `apps/agent/test/mcp-meaning.test.ts` |
| CA9–CA10 | prévia, mudou, texto longo, resposta | integração | `apps/agent/test/telegram-approvals.test.ts` |
| CA11 | `/status` | integração | `apps/agent/test/telegram-commands.test.ts` |
| migração | pino 19 e 18→19 | contrato | `apps/agent/test/migrations.test.ts` |
| CA1, CA3 | login pela tela | e2e | `tests/e2e/integracoes.spec.ts` |

## 11. Entrega

- **Ordem:** um PR.
- **Capturas:** Integrações com servidor OAuth esperando login.
- **Docs:** `docs/mcp.md`, `docs/seguranca.md`, `docs/telegram.md`, `docs/especificacao.md`, README.
- **Changelog:** `changelog/nao-lancado/etapa-18b-mcp-oauth.md`
- **Instalação:** nada novo (`MCP_CREDENTIAL_KEY` já existe e segue opcional; sem ela o OAuth fica desligado).
- **Portabilidade:** nenhum binding novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Serviço sem registro dinâmico | média | não dá para entrar | problema `oauth` com texto claro |
| DNS rebinding entre a conferência e o fetch | baixa | pedido a IP interno | já registrado em `docs/seguranca.md` para a etapa 22 |
| Mudança de modelo de embeddings | baixa | vetores velhos | chave inclui o modelo: refeitos no alarme |

## 13. Suposições

- A volta do login é `/configuracoes/integracoes` (rotas em português, sem
  código novo no JS inicial).
- A volta pede a senha recente, como as outras mudanças de servidor.
- Só ações do dono começam um login; turno e rotina nunca.
- O hash de aprovação de servidor OAuth usa `signed_in_at`.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| — | Nenhuma pergunta: o escopo já estava fechado em `docs/planos/mcp.md` | — |

### Perguntas abertas

- Nenhuma nova.
