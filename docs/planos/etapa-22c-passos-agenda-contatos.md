# Plano · Etapa 22c · Passos da agenda e dos contatos nos fluxos

Situação: aprovado em 04/11/2026 (modo contínuo; nenhuma pergunta de produto, custo ou segurança ficou aberta)
Origem: etapa 22c da especificação, plano `docs/planos/workflows-n8n.md`
Dependências: 19 (#136), 19b (#144), 22a (#153) e 22b (#161) mescladas (`develop` em 1ce03cc)

## 1. Resumo

Os fluxos ganham três passos novos no catálogo fechado: **Ler a agenda**
(eventos de uma agenda aberta à Zuri, numa janela de dias contada a partir de
hoje), **Criar evento** (um evento por item, numa agenda em "ler e editar",
sem convidados e sem e-mail a ninguém) e **Buscar contatos** (na cópia local
do Google Contatos, por nome, telefone, e-mail, etiqueta ou aniversário).
Tudo usa a conexão Google que já existe, conta no mesmo teto de chamadas do
despertar e não pede migration. De quebra, o Google simulado do
desenvolvimento passa a seguir o dia de São Paulo (issue #178).

## 2. Contexto no sistema

- Motor e catálogo: `apps/agent/src/flows/engine.ts` (`advance`, `step`),
  `packages/shared/src/flows.ts` (`FLOW_NODE_TYPES`, `FlowNode`,
  `FLOW_RUN_PROBLEMS`), `packages/shared/src/flows-schemas.ts`
  (`flowDefinitionSchema`), `apps/agent/src/flows/service.ts` (`newWake`,
  `execute`, `list`).
- Agenda: `GoogleCalendar.events`, `createEvent`, `readable`, `calendar`
  (`apps/agent/src/google/service.ts`), `eventBody` e `localInstant`
  (`apps/agent/src/google/events.ts`), `GoogleMeter` e o contador único do
  despertar (`apps/agent/src/agent/wake-budget.ts`, issue #152).
- Contatos: `GoogleContacts.search` e `labels`
  (`apps/agent/src/google/contacts.ts`), só leitura do banco do objeto.
- Tela: `apps/web/src/pages/automations/flows/FlowEditor.tsx`, `labels.ts`,
  textos em `packages/shared/i18n/pt-BR-flows.ts` e `en.ts`.
- Sugestão pela conversa: `apps/agent/src/tools/flows.ts` (`propose_flow`).
- Decisões: 03/11/2026 agenda só mexe em eventos; a Zuri não muda evento com
  convidados; fluxo grava só com métodos marcados (POST/PUT/PATCH), nada de
  DELETE; 02/11/2026 contatos só leitura (`contacts.readonly`), nada é enviado
  aos contatos; contatos fora de log e backup.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Passo **Ler a agenda**: uma agenda aberta (ou todas as abertas), janela de 1 a 31 dias começando de −30 a +365 dias a partir de hoje no fuso do dono, texto de busca opcional; cada evento vira um item (id, agenda, título, início, fim, dia inteiro, local, descrição cortada em 500, convidados, compartilhado, repetido); até 100 eventos | especificação + plano |
| CA2 | Passo **Criar evento**: um evento por item (até 10 por execução, acima disso nada é criado), numa agenda em "ler e editar"; título, início (`AAAA-MM-DD` ou `AAAA-MM-DDTHH:mm` no fuso do dono, ou instante ISO com fuso) e descrição montados com `{{campo}}`; duração de 5 a 1.440 min; nunca convidados, lembretes ou e-mail (`sendUpdates=none`); data inválida para antes de criar qualquer um | plano |
| CA3 | **Chave contra repetição**: com chave preenchida, o id do evento sai do fluxo e da chave (SHA-256), e o Google recusa o segundo (409), que conta como "já existia" sem erro | plano (novo) |
| CA4 | Nenhum passo muda ou apaga evento; agenda fechada, só leitura ou só livre/ocupado para com `calendar_missing` | decisões de 03/11 |
| CA5 | Passo **Buscar contatos**: na cópia local (sem chamada ao Google), por texto com `{{campo}}`, etiqueta e aniversário (hoje ou 7 dias), até 100; com "um por item" cada item ganha `contact` (o primeiro achado ou nulo); contatos desligados param com `contacts_off` | especificação + plano |
| CA6 | Chamadas ao Google entram no contador da execução (40) e no do despertar (20 dos fluxos e 44 do alarme); sem lugar, a execução espera 1 min sem refazer o que já fez | decisão #152 |
| CA7 | Google desconectado, sem permissão ou com escopo faltando para com `google_access`; Google fora do ar ou 429 tenta de novo em 1 e 5 min; no bloqueio nada é chamado | plano |
| CA8 | O que vem da agenda e dos contatos é dado: entra no modelo só em `<data source="flow">`, nunca muda um passo; nada de contato vai a log | regras 4 e 2 |
| CA9 | Editor: os três passos com campos rotulados, lista das agendas e etiquetas vinda de `GET /api/flows`, aviso quando o Google ou os contatos estão desligados; claro e escuro, celular, teclado, axe e e2e | padrão de qualidade |
| CA10 | `propose_flow` conhece os passos novos; a sugestão continua nascendo desligada | 22b |
| CA11 | Issue #178: os eventos de exemplo do Google simulado seguem o dia de São Paulo mesmo com o servidor ligado antes da meia-noite | issue #178 |

## 4. Escopo

**Entra:** três passos, cinco problemas novos (`google_access`,
`calendar_missing`, `contacts_off`, `invalid_date`, `events_limit`), dados do
Google na lista de fluxos, editor, `propose_flow`, `docs/fluxos.md`,
especificação, correção da #178.

**Fica fora:**

- Mudar ou apagar evento por fluxo: não faremos (decisões de 03/11/2026).
- Convidar pessoas: não faremos (nada é enviado a terceiros).
- Gatilho de fluxo por evento do CRM ou da agenda e passos do CRM no motor:
  pendência em `progresso.md` (PR própria; pede tabela de fila de gatilhos).
- Ligar cliente do CRM a contato do Google: pendência (o passo de contatos já
  permite cruzar pelo telefone dentro de um fluxo).

## 5. Como funciona para o Pablo

### Fluxo 1 · Lembrar o retorno de quem foi atendido ontem

1. Automações › Fluxos › **Novo fluxo**, todo dia às 8h.
2. Passo **Ler a agenda**: Consultório, começa em −1 dia, 1 dia.
3. Passo **Buscar contatos**, um por item, texto `{{title}}`.
4. Passo **Avisar** com `{{contact.name}}` e `{{contact.phone}}`.

### Fluxo 2 · Agendamentos de outro sistema na agenda

1. Passo **Chamar um serviço** (conexão cadastrada) que devolve a lista.
2. Passo **Criar evento** na agenda "ler e editar", título `{{paciente}}`,
   início `{{data}}`, 50 min, chave `{{id}}`. Rodar de novo não duplica.

Estados do editor: Google desconectado mostra "Conecte o Google em
Configurações › Integrações para usar este passo"; contatos desligados mostram
o aviso equivalente; sem agenda em "ler e editar", a escolha da agenda fica
vazia com o aviso. A lista de agendas e etiquetas vem com a lista de fluxos
(nenhuma consulta nova na tela).

### Textos visíveis

Chaves novas em `pt-BR-flows.ts` e `en.ts`: `web.flows.node.calendar`,
`web.flows.node.calendar_create`, `web.flows.node.contacts`, campos
`web.flows.form.calendar*`, `web.flows.form.contacts*`, avisos
`web.flows.form.googleOff`, `web.flows.form.contactsOff`,
`web.flows.form.noWritable` e os cinco `web.flows.problem.*` novos.

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Eventos lidos por passo | 100 | os 100 primeiros pela hora | — |
| Janela da leitura | início −30 a +365 dias, 1 a 31 dias | schema recusa | `VALIDATION_FAILED` |
| Eventos criados por execução | 10 | 11 itens: nada é criado | `events_limit` |
| Duração | 5 a 1.440 min | schema recusa | `VALIDATION_FAILED` |
| Contatos por busca | 1 a 100 | schema recusa | `VALIDATION_FAILED` |
| Chamadas ao Google por passo | 4 por despertar (como as rotinas) | espera 1 min | — |
| Data do item | `AAAA-MM-DD`, `AAAA-MM-DDTHH:mm` ou ISO com fuso | para antes de criar | `invalid_date` |

Fuso: o início local é convertido pelo fuso do dono (`localInstant`, que já
trata horário de verão); "hoje" da leitura é o dia local do dono.

## 7. Desenho técnico

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `packages/shared/src/flows.ts` | muda | tipos, limites, problemas, `FlowGoogleInfo` |
| `packages/shared/src/flows-schemas.ts` | muda | schemas dos três passos |
| `apps/agent/src/flows/google-steps.ts` | cria | os três passos (agenda, criar, contatos) |
| `apps/agent/src/flows/engine.ts` | muda | despacho dos passos e `EngineDeps.google` |
| `apps/agent/src/flows/service.ts` | muda | deps do Google, lista com agendas e etiquetas |
| `apps/agent/src/google/service.ts` | muda | `createEvent` com id escolhido; `GoogleMeter` aceita o contador dos fluxos |
| `apps/agent/src/google/dev-google.ts` | muda | id escolhido e 409; dia que acompanha São Paulo (#178) |
| `apps/agent/src/tools/flows.ts` | muda | descrição dos passos novos |
| `apps/web/src/pages/automations/flows/FlowEditor.tsx`, `labels.ts` | muda | campos dos passos |

### Rotas e contratos

`GET /api/flows` passa a trazer `google: { connected, calendars: [{ id, name,
writable }], contacts, labels: [{ id, name }] }`. Nenhuma rota nova.

### Banco

Sem migration: a definição é JSON em `zur_flows.definition`, validada pelo
schema ao salvar e ao ler.

### Ferramentas do agente

Nenhuma nova; `propose_flow` só descreve os passos novos.

### Agendamentos, IA e integrações externas

Leitura: `events.list` por agenda (1 chamada cada, mais a renovação do token
quando vence). Criação: `events.insert` com `sendUpdates=none`. Contatos: só
SQLite. Nenhum escopo novo.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Subrequisições por despertar | 1 a 2 | 4 por passo, 20 dos fluxos | teto de 44 do alarme | `wake-budget.ts` |
| Leituras SQLite (contatos) | ~100 linhas | 100 itens × busca de 1 | índices de 19b | `contacts.ts` |
| Cota da Calendar API | ~100/dia | 40 por execução × 500 | 1.000.000/dia do Google | documentação da Calendar API |
| JS inicial | 0 | 0 (editor é lazy) | 45 B | `check-bundle-size` |

Nada pago.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Texto de evento ou contato com instrução | só entra no modelo em `<data source="flow">` | `flows-google.test.ts` |
| Fluxo convida ou avisa terceiros | corpo só com título, horário, descrição; `sendUpdates=none` | `flows-google.test.ts` |
| Fluxo muda ou apaga evento | nenhum passo faz; agenda só leitura recusada | `flows-google.test.ts` |
| Rajada de eventos | 10 por execução, chave contra repetição | `flows-google.test.ts` |
| Id do evento escolhido por dado de fora | id é hash, só `[0-9a-f]` | `flows-google.test.ts` |
| Contatos em log | só o nome do erro vai ao log | lint de logs |
| Definição editada à mão | schema na leitura | `flows.test.ts` |

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1, CA4, CA6, CA7 | leitura, janela, agenda fechada, contador, erros | integração | `apps/agent/test/flows-google.test.ts` |
| CA2, CA3 | criação, data inválida, 10/11 itens, 409 | integração | `apps/agent/test/flows-google.test.ts` |
| CA5 | busca, um por item, desligado | integração | `apps/agent/test/flows-google.test.ts` |
| CA8 | `<data>` na IA | segurança | `apps/agent/test/flows-google.test.ts` |
| CA1, CA2, CA5 | schemas n−1, n, n+1 | unitário | `packages/shared/test/flows.test.ts` |
| CA9 | editor com os passos novos | e2e + axe | `tests/e2e/flows.spec.ts` |
| CA10 | descrição da ferramenta | unitário | `apps/agent/test/crm-tools.test.ts` |
| CA11 | dia de São Paulo | unitário | `apps/agent/test/google-hardening.test.ts` |

## 11. Entrega

- **Ordem:** um PR (a #178 vai junto, com `Closes #178`).
- **Capturas:** editor com os passos novos (computador e celular, claro e escuro).
- **Docs:** `docs/fluxos.md`, `docs/especificacao.md`, README ("O que já funciona").
- **Changelog:** `changelog/nao-lancado/etapa-22c-passos-agenda-contatos.md`.
- **Instalação:** nada novo.
- **Portabilidade:** nenhum binding novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Evento apagado no Google não volta a ser criado com a mesma chave (o id fica reservado) | média | baixo | documentado em `docs/fluxos.md` |
| Fluxo a cada 15 min lendo 10 agendas gasta a cota do despertar | baixa | médio | 4 chamadas por passo; o resto espera |

## 13. Suposições

- Criar evento entra nesta etapa (sem convidados), porque a especificação fala
  em "passos que usam a Google Agenda" e a decisão de 03/11 só proíbe mudar
  evento com convidados e apagar; mudar evento fica fora.
- O id escolhido usa o alfabeto hexadecimal, que cabe no base32hex que o
  Google aceita.
- Contatos com "um por item" usam só o primeiro achado, para o item não crescer.

## 14. Entrevista com o Pablo

Sem perguntas: nada novo de produto, custo ou segurança além das decisões já
registradas.
