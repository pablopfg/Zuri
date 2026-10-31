# MCP no Zuri: avaliação de viabilidade

Situação: proposta para o Pablo decidir. Nada aqui foi implementado.
Data: 31/10/2026.

## Resposta curta

Sim, dá para fazer, e metade já está no roteiro.

- **Zuri usando servidores MCP de fora (cliente MCP).** É exatamente o que o
  Talorys fez, e a etapa 18 da especificação ("Servidores MCP remotos") já
  prevê isso no Zuri, com os mesmos cuidados. Recomendação: manter na etapa 18,
  com quatro ajustes para o plano Free e para as regras do Zuri (seção
  "Ajustes").
- **Outros apps usando o Zuri por MCP (servidor MCP).** O Talorys **não** fez
  isso (o `docs/remote-access.md` dele diz "Isto não é um servidor MCP"). Seria
  escopo novo: o Claude, o Cursor ou outro app conversaria com as suas
  tarefas, notas e memórias. Dá para fazer no plano Free, mas é decisão de
  produto. Recomendação: deixar para depois da etapa 20 (tokens de acesso
  remoto), começar só leitura e com token, e só depois pensar em escrita e em
  login OAuth.

## O que o Talorys fez

Lido na branch `develop` do Talorys: `docs/mcp.md`, a seção "Servidores MCP
remotos" de `docs/security.md` e `apps/agent/src/mcp/` (8 arquivos, 1.756
linhas), com 60 testes em `apps/agent/test/mcp*.test.ts`.

- Só cliente, só transporte Streamable HTTP por `https://`, só ferramentas
  (prompts, recursos e sampling do MCP não são usados).
- Autenticação: nenhuma, token Bearer ou OAuth com PKCE e registro dinâmico de
  cliente. Credenciais cifradas com AES-256-GCM sob `MCP_CREDENTIAL_KEY`,
  vinculadas ao id do servidor, nunca devolvidas, logadas, exportadas nem
  enviadas à IA.
- `fetch` protegido: só host público, DNS conferido por DNS-over-HTTPS antes de
  conectar, sem redirecionamento, só a origem configurada, 10 s para conectar,
  30 s por chamada, 35 s no total, respostas acima de 2 MB recusadas, modelo vê
  até 8.000 caracteres do resultado.
- Toda ferramenta começa desligada. Ligada, pergunta sempre (padrão) ou roda sem
  perguntar (exige senha recente). Mesmo "sem perguntar" vira proposta quando
  há resultado de outro servidor MCP na conversa, quando os argumentos passam
  de 1.000 caracteres ou quando o turno já mandou 4.000 caracteres.
- Ferramenta alterada pelo servidor fica desligada até o dono revisar.
  Aprovação vinculada aos argumentos exatos e ao estado da ferramenta; roda uma
  vez só e nunca é repetida.
- Lista opcional de servidores permitidos (`TALORYS_MCP_ALLOWED_ORIGINS`) e
  teto de 20 ferramentas ligadas.
- Sessões MCP abertas sob demanda e guardadas **em memória por até 2 minutos**
  (`client.ts`, mapa `sessions`).

## Sentido 1: Zuri como cliente MCP (etapa 18)

### Como fica contra as regras invioláveis

| Regra | Como o desenho atende |
| --- | --- |
| 1. Plano gratuito | Nenhum produto novo da Cloudflare. Configuração no SQLite do Durable Object que já existe; chamadas são `fetch` comuns. |
| 2. Segredos | Credenciais cifradas com `MCP_CREDENTIAL_KEY` (Worker secret, já listado na especificação). Nunca no navegador, em log ou em backup. |
| 3. Ferramentas do agente | Não é HTTP arbitrário: o agente só chama ferramentas que o dono ligou, em servidores que o dono cadastrou pela tela, com sessão e CSRF. O agente não cadastra servidor nem liga ferramenta. Cada ferramenta MCP tem schema (convertido do JSON Schema do servidor e validado), permissão e limite por turno. Por padrão, toda chamada vira proposta aprovada pelo dono. |
| 4. Conteúdo é dado | Resultados e descrições de ferramentas entram como `<data source="mcp">`, já previsto na especificação. |
| 5. Migrations | Duas tabelas novas (`mcp_servers`, `mcp_tools`), só acréscimo. |
| 6. Idiomas | Tela em Configurações > Integrações, textos no catálogo, pt-BR e en. |
| 8. Testes | Os 60 testes do Talorys viram testes aqui, mais os de orçamento. |

