# CRM interno e eventos do n8n

A partir da etapa 22b, a aba **Clientes**, dentro de **Contatos**
(`/contatos/clientes`), guarda os seus clientes com a etapa do funil,
etiquetas, anotações, retorno e aniversário. O n8n continua conversando com
eles (WhatsApp, Chatwoot, agendamentos) e manda à Zuri o que acontece, por
eventos assinados. A Zuri não manda mensagem a cliente nenhum.

O plano técnico está em `docs/planos/etapa-22b-crm-interno.md`.

## Para o dono

### Clientes e funil

- **Novo cliente** cadastra nome, telefone, e-mail, aniversário (`AAAA-MM-DD`,
  ou `MM-DD` sem o ano), etapa, etiquetas separadas por vírgula, retorno e
  anotações.
- O funil começa com **Novo, Em conversa, Agendado, Cliente** e **Inativo**.
  **Editar funil** renomeia, reordena, acrescenta e tira etapas (de 2 a 12).
  Os clientes de uma etapa que você tirar vão para a primeira.
- Os botões do funil e dos retornos (atrasados, hoje, próximos 7 dias) filtram
  a lista. A busca acha por nome (sem acento), por qualquer pedaço do telefone
  ou pelo e-mail.
- Cada cliente guarda as 100 entradas mais novas do histórico: anotações,
  mudanças de etapa, etiquetas, retorno e o que o n8n mandou.
- Cabem 5.000 clientes, 200 etiquetas diferentes e 20 por cliente.
- **Apagar cliente** leva junto as anotações e o histórico, e não dá para
  desfazer. Só a tela apaga: a conversa nunca apaga um cliente.

### Avisos

Em **Avisos do CRM**, na mesma aba, você escolhe o que a Zuri avisa, pelos
canais da central de avisos:

- **Retorno**: na hora marcada. Até 10 avisos de uma vez; se vencerem mais, o
  resto vem num aviso só.
- **Aniversários**: às 9 h no seu fuso, com até 5 nomes por aviso. Quem faz
  aniversário em 29 de fevereiro é lembrado no dia 28 nos anos comuns.
- **Cliente novo vindo do n8n**: até 20 por dia.

### Na conversa

Peça, por exemplo, "quem tem retorno atrasado?", "como está o funil?" ou
"passa a Ana para Agendado e marca retorno na sexta". A Zuri:

- busca e mostra clientes, sem telefone e e-mail a menos que você peça;
- cadastra cliente e muda etapa, etiquetas, retorno e anotações **sem pedir
  confirmação** (decisão do Pablo de 03/11/2026);
- nunca apaga cliente, mexe no funil, liga os eventos nem fala com cliente.

As rotinas leem o CRM (por exemplo, um resumo do funil toda segunda), mas não
mudam nada.

### Sugestões de fluxo

Quando você pede na conversa um fluxo ("me avisa se o site cair"), a Zuri
deixa uma **sugestão** em **Automações › Fluxos**, na seção **Sugestões da
Zuri**. Nada roda: você toca em **Revisar**, confere e salva com a sua senha.
O fluxo salvo começa **desligado**. Uma sugestão some em 7 dias se você não a
salvar, e cabem 5 de cada vez.

## Ligar os eventos do n8n

1. Na aba **Clientes**, em **Eventos do n8n**, toque em **Ligar eventos**. Se a
   sua senha foi digitada há mais de 15 minutos, a Zuri pede de novo.
2. A Zuri mostra o **endereço** e o **segredo** uma única vez. Copie os dois
   para as credenciais do n8n e toque em **Já guardei**. Você recebe um aviso
   de segurança, como em toda chave nova.
3. **Trocar segredo** gera endereço e segredo novos; os antigos param na hora.
   **Desligar** não pede senha: só fecha a porta.

### Como o n8n assina cada evento

Cada evento é um `POST` com o corpo em JSON e dois cabeçalhos:

| Cabeçalho | Valor |
| --- | --- |
| `X-Zuri-Timestamp` | Instante do envio em segundos Unix, por exemplo `1793736000` |
| `X-Zuri-Signature` | `sha256=` seguido do HMAC-SHA256 em hexadecimal de `<timestamp>.<corpo>`, com o segredo como chave |

A assinatura vale para o corpo exato que vai na requisição, byte a byte. Por
isso, monte o texto do corpo uma vez e use o mesmo texto para assinar e para
enviar. Um evento com mais de 5 minutos de diferença do relógio da Zuri é
recusado.

No n8n, o jeito mais simples é um nó **Code** antes do **HTTP Request** (o
módulo `crypto` precisa estar liberado em `NODE_FUNCTION_ALLOW_BUILTIN`):

```js
const crypto = require("crypto");
const body = JSON.stringify({
  id: `chatwoot-${$json.id}`,
  type: "client.activity",
  data: { ref: String($json.contact_id), kind: "message_in", text: $json.content, name: $json.sender_name },
});
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = "sha256=" + crypto.createHmac("sha256", $env.ZURI_CRM_SECRET).update(`${timestamp}.${body}`).digest("hex");
return [{ json: { body, timestamp, signature } }];
```

