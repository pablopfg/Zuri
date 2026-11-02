### Adicionado

- Avisos pelo Telegram. A central de avisos ganhou o Telegram como canal: os
  avisos chegam no chat com o bot, discretos por padrão (título, tipo e
  prioridade), com som só nos de prioridade alta e crítica. Na tabela "O que
  vai para cada canal", a coluna nova **Texto completo** mostra o texto da
  categoria no Telegram.
- Botões nos avisos do Telegram: **Feito**, **Abrir** e, nos altos e
  críticos, **Adiar 1 h** e **Silenciar**. Depois do toque os botões saem da
  mensagem, e um toque num botão velho responde "Este aviso já foi tratado.".
- Grupo de avisos opcional, vinculado pelo cartão do Telegram com um link de
  10 minutos, com um tópico por tipo de aviso quando o bot pode criar tópicos.
  **Remover grupo** devolve os avisos ao chat com o bot.

### Segurança

- Todo endereço que vem num aviso chega desarmado no Telegram, e os botões
  levam só um número aleatório, nunca dado do aviso.
- No grupo, só a conta do dono aciona os botões; alertas de segurança e a
  última tentativa de um aviso insistente vão sempre ao chat privado.
- Vincular um grupo pede a senha recente e gera um alerta de segurança que só
  se resolve no app. Um alerta causado na web para de insistir quando você o
  responde no Telegram.
- Comandos (`/start`), menções (`@nome`) e endereços como `tg://` também
  chegam desarmados, e cada despertar manda no máximo 5 avisos.

### Atualização

- A migration 15 cria a tabela dos botões do Telegram e a hora de volta dos
  avisos adiados, e roda sozinha na primeira requisição depois do deploy.
