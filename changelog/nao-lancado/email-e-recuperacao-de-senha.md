### Adicionado

- Avisos por e-mail: com o e-mail configurado, os avisos também podem chegar na
  sua caixa de entrada. O assunto é discreto ("Zuri: você tem um aviso novo") e
  o aviso vem no corpo, com um link para abrir na Zuri. No máximo 10 e-mails por
  dia, e os 4 últimos ficam guardados para alertas de segurança.
- "Esqueci minha senha" na tela de entrada: a Zuri manda ao seu e-mail um link
  que vale 30 minutos para criar uma senha nova. Com a verificação em duas
  etapas ligada, o link pede também o código do app autenticador.
- O registro de acessos mostra os pedidos de link e a troca de senha pelo
  e-mail.

### Segurança

- O link de senha nova funciona uma vez só, e o servidor guarda só uma
  impressão dele. A resposta ao pedido é sempre a mesma, seja o e-mail o da
  conta ou não, e cada rede pode pedir 3 vezes a cada 15 minutos.
- Trocar a senha pelo e-mail encerra todas as sessões e gera um alerta de
  segurança em todos os canais.
- Links de fora do app chegam desarmados no e-mail, e todo e-mail termina
  lembrando que a Zuri nunca pede a sua senha.

### Atualização

- Opcional: para ligar o e-mail, siga "E-mail (opcional)" em
  `docs/configuracao-cloudflare.md` (segredo `ALERT_EMAIL_FROM` e binding
  `SEND_EMAIL`, gratuito para o seu próprio endereço verificado). Sem eles, a
  recuperação continua pelo código de instalação.
