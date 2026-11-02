<!-- versao: minor -->

### Adicionado

- Conversa com a Zuri pelo Telegram. Com **Conversar com a Zuri por aqui**
  ligado no cartão do Telegram (Configurações › Avisos), o que você escreve no
  chat com o bot vira uma conversa do app, com as mesmas memórias, ferramentas
  e limites. A resposta chega formatada, com "digitando…" enquanto a Zuri
  pensa, e a conversa aparece na sua lista com a marca "pelo Telegram".
- Voz e arquivos de áudio pelo Telegram: até 5 minutos e 5 MB, a Zuri
  transcreve, mostra o que entendeu e responde. Acima disso ela pergunta antes,
  com o custo em Neurons e o que sobra no dia, e só baixa depois de você tocar
  em **Processar mesmo assim** (vale 10 minutos).
- No app, mensagem encaminhada ou trecho citado no Telegram aparece numa caixa
  separada da sua mensagem.

### Segurança

- A conversa pelo Telegram nasce desligada; desligada, o bot não baixa nem o
  áudio.
- Mensagem encaminhada, citação e resposta à mensagem de outra pessoa entram
  como dado, nunca como ordem sua, e um comando encaminhado não roda.
- O identificador do arquivo nunca vai no botão, e o download para no meio se
  o arquivo vier maior do que o Telegram disse ou passar de 20 MB.
- Toda resposta sai com o texto escapado e os links desarmados.
- Depois de 12 horas sem uso do bot, a conversa se desliga sozinha e só volta
  pelo app. O limite é de 30 mensagens por hora para a Zuri.
- Arquivo de áudio e mensagem de bot inline entram como texto de terceiros; só
  a sua nota de voz conta como fala sua.
- O custo de um áudio também é estimado pelo tamanho do arquivo, então um
  áudio longo que diz ser curto não passa da cota do dia.

### Atualização

- A migration 16 cria a tabela dos áudios que esperam confirmação e guarda o
  texto de terceiros junto da mensagem, e roda sozinha na primeira requisição
  depois do deploy.
