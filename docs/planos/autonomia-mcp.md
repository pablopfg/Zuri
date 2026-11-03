# Plano · Autonomia por ferramenta MCP

Situação: aprovado em 03/11/2026
Origem: pedido do Pablo em 03/11/2026 (`docs/planos/mcp.md`, item 7)
Dependências: etapa 18b mesclada (#111)

## 1. Resumo

Hoje "Usar sem perguntar" só vale para ferramenta que o servidor marca como
de consulta, e rotinas nunca usam ferramenta externa. O Pablo quer decidir
por ferramenta: algumas rodam sozinhas na conversa, outras também em rotinas e
workflows, e uma rotina pode ganhar liberdade só para ela. Esta entrega troca
a política de dois valores por três níveis, abre as ferramentas externas às
rotinas com IA, cria a liberação por rotina e transforma a chamada de rotina
que esbarra numa trava em proposta com aviso. Uma PR, com migration 20.

## 2. Contexto no sistema

- Política atual: `MCP_TOOL_POLICIES = ["approve", "auto"]`
  (`packages/shared/src/mcp.ts`); `effectivePolicy` e `readOnly` em
  `apps/agent/src/mcp/service.ts` (auto só com `readOnlyHint`); a rota
  `PATCH /mcp/servers/:id/tools/:tool` pede senha recente para `auto`
  (`apps/agent/src/api/mcp.ts`); `McpTurnTools.mustAsk`
  (`apps/agent/src/mcp/agent.ts`); o seletor no cartão da ferramenta
  (`apps/web/src/pages/settings/IntegrationsTab.tsx`).
- Rotinas com IA: `AgentRunner.scheduled` (`apps/agent/src/agent/runner.ts`),
  modo `scheduled` (só leitura e `notify_owner`), executor em
  `apps/agent/src/automations/executor.ts`, tabela `zur_automations`.
- Propostas: `zur_pending_actions` (`conversation_id NOT NULL`),
  `runApprovedExternal`, aprovação no app, no bot e em `/aprovar` (18b).
- Decisões: autonomia por ferramenta (03/11/2026, `decisoes.md`); "Usar sem
  perguntar só para consulta" (18a) fica substituída; conteúdo de terceiros é
  dado; bloqueio corta tudo (16b).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Cada ferramenta tem um de três níveis: "Perguntar sempre" (padrão), "Sem perguntar na conversa", "Sem perguntar, também em rotinas e workflows" | Pablo |
| CA2 | Subir de nível pede a senha digitada agora e gera aviso de segurança; descer não pede | Pablo |
| CA3 | Ferramenta que escreve pode subir, com aviso a mais na tela | Pablo |
| CA4 | Ferramenta que o servidor marca como destrutiva (`destructiveHint: true`) fica sempre em "Perguntar sempre" (API recusa, executor confere de novo) | Pablo / regra 3 |
| CA5 | Rotina com IA recebe as ferramentas do terceiro nível e as liberadas para ela, com a mesma triagem | Pablo |
| CA6 | Liberação por rotina: na tela da rotina, o dono escolhe ferramentas que rodam sem perguntar só ali; senha recente e aviso; nunca destrutiva | Pablo |
| CA7 | Em rotina, chamada que pediria cartão (ferramenta sem autonomia ali, mais de 1.000 caracteres, turno acima de 4.000, resposta de outro servidor já na execução) não roda: vira proposta pendente, com aviso no app e no Telegram, e a rotina segue | Pablo |
| CA8 | Definição mudada volta a ferramenta para "Perguntar sempre" e tira a liberação das rotinas | Pablo |
| CA9 | Bloqueio da conta: nada externo em conversa nem rotina | 16b |
| CA10 | Rotina tem teto próprio de 12 subrequisições externas por execução | plano |

## 4. Escopo

**Entra:** três níveis, rotas e tela de Integrações, liberação por rotina na
tela de Automações, ferramentas externas nas rotinas com IA, propostas de
rotina, migration 20, docs.

**Fica fora:** workflows (etapa 22 reaproveita a liberação por automação);
ferramenta da Zuri com escrita em rotina (continua só leitura).

## 5. Como funciona para o Pablo

### Fluxo 1 · Dar autonomia a uma ferramenta

1. Integrações › cartão da ferramenta › "Quando usar": três opções.
2. Ferramenta que escreve: ao escolher um nível sem pergunta, aparece o aviso
   "Esta ferramenta pode mudar dados no serviço. Sem perguntar, a Zuri age
   sem mostrar antes o que vai mandar."
3. Destrutiva: as duas opções sem pergunta ficam desativadas, com o motivo.
4. Senha (se não recente) e aviso de segurança.

### Fluxo 2 · Liberar ferramentas para uma rotina

1. Automações › editar rotina com IA › seção "Ferramentas externas".
2. Lista as ferramentas ligadas: as do terceiro nível aparecem marcadas e
   travadas ("Liberada em Integrações"); as outras podem ser marcadas só para
   esta rotina; destrutivas não aparecem marcáveis.
3. Salvar pede a senha se marcou alguma e gera aviso.

### Fluxo 3 · Rotina que esbarra numa trava

1. A rotina roda; a chamada vira proposta numa conversa "Rotina: <nome>".
2. Aviso "A rotina <nome> quer usar <ferramenta>. Veja e aprove na conversa."
   no app e no Telegram (com **Aprovar** no bot, como na 18b).

### Textos visíveis

A definir na implementação, em pt-BR e en, pela `humanizer`.

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Nível sem pergunta em destrutiva | proibido | recusa | 409 `CONFLICT` |
| Ferramentas liberadas por rotina | até 10 | recusa a 11ª | 400 `VALIDATION_FAILED` |
| Subrequisições externas por execução de rotina | 12 | a chamada falha sem repetir | — |
| Propostas por execução de rotina | 3 | as seguintes só viram aviso | — |

## 7. Desenho técnico

- Migration 20: `ALTER TABLE zur_mcp_tools ADD COLUMN routines INTEGER NOT NULL DEFAULT 0`
  (terceiro nível = `policy = 'auto'` e `routines = 1`); tabela
  `zur_automation_mcp_tools (automation_id, exposed_name, created_at,
  PRIMARY KEY (automation_id, exposed_name))`; `zur_automations.conversation_id`
  para a conversa da rotina.
- Na API, `McpToolInfo.policy` passa a ter três valores: `approve`, `auto` e
  `routines`. Rotas novas: `GET` e `PATCH /api/mcp/routines/:id/tools`.
- Mudar a instrução de uma rotina desfaz a liberação dela (uma sessão roubada
  não troca o trabalho de uma rotina já liberada sem a senha).
- `effectivePolicy` passa a olhar `destructiveHint` em vez de `readOnlyHint`.
- `AgentRunner.scheduled` ganha as ferramentas externas (modo `scheduled`,
  `McpTurnTools` com `context: "routine"`), e as propostas vão para uma
  conversa da rotina criada sob demanda.
- Hash de aprovação inclui o nível (a liberação vale só na execução da rotina;
  a aprovação do dono é explícita).

## 8. Custo e cotas do plano Free

Rotina com ferramenta externa: até 12 subrequisições por execução, dentro das
50 do alarme. Sem Neuron a mais (a triagem por significado já existe). JS
inicial: telas sob demanda.

## 9. Segurança e privacidade

| Ameaça | Defesa |
| --- | --- |
| Rotina sem dono olhando manda dados para fora | só ferramentas que o dono liberou para rotinas ou para aquela rotina; tetos de 1.000/4.000; outro servidor já respondeu vira proposta |
| Servidor muda a ferramenta para destrutiva | definição mudada volta a "Perguntar sempre" e tira a liberação |
| Injeção na resposta pede outra ferramenta | só o que foi oferecido roda; resposta em `<data>` |
| Sessão roubada dá autonomia | senha recente e aviso |

Auditoria: orientação.

## 10. Testes

Cada CA com teste em `mcp-chat.test.ts`, `mcp-routes.test.ts`,
`automations-*.test.ts`, `migrations.test.ts` e e2e de Integrações e
Automações.

## 11. Entrega

- Uma PR para a `develop`, branch `feat/mcp-autonomia-por-ferramenta`.
- Capturas: cartão da ferramenta e seção da rotina.
- Docs: `docs/mcp.md`, `docs/seguranca.md`, `docs/especificacao.md` (regra
  das rotinas), README.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Rotina gasta subrequisições do alarme | baixa | outras tarefas do alarme sem cota | teto de 12 por execução |

## 13. Suposições

- Nível guardado como `policy` + coluna `routines` (sem refazer o CHECK).
- Propostas de rotina numa conversa própria, para reaproveitar cartão, bot e
  `/aprovar`.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| 03/11/2026 | Onde se configura, ferramentas que escrevem, rotina que esbarra numa trava (3 perguntas) | "Ok para as 3", e rotina ou workflow que precisar de mais liberdade tem de poder ser ajustado |
