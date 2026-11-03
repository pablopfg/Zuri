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

Nos textos, `{{campo}}` põe o valor de um campo do item, por exemplo
`Proposta de {{nome}}`. Não existe passo de código nem chamada a endereço
livre.

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
pararam e o motivo. Depois de 5 falhas seguidas o fluxo se desliga e a Zuri
avisa. No bot, `/status` mostra os sites e os fluxos com falha.

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

## Segurança

- Só a tela muda fluxos, conexões e endereços. Nenhuma ferramenta da Zuri,
  comando do bot ou token remoto cria, liga ou altera um fluxo.
- Toda chamada passa pelo mesmo `fetch` protegido do MCP: o nome é conferido
  por DNS (nada de rede interna), redirecionamento não é seguido e o tamanho
  e o tempo têm teto.
- A credencial nunca vai ao modelo, ao log, ao histórico nem ao backup.
- O que um serviço responde é dado: não muda os passos do fluxo e entra na IA
  dentro de `<data source="flow">`.
- No modo de bloqueio nada roda (as execuções ficam como **Pulada**) e as
  rotas dos fluxos respondem 423.
- Dados de contato que passam por um fluxo ficam fora dos logs.

## Custo no plano Free

Tudo roda no alarme único do Durable Object, sem Cloudflare Workflows, KV ou
fila. Cada despertar usa no máximo 20 subrequisições para os fluxos (uma
consulta DNS conta 2); o que não coube segue no despertar seguinte. Um
despertar sem nada devido lê 4 linhas. Uma execução do monitor com 10 sites
lê cerca de 80 linhas e grava cerca de 40, medido em
`apps/agent/test/free-tier-budget.test.ts`.

## Desenvolvimento

Em `npm run dev` e nos testes de interface, o Worker responde sozinho os
endereços `*.exemplo.com.br` (`apps/agent/src/flows/dev-flows.ts`):
`fora.exemplo.com.br` está fora do ar e `api.exemplo.com.br/v1/clientes`
devolve uma lista de clientes de exemplo.
