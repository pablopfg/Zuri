# Plano · Etapa 18a · Servidores MCP remotos (sem login e token Bearer)

Situação: aprovado em 02/11/2026 (decisões do Pablo de 31/10/2026 em `docs/planos/mcp.md`)
Origem: etapa 18 da especificação, primeira parte (18a); o login OAuth fica para a 18b
Dependências: etapas 9 (chat e aprovações), 10 (execuções agendadas), 16b (bloqueio) e 17 (busca semântica) mescladas

## 1. Resumo

O dono cadastra, em Configurações › Integrações, servidores MCP remotos
(Streamable HTTP por `https://`, sem login ou com token Bearer) e liga, uma a
uma, as ferramentas que a Zuri pode usar. Toda ferramenta começa desligada e,
ligada, pergunta antes de cada chamada; "Executar sem perguntar" só com senha
recente. A cada turno o servidor escolhe, sem IA, até 6 ferramentas MCP que
combinam com o pedido; a ferramenta nativa `find_tools` acha as que ficaram de
fora. Toda chamada passa por um `fetch` protegido (origem travada, DNS
conferido, sem redirecionamento, 2 MB, 35 s) que a etapa 22 reaproveita. O
resultado volta como dado (`<data source="mcp">`), nunca como instrução. O login
OAuth (18b) fica para uma PR própria.

## 2. Contexto no sistema

- Ferramentas e aprovações: `apps/agent/src/tools/registry.ts`
  (`ToolExecutor`, `runApprovedAction`), `apps/agent/src/chat/actions.ts`
  (`zur_pending_actions`), `POST /api/actions/:id/approve` em
  `apps/agent/src/api/chat.ts`, cartão em `apps/web/src/pages/chat/cards.tsx`.
- Turno: `apps/agent/src/agent/runner.ts` (`AgentRunner.chat` e
  `scheduled`), provedores em `apps/agent/src/ai/` (`ToolRequest`,
  `prepareStep` do AI SDK), contexto em `apps/agent/src/agent/context.ts`.
- Bloqueio: `auth.lockdown.active()` (etapa 16b); a API já recusa o chat no
  bloqueio, e o MCP confere de novo antes de cada chamada.
- Alertas de segurança: `zur_auth_events` com `alert_pending` →
  `flushSecurityAlerts`.
- Tela: `apps/web/src/pages/SettingsPage.tsx` mostra hoje um `LaterTab` em
  Integrações.
- Decisões: 31/10/2026, MCP só como cliente (`.claude/memoria/decisoes.md`);
  desenho em `docs/planos/mcp.md`.
- Talorys (referência, só leitura): `apps/agent/src/mcp/{url,client,credentials,repository,tools,service,routes}.ts`
  e `test/mcp*.test.ts`. Aproveitamos as defesas (endereço, DNS, `guardedFetch`,
  `limitBody`, cifra, catálogo com hash, aprovação vinculada) e evitamos as
  sessões em memória de 2 minutos (P5), as 20 ferramentas em toda chamada e a
  lista de origens permitidas por variável (não está na especificação).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Servidor só por `https://` em host público; URL com credenciais, fragmento, IP privado ou nome de rede local é recusada | especificação |