Ponto que exige atenção: o MCP é o único caminho pelo qual dados do dono saem
da conta Cloudflare (os argumentos da chamada vão para o servidor de fora). Isso
precisa estar claro na tela, como no Talorys, sem citar a infraestrutura.

### Ajustes em relação ao Talorys

1. **Sem sessão guardada em memória.** As sessões de 2 minutos do Talorys
   impedem a hibernação do objeto e quebram a regra P5. No Zuri, a sessão abre
   no turno e fecha no fim dele, dentro de `keepAliveWhile`. Custa uma
   subrequisição a mais por turno que usa MCP, nada de tempo de objeto acordado.
2. **Subrequisições contadas (P9).** Por servidor usado no turno: 1 a 2 de DNS
   (A e AAAA), 2 para abrir a sessão e 1 por chamada. Com 3 chamadas por
   ferramenta e o teto de 45 por turno, isso cabe, mas o contador do turno
   precisa somar as do MCP. Teste de orçamento com o pior caso.
3. **Contexto e Neurons (P7).** Descrições de ferramentas entram em toda
   chamada à IA do turno. Com o Llama 3.3 70B (24 mil tokens de contexto),
   reservar uma fatia fixa, por exemplo 2.000 tokens, para descrições MCP, e
   recusar ligar ferramenta que passe dela. O teto de 9.000 Neurons/dia continua
   valendo; o custo extra entra na estimativa antes da chamada.
4. **Teto menor de ferramentas.** Começar com 10 ferramentas ligadas, não 20,
   pelo contexto dos modelos grátis. Configurável por variável, como no
   Talorys.

Também vale manter as regras que a especificação já tem: nenhuma ferramenta MCP
em execução agendada (a especificação é mais restrita que o Talorys aqui, e é
melhor assim), conectar MCP nunca aprovado pelo bot, modo de bloqueio pausa as
chamadas, backup não leva credenciais e servidores importados chegam desligados.

### Esforço e impacto

- Esforço: grande. No Talorys são 1.756 linhas de servidor, 60 testes e um
  cartão de configuração. Estimo 1 PR grande, ou dois se o login OAuth for
  separado (18a: sem auth e Bearer; 18b: OAuth). Recomendo separar: o OAuth é a
  parte mais delicada e menos usada.
- JS inicial: zero, se o cartão de Integrações for carregado sob demanda (P11).
  A tela ganha um pedaço próprio de poucos kB, fora do pacote inicial.
- Worker: o cliente MCP oficial e o validador de schema aumentam o bundle do
  Worker (longe do limite de 64 MiB), e conferir o tempo de partida.
- Requisições: sem servidor cadastrado, zero requisição a mais. Com MCP, só
  subrequisições dentro do turno, que não contam como requisição ao Worker.
- CPU: o trabalho roda no Durable Object (30 s), não no Worker (10 ms).

## Sentido 2: Zuri como servidor MCP (escopo novo)

### O que seria

O Zuri ofereceria um endereço MCP próprio. Um app como o Claude Desktop, o
Claude Code ou o Cursor conectaria nele e poderia, por exemplo, listar as
tarefas do dia, buscar uma nota ou criar uma tarefa, sem abrir o Zuri.

### Como caberia