No **HTTP Request**: método `POST`, a URL do endereço, **Body Content Type**
`Raw` com `application/json` e o corpo `{{ $json.body }}`, e os dois
cabeçalhos com `{{ $json.timestamp }}` e `{{ $json.signature }}`. Sem o
módulo `crypto`, use o nó **Crypto** (ação **Hmac**, tipo **SHA256**,
codificação **hex**) sobre o texto `<timestamp>.<corpo>` e mande o mesmo
corpo em **Raw**.

Guarde o segredo numa credencial ou variável do n8n, nunca dentro do fluxo
exportado.

### Os eventos

Todo evento tem um `id` seu (até 100 caracteres) e um `type`. O cliente é
achado pelo `ref`, o id dele no sistema do n8n (até 100 caracteres visíveis,
sem espaço). Um `id` repetido nos últimos 7 dias responde `200` com
`duplicate: true` e não grava nada, então pode repetir o envio sem medo.

**`client.upsert`**: cria ou atualiza o cliente. Para criar, precisa de
`name`.

```json
{
  "id": "evt-123",
  "type": "client.upsert",
  "data": {
    "ref": "cw-42",
    "name": "Ana Souza",
    "phone": "+55 11 98888-7777",
    "email": "ana@exemplo.com.br",
    "birthday": "05-20",
    "stage": "Em conversa",
    "tagsAdd": ["lead"],
    "tagsRemove": ["inativo"]
  }
}
```

`phone`, `email` e `birthday` aceitam `null` para apagar. Uma `stage` com nome
que não existe no funil é ignorada.

**`client.activity`**: uma linha no histórico, que também conta como última
atividade (menos `note`). `kind` é um de `message_in`, `message_out`, `conversation_opened`,
`conversation_closed`, `appointment` ou `note`; `text` tem até 500
caracteres. Se o cliente não existe e o evento traz `name`, ele é criado.

**`client.follow_up`**: marca (`{"at": "2026-11-10T12:00:00.000Z", "note": "Confirmar"}`)
ou apaga (`null`) o retorno de um cliente que já existe.

### Respostas

| Código | Quando |
| --- | --- |
| 200 | Evento gravado (`{"ok": true}`) ou repetido (`{"ok": true, "duplicate": true}`) |
| 400 | Corpo que não é um evento, ou cliente desconhecido sem `name` (nada é gravado) |
| 401 | Assinatura errada, faltando, ou fora dos 5 minutos |
| 404 | Eventos desligados, ou endereço antigo depois de trocar o segredo |
| 413 | Corpo acima de 16 KB |
| 423 | Conta em bloqueio |
| 429 | Mais de 300 eventos na hora ou 1.000 no dia (UTC); `Retry-After` diz quando tentar |
| 507 | O CRM chegou a 5.000 clientes |

Os eventos recusados por formato também contam no limite, para um fluxo com
erro não ficar martelando a Zuri.

## Segurança e privacidade

- O endereço é público por natureza; quem manda é o segredo. O segredo é
  derivado de `SESSION_SECRET` e da chave do endereço, não fica guardado em
  lugar nenhum e só aparece na resposta de **Ligar eventos** ou **Trocar
  segredo**.
- A assinatura é conferida no Worker, antes do Cloudflare Access e antes de
  custar uma requisição ao Durable Object, e de novo dentro dele, comparando
  em tempo constante.
- Tudo que chega do n8n é dado de terceiro: passa pelo schema fechado antes de
  gravar, entra no prompt só em `<data source="crm">` e nunca vira instrução.
  Um evento é gravado inteiro ou não é gravado.
- Nome, telefone, e-mail, anotações e histórico dos clientes nunca vão para os
  logs, nem os de erro.
- Os avisos de retorno e de cliente novo levam o nome do cliente e a nota do
  retorno. Se eles chegam por push no celular, podem aparecer na tela
  bloqueada: desligue esses avisos em **Avisos do CRM** se os seus clientes
  forem dados sensíveis (por exemplo, de saúde).
- Depois que a conversa lê o CRM, nenhuma ferramenta de serviço externo (MCP)
  roda sem pedir, nem nas mensagens seguintes: um texto plantado por um
  estranho no histórico não manda os seus dados para fora sem você ver.
- A conversa recebe telefone e e-mail só quando você pede. Mensagens a clientes
  e atendimento por IA continuam no n8n.

## Custo no plano gratuito

A aba lê o funil e as etiquetas de contadores mantidos pelo banco, não dos
5.000 clientes; uma página da lista lê 50 clientes e as etiquetas deles. Um
evento do n8n lê e grava poucas dezenas de linhas. O alarme olha o próximo
retorno e o próximo aniversário por índice. Os números ficam conferidos em
`apps/agent/test/free-tier-budget.test.ts`.