| CA2 | Antes de conectar, o DNS (A e AAAA) é conferido; resposta com endereço privado recusa a conexão | especificação |
| CA3 | Toda requisição vai só à origem cadastrada; redirecionamento é recusado, nunca seguido | especificação |
| CA4 | Resposta acima de 2 MB ou aberta por mais de 35 s é cortada com erro; conectar tem 10 s, cada chamada 30 s | especificação |
| CA5 | Token Bearer cifrado com AES-256-GCM sob `MCP_CREDENTIAL_KEY`, preso ao id do servidor, nunca devolvido, logado ou enviado à IA; sem a chave, servidor com token responde `NOT_CONFIGURED` | especificação |
| CA6 | Trocar a URL zera a confiança (ferramentas desligadas, de volta a "Perguntar sempre") e a credencial | especificação |
| CA7 | Ferramentas chegam desligadas, com prefixo `mcp_`; ferramenta cuja definição mudou fica fora até o dono revisar | especificação |
| CA8 | "Perguntar sempre" vira cartão de aprovação com servidor, ferramenta e argumentos exatos; a aprovação roda uma vez, presa aos argumentos e ao estado da ferramenta, e nunca é repetida | especificação |
| CA9 | "Executar sem perguntar" exige senha recente; mesmo assim vira proposta quando outro servidor MCP já respondeu no turno, quando os argumentos passam de 1.000 caracteres ou quando o turno já mandou 4.000 caracteres a servidores MCP | plano MCP |
| CA10 | Nenhuma ferramenta MCP roda em execução agendada nem durante o bloqueio | especificação |
| CA11 | No máximo 10 servidores, 10 ferramentas ligadas e 6 oferecidas por turno; triagem determinística pela mensagem, pela dica "Quando usar" e pela descrição | plano MCP |
| CA12 | `find_tools` (read, 1 por turno) devolve até 5 ferramentas ligadas em `<data>`, que passam a ser oferecidas no passo seguinte | plano MCP |
| CA13 | Resultado e descrição de servidor entram como dado (`<data source="mcp">`); injeção neles não liga ferramenta, não muda a lista nem tira o cartão | especificação |
| CA14 | A sessão MCP abre no turno e fecha no fim dele (P5); 3 falhas seguidas tiram o servidor da triagem por 15 min | plano MCP |
| CA15 | Cadastrar servidor ou trocar a URL exige senha recente e gera alerta de segurança | plano MCP / Talorys |
| CA16 | (novo) Tela Integrações com estados vazio, carregando, erro, sucesso; teclado, leitor de tela, celular, claro/escuro, axe | padrões |

## 4. Escopo

**Entra:** migration 18 (`zur_mcp_servers`, `zur_mcp_tools`, coluna `result`
em `zur_pending_actions`), módulo `apps/agent/src/mcp/`, rotas `/api/mcp/*`,
ferramenta `find_tools`, triagem, aprovação de chamada externa, alerta de
segurança, tela Integrações, rótulos no chat, ação na paleta, `docs/mcp.md`.

**Fica fora (e onde vai parar):**

