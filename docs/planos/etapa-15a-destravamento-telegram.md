# Plano · Etapa 15a, destravamento e limites no Telegram

Situação: aprovado em 02/11/2026 (modo contínuo; a pergunta ao Pablo sobre o aviso do destravamento foi respondida, seção 14)
Origem: etapa 15 da especificação ("Comandos administrativos"), primeira parte
Dependências: etapas 4 (passkeys, PR #9), 11 (e-mail, PR #63), 12 (bot, PR #70) e 14 (conversa, PR #75), todas mescladas

## 1. Resumo

A etapa 15 tem duas metades de tamanhos parecidos: a trava de leitura com o destravamento por passkey ou e-mail, e os 13 comandos de consulta e ação rápida. Esta parte (15a) entrega a primeira: troca a trava provisória da etapa 14 (a conversa se desligava sozinha depois de 12 h sem uso) pela trava da especificação, com `/destravar` confirmado na página `/aprovar` por passkey ou por um código de 6 dígitos enviado ao e-mail, o limite de 60 comandos por hora e `/nova_conversa`. A 15b (comandos, fotos e documentos) vem logo depois e já encontra a trava pronta. O mesmo desafio de confirmação serve à etapa 16, que só acrescenta o propósito `approval`. Uma migration (17), uma página nova (`/aprovar`) e duas rotas públicas.

## 2. Contexto no sistema

- Bot: `apps/agent/src/telegram/service.ts` (`#fromOwner`: trava provisória `idle_off`, limite de 30 mensagens/h em `telegram_chat_window`, `/ajuda`, menu com `TELEGRAM_MENU_VERSION = 1`), `links.ts` (`touch`, `last_used_at`), `conversation.ts` (`telegram_conversation` em `zur_settings`, botões `v1:large_file|large_skip:<id>`), `client.ts` (`sendMessage` devolve `message_id`, `editMessageText`, `deleteMessage`).
- Passkeys: `apps/agent/src/auth/passkeys.ts` (`authenticationOptions(rp, "required", challenge?)` e `verifyAssertion` já previstos para "uma aprovação do bot"); limitador `auth/login-limiter.ts` (`assertAllowed`, `begin`, `succeed`).
- E-mail: `apps/agent/src/email/sender.ts` (10 por dia, 4 reservados para segurança, rodapé `notice.email.footer`).
- Alertas: `auth/events.ts` (`record(..., { alert: true })`), `alerts/security.ts` (`BOT_CAUSED`, origem `bot`).
- Página pública modelo: `apps/web/src/pages/setup/RecoveryPage.tsx` (token no fragmento, apagado com `history.replaceState`).
- Contrato: especificação, "Contrato da API" (`POST /api/approvals/telegram/options` e `/verify`, 410 `APPROVAL_EXPIRED`, 423 `APPROVALS_LOCKED`), "Tabelas do Telegram" (`zur_telegram_approvals`), "Trava de leitura do bot", "Aprovação pelo bot" (fluxo que o destravamento reaproveita).
- Decisões: N10 (trava ligada, 12 h), N11 (`TELEGRAM_ADMIN_ID` obrigatório para aprovações), 30/10/2026 (aprovação por passkey ou código por e-mail, nunca TOTP).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Depois de `bot_read_lock_hours` (1–72, padrão 12) sem uso, a conversa, `/nova_conversa` e o botão de arquivo grande pedem destravamento; `/ajuda` e `/destravar` nunca pedem | especificação |
| CA2 | Mensagem enquanto travado não conta como uso: mandar `/ajuda` ou texto não destrava | plano (novo) |
| CA3 | `/destravar` cria um desafio de 5 min e oferece **Confirmar com passkey** (botão `url` para `/aprovar#<token>`) e **Receber código por e-mail**, só os que funcionam aqui | especificação |
| CA4 | Token da página: 32 bytes aleatórios, guardado só como HMAC, uso único, 5 min; a página apaga o fragmento antes de qualquer requisição | especificação |
| CA5 | O desafio do WebAuthn (32 bytes) fica na linha do desafio e é consumido na primeira resposta, certa ou errada; exige `userVerification: required`, origem, `rpId` e contador | especificação |
| CA6 | Código por e-mail: 6 dígitos, só hash, 5 min, um desafio; reenvio depois de 60 s, no máximo 3 por hora; cota própria de 10 e-mails de confirmação por dia | especificação |
| CA7 | O código só vale como resposta ao `force_reply` do desafio; a mensagem é apagada logo depois de lida; código fora desse `force_reply` é ignorado, apagado e nunca vai para a conversa | especificação |
| CA8 | Confirmação certa: leitura liberada por 12 h, o bot edita a mensagem do desafio e o evento vai para Acessos | especificação |
| CA9 | 5 falhas em 15 min (passkey recusada ou código errado) travam a confirmação pelo bot por 1 h (423 `APPROVALS_LOCKED`) e geram alerta crítico, no máximo 1 por dia | especificação |
| CA10 | Sem `TELEGRAM_ADMIN_ID`, `/destravar` explica que falta configurar e não cria desafio | N11 |
| CA11 | Até 60 comandos por hora; o 61º recebe uma resposta e os seguintes são ignorados até a janela virar | especificação |
| CA12 | `/nova_conversa` começa outra conversa: a próxima mensagem abre uma conversa nova no app | especificação |
| CA13 | Página `/aprovar` com estados carregando, link inválido ou vencido, já usado, travado, passkey indisponível neste navegador, falhou e pronto ("Pode voltar ao Telegram"); acessível e em pt-BR e en | especificação |
| CA14 | Menu do bot com `/ajuda`, `/destravar` e `/nova_conversa`, reenviado pela versão nova | especificação |

## 4. Escopo

**Entra:** trava de leitura, `/destravar` com passkey e e-mail, página `/aprovar` (só propósito `unlock`), rotas `POST /api/approvals/telegram/{options,verify}`, migration 17 (`zur_telegram_approvals`), limite de 60 comandos por hora, `/nova_conversa`, `/ajuda` e menu novos, cota de e-mails de confirmação, docs (`docs/telegram.md`, `docs/seguranca.md`), README e changelog.

**Fica fora (e onde vai parar):**

- Comandos `/hoje`, `/tarefas`, `/nova`, `/feito`, `/lembrar`, `/nota`, `/buscar`, `/memoria`, `/rotinas`, `/avisos`, `/uso`, `/status`, `/backup`, a gramática de datas e fotos/documentos com legenda → etapa 15b.
- Propósito `approval` (botão Aprovar, prévia confiável, `TARGET_CHANGED`) e o reconhecimento no app dos alertas causados pelo bot → etapa 16.
- Mostrar no cartão do app se a leitura está travada → 15b, junto com `/status`.

## 5. Como funciona para o Pablo

### Fluxo 1 · Trava e destravamento por passkey

1. Passou de 12 h sem usar o bot. O Pablo escreve "oi". O bot responde: "Faz um tempo que você não usa o bot, então travei a leitura por segurança. Toque em /destravar para liberar." Nada vai para a Zuri.
2. `/destravar`: "Para liberar a leitura por 12 h, confirme que é você." com os botões **Confirmar com passkey** e **Receber código por e-mail**.
3. **Confirmar com passkey** abre `/aprovar` no navegador. A página mostra "Destravar o bot do Telegram", o botão **Confirmar com passkey** e a dica "Se a digital não aparecer, abra no navegador do celular".
4. A digital confere. A página mostra "Pronto! Pode voltar ao Telegram." e o bot troca a mensagem do passo 2 por "Leitura liberada até 23:40."

### Fluxo 2 · Código por e-mail

1. No passo 2, **Receber código por e-mail**. O bot responde "Mandei um código para o seu e-mail. Responda a esta mensagem com os 6 dígitos." (resposta forçada).
2. O e-mail traz o código, a validade e o aviso "Se não foi você que pediu no Telegram, não digite este código...".
3. O Pablo responde com o código. O bot apaga a mensagem dele e libera, como no passo 4 do fluxo 1. Código errado: "Código errado. Confira o e-mail e tente de novo." Tocar de novo antes de 60 s: "Espere um minuto para pedir outro código."

### Fluxo 3 · Limites e conversa nova

- 61º comando na hora: "Você chegou ao limite de 60 comandos por hora. Até a hora virar, ignoro os próximos por segurança."
- `/nova_conversa`: "Pronto, começamos uma conversa nova. Pode mandar." A conversa anterior fica no app.

### Página `/aprovar`

Tela pública, sem a casca do app, no mesmo cartão centrado da recuperação de senha (logo, título, texto, um botão). Estados: carregando, pronto para confirmar, confirmando, pronto, link inválido ou vencido, já usado, travado (com o horário), passkey indisponível neste navegador, falhou. Teclado: o botão recebe o foco; o resultado vai para uma região `aria-live`. Celular: largura total com margem de 16 px. Escuro: os tokens do tema. Fora da barra lateral, da paleta e da central de avisos.

### Textos visíveis

| Chave | pt-BR | en | Onde |
| --- | --- | --- | --- |
| `telegram.lock.locked` | Faz um tempo que você não usa o bot, então travei a leitura por segurança. Toque em /destravar para liberar. | It's been a while since you used the bot, so I locked reading for safety. Tap /destravar to unlock it. | bot |
| `telegram.unlock.choose` | Para liberar a leitura por 12 h, confirme que é você. | To unlock reading for 12 h, confirm it's you. | bot |
| `telegram.unlock.passkey` | Confirmar com passkey | Confirm with a passkey | botão |
| `telegram.unlock.email` | Receber código por e-mail | Get a code by e-mail | botão |
| `telegram.unlock.codeSent` | Mandei um código para o seu e-mail. Responda a esta mensagem com os 6 dígitos. | I sent a code to your e-mail. Reply to this message with the 6 digits. | bot |
| `telegram.unlock.codeWrong` | Código errado. Confira o e-mail e tente de novo. | Wrong code. Check the e-mail and try again. | bot |
| `telegram.unlock.wait` | Espere um minuto para pedir outro código. | Wait a minute to ask for another code. | bot |
| `telegram.unlock.done` | Leitura liberada até {hora}. | Reading unlocked until {hora}. | bot |
| `telegram.unlock.expired` | Esse pedido venceu. Toque em /destravar de novo. | This request expired. Tap /destravar again. | bot |
| `telegram.unlock.blocked` | Muitas tentativas erradas. Por segurança, a confirmação pelo bot volta às {hora}. | Too many wrong tries. For safety, confirming through the bot comes back at {hora}. | bot |
| `telegram.unlock.noMethod` | Para destravar, cadastre uma passkey ou configure o e-mail no app. | To unlock, add a passkey or set up e-mail in the app. | bot |
| `telegram.unlock.needsAdmin` | Para destravar pelo bot, falta configurar o id da sua conta do Telegram na instalação. | To unlock through the bot, your Telegram account id still has to be set in the installation. | bot |
| `telegram.unlock.already` | A leitura já está liberada até {hora}. | Reading is already unlocked until {hora}. | bot |
| `telegram.unlock.emailFailed` | Não consegui mandar o e-mail agora. Tente de novo daqui a pouco ou use a passkey. | I couldn't send the e-mail now. Try again in a bit or use the passkey. | bot |
| `telegram.unlock.emailLimit` | Já mandei códigos demais por hoje. Use a passkey ou tente amanhã. | I've sent too many codes today. Use the passkey or try tomorrow. | bot |
| `telegram.cmd.rate` | Você chegou ao limite de 60 comandos por hora. Até a hora virar, ignoro os próximos por segurança. | You reached the limit of 60 commands an hour. Until the hour turns, I'll ignore the next ones for safety. | bot |
| `telegram.newConversation` | Pronto, começamos uma conversa nova. Pode mandar. | Done, we're starting a new conversation. Go ahead. | bot |
| `notice.email.unlock.subject` / `.body` | Código para destravar o bot / código, validade e o aviso "Se não foi você..." | Code to unlock the bot / … | e-mail |
| `approve.*` | textos da página (título, botão, dica, cada estado) | — | `/aprovar` |

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Trava de leitura | `bot_read_lock_hours` sem uso (1–72, padrão 12) | `idle > horas` trava; igual não trava | resposta `telegram.lock.locked` |
| Leitura liberada | 12 h a partir da confirmação (`bot_unlocked_until`) | às 12 h exatas volta a valer só a regra do uso | — |
| Desafio | 5 min; um aberto por vez (um novo `/destravar` vence o anterior) | 5 min exatos: vencido | 410 `APPROVAL_EXPIRED` |
| Falhas | 5 em 15 min | a 5ª trava por 1 h | 423 `APPROVALS_LOCKED` |
| Reenvio do código | 60 s entre envios, 3 por hora | o 4º na hora recusa | `telegram.unlock.wait` |
| E-mails de confirmação | 10 por dia, à parte dos 10 de avisos | o 11º recusa | `telegram.unlock.emailLimit` |
| Comandos | 60 por hora | o 61º responde uma vez, os seguintes são ignorados | `telegram.cmd.rate` |
| Mensagens à Zuri | 30 por hora (já existe) | igual | `telegram.chat.rate` |

Concorrência: as atualizações do bot correm uma por vez na fila do objeto; a página e o bot gravam o mesmo desafio com `UPDATE ... WHERE status = 'open'`, então só uma confirmação vale.

## 7. Desenho técnico

Um módulo profundo, `TelegramConfirmations`, guarda o desafio inteiro (token, WebAuthn, código, falhas e trava). O serviço do bot pergunta só "está travado?", "comece um destravamento", "esta mensagem é um código?". A página fala com ele pelas duas rotas. A 16 acrescenta o propósito `approval` sem mudar a interface.

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `apps/agent/src/telegram/confirmations.ts` | cria | desafios de confirmação (token, passkey, código, falhas, trava de 1 h) |
| `apps/agent/src/telegram/read-lock.ts` | cria | trava de leitura e janela de 12 h |
| `apps/agent/src/telegram/service.ts` | muda | trava, `/destravar`, `/nova_conversa`, 60 comandos/h, código em resposta, menu |
| `apps/agent/src/telegram/conversation.ts` | muda | `startNew()` troca `telegram_conversation` |
| `apps/agent/src/api/approvals.ts` | cria | rotas públicas da página `/aprovar` |
| `apps/agent/src/api/app.ts`, `agent/zuri-agent.ts` | muda | registro e montagem |
| `apps/agent/src/email/sender.ts` | muda | cota separada para confirmações |
| `apps/agent/src/db/migrations.ts` | muda | migration 17 |
| `packages/shared/src/telegram.ts` | muda | limites, schemas e tipos da página |
| `packages/shared/i18n/{pt-BR-server,pt-BR-approve,en,pt-BR,index}.ts` | muda/cria | textos |
| `apps/web/src/pages/ApprovePage.tsx`, `App.tsx`, `lib/next.ts` | cria/muda | página `/aprovar`, sob demanda |

### Rotas e contratos

- `POST /api/approvals/telegram/options` `{ token }` → 200 `{ purpose: "unlock", options, expiresAt }`; 410 `APPROVAL_EXPIRED` com `details.approval: "expired" | "used" | "invalid"`; 423 `APPROVALS_LOCKED` com `retryAfter`; 404 `NOT_FOUND` sem passkey deste endereço; 429 `RATE_LIMITED`.
- `POST /api/approvals/telegram/verify` `{ token, credential }` → 200 `{ purpose: "unlock", unlockedUntil }`; 401 `INVALID_CREDENTIALS` (passkey recusada, token gasto); demais como acima.
- Sem sessão, antes do `requireSession`, com CSRF (mesma origem) e o limitador do login por rede. Corpo: 1 KB e 32 KB. `Cache-Control: no-store` (cabeçalhos da API).

### Banco

Migration 17 `telegram_approvals`: `zur_telegram_approvals` com as colunas do contrato e `reply_message_id INTEGER` (a mensagem com `force_reply`; o contrato só tem a do desafio). Índice por `status`. Uma linha por pedido, apagada 24 h depois de fechada (volume mínimo). Nunca no backup.

### Ferramentas do agente

Nenhuma muda: o destravamento é do bot, não da Zuri.

### Agendamentos, IA e integrações externas

Sem IA e sem alarme novo. Bot API: `sendMessage`, `editMessageText`, `deleteMessage`, `answerCallbackQuery` (até 3 por atualização). E-mail pelo `SEND_EMAIL`.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Requisições ao Worker | 2–4 por destravamento (página) | limitador do login por rede | 100 mil/dia | `docs/arquitetura/orcamento-free-tier.md` |
| Subrequisições | ≤ 3 por atualização | ≤ 4 | 50 | idem |
| Neurons | 0 | 0 | — | comandos sem IA |
| E-mail | ≤ 2 por dia | 10 por dia (cota própria) | — | especificação |
| JS inicial | +~0,2 kB (rota sob demanda) | — | teto 139 kB | CI |

Nada pago.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Quem tomou o Telegram lê tudo | trava depois de 12 h; mensagem travada não conta como uso | trava não se desfaz com `/ajuda` nem texto |
| Destravar sem o dono | passkey com UV ou código no e-mail do dono; `TELEGRAM_ADMIN_ID` obrigatório | sem admin não cria desafio |
| Token da página vazado ou reusado | 32 bytes, só HMAC, uso único, 5 min, fragmento apagado | segundo uso 410; vencido 410 |
| Replay do WebAuthn | desafio consumido na primeira resposta, certa ou errada | segunda resposta recusada |
| Adivinhar o código | 6 dígitos, 5 falhas em 15 min travam 1 h; hash com HMAC | 5ª falha 423 e alerta |
| Código lido por outra pessoa no chat | mensagem apagada; código fora do `force_reply` apagado e ignorado | código solto nunca chega à Zuri |
| Força bruta na página | limitador do login por rede | 429 depois de 3 falhas |
| E-mail em massa | 60 s, 3 por hora, 10 por dia à parte | n−1, n, n+1 |
| Dados em log | só códigos de evento; nunca token, código ou id | teste de log |

Auditoria: orientação (a completa da área fica na 16).

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1, CA2 | trava em `horas`, não em `horas − 1`; mensagem travada não toca `last_used_at` | integração | `apps/agent/test/telegram-unlock.test.ts` |
| CA3, CA10 | botões conforme passkey/e-mail; sem admin, sem desafio | integração | idem |
| CA4, CA5, CA8 | página: opções, verificação com passkey simulada, uso único, vencido | integração/contrato | `apps/agent/test/telegram-approve-routes.test.ts` |
| CA6, CA7 | código certo, errado, fora do `force_reply`, reenvio 60 s, 3/h, cota 10/dia | integração | `telegram-unlock.test.ts`, `email.test.ts` |
| CA9 | 4 falhas não travam, a 5ª trava 1 h e grava um alerta por dia | integração | idem |
| CA11 | 60 comandos passam, o 61º responde, o 62º fica calado; a hora vira | integração | idem |
| CA12 | `/nova_conversa` faz a próxima mensagem abrir outra conversa | integração | idem |
| CA13 | estados da página, axe, celular | e2e/a11y | `tests/e2e/approve.spec.ts` |
| CA14 | `setMyCommands` com os 3 comandos e versão 2 | integração | `telegram-routes.test.ts` |

## 11. Entrega

- **Ordem:** um PR (15a). Depois, a 15b numa thread nova.
- **Capturas:** `/aprovar` (pronto para confirmar e pronto), computador e celular, claro e escuro.
- **Docs:** `docs/telegram.md`, `docs/seguranca.md`, `docs/especificacao.md` (divisão 15a/15b), `docs/agente/prompts-das-etapas.md`, README.
- **Changelog:** `changelog/nao-lancado/etapa-15a-destravamento-telegram.md` com `<!-- versao: minor -->`.
- **Instalação:** nada novo (usa `SEND_EMAIL` e passkeys que já existem).
- **Portabilidade:** nenhum binding novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Navegador interno do Telegram sem passkey | média | dono não destrava pela passkey | dica na página e caminho por e-mail |
| Dono sem passkey deste endereço e sem e-mail | baixa | bot fica travado | resposta diz o que cadastrar |
| Aviso a cada destravamento cansar o dono | média | ruído | pergunta ao Pablo (seção 14) |

## 13. Suposições

- Mensagem e toque enquanto travado não contam como uso; só a confirmação e o uso destravado renovam `last_used_at`.
- Ligar a conversa no app não destrava mais (antes, renovava `last_used_at`).
- `/destravar` com a leitura liberada responde "já está liberada até…" e não cria desafio.
- Um `/destravar` novo vence o desafio aberto (o token antigo só existe como HMAC e não dá para mostrar de novo).
- O 60/h conta só mensagens que começam com `/`; toques em botões não contam.
- Código de 6 dígitos solto (fora do `force_reply`) é apagado e ignorado enquanto houver código mandado na última hora.
- Coluna a mais `reply_message_id` em `zur_telegram_approvals`, como `display_name` na etapa 12.
- Cada código por e-mail vale 5 minutos a partir do próprio e-mail e move o fim do pedido para essa hora (um fim só para a página e o código). Com 3 envios por hora, um pedido dura no máximo uns 15 minutos.
- A espera de 60 s entre e-mails é do bot inteiro, não do pedido: um `/destravar` novo não a zera.
- O botão no aviso de trava (seção "Trava de leitura do bot" da especificação) fica para a 15b, junto com os comandos.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| 02/11/2026 | Como avisar a cada destravamento? Recomendação: um aviso de segurança só, sem insistir, e o registro em Acessos | Um aviso só, sem insistir (02/11/2026) |

### Perguntas abertas

- Nenhuma.
