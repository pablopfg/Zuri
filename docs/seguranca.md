# Segurança

O Zuri tem um dono só. O modelo de ameaças supõe que qualquer pessoa na
internet chega ao endereço do Zuri; só o dono pode ler ou mudar os dados. Este
documento cresce a cada etapa. Os portões de toda requisição estão em
[arquitetura.md](arquitetura.md#portões-de-toda-requisição).

## Login

- **E-mail e senha.** O login pede o `OWNER_EMAIL` e a senha. O e-mail é
  comparado por HMAC com o `SESSION_SECRET` (sem diferença de maiúsculas nem de
  espaços nas pontas), em tempo constante. O PBKDF2 da senha roda mesmo quando o
  e-mail está errado, e a recusa nunca diz qual dos dois errou: 401
  `INVALID_CREDENTIALS`, "E-mail ou senha incorretos".
- **Hash.** `pbkdf2$100000$<sal>$<hash>`: PBKDF2-SHA-256 com 100.000 iterações
  (o máximo que o WebCrypto dos Workers aceita), sal aleatório de 16 bytes, sobre
  `HMAC-SHA-256(PASSWORD_PEPPER, NFKC(senha))`. O pepper vive só como segredo do
  Worker, nunca ao lado do hash: um vazamento do banco sozinho não basta para
  testar senhas. O número de iterações fica no texto para poder mudar; hoje só
  100.000 é aceito (menos seria mais fácil de quebrar).
- **De onde vem a senha**, nesta ordem: o hash gravado no banco por uma troca
  no app, o segredo `OWNER_PASSWORD_HASH` e o segredo `OWNER_PASSWORD` (20+
  caracteres). Sem nenhum, o login e o health check respondem 503
  `NOT_CONFIGURED`.
- **Instalação sem instalador.** Com `OWNER_PASSWORD`, o primeiro login entra,
  mas só a troca de senha funciona (403 `PASSWORD_CHANGE_REQUIRED` em todo o
  resto, menos sessão, heartbeat e sair). A senha nova vira hash no banco, e a
  sessão passa a responder `removePlainPasswordSecret: true` até o dono apagar o
  segredo do painel.
- **Redefinir pelo painel.** O Zuri guarda uma impressão digital dos segredos
  de senha e do pepper (HMAC e SHA-256, nunca o valor). Um `OWNER_PASSWORD` ou
  `OWNER_PASSWORD_HASH` com valor novo, ou um `PASSWORD_PEPPER` novo, descarta a
  senha do banco e encerra todas as sessões, com um evento `credentials_reset`
  marcado para alerta. Apagar o `OWNER_PASSWORD` depois da troca não redefine
  nada. A recuperação por e-mail chega na etapa 11.
- Não existe rota de cadastro, de configuração inicial nem de "assumir o dono".

## Política de senha

- 15 caracteres ou mais (cada letra acentuada ou emoji conta um), até 256.
  Colar é permitido; não há regra de composição (NIST SP 800-63B).
- **Partes previsíveis não contam.** Antes de medir, saem as palavras comuns
  (senha, password, zuri, times de futebol...), sequências de 4 ou mais
  (`1234`, `qwer`, `zyxw`), repetições (`abcabc`, `aaaa`), as trocas de letra
  comuns (`s3nh@`) e os dados do próprio dono (as partes do e-mail e o nome do
  agente). "Senha@123456789" é recusada por mais longa que seja.
- **Vazamentos.** Uma senha nova é conferida no Have I Been Pwned por
  k-anonimato: só os 5 primeiros caracteres do SHA-1 saem do Worker, com
  `Add-Padding`, sem seguir redirecionamento e com 5 s de limite. Sem resposta
  (rede fora, erro, tempo esgotado), a troca é recusada com 503
  `SERVICE_UNAVAILABLE`: falha fechada, nunca "aceita por não saber".
- **Senha fraca atual.** Se a senha em uso não passa nas regras de hoje, o
  login entra e exige a troca, como com o `OWNER_PASSWORD`.
- Trocar a senha pede a senha atual (com o mesmo limite de tentativas do
  login), recusa a mesma senha, encerra **todas** as sessões, inclusive a atual,
  e devolve um cookie novo a este navegador. Gera um evento com alerta.

## Sessões

- Token aleatório de 256 bits no cookie `__Host-zuri_session` (`HttpOnly`,
  `Secure`, `SameSite=Strict`, `Path=/`, sem `Domain` e sem validade: some
  quando o navegador fecha). O banco guarda só `HMAC(SESSION_SECRET, token)`,
  então uma cópia do banco não abre sessão nenhuma. Em `http://localhost`, e só
  lá, o cookie se chama `zuri_session` e vai sem `Secure`.
- O servidor encerra a sessão no que vier primeiro:
  - **30 minutos sem uso.** Só conta como uso a requisição que o dono iniciou,
    marcada com `x-zuri-activity: 1`; o polling em segundo plano não segura a
    sessão.
  - **5 minutos sem aba aberta.** Qualquer requisição de uma aba conta como
    presença; a interface manda `POST /api/auth/heartbeat` uma vez por minuto.
  - **6 horas** no total, com uso ou sem.

  As faixas configuráveis são 5 a 60 min, 3 a 15 min e 1 a 24 h; um máximo
  menor vale também para as sessões já abertas. Uso e presença são gravados no
  máximo uma vez por minuto (gravações contam no plano Free). O fim fica na
  atividade de acesso com o motivo (`idle`, `presence`, `max`).
- Entrar encerra a sessão que o navegador já tinha: um cookie plantado antes do
  login não pega carona. No máximo 20 sessões ficam abertas; passou disso, sai a
  menos usada.
- Sair (`POST /api/auth/logout`) apaga a sessão no servidor, o cookie e o cache
  do app (`Clear-Site-Data: "cache"`; não `"cookies"`, que apagaria também os
  do Cloudflare Access no domínio).
- Um cookie que não abre nada recebe de volta um `Set-Cookie` que o apaga.

## Senha recente

Ações sensíveis (regra 7 da especificação) pedem a senha digitada nos últimos
15 minutos **nesta sessão**: o login conta, e `POST /api/auth/confirm` abre a
janela de novo, com o mesmo limite de tentativas do login. Fora da janela, 403
`RECENT_AUTH_REQUIRED`. A sessão diz até quando a janela vale
(`recentAuthUntil`). O código TOTP no lugar da senha chega com a verificação
em duas etapas (etapa 4); até lá, um código é recusado.

## Força bruta

- **Por rede.** Uma rede é o endereço IPv4 do `CF-Connecting-IP`, ou o /64
  inteiro no IPv6 (um assinante costuma ter um /64 e poderia trocar de endereço
  a cada chute). IPv6 com IPv4 mapeado conta como o IPv4. Sem o cabeçalho (só
  fora da Cloudflare), a requisição é recusada, para não cair num balde
  compartilhado; a exceção é o desenvolvimento local.
- **3 falhas por rede em 15 minutos**: a quarta tentativa recebe 429
  `RATE_LIMITED`, com `Retry-After` e `details.retryAfter` em segundos, até a
  falha mais antiga sair da janela. Login, confirmação de senha e troca de senha
  usam o mesmo contador.
- **Ataque distribuído.** Com 25 falhas somando todas as redes na janela, uma
  rede que não entrou com sucesso nos últimos 30 dias tem uma tentativa só; com
  100, nenhuma até a janela esvaziar. As redes do dono mantêm as 3. O dono
  recebe um evento com alerta, no máximo a cada 6 horas.
- **A ordem importa.** O limite vem antes de tudo (uma rede bloqueada ouve
  "espere", e não custa PBKDF2 nem Turnstile). Depois vem o Turnstile, quando
  exigido. Só então a tentativa é contada como falha e a senha é conferida; um
  acerto vira sucesso. Contar antes da conta lenta, no mesmo passo síncrono da
  checagem, impede que pedidos simultâneos passem juntos pelo limite.

### Turnstile adaptativo

Com `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` (os dois, ou fica desligado),
o login só pede a verificação quando parece arriscado:

- a rede errou a senha nos últimos 15 minutos (1 falha basta), ou
- 10 falhas se acumularam somando todas as redes na janela.

Sem token, 400 `TURNSTILE_REQUIRED` com `details.turnstileSiteKey` para a
interface desenhar o widget. O token é conferido no `siteverify` da Cloudflare
(5 s, sem seguir redirecionamento) **antes** de a tentativa contar e antes de
qualquer PBKDF2. Precisa vir da ação `login` e do host do `PUBLIC_URL`. Sem
resposta do `siteverify`, o login é recusado com 503 `SERVICE_UNAVAILABLE`
(falha fechada). Cada verificação recusada conta por rede; com 10 na janela, a
rede espera como uma bloqueada, sem nova chamada ao `siteverify`.

## CSRF

Toda rota da API, menos `GET /api/health`, exige:

1. o cabeçalho `x-zuri-request: 1`, que um formulário, imagem ou link de outro
   site não envia, e que um `fetch` de outra origem só enviaria depois de um
   preflight de CORS que nunca é concedido;
2. `Origin` igual à origem do `PUBLIC_URL`, ou, sem `Origin`, um
   `Sec-Fetch-Site` `same-origin` ou `none`;
3. e o cookie `SameSite=Strict`.

Falhou, 403 `CSRF_FAILED`, antes de ler sessão ou corpo. O login também passa
por isso (sem CSRF de login). O corpo precisa ser `application/json`, com
limite de tamanho lido em fluxo.

## Atividade de acesso

`zur_auth_events` guarda logins, falhas, bloqueios, verificações recusadas,
saídas, fins de sessão, confirmações e trocas de senha, com a hora, a rede, o
IP, o país, a região, a cidade, o ASN e o data center da borda, o user agent
(300 caracteres, sem caracteres de controle), se o navegador era conhecido e os
16 primeiros caracteres do id da sessão.

- **Nunca guardados:** senha, código, token e o e-mail digitado numa tentativa
  errada.
- **A localização vem só da borda.** O Worker remove qualquer
  `x-zuri-client-geo` enviado pelo cliente e o recria a partir de `request.cf`.
- **Com limite.** Recusas repetidas de uma rede (bloqueio, Turnstile) viram uma
  linha por janela com contador, gravado no máximo uma vez por minuto. No
  máximo 50.000 linhas detalhadas, 5.000 delas reservadas aos eventos do próprio
  dono: uma enxurrada de recusas nunca empurra para fora o registro de quem
  entrou.
- **Retenção (LGPD).** Os detalhes ficam 90 dias e viram contagens diárias por
  tipo e país, sem IP nem user agent, guardadas por um ano. Base legal:
  legítimo interesse na segurança da conta (LGPD art. 7º, IX, e art. 46). A
  limpeza roda no máximo uma vez por hora, quando a atividade é gravada.
- **Cookie de aparelho.** O login define `__Host-zuri_device` (aleatório, 180
  dias, `HttpOnly`, `Secure`, `SameSite=Strict`). O banco guarda só o HMAC,
  para até 50 navegadores. Ele só distingue um navegador conhecido de um novo:
  nunca autentica, nunca dispensa senha nem segundo fator e nunca afrouxa o
  limite de tentativas.
- **Alertas.** Um login de navegador novo ou de rede sem login nos últimos 30
  dias (menos o primeiro login de todos), a troca de senha, a redefinição pelo
  painel e o início de um ataque distribuído ficam marcados com
  `alert_pending = 1`. A etapa 11 entrega esses avisos; o texto será genérico,
  para não mostrar onde nem como numa tela bloqueada.
- **Não registrado:** o que os portões do Worker recusam antes do agente (host
  errado, Access) e as recusas de CSRF. Registrar custaria uma requisição ou uma
  gravação no Durable Object por pedido de lixo.