- Login OAuth com PKCE e registro dinâmico → etapa 18b (rota
  `/api/mcp/oauth/callback`, página `/settings/mcp-oauth`, linha "MCP sem
  login" do `/status`).
- Nota por embedding da descrição na triagem → 18b (com o embedder da etapa 17).
- Aprovar chamada MCP pelo bot → 18b; até lá o cartão do bot mostra **Abrir no app** (lista fechada `BOT_APPROVABLE`).
- Lista de origens permitidas por variável (Talorys) → não faremos: não está na especificação; a tela e a senha recente já controlam quem cadastra.
- Backup das tabelas → etapa 23 (nunca leva a credencial).

## 5. Como funciona para o Pablo

### Fluxo 1 · Cadastrar um servidor

1. Configurações › Integrações › **Adicionar servidor**: nome, endereço
   (`https://…`), acesso (Sem login | Token) e o token quando houver.
2. Ao salvar, o app pede a senha se a última confirmação passou de 5 min; o
   servidor conecta na hora e lista as ferramentas, todas desligadas.
3. Erro de conexão aparece no cartão do servidor com o motivo em linguagem
   simples e o botão **Tentar de novo**.
4. Um aviso de segurança ("Servidor externo adicionado") vai a todos os canais.

### Fluxo 2 · Ligar uma ferramenta

1. Em cada servidor, a lista de ferramentas mostra nome, descrição (texto do
   servidor), selo "Só leitura" quando o servidor declara, e o interruptor.
2. Ligada, aparece "Quando usar" (até 200 caracteres, opcional) e a escolha
   **Perguntar sempre** (padrão) ou **Executar sem perguntar** (senha recente).
3. Ferramenta que mudou no servidor mostra "Mudou desde a sua revisão" e fica
   fora até ser ligada de novo.

### Fluxo 3 · Usar no chat

1. O dono pede algo; a Zuri recebe só as ferramentas que combinam (até 6).
2. Ferramenta com "Perguntar sempre": cartão "Usar *ferramenta* em
   *servidor*" com os argumentos exatos e **Aprovar**/**Recusar**. Aprovado,
   o resultado aparece no cartão e entra no contexto da próxima mensagem.
3. "Executar sem perguntar": roda no turno, e a atividade mostra a ferramenta
   e o servidor.

### Textos visíveis

Todos no catálogo (`packages/shared/i18n/pt-BR-settings.ts` para a tela,
`pt-BR-chat.ts` para o chat, `pt-BR-server.ts` para erros e avisos) e em `en.ts`.
A tela diz que o servidor externo recebe os argumentos das chamadas. Nenhum
texto cita infraestrutura.

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Servidores cadastrados | 10 | 11º recusado | `CONFLICT` |
| Ferramentas ligadas | 10 | 11ª recusada | `CONFLICT` |
| Ferramentas MCP oferecidas por turno | 6 e 2.000 tokens | as de nota menor ficam de fora | — |
| `find_tools` | 1 por turno, até 5 resultados | 2ª chamada recusada | ToolError |
| Chamadas por ferramenta MCP no turno | 3 | 4ª recusada | ToolError |
| Nome do servidor | 1 a 60 caracteres | 61 recusado | `VALIDATION_FAILED` |
| URL | até 2.048 caracteres | 2.049 recusado | `VALIDATION_FAILED` |
| Token | 1 a 4.096 caracteres | 4.097 recusado | `VALIDATION_FAILED` |
| "Quando usar" | até 200 caracteres | 201 recusado | `VALIDATION_FAILED` |
| Descrição que vai ao modelo | 500 caracteres | cortada | — |
| Schema de entrada | 6.000 caracteres, 10 níveis, `type: object` | ferramenta "incompatível" | — |
| Ferramentas lidas por servidor | 100 (5 páginas) | as demais ignoradas, aviso no cartão | — |
| Resposta | 2 MB, 35 s | cortada | erro "resposta grande demais" / "demorou" |
| Conectar / chamar | 10 s / 30 s | cancelado | — |
| Resultado ao modelo / guardado | 8.000 / 1.500 caracteres | cortado com aviso | — |
| Sem perguntar vira proposta | argumentos > 1.000; turno > 4.000 caracteres enviados; outro servidor já respondeu no turno | proposta | — |
| Falhas seguidas | 3 | fora da triagem por 15 min | — |
| Aprovação | 30 min (`PENDING_ACTION_TTL_MS`), uma vez | depois expira | `APPROVAL_EXPIRED` |

## 7. Desenho técnico

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `packages/shared/src/mcp.ts` | cria | constantes, schemas Zod das rotas, tipos de servidor e ferramenta |
| `packages/shared/src/chat.ts` | muda | `find_tools`, atividade e proposta de ferramenta externa (`mcp_call`, `external`, `result`) |
| `apps/agent/src/mcp/url.ts` | cria | endereço público, DNS por DNS-over-HTTPS, `McpEndpointError` |
| `apps/agent/src/mcp/guarded-fetch.ts` | cria | `guardedFetch`, `limitBody`, `classifyMcpError` (a etapa 22 reaproveita) |
| `apps/agent/src/mcp/credentials.ts` | cria | AES-256-GCM com HKDF de `MCP_CREDENTIAL_KEY`, id do servidor como AAD |
| `apps/agent/src/mcp/repository.ts` | cria | `zur_mcp_servers`, `zur_mcp_tools`, catálogo com hash |
| `apps/agent/src/mcp/catalog.ts` | cria | `checkTool`, `toZod` sem `pattern`, `resultText` |
| `apps/agent/src/mcp/triage.ts` | cria | nota por palavras, seleção por turno |
| `apps/agent/src/mcp/session.ts` | cria | sessão do turno (abre sob demanda, fecha no fim) |
| `apps/agent/src/mcp/service.ts` | cria | gestão pelo dono, ferramentas do turno, chamada, aprovação |
| `apps/agent/src/tools/find-tools.ts` | cria | ferramenta nativa `find_tools` |
| `apps/agent/src/tools/registry.ts` | muda | ferramentas externas, escalonamento para proposta, chamadas externas aprovadas |
| `apps/agent/src/agent/runner.ts` | muda | oferta por turno com `activeTools`, sessão fechada no fim |
| `apps/agent/src/ai/{provider,workers-ai,mock,metered}.ts` | muda | `activeTools` por passo |
| `apps/agent/src/api/mcp.ts` | cria | rotas do dono |
| `apps/web/src/pages/settings/IntegrationsTab.tsx` | cria | tela |
| `apps/web/src/pages/chat/{cards,labels}.tsx` | muda | cartão e rótulo de ferramenta externa |

### Rotas e contratos

Todas com sessão, CSRF e fora de `WHILE_LOCKDOWN`.

- `GET /api/mcp` → `{ credentialsAvailable, servers: McpServerInfo[] }` (os limites vêm de `MCP_LIMITS` no pacote compartilhado)
- `POST /api/mcp/servers` (`mcpServerCreateSchema`, 16 KB, senha recente) → 201 `{ server }`
- `PATCH /api/mcp/servers/:id` (`mcpServerUpdateSchema`; senha recente se a URL muda)
- `DELETE /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/connect` → reconecta e relê o catálogo
- `GET /api/mcp/servers/:id/tools` → `{ tools: McpToolInfo[] }`
- `PATCH /api/mcp/servers/:id/tools/:toolId` (`mcpToolUpdateSchema`; senha recente para ligar ou manter "sem perguntar")

### Banco

Migration 18 `mcp_servers`: `zur_mcp_servers` (id, slug, name, url,
auth_type `none|bearer|oauth`, credential cifrada, enabled, status, error
code, failures, paused_until, discovered_at, created_at, updated_at) e
`zur_mcp_tools` (server_id, name, exposed_name único, title, description,
input_schema, annotations, schema_hash, status, invalid_reason, enabled,
policy, hint, reviewed_hash, created_at, updated_at), mais
`zur_pending_actions.result`. Volume: até 10 servidores e 1.000 ferramentas.

### Ferramentas do agente

- `find_tools` (read, 1 por turno): frase até 200 caracteres → até 5 ferramentas ligadas em `<data source="mcp">`.
- `mcp_<servidor>_<ferramenta>` (dinâmicas): schema convertido do JSON Schema
  do servidor; "Perguntar sempre" = proposta; "Executar sem perguntar" =
  `read` com escalonamento; 3 por turno; nunca em `scheduled`.

### Agendamentos, IA e integrações externas

Sem alarme novo. DNS por `https://cloudflare-dns.com/dns-query` (5 s). A IA
gasta o mesmo de sempre; a fatia de 2.000 tokens das ferramentas MCP entra no
orçamento de contexto.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Subrequests por turno | 0 sem MCP; 2 DNS + 2 sessão + 1 chamada | 3 ferramentas × 3 chamadas + 2 servidores × 4 = 17 | 50 por invocação | `.claude/rules/performance.md` (P9) |
| Linhas lidas por turno | +2 consultas (≤ 10 servidores, ≤ 10 ferramentas ligadas) | 20 | — | `docs/arquitetura/orcamento-free-tier.md` |
| Escritas | 1 por chamada que falha (contador) | 3 | — | idem |
| JS inicial | 0 (tela sob demanda, ícone já carregado) | 0 | teto 139,1 kB | CI |
| Neurons | fatia de 2.000 tokens só com ferramenta oferecida | — | 9.000/dia | `docs/ia.md` |

Nenhum produto pago. Sem ⚠️.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| SSRF por URL ou DNS | endereço público, DNS conferido, origem travada, sem redirecionamento | `mcp-units.test.ts` |
| Servidor lento ou enorme | 10/30/35 s, 2 MB | `mcp-units.test.ts` |
| Vazamento do token | cifra, AAD, nunca em resposta, log ou prompt; só para a origem | `mcp-routes.test.ts` |
| Troca de URL para roubar confiança | zera ferramentas e credencial; senha recente; alerta | `mcp-routes.test.ts` |
| Injeção indireta (descrição/resultado) | `<data>`, descrição cortada, sem efeito na lista ou no cartão | `mcp-chat.test.ts` |
| Agência excessiva | desligada por padrão, aprovação, escalonamento, sem agendadas, bloqueio | `mcp-chat.test.ts` |
| Regex que trava o objeto | `pattern` removido antes do Zod | `mcp-units.test.ts` |
| Ferramenta trocada pelo servidor | hash revisado; aprovação presa ao hash | `mcp-chat.test.ts` |

Auditoria: orientação (completa nas etapas 3, 4, 12, 16, 18, 20 e 25: a 18 é completa).

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1–CA2 | endereços e DNS | unitário | `apps/agent/test/mcp-units.test.ts` |
| CA3–CA4 | origem, redirecionamento, 2 MB, 35 s | unitário | `apps/agent/test/mcp-units.test.ts` |
| CA5–CA7, CA15 | cadastro, token, troca de URL, catálogo, revisão, senha recente, alerta, limites | integração | `apps/agent/test/mcp-routes.test.ts` |
| CA8–CA14 | chat com servidor de teste, aprovação, escalonamento, triagem, `find_tools`, injeção, agendada, bloqueio, sessão fechada | integração/segurança | `apps/agent/test/mcp-chat.test.ts` |
| CA11 | triagem determinística pt-BR e en | unitário | `apps/agent/test/mcp-units.test.ts` |
| P9 | subrequests e linhas do pior turno | orçamento | `apps/agent/test/free-tier-budget.test.ts` |
| CA16 | tela, axe | e2e | `tests/e2e/integracoes.spec.ts` |

## 11. Entrega

- **Ordem:** um PR (18a); a 18b em outro.
- **Capturas:** Configurações › Integrações (vazio e com servidor), computador e celular, claro e escuro.
- **Docs:** `docs/mcp.md` (novo), `docs/seguranca.md`, `docs/chat.md`, `docs/configuracao-cloudflare.md` (segredo `MCP_CREDENTIAL_KEY`), README.
- **Changelog:** `changelog/nao-lancado/mcp-remoto.md` com `<!-- versao: minor -->`.
- **Instalação:** segredo opcional `MCP_CREDENTIAL_KEY` (32+ caracteres) para servidores com token.
- **Portabilidade:** nenhum binding novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Bundle do Worker cresce com o cliente MCP | alta | baixo | `@modelcontextprotocol/client` já vem com o Agents SDK; medir no build |
| Modelo grátis erra o nome da ferramenta | média | baixo | triagem enxuta, `find_tools`, nome curto |
| Servidor muda ferramenta entre proposta e aprovação | baixa | médio | hash da definição na aprovação (`TARGET_CHANGED`) |

## 13. Suposições

- Etapa dividida em 18a e 18b, como o plano MCP recomenda e a especificação permite.
- Aprovação de chamada MCP pelo bot fica para a 18b.
- "Outro servidor na conversa" vale para a conversa toda: a revisão de segurança mostrou que o texto das respostas de turnos anteriores volta ao contexto, então contam as aprovações com resposta e as chamadas automáticas recentes (corrigido antes do PR).
- "Usar sem perguntar" só para ferramenta que o servidor marca como de consulta (`readOnlyHint`). É a leitura da regra 3 da especificação (escrita vira proposta); a revisão de QA achou o caso, e o PR avisa o Pablo.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| 31/10/2026 | Zuri usa servidores MCP de fora? Vira servidor MCP? | Sim / não (`docs/planos/mcp.md`) |

### Perguntas abertas

- Nenhuma.
