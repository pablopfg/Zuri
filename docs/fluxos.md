# Fluxos e monitor de sites

A partir da etapa 22a, a aba **Fluxos**, em **Automações**, guarda passos que
rodam sozinhos: olhar os seus sites, buscar dados de um serviço seu, filtrar o
que interessa e avisar você. O primeiro modelo pronto é o **monitor de sites**.
O plano técnico está em `docs/planos/etapa-22a-motor-de-fluxos.md`.

## Para o dono

### Monitorar sites

1. Abra **Automações › Fluxos** e toque em **Monitorar sites**.
2. Escreva os endereços, um por linha, com `https://`. Cabem até 10 endereços
   somando todos os fluxos.
3. Toque em **Criar fluxo**. O fluxo nasce **desligado**: confira e toque em
   **Ligar**. Se a sua senha foi digitada há mais de 15 minutos, a Zuri pede de
   novo.

A cada 15 minutos a Zuri abre cada endereço. Um site que respondeu (código
2xx ou 3xx) aparece como **No ar** na hora. Um site que falhou é testado de
novo 1 minuto e 5 minutos depois; só depois da terceira falha ele conta como
**Fora do ar**. Você recebe um aviso quando um site cai e outro quando volta,
uma vez por mudança. Nada da página é guardado: só o código e o tempo de
resposta.

Endereços recusados: `http://`, com usuário ou senha, com outra porta, com IP
no lugar do nome, o endereço da própria Zuri, nomes sem ponto e consultas
(`?…`) com mais de 200 caracteres.

### Montar um fluxo

Toque em **Novo fluxo**, dê um nome, escolha quando ele roda (só quando você
executar, a cada tantos minutos, todo dia ou em dias da semana) e adicione os
passos, na ordem:

| Passo | O que faz |
| --- | --- |
| Chamar um serviço | Chama uma conexão sua (veja abaixo) e transforma a resposta em itens |
| Filtrar itens | Deixa passar só os itens que seguem as regras (igual, contém, maior, existe…) |
| Montar campos | Cria ou ajusta campos de cada item |
| Esperar | Pausa o fluxo por alguns minutos ou dias; ele continua sozinho |
| Avisar você | Manda um aviso, um só ou um por item (até 10) |
| Pedir à IA | Resume ou classifica os itens; a IA só lê os itens como dados |
| Olhar sites | O passo do monitor |
| Ler a agenda | Lê os eventos de uma agenda aberta à Zuri (ou de todas), de tantos dias a partir de hoje; cada evento vira um item |
| Criar evento | Cria um evento por item numa agenda em "ler e editar", sem convidados e sem e-mail a ninguém |
| Buscar contatos | Busca na cópia dos seus contatos do Google, por nome, telefone, e-mail, etiqueta ou aniversário |

Nos textos, `{{campo}}` põe o valor de um campo do item, por exemplo
`Proposta de {{nome}}`. Não existe passo de código nem chamada a endereço
livre.

### Agenda e contatos

Os três passos do Google usam a conexão de **Configurações › Integrações**.
Sem o Google conectado, o passo mostra onde conectar.

- **Ler a agenda**: "Começa em quantos dias" conta a partir de hoje no seu
  fuso (0 é hoje, −1 é ontem) e "Quantos dias ler" vai de 1 a 31. Cada evento
  vira um item com `id`, `calendar`, `title`, `start`, `end`, `allDay`,
  `location`, `description` (até 500 caracteres), `guests`, `shared` e
  `recurring`. Até 100 eventos; agenda fechada fica de fora.
- **Criar evento**: o início sai do item e aceita `AAAA-MM-DD` (dia inteiro),
  `AAAA-MM-DDTHH:mm` (no seu fuso) ou um instante ISO com fuso, como o
  `{{start}}` do passo de leitura. Um item com data que não serve para a
  execução antes de criar qualquer evento. São no máximo 10 eventos por
  execução; com mais itens, nenhum é criado. A **chave contra repetição**
  (por exemplo `{{id}}`) faz o mesmo item nunca virar um segundo evento,
  mesmo em outra execução. O Google guarda a chave de um evento apagado, então
  apagar o evento não faz o fluxo criá-lo de novo. Nenhum passo muda ou apaga
  evento. Cada item ganha `event` com `id`, `calendar`, `start` e `created`.
- **Buscar contatos**: lê só a cópia que a Zuri guarda (nenhuma chamada ao
  Google). Sem "um por item", os contatos achados viram os itens (`id`,
  `name`, `labels`, `phone`, `email`, `birthday`). Com "um por item", cada
  item ganha `contact`, o primeiro contato achado pelo texto da busca (por
  exemplo `{{telefone}}`), ou vazio.

### Conexões

Uma conexão diz **onde** um fluxo pode chamar. Em **Conexões**, toque em
**Nova conexão** e preencha:

- **Endereço do serviço**: só o começo, com `https://`, como
  `https://api.exemplo.com.br`.
