# Avisos e Diagnóstico

A etapa 11 junta num lugar só tudo o que a Zuri tem a dizer ao dono: o sino da
barra (com o número de avisos sem ler) abre a central de avisos. Ela chega em
três partes:

| Parte | O que entrega | Situação |
| --- | --- | --- |
| 11a | Central de avisos, insistência, alertas de acesso, resultados das automações, vigias, resumo do dia e a aba Diagnóstico | mesclada |
| 11b | Notificação no aparelho (Web Push com VAPID) e canais por tipo de aviso | este PR |
| 11c | E-mail (`SEND_EMAIL`) e recuperação de senha por e-mail | próxima |
| 11d | Prioridade que aprende e campo de prioridade nas automações | depois da 11c |

## Onde fica o código

- `packages/shared/src/alerts.ts`: prioridades, categorias, canais, tipos de aviso, limites (`ALERT_LIMITS`, `ESCALATION`, `WATCH`, `DIAGNOSTIC_LIMITS`) e schemas das rotas.
- `apps/agent/src/alerts/service.ts`: `AlertService` cria, lista, marca como lido, silencia e apaga avisos; entrega aos canais; faz a insistência.
- `apps/agent/src/alerts/channels.ts`: a interface `AlertChannel` que push (11b), e-mail (11c) e Telegram (13) implementam.
- `apps/agent/src/push/`: a cifra e a assinatura do Web Push (`webpush.ts`), os aparelhos (`devices.ts`), o canal (`channel.ts`) e o que a aba usa (`service.ts`).
- `apps/agent/src/alerts/security.ts`: transforma os eventos de acesso marcados para alerta em avisos críticos.
- `apps/agent/src/alerts/watchers.ts`: os vigias e o resumo do dia.
- `apps/agent/src/alerts/automations.ts`: o que cada execução de automação vira (aviso, aviso de sistema ou falha no Diagnóstico).
- `apps/agent/src/diagnostics/service.ts`: o registro próprio de falhas.
- `apps/agent/src/api/notices.ts`: as rotas `/api/notices*`, `/api/alerts` e `/api/diagnostics*`.
- `apps/web/src/components/NotificationCenter.tsx` (sino, no pacote inicial) e `NoticesPanel.tsx` (painel, sob demanda); `pages/settings/AlertsTab.tsx` (com `PushCard.tsx` e `RoutesCard.tsx`) e `DiagnosticsTab.tsx`; `public/sw.js` mostra a notificação.
- Migration 12: `zur_push_devices`.
- Migration 11: `zur_notices`, `zur_alert_keys`, `zur_alert_deliveries`, `zur_diagnostics` e os contadores `notices`, `security_notices`, `notices_unread` e `alert_deliveries`.

## O que vira aviso

| Origem | Categoria | Prioridade | Observação |
| --- | --- | --- | --- |
| Resultado de lembrete, resumo das tarefas ou rotina | lembretes, resumos ou rotinas | normal | O texto de `notify_owner` vai junto no resultado |
| Rotina pulada por falta de IA | sistema | normal | No máximo 1 por rotina a cada 20 h |
| Tarefa vencendo na próxima hora | tarefas | normal | Uma vez por tarefa e prazo |
| Tarefa vencendo nas próximas 24 h | tarefas | normal | Uma vez por tarefa e prazo |
| Tarefa atrasada | tarefas | alta no primeiro dia, depois normal | Uma vez por dia local, só depois do horário do resumo, até 7 dias |
| Tarefa "em andamento" parada há 7 dias | tarefas | normal | Uma vez a cada 7 dias |
| Rotina com as duas últimas execuções em erro | sistema | normal | Uma vez por dia |
| IA do dia em 80% / 100% | sistema | normal / alta | Uma vez por dia UTC |
| Segredo obrigatório faltando (saúde) | sistema | crítica | Uma vez por dia, mesmo com os vigias desligados |
| Mesma falha 5 vezes em 15 min ou 20 no dia | sistema | alta | Uma vez por dia por tipo de falha |
| Falha nova nesta versão | sistema | normal | Uma vez por dia por tipo de falha |
| Evento de acesso marcado para alerta | segurança | sempre crítica | Novo acesso, 2FA ou passkey mudando, senha trocada etc. |

Os vigias rodam a cada 15 minutos, no máximo 5 avisos de tarefa por rodada e 20
em 24 horas. O resumo do dia sai uma vez por dia local, no horário escolhido
(padrão 07:30), até 3 horas depois dele; traz até 10 itens por grupo
(atrasadas, de hoje, automações do dia) e quantos avisos quietos chegaram.

Título e texto são escritos pelo servidor no idioma do dono. O texto que vem de
automação é guardado como dado e mostrado como texto puro; o link de um aviso só
pode apontar para uma das páginas da lista `NOTICE_LINKS`.

## Notificação no aparelho

- Configurações › Avisos › **Receber avisos neste aparelho** pede a permissão do
  navegador, inscreve com a chave pública VAPID e manda a inscrição ao servidor
  (`POST /api/push/devices`, com a senha digitada há pouco). Até 3 aparelhos.
- Cada aviso que vai para o push sai cifrado para cada aparelho (título até 120
  caracteres, texto até 600, link só da lista `NOTICE_LINKS`), com urgência alta
  para prioridade alta ou crítica, e fica na tela até o dono agir.
- Resposta 404 ou 410 do serviço de notificação apaga o aparelho na hora. 429 e
  5xx contam como "o destino não respondeu"; o aviso conta como enviado quando
  pelo menos um aparelho o recebeu.
