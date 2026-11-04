# Acesso remoto e eventos

A partir da etapa 20, outros programas falam com a Zuri por um token de
acesso: o n8n, o Home Assistant, um atalho do celular ou um script seu. Cada
token tem um escopo, vale 90 dias e só alcança uma lista fechada de rotas. O
escopo **Só eventos** manda avisos para a central da Zuri, como "Backup
falhou".

O plano técnico está em `docs/planos/etapa-20-acesso-remoto.md`.

## Para o dono

### Ligar e criar um token

1. Abra **Configurações › Segurança › Acesso remoto**.
2. Ligue **Permitir acesso por token**. Se faz mais de 15 minutos que você
   digitou a senha, a Zuri pede de novo.
3. **Novo token**: dê um nome (por exemplo, `n8n`) e escolha o escopo.
4. **Gerar token** mostra o token **uma única vez**, com um botão para copiar
   e um exemplo de `curl`. Guarde no cofre de credenciais da integração. A
   Zuri guarda só uma impressão dele (HMAC) e não consegue mostrar de novo.

Ligar o acesso e criar um token geram um alerta de segurança em todos os
canais. Cabem 20 tokens.

### Escopos

| Escopo | O que alcança |
| --- | --- |
| **Só ler** | Ler tarefas, contagens, notas, projetos, memórias e automações; `GET /api/health` |
| **Ler e escrever** | O de **Só ler**, mais criar e mudar tarefas, notas e automações, criar memórias; apagar tarefas e notas (vão para a lixeira) |
| **Só eventos** | Só `POST /api/remote/events` |

Nenhum token chega a login, sessões, senha, 2FA, Telegram, aprovações, modo
de bloqueio, conversa, fluxos, CRM, MCP, Google, avaliações, configurações,
lixeira, avisos, busca ou à própria tela de tokens. Também não:

- apaga memórias nem automações (a memória não tem lixeira; pause a automação
  com `PATCH {"paused": true}`);
- muda o texto de uma memória (a edição não guarda histórico, então apagaria o
  texto antigo). Uma memória criada por token entra na conversa como "salva, não
  confirmada", como as que a Zuri guarda sozinha, até você editar na tela;
- cria nem muda uma rotina com IA (`agent_prompt`), só lembretes e resumos de
  tarefas, com prioridade baixa ou normal;
- faz busca por significado (gastaria a cota de IA do dia).

### Revogar

- Na tela: **Revogar** num token (com confirmação) ou **Revogar todos**.
- No Telegram: `/tokens` lista os tokens ativos com **Revogar** em cada um.
- Desligar a chave suspende todos sem apagar: religar devolve.
- O modo de bloqueio suspende os tokens e sair dele devolve.
- Trocar a senha, recuperar o acesso ou redefinir as credenciais revoga todos.

A lista mostra quando cada token foi criado, quando vence e quando foi usado
pela última vez (conferido no máximo uma vez por minuto). Vencido, ele para de
funcionar e fica na lista até você revogar.

## Para quem integra

Mande o token no cabeçalho `Authorization: Bearer zur_pat_…`. Ele nunca vai na
URL. Use uma variável ou o cofre de credenciais da ferramenta, nunca o token
colado num comando (ele ficaria no histórico do shell).

```sh
curl "https://exemplo.com.br/api/tasks" \
  -H "Authorization: Bearer $ZURI_TOKEN"
```

O navegador não consegue usar um token em outro site (a Zuri não libera
CORS): chame de um servidor.

### Eventos

```sh
curl -X POST "https://exemplo.com.br/api/remote/events" \
  -H "Authorization: Bearer $ZURI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Backup falhou","source":"n8n","priority":"high","id":"backup-2026-11-04"}'
```

