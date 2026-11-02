# Plano · Etapa 13, avisos no Telegram

Situação: aprovado em 02/11/2026 (modo contínuo, sem decisão pendente do Pablo)
Origem: etapa 13 da especificação
Dependências: etapa 11 (central de avisos, PRs #55, #56, #63, #64) e etapa 12 (fundação do bot, PR #70), todas mescladas

## 1. Resumo

A central de avisos ganha o terceiro canal: o Telegram. Cada aviso que sai do app chega ao chat privado com o bot (ou ao grupo de avisos, se o Pablo vincular um), em texto puro, discreto por padrão, com os botões **Abrir**, **Feito**, **Adiar 1 h** e **Silenciar**. O grupo é opcional (N9), ganha um tópico por categoria quando o bot pode criar tópicos, e nunca recebe sozinho um alerta de segurança. Só a conta do dono aciona os botões. Uma migration nova (15), um cartão de grupo dentro do cartão do Telegram e uma coluna "Texto completo" na tabela de canais.

## 2. Contexto no sistema

- Central de avisos: `apps/agent/src/alerts/service.ts` (`AlertService.raise`, rotas, limites, insistência +15/+60 min, `markRead`, `mute`), contrato do canal em `apps/agent/src/alerts/channels.ts`. Canais ligados em `apps/agent/src/agent/zuri-agent.ts` (push e e-mail; o comentário "Telegram plugs in here in step 13").
- Bot: `apps/agent/src/telegram/{client,links,service}.ts` (etapa 12). Vínculo privado em `zur_telegram_links` (`kind = 'private'`); a tabela já aceita `kind = 'group'` e tem `topic_ids`. A Bot API simulada fica em `src/telegram/dev-telegram.ts` e nos testes.
- Desarme de links: `disarmLinks` em `packages/shared/src/email.ts` (já usado no e-mail).
- Alertas de segurança: `apps/agent/src/alerts/security.ts` levanta com `origin: "web"`.
- Telas: `apps/web/src/pages/settings/TelegramCard.tsx` e `RoutesCard.tsx` (aba Avisos).
- Decisões: N9 (grupo opcional), notificações sempre discretas (02/11/2026), idioma das Configurações em tudo (02/11/2026), observabilidade com Telegram como canal de alerta (31/10/2026).
- Talorys (`apps/agent/src/telegram/service.ts`, `alerts/channels.ts`, `docs/alerts.md`): aproveitamos o formato discreto, o tópico por categoria criado no primeiro uso, a volta ao tópico geral quando o tópico some, a terceira tentativa no chat privado e "Só o dono pode usar estes botões.". Evitamos o `callback_data` com o id do aviso (aqui vai um id opaco de 12 bytes, como manda a especificação) e o `parse_mode: HTML` (aqui o aviso vai em texto puro, nota da etapa 12).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | O Telegram é um canal da central: respeita rotas por categoria, limites por canal, prioridade baixa fica no app, crítico vai sempre | especificação |
| CA2 | Chat privado é o padrão; com grupo vinculado, os avisos vão ao grupo, num tópico por categoria quando o grupo tem tópicos e o bot pode criá-los | especificação |
| CA3 | Discreto por padrão: título, categoria e prioridade; o texto só com "Texto completo" ligado na categoria | especificação |
| CA4 | Som só em alta e crítica (`disable_notification` nas demais) | especificação |
| CA5 | Botões Abrir, Feito, Adiar 1 h e Silenciar; depois do toque, os botões saem da mensagem; segundo toque responde "Este aviso já foi tratado." | especificação |
| CA6 | Link desarmado em todo texto que o canal envia | especificação, prompt |
| CA7 | Só o dono aciona botões no grupo; outra pessoa recebe "Só o dono pode usar estes botões." e nada é gravado | especificação, prompt |
| CA8 | Insistência +15 min e +60 min chega ao Telegram (relógio falso); a terceira tentativa vai ao chat privado | prompt, Talorys |
| CA9 | O grupo nunca recebe sozinho um alerta de segurança: segurança vai sempre ao chat privado | especificação, prompt |
| CA10 | Reconhecimento cruzado: alerta de segurança causado na web para de insistir com Feito, Adiar ou Silenciar no Telegram; causado pelo bot, o Telegram recusa | especificação |
| CA11 | `callback_data` no formato `v1:<ação>:<id de 12 bytes>`, até 64 bytes, sem dado do dono; validade de 24 h | especificação |
| CA12 (novo) | Vincular o grupo pede senha recente no app, só vale com o código de 10 min tocado pela conta do dono e gera alerta de segurança; o bot sai de qualquer outro grupo | plano |
| CA13 (novo) | Desvincular a conta tira o grupo junto; tirar o bot do grupo desvincula o grupo | plano |

## 4. Escopo

**Entra:** canal Telegram, grupo opcional com tópicos, modo discreto com "Texto completo" por categoria, som, quatro botões, tabela de callbacks, cartão do grupo, coluna "Texto completo", docs (`docs/telegram.md`), README, changelog.

**Fica fora:** comandos (`/avisos` é da 15), conversa (14), aprovações e reconhecimento no app com senha recente dos alertas causados pelo bot (16), fila de envio por chat (a central já limita por canal; ver Riscos), botão "Corrigir prioridade" do Talorys (a prioridade que aprende já tem desfazer no app).

## 5. Como funciona para o Pablo

1. Com a conta conectada (etapa 12), os avisos passam a chegar no chat com o bot, em silêncio quando normais e com som quando altos ou críticos.
2. Mensagem: `🔴 <título>` · texto ou "Abra a Zuri para ler." · rodapé "Rotinas · Alta" (e "Tentativa 2 de 3, ainda sem confirmação" na insistência).
3. Botões: **Abrir** (abre a página do aviso no app), **Feito** (marca como lido), e nos altos e críticos **Adiar 1 h** (o aviso volta daqui a uma hora) e **Silenciar** (para de insistir sem marcar como lido). Depois do toque, os botões somem; um toque velho responde "Este aviso já foi tratado.".
4. Grupo (opcional): no cartão do Telegram, **Adicionar a um grupo** (pede a senha se faz tempo) abre o Telegram para escolher o grupo. O bot confirma no grupo: "Este grupo agora recebe os avisos da Zuri.". O cartão mostra o nome do grupo, se os tópicos estão ligados e o botão **Tirar do grupo**.
5. Aba Avisos, tabela "Para onde vão os avisos": nova coluna **Texto completo** (só Telegram), desligada em todas as categorias.

## 6. Regras de negócio e limites

- Destino: segurança → chat privado; terceira tentativa → chat privado; demais → grupo se houver, senão chat privado.
- Texto: título até 200 caracteres, corpo até 3.500, tudo com `disarmLinks`, sem `parse_mode`, sem prévia de link.
- Callbacks: um por botão de ação (Feito, Adiar, Silenciar), id de 12 bytes aleatórios em base64url (16 caracteres), `v1:done|snooze|mute:<id>` (no máximo 26 bytes), validade 24 h, uso único por aviso (o toque marca todos os callbacks daquele aviso); linhas vencidas há mais de 1 dia são apagadas no envio.
- Adiar 1 h: marca como lido, encerra a insistência e guarda `snoozed_until`; no despertar seguinte depois disso, um aviso igual nasce de novo (sem aprender prioridade), com as regras normais.
- Código do grupo: 8 caracteres, 10 min, só HMAC, um por vez, em `zur_internal_state`; só vale vindo da conta do vínculo ativo (e de `TELEGRAM_ADMIN_ID`).
- Tópicos: criados no primeiro aviso da categoria com o nome da categoria no idioma das Configurações; recusa 400/403 desliga tópicos até vincular o grupo de novo; tópico apagado volta ao geral e é recriado no próximo.

## 7. Desenho técnico

- `packages/shared`: `alertFullText` (lista de categorias) nas Configurações; `TelegramStatus.group`; schema da resposta do código do grupo; textos pt-BR e en.
- Migration 15 (`telegram_alerts`): `zur_telegram_callbacks` (colunas da especificação) e `zur_notices.snoozed_until`.
- `apps/agent/src/telegram/callbacks.ts`: cria, lê e consome callbacks.
- `apps/agent/src/telegram/channel.ts`: `TelegramChannel implements AlertChannel` (estado, destino, texto, teclado, tópicos).
- `TelegramLinks`: grupo (`group()`, `saveGroup`, `removeGroup`, `setTopics`, `moveGroup`); `remove()` tira os dois.
- `TelegramService`: grupos (vincular com código, sair de grupo estranho, migração para supergrupo, saída do bot), toques nos botões (dono só, já tratado, resposta em até 10 s), `groupCode()` e `unlinkGroup()`.
- `AlertService.respond(id, action, "telegram")` e `snoozed_until` no `nextDue`/`escalate`.
- Rotas: `POST /api/telegram/group` (senha recente) e `DELETE /api/telegram/group` (senha recente).
- Evento novo `telegram_group_linked` (alerta de segurança com `origin: "bot"`).

## 8. Custo e cotas do plano Free

Sem recurso novo. Cada aviso é uma subrequisição à Bot API (gratuita) dentro do limite por canal (padrão 6/h, 30/dia); o tópico custa uma chamada a mais na primeira vez. Os botões chegam pelo webhook, já contado nas 100 mil requisições diárias. Nada de IA.

## 9. Segurança e privacidade

- Texto de terceiros (corpo de rotina, nome de automação) vai em texto puro com links desarmados; o `callback_data` nunca leva id do aviso nem dado do dono.
- Grupo: quem está nele vê os avisos; por isso discreto por padrão, segurança nunca no grupo e vincular pede senha recente e o código tocado pela conta do dono.
- Toque de outra conta: nada gravado (nem o `update_id`).
- Alerta de segurança causado pelo bot não se reconhece pelo bot.
- Nada de id do Telegram em log.

## 10. Testes

`apps/agent/test/telegram-alerts.test.ts` (Worker + objeto, Bot API simulada) cobre CA1 a CA13, inclusive desarme de `https://`, `www.` e IP, limites exatos do texto, toque de estranho no grupo, segundo toque, callback vencido, insistência com relógio falso, segurança nunca no grupo, migração para supergrupo, tópico apagado. Unitários dos callbacks e do formato. Interface: e2e do cartão do grupo e da coluna "Texto completo", axe na aba.

## 11. Entrega

Um PR `feat(telegram): envia avisos com botões` para a `develop`, com capturas da aba Avisos (computador e celular, claro e escuro), changelog em `changelog/nao-lancado/avisos-no-telegram.md`, README e `progresso.md` (12 mesclada, 13 em revisão).

## 12. Riscos

- Sem fila por chat: um pico de avisos críticos no grupo pode bater no limite de 20/min do Telegram; o cliente já respeita `retry_after` curto e o limite por canal segura o resto. Fila própria fica para quando houver volume.
- O Telegram recusa botão `url` com `localhost`; em produção `PUBLIC_URL` é https.

## 13. Suposições

- Feito em aviso normal marca como lido (Talorys só oferece Abrir); Adiar e Silenciar só fazem sentido em avisos que insistem (altos e críticos).
- "Texto completo" vale só para o Telegram; o e-mail segue como está.
- Vincular grupo não pede confirmação no app além da senha recente: o código já foi gerado com senha e só vale vindo da conta confirmada.

## 14. Entrevista com o Pablo

Sem perguntas: grupo opcional (N9), comportamento "igual ao Talorys" e as regras de segurança já estão na especificação.

| Data | Pergunta | Resposta |
| --- | --- | --- |
| — | — | — |

### Perguntas abertas

- Nenhuma.