- **Autenticação.** Reaproveitar os tokens de acesso remoto da etapa 20
  (`zur_pat_`, só hash, 90 dias, com escopo), com um escopo novo `mcp`. Tokens
  continuam sem alcançar `/api/auth*`, `/api/telegram*`, aprovações e bloqueio;
  modo de bloqueio suspende o token. Criar token nunca pelo bot (já está na
  especificação).
- **Ferramentas expostas.** As mesmas do agente, pelo mesmo registro (schema
  Zod, permissão, limite). Primeira versão só `read`: listar e buscar tarefas,
  notas e memórias. `write` numa segunda versão. `destructive` nunca roda direto:
  vira proposta para o dono aprovar no app ou no bot, igual ao chat.
- **Transporte.** Streamable HTTP sem estado, atendido dentro do Durable Object
  que já existe (o Worker só confere o token e repassa, P6). Sem objeto novo por
  sessão. O Agents SDK tem utilitários de servidor MCP; os nomes exatos da API
  serão conferidos nas skills do plugin `cloudflare` antes de implementar.
- **Limites.** Mesma cota dos tokens remotos (60 por hora, 100 por dia), para
  um app externo não gastar as 100 mil requisições diárias do objeto.

### Riscos

- **Token vazado = leitura das memórias e notas.** É o maior risco. Mitigação:
  escopo só leitura por padrão, validade curta, aviso no Telegram a cada token
  novo e a cada primeiro uso de rede nova, revogação com um toque, registro em
  Acessos.
- **Dados vão para outra IA.** O que o app externo lê sai da conta Cloudflare
  e vai para o provedor daquela IA. É escolha do dono, mas a tela precisa dizer
  isso com clareza.
- **Injeção indireta no outro lado.** Uma nota com texto malicioso pode
  influenciar o app externo. O Zuri não controla esse lado; escrita e exclusão
  passando por aprovação limitam o estrago no Zuri.
- **Login OAuth para o conector do claude.ai.** O conector do claude.ai pede
  OAuth. A biblioteca pronta da Cloudflare para servidor OAuth guarda dados no
  KV, que é recurso novo (⚠, precisa do seu OK, mesmo tendo cota grátis). A
  alternativa é escrever o servidor OAuth no SQLite do objeto, o que é mais
  trabalho e mais superfície de ataque. Por isso a recomendação é começar só
  com token, que já funciona com Claude Code, Claude Desktop e Cursor.

### Esforço e impacto

- Esforço: médio para a versão só leitura com token (reaproveita etapa 20 e o
  registro de ferramentas), grande se entrar escrita com aprovação e OAuth.
- JS inicial: zero (a tela de tokens já existirá; só um escopo a mais).
- Orçamento: cada chamada de um app externo é uma requisição ao Worker e ao
  objeto, mais as linhas lidas. Nenhum Neuron, porque quem raciocina é a IA do
  app externo. Entra no teste de orçamento com teto por chamada.

## Recomendação

1. **Cliente MCP:** fazer, na etapa 18 como já está, com os quatro ajustes
   acima, e dividida em 18a (sem auth e Bearer) e 18b (OAuth). Depende da etapa
   11, como toda a fase D.
2. **Servidor MCP:** fazer depois, como etapa nova logo após a 20, só leitura e
   com token. Escrita com aprovação e OAuth ficam para uma segunda rodada, e o
   OAuth só com o seu OK se precisar de KV.
3. Se aprovar, registro a decisão em `.claude/memoria/decisoes.md`, acrescento
   a etapa nova na especificação e o bloco dela em
   `docs/agente/prompts-das-etapas.md`, e ajusto o texto da etapa 18.

## Perguntas para o Pablo

- Quer o Zuri como servidor MCP (sentido 2)? Recomendo sim, depois da etapa 20,
  só leitura no começo.
- Pode dividir a etapa 18 em duas (sem OAuth e com OAuth)? Recomendo sim.