| Campo | Regra |
| --- | --- |
| `title` | Obrigatório, de 1 a 120 caracteres |
| `body` | Opcional, até 1.000 caracteres |
| `priority` | `low`, `normal` (padrão) ou `high`; `critical` é recusado |
| `source` | Opcional, até 40 caracteres: letras, números, `.`, `-` e `_` (padrão `remote`) |
| `kind` | Opcional, no mesmo formato; separa tipos de evento da mesma origem |
| `id` ou `dedupeKey` | Opcional, até 100 caracteres; o mesmo `source` + `id` em 24 h é descartado (`dedupeKey` é o nome da especificação; vale o mesmo) |
| `category` | Opcional; só `events` |

Respostas: 201 com o aviso criado; 200 com `{"event": null, "duplicate": true}`
para uma repetição; 400 `VALIDATION_FAILED` para um campo fora da regra, um
campo a mais ou corpo acima de 2 KB; 429 com `Retry-After` passados os limites.

No n8n, use um nó **HTTP Request** com método `POST`, a URL acima, uma
credencial **Header Auth** (`Authorization` = `Bearer zur_pat_…`) e o corpo em
JSON.

### O que a Zuri faz com um evento

- Vira um aviso na categoria **Eventos** da central, com a origem no título
  ("n8n: Backup falhou"), em uma linha, com links desarmados. O corpo mantém as
  linhas, sem caracteres invisíveis ou de direção e sem linhas em branco em
  sequência. O texto é
  guardado como dado: nunca vira instrução para a Zuri.
- Uma origem com "zuri" ou com o nome da agente aparece como `remote`, para
  um evento não se passar pela Zuri.
- A prioridade aprende por origem e tipo, como os outros avisos (até 50 pares;
  o resto divide um só).
- Eventos usam no máximo metade do limite por hora e por dia de cada canal,
  para os seus avisos continuarem saindo. No máximo 3 eventos insistem ao
  mesmo tempo. A central guarda os 250 eventos mais novos, para eles nunca
  tirarem os seus avisos de lá.

### Limites

| Limite | Valor | Resposta |
| --- | --- | --- |
| Pedidos por token | 120 por minuto | 429 + `Retry-After` |
| Pedidos de todos os tokens | 10.000 por dia (UTC) | 429 até a meia-noite UTC |
| Escritas de todos os tokens | 1.000 por dia (UTC) | 429 até a meia-noite UTC; a leitura continua |
| Tokens recusados por rede | 10 em 15 minutos (até o token certo é barrado) | 429 + `Retry-After` |
| Tentativas recusadas contadas | 200 de todas as redes em 15 minutos; passado isso, uma recusa não grava nada | 401 |
| Eventos | 60 por hora e 100 por dia, somando todos os tokens | 429 + `Retry-After` |
| Rota fora do escopo | — | 403 `FORBIDDEN` |
| Token inválido, vencido, revogado ou suspenso | — | 401 `UNAUTHORIZED` |

Um token errado nunca cai para o cookie de sessão: ou ele vale, ou o pedido
termina em 401. Um cabeçalho que nem tem o formato de um token é recusado antes
de chegar ao banco, e com o acesso remoto desligado nenhuma tentativa grava
nada. Os tetos por dia existem para um cliente preso num laço não gastar a cota
diária do plano Free e deixar o app e o bot sem a deles.

### Com o Cloudflare Access ligado

O Access barra qualquer pedido sem login antes de chegar à Zuri. Para um
cliente remoto passar, crie um **service token** no Access (Zero Trust ›
Access › Service Auth), acrescente à aplicação da Zuri uma política
**Service Auth** que inclua esse service token e mande os dois cabeçalhos
junto com o token da Zuri:

```sh
curl "https://exemplo.com.br/api/tasks" \
  -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $ZURI_TOKEN"
```

A Zuri não abre exceção no Access para tokens: as duas camadas valem juntas.

## Registro de acessos

Ligar, desligar, criar e revogar aparecem em **Segurança › Atividade de
acesso**. Tokens recusados e escritas por token também aparecem, agrupados por
rede e motivo para não encher o registro. O token, o corpo e a query nunca vão
para o registro nem para os logs.