- **Métodos permitidos**: GET só lê; POST, PUT e PATCH mandam dados. DELETE
  nunca é permitido.
- **Caminhos permitidos**: um por linha, como `/v1/clientes`. O fluxo só
  chama o que começar por um deles, por partes inteiras (`/v1` não libera
  `/v10`).
- **Credencial**: nenhuma, um token no cabeçalho `Authorization` ou um
  cabeçalho com outro nome. Ela fica cifrada e nunca volta para a tela; para
  trocar, digite a nova.

Criar e mudar uma conexão pede a senha recente. Mudar o endereço ou o tipo de
credencial apaga a credencial guardada, e você recebe um alerta de segurança
quando uma conexão é criada ou muda de destino. Uma conexão usada por um fluxo
não pode ser apagada.

### Histórico e falhas

O **Histórico dos fluxos** mostra as últimas execuções, com o passo em que
pararam e o motivo. Uma chamada que falhou por um motivo passageiro (rede,
excesso de pedidos ou erro do serviço) é tentada de novo 1 e 5 minutos
depois. Se a IA estiver indisponível, a execução para na hora, sem tentar de
novo. Depois de 5 falhas seguidas o fluxo se desliga e a Zuri avisa.

Desligar ou mudar um fluxo encerra a execução dele que estava esperando: ela
não continua com os passos antigos.

No bot, `/status` mostra os sites e os fluxos com falha. Com a leitura
travada, mostra só as contagens, sem endereços nem nomes de fluxos.

## Limites

| Limite | Valor |
| --- | --- |
| Fluxos | 20 |
| Passos por fluxo | 20 |
| Conexões | 20 |
| Sites, somando os monitores | 10 |
| Intervalo mínimo | 15 min (60 min com passo de IA) |
| Chamadas por execução | 40 |
| Itens por execução | 200 |
| Resposta de um serviço | 256 KB, em até 10 s |
| Execuções por dia | 500 |
| IA dos fluxos por dia | 3.000 Neurons, dentro dos 9.000 do dia |
| Histórico | últimas 2.000 execuções |
| Eventos lidos por passo | 100, de no máximo 10 agendas |
| Janela da leitura | começa de −30 a +365 dias, dura de 1 a 31 |
| Eventos criados por execução | 10 |
| Contatos por busca | 100 |

## Segurança

- Só a tela muda fluxos, conexões e endereços. Nenhuma ferramenta da Zuri,
  comando do bot ou token remoto cria, liga ou altera um fluxo.
- Toda chamada passa pelo mesmo `fetch` protegido do MCP: o nome é conferido
  por DNS (nada de rede interna), redirecionamento não é seguido e o tamanho
  e o tempo têm teto.
- A credencial nunca vai ao modelo, ao log, ao histórico nem ao backup.
- O que um serviço responde é dado: não muda os passos do fluxo e entra na IA
  dentro de `<data source="flow">`. Um valor de fora igual a `.` ou `..` num
  caminho encerra a execução, para não trocar o endereço chamado.
- Se um serviço devolver na resposta a própria credencial, ela passa a fazer
  parte dos itens. A Zuri não tem como impedir isso; use credenciais de
  serviços que não as repetem.
- **Executar agora** não pede a senha, mesmo com o fluxo desligado (decisão do
  dono, risco aceito). Criar, mudar e ligar pedem.
- No modo de bloqueio nada roda (as execuções ficam como **Pulada**) e as
  rotas dos fluxos respondem 423.
- Dados de contato que passam por um fluxo ficam fora dos logs.
- O que vem da agenda e dos contatos também é dado: entra na IA só dentro de
  `<data source="flow">`. Um evento criado por fluxo nunca tem convidados e o
  Google não manda e-mail a ninguém (`sendUpdates=none`).

## Custo no plano Free

Tudo roda no alarme único do Durable Object, sem Cloudflare Workflows, KV ou
fila. Cada despertar usa no máximo 20 subrequisições para os fluxos (uma
consulta DNS conta 2), dentro do contador único do despertar, que soma
todas as áreas do alarme e para antes de 45 (veja P9 em
`docs/arquitetura/orcamento-free-tier.md`); o que não coube segue no despertar
seguinte. Ler a agenda faz uma chamada por agenda (mais a renovação do
token, quando vence) e espera o despertar seguinte se não couberem todas;
criar evento faz uma por item. Buscar contatos não faz chamada. Um
despertar sem nada devido lê 4 linhas. Uma execução do monitor com 10 sites
lê cerca de 80 linhas e grava cerca de 40, medido em
`apps/agent/test/free-tier-budget.test.ts`.

## Desenvolvimento

Em `npm run dev` e nos testes de interface, o Worker responde sozinho os
endereços `*.exemplo.com.br` (`apps/agent/src/flows/dev-flows.ts`):
`fora.exemplo.com.br` está fora do ar e `api.exemplo.com.br/v1/clientes`
devolve uma lista de clientes de exemplo.
