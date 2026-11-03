# Avaliação: Dafthunk, agents-starter, Kumo UI e Cloudflare Agents

Pedido do Pablo em 03/11/2026: quatro perguntas de viabilidade, sem implementar
nada. Este documento registra o que foi lido, o custo de cada caminho e a
recomendação. Nada aqui muda código nem decisão já tomada.

Fontes lidas nesta data, no commit mais recente de cada repositório:

| Fonte | Commit lido em | Licença |
| --- | --- | --- |
| [dafthunk.com](https://www.dafthunk.com/) e [dafthunk-com/dafthunk](https://github.com/dafthunk-com/dafthunk) | 05/09/2026 | MIT |
| [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) | 24/07/2026 | MIT |
| [cloudflare/kumo](https://github.com/cloudflare/kumo) (`@cloudflare/kumo` 2.17.0) | 03/11/2026 | MIT |
| [cloudflare/agents](https://github.com/cloudflare/agents) (`agents` 0.33.0) | 03/11/2026 | MIT |
| [Workflows: limits](https://developers.cloudflare.com/workflows/reference/limits/) | 03/11/2026 | — |
| CRM do repositório de scripts do Pablo (privado) | 03/11/2026 | — |

## Resumo

| Pergunta | Resposta curta | Recomendação |
| --- | --- | --- |
| 1. Dafthunk na área de Automações | Não é seguro nem cabe no plano gratuito | Não usar; manter o motor da 22a |
| 2. agents-starter | É um exemplo de chat; a Zuri já usa o mesmo SDK, mais novo | Aproveitar duas ideias pequenas, nada do resto |
| 3. Kumo UI | Biblioteca de componentes React da Cloudflare | Não adotar |
| 4. Migrar o n8n com `cloudflare/agents` | Não migra nada sozinho; é um SDK para escrever agentes em código | Seguir o plano atual: motor 22a + CRM 22b; atendimento fica no n8n |

## 1. Dafthunk

### O que é

Editor visual de workflows (estilo n8n) feito para rodar na Cloudflare, com
mais de 470 nós (IA, navegador, mídia, redes sociais, HTTP, JavaScript). É um
produto completo e multiusuário: tem API própria, interface própria, login,
créditos de uso e versão hospedada.

### Segurança

| Ponto | O que encontramos | Peso para a Zuri |
| --- | --- | --- |
| Licença | MIT, sem restrição | Ok |
| Maturidade | Sem releases nem versão publicada; o site diz "fornecido como está, sem garantia" e que o projeto nasceu para explorar desenvolvimento assistido por IA | Alto risco para dado sensível |
| Quem roda o código | O nó **JavaScript** e o "Code Mode" executam código escrito pelo usuário ou gerado pela IA (Worker Loader e sandboxes em container) | **Fere a regra 3** (sem execução de código) |
| Rede | Nó **HTTP Request** para qualquer endereço, nós de navegador e de raspagem | **Fere a regra 3** (sem HTTP arbitrário) |
| Dados | Guarda fluxos, execuções, credenciais e arquivos em D1, KV, R2 e Analytics Engine, fora do SQLite do dono | Quebra "um Durable Object com SQLite" e o backup da etapa 23 |
| Superfície | Webhooks, formulários públicos, e-mail de entrada, agentes de IA com ferramentas | Muito maior que a da Zuri, sem a auditoria que a Zuri passou |

### Custo na Cloudflare

O `wrangler.jsonc` da API pede: Workflows, D1, KV, **R2** (3 buckets),
**Queues**, **Containers** (FFmpeg, DuckDB e sandbox de linguagens), **Worker
Loader**, Analytics Engine, envio de e-mail e Browser Rendering. Containers só
existem no Workers Paid; R2 e Queues são recursos novos que pedem OK do Pablo
(⚠). Mesmo cortando os nós pesados, a parte que sobra continua pedindo D1, KV e
R2. **Não cabe no plano gratuito como está.**

### Embute na área de Automações ou substitui o motor 22a?

Nenhum dos dois é viável sem um fork grande:

- **Embutir:** a interface é um app React separado, com React Flow. Só a tela
  de edição passaria muito do teto de JS inicial (139.600 B, com 43 B de folga);
  mesmo carregada sob demanda, traria outra stack visual, outra autenticação e
  outro banco.
- **Substituir o 22a:** perderíamos as travas que já estão prontas e testadas:
  catálogo fechado de passos, conexões cadastradas com senha recente, origem
  https fixa, DELETE proibido, fetch protegido, `<data source="flow">`, bloqueio
  (423), tetos por dia e o alarme único.
- **Esforço estimado:** semanas para um fork que remova código, HTTP livre,
  containers e D1/R2, e o resultado seria um projeto novo para manter e
  auditar.

### Dá para fazer as automações do CRM na Zuri?

Encontramos o CRM no repositório de scripts: **33 fluxos** no n8n, cerca de
**662 execuções agendadas por dia**, com **217 nós de código**, 177 IFs, 171
consultas ao Postgres, 125 chamadas HTTP, gatilho por IMAP e modelos pagos de
IA. A maior parte manda mensagens a terceiros (confirmação, aniversário,
recaptação, plano, marketing), o que já foi decidido que fica no n8n.

| Grupo do CRM | Onde fica |
| --- | --- |
| Avaliações do Google (coleta, vínculo, resposta) | Etapas 19c e 19d (plano `google-business-profile.md`) |
| Contatos do Google (leitura) | Já feito na 19b; padronizar e gravar no Google não entra (só leitura) |
| Funil, etiquetas, retorno, histórico | CRM interno da 22b, alimentado por eventos assinados (HMAC) do n8n |
| Agenda do dia, relatórios para o dono, sinais vitais, alertas | Fluxos da 22a (agendamento + IA + aviso) e 22c |
| Confirmação, aniversário, recaptação, plano alimentar, marketing, fila de envio | Ficam no n8n (mensagem a terceiros e nós de código) |
| Backup e restauração dos fluxos do n8n, configuração do Chatwoot | Ficam no n8n |

O Dafthunk não muda essa divisão: ele faria o mesmo que o n8n faz hoje, mas
com menos maturidade e custo maior.

**Recomendação:** não usar o Dafthunk. Seguir com 22a + 22b + 19c/19d. Se o
Pablo quiser, uma ideia de interface vale copiar depois (MIT permite): mostrar a
entrada e a saída de cada passo na tela de execução do fluxo.

## 2. cloudflare/agents-starter

### O que faz

Modelo de um chat com IA (cerca de 200 linhas no servidor e 1.000 na tela):
`AIChatAgent` do pacote `@cloudflare/ai-chat`, Workers AI, conversa por
WebSocket, tela feita com Kumo e quatro tipos de ferramenta de demonstração
(servidor, navegador, com aprovação e agendamento), mais conexão a servidores
MCP com login OAuth em janela.

A Zuri já usa o mesmo SDK (`agents` 0.30.1, mais novo que o 0.17 do modelo),
com classe `Agent` própria, agendamento pelo `this.schedule` e alarme único.

### O que dá para aproveitar

| Ideia | Como ficaria na Zuri | Valor |
| --- | --- | --- |
| `pruneMessages` do AI SDK: tira chamadas de ferramenta e raciocínio antigos do histórico mandado ao modelo | Antes de cada turno, cortar resultados de ferramenta de mensagens antigas | Bom: economiza Neurons do teto de 9.000/dia. Medir no teste de orçamento antes |
| `needsApproval` com função: a aprovação depende dos argumentos (ex.: só acima de um valor) | A Zuri já tem propostas e autonomia por ferramenta; a ideia só serve se um dia uma ferramenta precisar de limite por valor | Baixo; registrar como referência |
| `getSchedulePrompt` e `scheduleSchema`: texto pronto para a IA entender "daqui a 5 minutos" e cron | As rotinas já resolvem isso com data/hora do fuso do dono no servidor | Nenhum |

### O que conflita com as regras

- Conversa por **WebSocket do SDK** (`routeAgentRequest`, `/agents/*`): a Zuri
  fecha esses sockets de propósito; todo upgrade vai para `/api/live`.
- `@callable addServer(name, url)`: qualquer cliente conectado cadastra um
  servidor MCP sem senha recente nem conferência de endereço.
- **Ferramenta do navegador** (o cliente responde por ela): resposta vinda da
  tela vira entrada sem validação no servidor.
- **Modo de depuração** que mostra o JSON cru das mensagens na tela.
- **Kumo** e `@phosphor-icons/react` no pacote da tela (ver item 3).
- O `executeTask` agendado não tem limite, bloqueio nem `<data>`.

**Recomendação:** não trazer o modelo. Abrir, quando houver espaço no
cronograma, um ajuste pequeno de performance para testar o `pruneMessages` no
histórico mandado ao modelo, medido no teste de orçamento.

## 3. Kumo UI

### O que é

A biblioteca de componentes React da Cloudflare (a mesma linguagem visual do
painel da Cloudflare), sobre o Base UI, com Tailwind 4, ícones Phosphor, tema
claro e escuro, acessibilidade por padrão, kit no Figma e uma linha de comando
que mostra a documentação dos componentes. Serve para quem começa uma tela do
zero e quer componentes prontos com cara de Cloudflare.

### Serve para a Zuri?

Não agora:

- A Zuri já tem os próprios componentes (`ui.tsx`, PageHeader, AppShell),
  testados com axe, e identidade visual aprovada (N · Sinal).
- Kumo puxa Base UI, `motion`, `react-day-picker`, `shiki` e ícones Phosphor
  (a Zuri usa lucide). Qualquer pedaço na primeira tela estoura o teto de JS
  de 139.600 B; fora dela ainda duplicaria ícones e estilos.
- A tela ficaria com a cara do painel da Cloudflare, não da Zuri.

**Recomendação:** não adotar. Vale só como referência de padrões de
acessibilidade se um componente novo complicado aparecer.

## 4. cloudflare/agents para migrar o n8n

### O que o SDK oferece

O `agents` é um SDK para **escrever agentes em TypeScript**. Não lê nem importa
arquivos do n8n e não tem editor visual. Para fluxos, ele oferece:

| Recurso do SDK | O que faz | Já na Zuri? |
| --- | --- | --- |
| `this.schedule` (data, atraso, cron) | Agenda chamadas de método no Durable Object | Sim, no alarme único |
| `this.retry` e tentativas em agendamentos | Novas tentativas com espera crescente | O motor 22a já tem as suas (1, 5, 15 min) |
| `runFiber` e `stash` | Trabalho que sobrevive ao objeto ser despejado, com ponto de retomada | Não; o 22a grava o ponto onde parou no SQLite |
| `AgentWorkflow` | Liga o agente ao Cloudflare Workflows, com `waitForApproval` | Não |
| Code Mode | A IA escreve código que roda num Worker dinâmico | **Proibido** (regra 3) |
| Cliente MCP | Conexão a servidores MCP | Sim (etapas 18a/18b) |

### Comparação honesta dos três caminhos

| | Motor 22a (já pronto) | Cloudflare Workflows (via `AgentWorkflow`) | Reescrever no `agents` sem Workflows |
| --- | --- | --- | --- |
| Onde roda | Alarme do DO, SQLite do dono | Instâncias do Workflows, estado guardado pela Cloudflare | DO, como hoje |
| CPU no Free | 30 s por despertar | **10 ms por passo** | 30 s |
| Subrequisições no Free | 20 por despertar (50 do Worker) | 50 por instância | 50 por invocação |
| Passos | Até 20 por fluxo, catálogo fechado | 1.024 por instância | Livre, em código |
| Estado e dados | No banco do dono, entra no backup | Resultado de cada passo guardado por **3 dias** fora do banco do dono, até 1 MiB por passo | No banco do dono |
| Instâncias | 500 execuções/dia (teto da Zuri) | 100 simultâneas, 100.000 na fila | — |
| Nó de código / HTTP livre | Não (regra 3) | Só se escrevermos | Só se escrevermos |
| Custo extra | Nenhum | Nenhum no Free, mas com os limites acima | Nenhum |
| Esforço | Feito | 1–2 semanas para ligar e reauditar | Cada fluxo vira código revisado em PR |

Pontos que pesam:

- **10 ms de CPU por passo** no Free não deixa transformar JSON nem montar
  relatório dentro do passo; o 22a tem 30 s.
- O que um passo do Workflows devolve fica na Cloudflare por 3 dias. Para dados
  de saúde de "clientes" isso é um problema de LGPD, por isso a regra do plano
  `workflows-n8n.md`: passo recebe só ids, nunca dado nem credencial.
- O CRM do n8n tem 217 nós de código. Nenhum dos três caminhos importa isso
  automaticamente: cada fluxo teria de ser reescrito à mão. No 22a, como
  passos do catálogo; no SDK, como código, que é exatamente o que a regra 3
  impede o agente de criar sozinho.
- As ~662 execuções agendadas por dia do CRM passam do teto de 500 do 22a,
  mas a maior parte é de mensagens a terceiros, que ficam no n8n. O que vem para
  a Zuri (eventos, avisos, relatórios, avaliações) fica bem abaixo disso.

### Custo de cada caminho

| Caminho | Cloudflare | Trabalho |
| --- | --- | --- |
| Seguir 22a + 22b + 19c/19d + 22c | Free, sem recurso novo | Já no cronograma |
| Mover fluxos longos para o Workflows | Free (binding `WORKFLOW` já previsto), com 10 ms/passo e 3 dias de retenção | Só quando um fluxo precisar de mais de 15 min seguidos |
| Migrar todo o n8n para a Cloudflare | Exigiria Workers Paid para CPU, IA paga para os modelos do CRM e envio a terceiros pelo Chatwoot (⚠) | Meses, e fere as regras 1 e 3 |

**Recomendação:** não migrar o n8n inteiro. Seguir o plano atual: o motor 22a
para o que é da Zuri, o CRM interno da 22b recebendo eventos do n8n, as
avaliações na 19c/19d e a agenda e os contatos na 22c. O `AgentWorkflow` fica
como opção registrada para um fluxo que precise de mais de 15 min, com passos
que recebem só ids. O `runFiber` do SDK vale uma olhada na 22c, para comparar
com a retomada que o 22a já faz no SQLite.
