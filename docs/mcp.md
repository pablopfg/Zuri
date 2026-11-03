# Serviços externos (MCP)

A partir da etapa 18, a Zuri pode usar ferramentas de servidores MCP remotos
(Model Context Protocol): uma busca na documentação da equipe, um sistema de
chamados, um serviço de previsão do tempo. A Zuri só é **cliente** MCP: ela
chama servidores dos outros e nunca serve as próprias ferramentas para fora
(decisão de 31/10/2026, `docs/planos/mcp.md`). O plano desta etapa está em
`docs/planos/etapa-18a-mcp-remoto.md`.

## Para o dono

Em **Configurações > Integrações**:

1. **Adicionar servidor**: um nome seu, o endereço completo (`https://…`) e o
   acesso. **Sem login** serve para servidores abertos; **Token de acesso**
   guarda um token fixo, cifrado, que nunca aparece de novo. A Zuri conecta na
   hora e lê a lista de ferramentas.
2. Em **Ver ferramentas**, cada ferramenta começa **desligada**. Ligue só as
   que fizerem sentido. Para cada uma ligada:
   - **Antes de usar**: **Perguntar sempre** (padrão) mostra no chat um cartão
     com os dados exatos que vão para o serviço, e a chamada só roda se você
     aprovar. **Usar sem perguntar** roda direto e pede a senha digitada
     agora. Só fica disponível para ferramentas que o servidor marca como de
     consulta (`readOnlyHint`); as outras sempre perguntam, e a API recusa
     com `409` uma tentativa de mudar isso.
   - **Quando usar**: uma dica sua, até 200 caracteres, que ajuda a Zuri a
     escolher a ferramenta certa.
3. **Reconectar** lê a lista de novo. Se o serviço mudar a descrição ou a
   entrada de uma ferramenta ligada, ela sai de uso e aparece "Mudou: ligue de
   novo para revisar".

Mesmo em **Usar sem perguntar**, a Zuri pergunta quando a chamada leva mais de
1.000 caracteres, quando o turno já mandou mais de 4.000, ou quando outro
serviço já respondeu na mesma conversa, neste turno ou num anterior (os dados
de um serviço não passam para outro sem você ver).

Trocar o token ou o tipo de acesso também gera o aviso de segurança.
Trocar o endereço de um servidor é o mesmo que adicionar outro: as ferramentas
voltam a desligadas e "Perguntar sempre", o token antigo é descartado, a senha
digitada agora é pedida e você recebe o aviso de segurança.

As aprovações de chamadas externas acontecem só no app. Pelo bot do Telegram,
a proposta aparece com **Abrir no app**.

## Limites

| O quê | Limite |
| --- | --- |
| Servidores | 10 |
| Ferramentas ligadas ao mesmo tempo | 10 |
| Ferramentas oferecidas ao modelo por turno | 6, em até 2.000 tokens do prompt |
| Ferramentas lidas por servidor | 100, em até 5 páginas |
| Chamadas da mesma ferramenta por turno | 3 |
| Dados de uma chamada | 4.000 caracteres (acima de 1.000, sempre pergunta) |
| Resposta do servidor | 2 MB e 35 s |
| Prazos | conectar 10 s, listar 15 s, chamar 30 s, DNS 5 s |
| Subrequisições do MCP por turno | 24 (de 50 do plano Free); 12 num turno do Telegram |
| Resposta mostrada no cartão | 1.500 caracteres; o modelo lê até 8.000 |
| Falhas seguidas antes de pausar | 3, por 15 minutos |
| Ferramentas que `find_tools` libera | até 5, sem passar das 6 vagas e dos 2.000 tokens do turno |

## Como funciona

