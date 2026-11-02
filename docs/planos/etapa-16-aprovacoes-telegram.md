# Plano · Etapa 16, aprovações seguras e modo de bloqueio

Situação: aprovado em 02/11/2026 (modo contínuo; sem perguntas ao Pablo, seção 14)
Origem: etapa 16 da especificação ("Aprovações seguras e modo de bloqueio")
Dependências: etapas 4 (passkeys, PR #9), 9 (propostas, PR #28), 11 (e-mail, PR #63), 15a (confirmação fora do Telegram, PR #84) e 15b (botões dos comandos, PR #89), todas mescladas

## 1. Resumo

A etapa 16 tem duas metades independentes, como a 15: aprovar pelo bot as propostas da Zuri (com passkey ou código por e-mail) e o pacote de emergência (comandos de segurança, modo de bloqueio e reconhecimento no app dos alertas causados pelo bot). Dividimos em duas PRs:

- **16a · Aprovações pelo bot** (esta PR): o botão **Aprovar** debaixo de cada proposta, a prévia montada pelo servidor, o comando `/aprovar`, a confirmação pelo mesmo desafio da 15a (agora com o propósito `approval`, preso à proposta e ao hash do alvo) e a execução pelo mesmo caminho do app. Sem migration: a tabela `zur_telegram_approvals` da 15a já tem `pending_action_id` e `target_hash`.
- **16b · Comandos de segurança e modo de bloqueio** (PR seguinte): `/acessos`, `/sessoes`, `/encerrar_sessoes`, `/tokens`, `/pausar_rotinas`, `/bloquear`, o modo de bloqueio com a tela **Sair do bloqueio**, o rebloqueio em 24 h que suspende o vínculo e o reconhecimento no app (com senha recente) dos alertas causados pelo bot.

## 2. Contexto no sistema

- Propostas: `apps/agent/src/chat/actions.ts` (`PendingActionRepository`: `claim`, `fail`, validade de 30 min), `apps/agent/src/tools/registry.ts` (`propose`, `runApprovedAction`: reivindica, confere o hash do `snapshot` e grava numa transação; `TARGET_CHANGED`). Os seis destrutivos: `delete_task`, `replace_task_description`, `replace_note_content`, `delete_note`, `forget_memory`, `cancel_automation`. Todo `snapshot` é uma lista que começa pelo título atual do alvo (o texto, na memória) e, nas reescritas, segue com o texto atual.
- Confirmação fora do Telegram: `apps/agent/src/telegram/confirmations.ts` (`open`, `pageOptions`, `pageVerify`, `sendCode`, `checkCode`, 5 falhas/15 min travam 1 h), rotas `apps/agent/src/api/approvals.ts`, página `apps/web/src/pages/ApprovePage.tsx` (textos em `pt-BR-approve.ts`).
- Bot: `apps/agent/src/telegram/service.ts` (`/destravar`, `#maybeCode`, `#unlocked`), `conversation.ts` (proposta no turno manda **Abrir no app**), `callbacks.ts` (`CommandButtons`, `COMMAND_ACTIONS`), `commands.ts` (`OPEN_COMMANDS`).
- Alertas: `apps/agent/src/alerts/security.ts` (`BOT_CAUSED`, `TOLD_ONCE`), `alerts/service.ts` (`respondOutOfBand` recusa no bot o alerta de origem `bot`).
- Contrato: especificação, "Aprovação pelo bot", "Modo de bloqueio", "Reconhecimento cruzado", tabela de rotas (etapa 16: 409 `TARGET_CHANGED`).
- Decisões: 30/10/2026 (aprovar pelo bot com passkey ou código por e-mail, nunca TOTP, lista "nunca pelo bot"), N11 (`TELEGRAM_ADMIN_ID` obrigatório), 02/11/2026 (destravamento avisa uma vez, sem insistir).

## 3. Objetivo e critérios de aceite

16a:

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Proposta feita num turno do Telegram chega com a prévia do servidor e o botão **Aprovar** no lugar de **Abrir no app** | especificação |
| CA2 | A prévia vem do banco (ação, título atual do alvo, texto atual e novo nas reescritas, validade), nunca do texto do modelo; o hash do alvo é conferido na exibição | especificação |
| CA3 | **Aprovar** abre um desafio de 5 min preso à proposta, ao hash do alvo e à mensagem, com **Confirmar com passkey** e **Receber código por e-mail** (só os que funcionam aqui); tocar de novo reaproveita o desafio aberto | especificação |
| CA4 | A página `/aprovar` mostra a mesma prévia; confirmação certa roda a proposta uma vez, pelo caminho do app, e o bot edita a mensagem com o resultado | especificação |
| CA5 | Alvo mudou entre a proposta e a execução: nada roda, 409 `TARGET_CHANGED` na página e "alvo mudou" no bot | especificação |
| CA6 | O token da página e o código por e-mail não servem duas vezes nem para outra proposta | especificação (aceite) |
| CA7 | 5 falhas de confirmação em 15 min travam as aprovações pelo bot por 1 h e geram alerta | especificação (aceite) |
| CA8 | O e-mail do código traz a prévia (links desarmados) e o aviso "Se não foi você que tocou em Aprovar…" | especificação |
| CA9 | `/aprovar` lista as propostas pendentes (até 5) com **Aprovar**; vazio diz que não há nada; pede destravamento | especificação |
| CA10 | Sem `TELEGRAM_ADMIN_ID`, sem passkey e sem e-mail, ou para ação fora da lista do bot: nada de desafio, o bot mostra **Abrir no app** | especificação, N11 |
| CA11 | Aprovação feita pelo bot gera alerta de segurança que só se reconhece no app | especificação ("Reconhecimento cruzado") |
| CA12 | Menu do bot ganha `/aprovar` (versão 4) e `/ajuda` explica | especificação |

16b (resumo; o plano detalhado da 16b acrescenta os seus CAs aqui): `/bloquear` funciona com a IA fora do ar; login durante o bloqueio recusado com 2FA e aceito com código de recuperação na primeira hora; rebloqueio em 24 h suspende o vínculo; tokens suspensos voltam ao sair (os tokens remotos chegam na etapa 20: até lá `/tokens` mostra o estado vazio e o bloqueio deixa o gancho pronto); alerta causado pelo bot não se reconhece pelo bot e, no app, só com senha digitada nos últimos 15 min.

## 4. Escopo

**Entra (16a):** propósito `approval` no desafio, prévia confiável (bot, página e e-mail), botão **Aprovar** e `/aprovar`, execução e edição da mensagem, evento e alerta `telegram_approved`, estados novos da página (prévia, alvo mudou, aprovada), menu v4, `/ajuda`, docs, README, changelog.

**Fica fora:** comandos de segurança, modo de bloqueio, tela **Sair do bloqueio**, reconhecimento no app com senha recente → 16b. Planos de tarefas e rotinas propostas no chat continuam com **Abrir no app** (não são propostas destrutivas; a especificação fala de `pending_actions`).

## 5. Como funciona para o Pablo

### Fluxo 1 · Aprovar uma proposta pela passkey

1. No Telegram: "apaga a tarefa comprar pão". A Zuri responde e, logo abaixo, chega: "Proposta da Zuri: apagar a tarefa / Item: comprar pão / Vale até 15:30." com o botão **Aprovar**.
2. **Aprovar**: "Para aprovar, confirme que é você." com **Confirmar com passkey** e **Receber código por e-mail**.
3. A passkey abre `/aprovar` com o título "Aprovar pelo Telegram", a mesma prévia num cartão e o botão **Confirmar com passkey**.
4. Confere: "Pronto! Pode voltar ao Telegram." e "A proposta foi aprovada e já está feita." O bot troca a mensagem do passo 2 por "Feito: apagar a tarefa «comprar pão»."

### Fluxo 2 · Código por e-mail

Igual à 15a: o e-mail traz o código, a prévia e o aviso; o Pablo responde à mensagem do bot com os 6 dígitos, a mensagem é apagada e a proposta roda.

### Fluxo 3 · `/aprovar`

Lista até 5 propostas pendentes, uma mensagem cada com **Aprovar**, e "e mais N no app" se houver mais. Sem nenhuma: "Nenhuma proposta esperando a sua aprovação."

### Página `/aprovar`

Mesmo cartão da 15a. Novos estados: prévia da proposta (ação, item, texto atual e novo nas reescritas, com rolagem e quebra de linha), aprovada, alvo mudou ("O item mudou depois da proposta, então não fiz nada."), proposta já tratada ou vencida. Teclado e leitor de tela como na 15a; o cartão da prévia é uma lista de definições.

### Textos visíveis (pt-BR; en no catálogo)

| Chave | pt-BR |
| --- | --- |
| `telegram.aprovar.botao` | Aprovar |
| `telegram.aprovar.proposta` | Proposta da Zuri: {acao} |
| `telegram.aprovar.item` / `.atual` / `.novo` / `.validade` | Item: {item} / Texto atual: {texto} / Texto novo: {texto} / Vale até {hora}. |
| `telegram.aprovar.escolha` | Para aprovar, confirme que é você. |
| `telegram.aprovar.feito` | Feito: {acao} «{item}». |
| `telegram.aprovar.alvo_mudou` | O item mudou depois da proposta, então não fiz nada. Peça de novo à Zuri se ainda quiser. |
| `telegram.aprovar.expirou` | Essa proposta venceu ou já foi tratada. |
| `telegram.aprovar.travado` | Muitas tentativas erradas. Por segurança, só dá para aprovar pelo bot de novo às {hora}. |
| `telegram.aprovar.soNoApp` | Essa proposta só pode ser aprovada no app. |
| `telegram.aprovar.vazio` | Nenhuma proposta esperando a sua aprovação. |
| `telegram.aprovar.mais` | E mais {n} no app. |
| `telegram.aprovar.acao.<ferramenta>` | apagar a tarefa, trocar a descrição da tarefa, trocar o texto da nota, apagar a nota, esquecer a memória, cancelar a automação |
| `notice.email.approve.subject` / `.body` | Código para aprovar uma proposta da Zuri / código, validade, prévia e o aviso da especificação |
| `notice.security.telegram_approved.*`, `web.activity.kind.telegram_approved` | Proposta aprovada pelo Telegram |
| `web.approve.*` | título, texto e estados novos da página |

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Desafio | 5 min, um aberto por vez | 5 min exatos: vencido | 410 `APPROVAL_EXPIRED` |
| Reaproveitar | Aprovar de novo na mesma proposta com desafio aberto e mesmo hash: mesmo desafio, link novo (o antigo deixa de valer) | — | — |
| Proposta | 30 min (etapa 9) | vencida: `telegram.aprovar.expirou` | 410 `APPROVAL_EXPIRED` |
| Alvo | hash do `snapshot` conferido na exibição, na página e na execução | diferente: nada roda | 409 `TARGET_CHANGED` |
| Falhas | 5 em 15 min (as mesmas da 15a) | a 5ª trava 1 h | 423 `APPROVALS_LOCKED` |
| Cartões por turno | até 3 propostas com **Aprovar** por resposta; o resto em `/aprovar` | 4ª: "e mais N" | — |
| `/aprovar` | até 5 cartões | 6ª: "E mais N no app." | — |
| E-mail | cota de confirmações da 15a (10/dia, 60 s, 3/h) | igual | igual |

Concorrência: a fila do bot trata uma atualização por vez; a página e o código gravam o mesmo desafio com `UPDATE … WHERE status = 'open'`; a proposta é reivindicada numa instrução (`claim`), então app e bot nunca rodam a mesma duas vezes.

## 7. Desenho técnico

Um módulo novo, `TelegramApprovals` (`apps/agent/src/telegram/approvals.ts`), concentra a proposta vista pelo bot: a prévia a partir do `snapshot` atual, o cartão com **Aprovar**, a lista do `/aprovar` e a execução por `runApprovedAction`. `TelegramConfirmations` ganha o propósito `approval` preso à proposta (`open(purpose, target?)`, `Confirmed` com `pendingActionId` e `targetHash`). O serviço do bot só liga as pontas.

Uma lista fechada `BOT_APPROVABLE` diz que ferramentas o bot aprova (hoje as seis): ferramenta destrutiva nova nasce só no app até alguém incluí-la de propósito. Nenhuma das ações "nunca pelo bot" da especificação é uma proposta da Zuri.

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `apps/agent/src/telegram/approvals.ts` | cria | prévia, cartão, lista e execução |
| `apps/agent/src/telegram/confirmations.ts` | muda | propósito `approval`, reaproveitar desafio |
| `apps/agent/src/telegram/service.ts` | muda | botão Aprovar, `/aprovar`, código e página por propósito, menu v4 |
| `apps/agent/src/telegram/conversation.ts` | muda | cartões depois da resposta |
| `apps/agent/src/telegram/callbacks.ts` | muda | ação `approve` (não se gasta no toque) |
| `apps/agent/src/tools/registry.ts` | muda | `targetState` exportado (snapshot e hash atuais) |
| `apps/agent/src/api/approvals.ts` | muda | devolver a tentativa também em `TARGET_CHANGED` e proposta tratada |
| `apps/agent/src/agent/zuri-agent.ts` | muda | montagem e e-mail por propósito |
| `apps/agent/src/auth/events.ts`, `alerts/security.ts`, `alerts/service.ts` | muda | evento `telegram_approved` |
| `packages/shared/src/{telegram,alerts,auth-activity}.ts` | muda | propósito, `ApprovalPreview`, resultado, evento |
| `packages/shared/i18n/{pt-BR-server,pt-BR-approve,pt-BR-security,en}.ts` | muda | textos |
| `apps/web/src/pages/ApprovePage.tsx`, `components/security/activity.ts` | muda | prévia e estados novos; nome do evento |

### Rotas e contratos

- `POST /api/approvals/telegram/options` → 200 `{ purpose, options, expiresAt, approval? }` com `approval: { tool, target, before?, after?, expiresAt }` quando `purpose = "approval"`; 409 `TARGET_CHANGED` se o alvo mudou; 410 `APPROVAL_EXPIRED` se a proposta venceu ou já foi tratada.
- `POST /api/approvals/telegram/verify` → 200 `{ purpose: "unlock", unlockedUntil }` ou `{ purpose: "approval", status: "approved" }`; 409 `TARGET_CHANGED`; 409 `CONFLICT` (já tratada no app); 410 `APPROVAL_EXPIRED`.

### Banco

Sem migration. `zur_telegram_approvals.purpose = 'approval'` com `pending_action_id` e `target_hash` (colunas da migration 17). Botão `v1:approve:<id>` em `zur_telegram_callbacks` (`target_type = 'command'`), válido até o fim da proposta.

### Ferramentas do agente

Nenhuma muda. A nota que a Zuri recebe ao propor continua "o dono vê um botão Aprovar".

### Agendamentos, IA e integrações externas

Sem IA e sem alarme novo. Bot API: `sendMessage` (cartões), `editMessageText`, `answerCallbackQuery`, `deleteMessage`.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Subrequisições num turno | +1 por proposta (≤ 3) | 3 | o turno para antes de 45 | `docs/arquitetura/orcamento-free-tier.md` |
| Subrequisições num toque | ≤ 3 | 4 | 50 | idem |
| Linhas lidas na prévia | 1 proposta + 1 alvo | `/aprovar`: ≤ 6 propostas e 5 alvos | — | idem |
| Neurons | 0 | 0 | — | sem IA |
| E-mail | ≤ 2 por dia | 10 (cota da 15a) | — | especificação |
| JS inicial | 0 (página sob demanda) | — | teto 139,1 kB | CI |

Nada pago.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Quem tomou o Telegram aprova | toque não basta: passkey com UV ou código no e-mail do dono; `TELEGRAM_ADMIN_ID` obrigatório | Aprovar sem confirmação não roda nada |
| Prévia enganosa (texto do modelo) | prévia montada do `snapshot` do banco e da proposta estruturada; hash conferido na exibição | prévia mostra o título do banco mesmo quando o modelo descreve outro |
| Trocar o alvo depois de aprovar | hash na página e na execução, dentro da transação | 409 `TARGET_CHANGED` e nada muda |
| Token ou código de outra proposta | o desafio guarda `pending_action_id` e `target_hash`; código com HMAC preso ao desafio | token de uma proposta não roda outra |
| Repetição | token e código de uso único; `claim` da proposta | segundo uso 410 |
| Ação sensível pelo bot | lista fechada `BOT_APPROVABLE`; fora dela, **Abrir no app** | ferramenta fora da lista não abre desafio |
| Texto do dono no Telegram e no e-mail | `disarm()` no bot, `disarmLinks` no e-mail, linhas cortadas | link na nota não vira link |
| Aprovação sem o dono saber | evento `telegram_approved` em Acessos e alerta que só se reconhece no app | `respondOutOfBand` devolve `app_only` |

Auditoria completa (`cloudflare-security-audit:security-audit`, etapa 16), `auditor-seguranca` e `/security-review`.

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1, CA2 | turno com proposta manda cartão com Aprovar e prévia do banco; reescrita mostra texto atual e novo | integração | `apps/agent/test/telegram-approvals.test.ts` |
| CA3 | Aprovar abre desafio com os botões possíveis; Aprovar de novo reaproveita a linha | integração | idem |
| CA4, CA6 | passkey na página roda a proposta uma vez e edita a mensagem; token reusado 410; token de outra proposta não roda | integração/contrato | idem |
| CA5 | alvo editado entre a proposta e a passkey: 409, nada muda, mensagem "alvo mudou" | integração | idem |
| CA6, CA8 | código por e-mail certo roda; e-mail traz prévia desarmada e aviso; código de outro desafio falha | integração | idem |
| CA7 | 5 códigos errados travam 1 h e gravam alerta | integração | idem |
| CA9 | `/aprovar` vazio, com 1 e com 7 propostas; travado pede destravamento | integração | idem |
| CA10 | sem admin, sem métodos, ferramenta fora da lista: Abrir no app | integração | idem |
| CA11 | `telegram_approved` vira alerta de origem `bot`, sem insistir, recusado no botão do Telegram | integração | idem |
| CA12 | menu v4 com `/aprovar` | integração | `telegram-routes.test.ts` |
| página | prévia, aprovada, alvo mudou, já tratada; axe; celular | e2e/a11y | `tests/e2e/approve.spec.ts` |

## 11. Entrega

- **Ordem:** 16a (esta PR), depois 16b numa thread nova.
- **Capturas:** `/aprovar` com a prévia e aprovada, computador e celular, claro e escuro.
- **Docs:** `docs/telegram.md`, `docs/seguranca.md`, `docs/especificacao.md` (divisão 16a/16b), `docs/agente/prompts-das-etapas.md`, README.
- **Changelog:** `changelog/nao-lancado/etapa-16a-aprovacoes-telegram.md` com `<!-- versao: minor -->`.
- **Instalação e portabilidade:** nada novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| Navegador interno do Telegram sem passkey | média | dono não aprova pela passkey | dica na página e caminho por e-mail |
| Proposta vence (30 min) antes da confirmação | baixa | dono confirma à toa | desafio de 5 min; prévia mostra a validade |
| Muitos cartões num turno | baixa | orçamento de subrequisições | no máximo 3 e "e mais N" |

## 13. Suposições

- O aviso de aprovação pelo bot segue a decisão do destravamento (02/11/2026): um aviso de segurança só, sem insistir, e o registro em Acessos. Ele continua só reconhecível no app.
- Aprovar de novo com desafio aberto da mesma proposta e do mesmo hash troca só o link da passkey (o antigo existe só como HMAC); o código por e-mail e as tentativas continuam.
- Um desafio novo (outra proposta ou `/destravar`) encerra o aberto, como na 15a.
- O título atual do alvo sai do primeiro campo do `snapshot`, e o texto atual das reescritas do segundo (teste confere o formato das seis ferramentas).
- Planos de tarefas e rotinas propostas no chat seguem com **Abrir no app**.
- Prévia no bot: texto atual até 300 caracteres e texto novo até 600; na página, completos.
- O botão Aprovar não se gasta no toque (reaproveitar o desafio); a proposta é que tem uso único.

## 14. Entrevista com o Pablo

Sem perguntas: tudo coberto pela decisão de 30/10/2026 (aprovar pelo bot com passkey ou e-mail), N11, a decisão de 02/11/2026 sobre o aviso do destravamento e a especificação. A divisão em 16a e 16b é técnica (mesmo motivo da 15).

### Perguntas abertas

- Nenhuma.
