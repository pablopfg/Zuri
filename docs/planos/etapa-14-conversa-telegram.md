# Plano · Etapa 14, conversa e voz no Telegram

Situação: aprovado em 02/11/2026 (modo contínuo, sem decisão pendente do Pablo)
Origem: etapa 14 da especificação
Dependências: etapa 9 (conversa, PR #28), etapa 12 (fundação do bot, PR #70) e etapa 13 (avisos e botões, PR #73), todas mescladas

## 1. Resumo

O chat privado com o bot vira uma conversa comum do app. O Pablo escreve ou manda um áudio no Telegram, a Zuri responde ali mesmo com as mesmas memórias, ferramentas e limites do app, e a conversa aparece na lista do app marcada como "pelo Telegram". Áudio de até 5 min e 5 MB é transcrito direto; acima disso a Zuri pergunta antes de baixar (**Processar mesmo assim** / **Deixar pra lá**, 10 min); acima do teto rígido ela explica e não pergunta. A conversa nasce desligada e liga num interruptor novo no cartão do Telegram. Uma migration (16).

## 2. Contexto no sistema

- Bot: `apps/agent/src/telegram/service.ts` (travas, fila serial, `#fromOwner` responde "ainda não converso"), `client.ts` (sem download de arquivo ainda), `callbacks.ts` (botões dos avisos), `channel.ts` (`disarm`).
- Conversa: `apps/agent/src/agent/runner.ts` (`AgentRunner.chat`, eventos), `chat/conversations.ts` (`source` por mensagem já existe: `app`, `telegram`, `import`), `agent/context.ts` (mensagens restauradas entram como `<data>`; o mesmo caminho serve para o conteúdo de terceiros).
- Voz: `ai/metered.ts` (`MeteredAI.transcribe`, preso a 60 s do app), `ai/usage.ts` (`reserveAudio`, 3.600 s por dia, teto de Neurons), `ai/transcription.ts` (Whisper Large v3 Turbo).
- Memória: `tools/memories.ts` grava `origin: "app"` sempre; a especificação manda `origin: telegram` num turno do bot.
- Tela: `apps/web/src/pages/settings/TelegramCard.tsx` não tem o interruptor da conversa (o PATCH já aceita `conversation`); `pages/chat/ChatPage.tsx` marca só mensagens restauradas.
- Talorys: `apps/agent/src/telegram/service.ts` (turno no objeto com `keepAliveWhile`, "digitando…" repetido, divisão da resposta). Aproveitamos a ideia; a conversão de Markdown e a divisão aqui são próprias (sem biblioteca, bundle pequeno).

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Texto livre no chat privado vira turno de uma conversa do app (`source: telegram`) que aparece na lista do app | especificação |
| CA2 | Um turno por vez; mensagem durante um turno recebe "ainda estou respondendo"; limite de 3 min | especificação |
| CA3 | "digitando…" a cada 5 s no primeiro minuto, no máximo 12 por turno; o turno conta subrequisições e para antes de 45 | especificação |
| CA4 | Resposta em HTML do Telegram com escape de `<`, `>` e `&`, links desarmados, blocos de até 4.096 caracteres sem cortar tags nem entidades | especificação, prompt |
| CA5 | Encaminhadas, citações, respostas externas e legendas/nomes de arquivo de terceiros entram no prompt como `<data source="telegram_forward">`, nunca como instrução nem comando | especificação |
| CA6 | Voz e áudio até 5 min e 5 MB: baixa, transcreve pelo mesmo serviço e medidor do app, ecoa "🎙️ texto" e responde; áudio nunca guardado | especificação |
| CA7 | Conversa desligada: o bot avisa e não chama `getFile` | especificação, prompt |
| CA8 | Acima do limite e abaixo do teto rígido: pergunta com tamanho, duração, limite, Neurons estimados e o que sobra; `file_id` fica no banco, nunca no botão | especificação |
| CA9 | `getFile` só depois do toque do dono em **Processar mesmo assim** dentro de 10 min; vencido, cancelado, segundo toque e toque de outra conta não baixam | prompt |
| CA10 | Cota que acabou entre a pergunta e o toque explica em vez de processar (reserva no medidor antes de baixar) | prompt |
| CA11 | Acima do teto rígido (20 MB da Bot API, áudio ou Neurons que sobram no dia, 30 min por arquivo) explica qual teto e não pergunta | especificação |
| CA12 | O download confere o tamanho de novo e corta no meio se passar do informado ou de 20 MB | especificação |
| CA13 | `remember` num turno do Telegram grava `origin: telegram` e `author: agent` | especificação, nota da etapa 9 |
| CA14 | Pergunta, confirmação, recusa e expiração vão para `zur_telegram_audit` com `kind = large_file`, sem `file_id` nem nome de arquivo | especificação |
| CA15 (novo) | Interruptor "Conversar pelo Telegram" no cartão, desligado por padrão | plano |

## 4. Escopo

**Entra:** conversa por texto, voz e arquivo de áudio, pergunta de arquivo grande, conteúdo de terceiros como dado, interruptor no cartão, marca "pelo Telegram" na conversa do app, docs (`docs/telegram.md`), README, changelog.

**Fica fora:** trava de leitura de 12 h e `/destravar` (15, depende das aprovações da 16), limite de 30 mensagens por hora (15), `/nova_conversa` (15), aprovação de propostas pelo bot (16: aqui a proposta aparece com **Abrir no app**), fotos e documentos (15; aqui recebem "por enquanto só texto e áudio").

## 5. Como funciona para o Pablo

1. Em Configurações › Avisos › Telegram, liga **Conversar com a Zuri por aqui**.
2. Escreve no chat do bot. Aparece "digitando…" e a resposta chega formatada (negrito, itálico, código). Resposta longa chega em mais de uma mensagem.
3. A conversa fica na lista do app; cada mensagem dela tem a marca "pelo Telegram".
4. Manda um áudio curto: a Zuri responde "🎙️ <o que entendeu>" e depois a resposta.
5. Áudio longo (por exemplo, 8 min): "Esse áudio tem 8 min e 7,6 MB, acima do meu limite de 5 min e 5 MB. Transcrever deve gastar uns 373 Neurons, e hoje ainda sobram 8.400. Quer que eu processe mesmo assim?" com os dois botões.
6. Com a conversa desligada, o bot responde "A conversa por aqui está desligada. Para ligar, abra Configurações › Avisos no app." e não baixa nada.

## 6. Regras de negócio e limites

- Uma conversa do Telegram por vez, guardada em `zur_settings` (`telegram_conversation`); apagada no app, a próxima mensagem abre outra.
- Turno: 3 min (aborta o modelo), um por vez no bot, e dentro do limite de 2 turnos simultâneos do app; conversa ocupada no app → "ainda estou respondendo".
- Limite padrão do áudio: 5 min e 5 MB. Teto rígido: 20 MB, 30 min, áudio e Neurons que sobram no dia (estimativa `audioNeurons`). Um pedido aberto por chat; um novo substitui o anterior.
- Download: `getFile` + GET do arquivo, sem redirecionamento, lido em pedaços e cortado acima do tamanho informado ou de 20 MB.
- O medidor cobra a duração informada pelo Telegram (mínimo 1 s) e acerta com a que o Whisper devolver.
- O texto do dono é a mensagem do turno, como no app; o que é de terceiros vira `<data>`.

## 7. Desenho técnico

### Arquivos

- Novo `apps/agent/src/telegram/format.ts`: Markdown simples → HTML do Telegram com escape e desarme; divisão em blocos de 4.096 que fecha e reabre tags.
- Novo `apps/agent/src/telegram/conversation.ts`: `TelegramConversation` (turno, "digitando…", envio em blocos, voz, pergunta de arquivo grande, toques).
- `client.ts`: `download(filePath, maxBytes)` e `sendMessage` com `parse_mode`.
- `service.ts`: `#fromOwner` repassa texto, voz e áudio; toques `large_file`/`large_skip`; parse de `voice`, `audio`, `forward_origin`, `quote`, `external_reply`, `reply_to_message`, `caption`.
- `runner.ts`: `TurnInput.source` e `quoted`; `ToolContext.source`; `tools/memories.ts` usa a origem.
- `metered.ts`: `transcribe` aceita `maxSeconds` e duração informada.
- `usage.ts`: `room(limits)` (áudio e Neurons que sobram).
- Tela: interruptor em `TelegramCard.tsx`; marca "pelo Telegram" e citação em `ChatPage.tsx`.

### Rotas e contratos

Nenhuma rota nova. `ChatMessage.quoted?: { kind, text }[]` (texto de terceiros, mostrado como citação). Callback `v1:large_file:<id>` e `v1:large_skip:<id>` (id de 12 bytes, o da linha de `zur_telegram_pending_files`).

### Banco

Migration 16 `telegram_conversation`: `zur_telegram_pending_files` (contrato da especificação) e `zur_messages.quoted TEXT` (JSON).

### Ferramentas do agente

Nenhuma nova. `remember` e `update_memory` gravam `origin: telegram` num turno do bot.

### Agendamentos, IA e integrações externas

Nenhum alarme novo. IA só por `agent.ai()`. Bot API: `sendChatAction`, `sendMessage`, `getFile`, download, `answerCallbackQuery`, `editMessageReplyMarkup`.

## 8. Custo e cotas do plano Free

Turno: mesmas reservas do app. Áudio: 46,63 Neurons por minuto (5 min ≈ 233). Subrequisições por turno: até 12 "digitando…", 1 eco, 2 do arquivo e os blocos da resposta, com o orçamento de 45 do cliente. Nenhum recurso pago.

## 9. Segurança e privacidade

- Travas da etapa 12 antes de tudo (conta, `TELEGRAM_ADMIN_ID`, chat privado); a conversa desligada corta antes de qualquer download.
- Conteúdo de terceiros só como `<data>`; encaminhada que começa com "/" não vira comando.
- `file_id` só no banco; nada de áudio, nome de arquivo ou texto do dono em log ou auditoria.
- Saída com escape e links desarmados; o token nunca aparece no erro do download.

## 10. Testes

Integração no workerd com a Bot API falsa (`telegram-conversation.test.ts`): cada CA, incluindo limites n−1/n/n+1 (5 min, 5 MB, 20 MB), toques vencido, repetido, cancelado, de outra conta, cota que acabou, download que passa do tamanho, turno ocupado, injeção por encaminhada. Unitários para `format.ts` (escape, tags, entidades, divisão). e2e: interruptor e marca na conversa (com axe).

## 11. Entrega

Um PR `feat(telegram): conversa com o agente por texto e voz` para a `develop`, com capturas do cartão e da conversa, changelog, README e `progresso.md`.

## 12. Riscos

- A documentação do Whisper no Workers AI não publica limite por chamada; o teto de 30 min por arquivo e o prazo de 3 min são estimativas, a medir no primeiro uso real.
- Memória: arquivo de 20 MB vira ~27 MB em base64; pico perto de 75 MB, abaixo de 128 MB.

## 13. Suposições

- A mensagem do próprio dono é a pergunta do turno (como no app); "Texto do Telegram é dado" vale para o que é de terceiros (seção "Conversa com o agente").
- Uma conversa contínua por Telegram, recriada se apagada; `/nova_conversa` chega na 15.
- Proposta de ação no turno mostra **Abrir no app** até a 16.

## 14. Entrevista com o Pablo

Sem perguntas: as regras de arquivo grande já são decisão dele (02/11/2026) e o resto é técnico.

### Perguntas abertas

Nenhuma.