- O aparelho se mantém pela checagem de sessão do navegador dele (uma escrita
  por dia, no máximo); 7 dias sem abrir a Zuri e ele sai, na rodada do alarme.
- **Mandar um teste** manda uma notificação a todos os aparelhos, 3 por hora.
- Sem `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` o canal fica "Ainda não
  disponível" (guia em [configuracao-cloudflare.md](configuracao-cloudflare.md)).

## Canais por tipo de aviso

A aba mostra uma tabela com cada tipo de aviso (lembretes, resumos, rotinas,
tarefas, sistema, segurança e eventos da agenda) e cada canal. O padrão manda
tudo para o push e o Telegram; segurança vai sempre por todos e não muda. Os
limites por canal (padrão 6 por hora e 30 por dia) ficam logo abaixo.

## Insistência e reconhecimento

- Aviso alto ou crítico entregue a um canal fora do app (push, desde a 11b) é
  mandado de novo em +15 min e +60 min. Sem resposta em 75 min, fica "sem
  resposta". No máximo 20 avisos insistindo ao mesmo tempo, e duas tentativas
  nunca saem com menos de 15 min entre elas.
- Abrir ou marcar como lido no app para a insistência. "Parar de insistir"
  silencia sem marcar como lido.
- Alerta de segurança não silencia, e marcar como lido no app não o reconhece
  (reconhecimento cruzado da especificação): ele para quando é respondido em
  outro canal. Apagar um alerta de segurança pede a senha digitada há pouco.
- Cada canal tem limite por hora (padrão 6, de 1 a 60) e por dia (padrão 30,
  de 1 a 500); prioridade baixa não sai do app. Alerta crítico ignora as rotas.

## Limites e retenção

- 500 avisos guardados (alertas de segurança à parte, 200). Quando passa de 50
  acima do teto, os mais antigos saem até voltar ao teto; um aviso que ainda
  insiste nunca sai.
- Histórico de envios: 90 dias e no máximo 2.000 linhas; a aba mostra os 100
  mais recentes.
- Chave de deduplicação: 6 h por padrão, numa tabela própria, apagada quando
  vence.
- O contador do sino é uma linha de `zur_counts` mantida por gatilhos: a
  checagem de sessão e o heartbeat leem uma linha a mais, nunca um `count(*)`.

## Um alarme só

Os vigias e as tentativas de insistência usam o mesmo alarme das automações
(regra P8). `AutomationService.rearm()` marca o alarme no horário mais cedo entre
a próxima automação e o `otherDue` (próxima rodada dos vigias ou próxima
tentativa). Ao despertar, `runAutomations` limpa envios presos, transforma
eventos de acesso em avisos, faz as tentativas devidas, roda os vigias e só então
as automações. Cada passo tem o próprio `try`; se um deles falhar e deixar
trabalho vencido, o alarme volta só depois de 1 minuto, nunca na hora, para que
um passo quebrado não gaste a cota do dia. A primeira rodada dos vigias acontece 15 min depois do primeiro
uso do banco, para que a primeira requisição não escreva nada em segundo plano.

## Diagnóstico

A aba Configurações › Diagnóstico mostra o estado (tudo funcionando, falha
recente ou falha se repetindo) e cada tipo de falha dos últimos 30 dias.

- Um tipo de falha é origem + rota + código + nome do erro; o id é um FNV-1a de
  64 bits desse texto. Mil erros iguais custam uma linha.
- Guardamos só nomes e códigos: nunca mensagem, pilha, corpo ou valor. Código,
  nome, rota, referência (`cf-ray`) e versão passam por expressões estritas
  antes de gravar; o que não passa vira `UNKNOWN`, `Error` ou vazio.
- No máximo 200 tipos; o visto há mais tempo sai primeiro.
- Origens: servidor (erro inesperado ou serviço fora do ar na API), IA (falha do
  runner), automações (execução com erro) e tela.
- A tela manda só o nome do erro e o caminho da página (ids trocados por `id`)
  quando uma página quebra, uma vez por tipo a cada carregamento, até 20 por
  hora no servidor. A rota recusa qualquer outro campo.
- "Marcar como resolvida" zera a contagem do dia; a próxima falha reabre.
- O "dia" das contagens (hoje, 20 no dia) é o dia UTC, o mesmo do teto de IA:
  em São Paulo ele vira às 21:00.
- A mesma falha repetida em menos de 5 s é somada na memória e gravada junto
  com a seguinte (ou na próxima rodada do alarme, ou ao abrir a aba): uma
  enxurrada custa uma escrita a cada poucos segundos por tipo.
- O servidor guarda só a página da tela que falhou (as páginas do app e as abas
  de Configurações); qualquer outro trecho do caminho vira `id`, e uma página
  desconhecida vira `/outra`.
- A versão vem do binding `CF_VERSION_METADATA` (grátis). Numa VPS
  (`docs/planos/migracao-vps.md`), ele é trocado por uma variável com o commit
  publicado; sem ele, "falha nova nesta versão" só vale para tipos nunca vistos.

## Logs

Erros dos canais, das rodadas e do próprio Diagnóstico saem pelo módulo único de
log (`alert_delivery_failed`, `alert_tick_failed`, `diagnostics_failed`,
`push_refused` com o status HTTP, `push_failed`), só com nomes e códigos. Gravar uma falha nunca lança erro.