- **Triagem por turno** (`apps/agent/src/mcp/triage.ts`): sem IA. Quando as
  ferramentas ligadas não cabem nas 6 vagas e nos 2.000 tokens, a triagem usa
  só metade (3 vagas e 1.000 tokens): vão primeiro as usadas nas últimas
  mensagens e depois as que têm palavras da mensagem do dono (a dica "Quando
  usar" pesa 3, o nome 2 e a descrição 1). Se alguma ficou de fora, o modelo
  recebe `find_tools`, que procura entre as ligadas e libera para o passo
  seguinte (`activeTools` do AI SDK) só o que ainda cabe nas 6 vagas e nos
  2.000 tokens. O executor confere de novo
  e recusa uma ferramenta que não foi oferecida.
- **Sessões por turno** (`session.ts`): a sessão MCP abre na primeira chamada
  do turno e fecha no fim dele, com um `DELETE` educado se ainda houver
  subrequisição. Nada fica aberto entre turnos, então o Durable Object dorme
  (regra P5). Sem reconexão automática, sem a stream `GET` do servidor.
- **Fetch protegido** (`guarded-fetch.ts`): só a origem do servidor, sem
  seguir redirecionamento, sem cookie, com o token só nessa origem, corpo
  cortado em 2 MB e 35 s. Antes de cada conexão, o nome é resolvido por DNS
  sobre HTTPS (A e AAAA) e qualquer endereço particular, reservado ou de
  metadados recusa a conexão (`url.ts`).
- **Catálogo** (`catalog.ts`): o nome, o título e a descrição viram texto de
  uma linha, sem caracteres invisíveis, e inertes: `<` e `>` viram `‹` e `›`,
  colchetes viram parênteses, também nas descrições do schema. Assim um texto
  do servidor não fecha o bloco `<data>` nem imita um link. O schema de entrada vira Zod
  (`z.fromJSONSchema`) sem `pattern`, `patternProperties` e `format`, para que
  uma expressão regular do servidor nunca rode dentro do Durable Object. Schema
  com mais de 6.000 caracteres, mais de 10 níveis ou que não é objeto fica
  "Incompatível". O hash cobre título, descrição, schema e anotações.
- **Resultado como dado**: a resposta chega ao modelo dentro de
  `<data source="mcp">`, com a nota de que é conteúdo de terceiros. Uma resposta
  aprovada fica guardada (cortada) com a proposta e volta no turno seguinte do
  mesmo jeito.
- **Aprovação presa ao que o cartão mostrou**: a proposta guarda o hash do
  servidor (endereço, tipo de acesso, token cifrado), da definição revisada, da
  política e dos argumentos exatos. Ao aprovar, a proposta é reivindicada uma
  vez e o hash é recalculado; qualquer diferença dá `409 TARGET_CHANGED` e nada
  é enviado. A chamada nunca é repetida: uma escrita pode ter acontecido mesmo
  sem resposta.
- **Falhas**: um tempo esgotado, uma resposta grande demais, um servidor fora
  do ar ou um erro de protocolo não desconectam o servidor; depois de 3 falhas
  seguidas ele pausa por 15 minutos. Token recusado ou ilegível desconecta até
  você editar o servidor.
- **Bloqueio e rotinas**: durante o bloqueio da conta (etapa 16b) nenhuma
  ferramenta externa é oferecida nem chamada. Rotinas agendadas nunca recebem
  ferramentas externas nem `find_tools`.

## Credenciais

O token fica em `zur_mcp_servers.credential` como `v1.<iv>.<cifrado>`, em
AES-256-GCM com chave derivada (HKDF-SHA256) do segredo `MCP_CREDENTIAL_KEY`
(32 caracteres ou mais) e o id do servidor como dado associado: copiado para a
linha de outro servidor, não abre. Sem o segredo, servidores com token não
podem ser adicionados; os sem login funcionam. Trocar o segredo torna os tokens
ilegíveis ("O token guardado não pode mais ser lido"): edite cada servidor e
informe o token de novo. Como gravar o segredo:
[configuracao-cloudflare.md](configuracao-cloudflare.md#serviços-externos-mcp-opcional).

O token nunca volta para o navegador (a API só diz se há um), nunca vai para o
log e não entra no prompt.

## Modelo de dados (migration 18)

| Tabela | O que guarda |
| --- | --- |
| `zur_mcp_servers` | Nome, `slug`, endereço, tipo de acesso, token cifrado, ligado, estado, problema (código), falhas seguidas, pausa e datas |
| `zur_mcp_tools` | Por servidor e nome: nome exposto (`mcp_<slug>_<ferramenta>`, até 64 caracteres), título, descrição, schema, anotações, hash, estado, problema, ligada, política, dica e hash revisado |

`zur_pending_actions` ganhou a coluna `result`, com a resposta de uma chamada
aprovada.

## API

Todas pedem a sessão, o cabeçalho de CSRF e a origem do dono. Nenhuma funciona
durante o bloqueio da conta.

| Rota | O que faz |
| --- | --- |
| `GET /api/mcp` | Servidores e se o segredo das credenciais existe |
| `POST /api/mcp/servers` | Adiciona e conecta. Pede a senha digitada agora; registra `mcp_server_added` com aviso |
| `PATCH /api/mcp/servers/:id` | Nome, ligado, endereço, acesso ou token. Endereço, acesso ou token pedem a senha digitada agora e registram `mcp_server_changed` com aviso |
| `DELETE /api/mcp/servers/:id` | Remove com as ferramentas |
| `POST /api/mcp/servers/:id/connect` | Conecta e lê a lista de novo; a falha volta como estado do servidor |
| `GET /api/mcp/servers/:id/tools` | As ferramentas do servidor |
| `PATCH /api/mcp/servers/:id/tools/:tool` | Liga, desliga, política e dica. Pôr em "Usar sem perguntar" (ou religar uma assim) pede a senha digitada agora; numa ferramenta que não é só de consulta, `409` |

## Desenvolvimento local

Com `PUBLIC_URL` em `http://localhost`, qualquer endereço `https://…exemplo.com.br`
é um servidor simulado (`apps/agent/src/mcp/dev-mcp.ts`) com duas ferramentas:
`buscar_documentos` (só consulta) e `criar_chamado`. Um token com a palavra
`invalido` é recusado, para ver o erro de acesso. Os outros endereços saem para
a internet como em produção, então dá para testar um servidor real.

## Testes

| Arquivo | O que cobre |
| --- | --- |
| `apps/agent/test/mcp-units.test.ts` | Endereços e faixas particulares, DNS, fetch protegido, corte de corpo, credenciais, catálogo, triagem e o servidor simulado |
| `apps/agent/test/mcp-routes.test.ts` | Rotas, senha recente, avisos, token cifrado e ilegível, segredo ausente, redirecionamento, DNS particular, limites, pausa após 3 falhas, bloqueio da conta |
| `apps/agent/test/mcp-chat.test.ts` | Turno com ferramenta externa, resultado como dado, aprovação única, aprovações ao mesmo tempo, alvo trocado, escalada para cartão (inclusive entre turnos), triagem e o teto de `find_tools`, textos inertes, falhas e pausa, bloqueio e rotina |
| `apps/agent/test/telegram-approvals.test.ts` | Proposta externa só no app |
| `apps/agent/test/free-tier-budget.test.ts` | Linhas lidas e escritas das rotas, da lista de um turno, de um turno com chamada externa e de uma aprovação |
| `tests/e2e/integracoes.spec.ts` | A tela, o cartão de aprovação no chat, token recusado e acessibilidade |
