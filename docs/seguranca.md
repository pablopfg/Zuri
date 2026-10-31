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
  nada. A redefinição vale já na primeira requisição depois do deploy, mesmo
  que seja um login com a senha antiga. Trocar só o `PASSWORD_PEPPER` também
  apaga a senha do banco: defina junto um `OWNER_PASSWORD` ou
  `OWNER_PASSWORD_HASH`, ou o login fica em 503 `NOT_CONFIGURED`. Um segredo de
  senha novo mantém a verificação em duas etapas; um `PASSWORD_PEPPER` novo é a
  redefinição completa (perdeu a senha **e** o celular) e desliga a verificação
  em duas etapas e as passkeys, com um evento `mfa_disabled` marcado para alerta.
  A recuperação por e-mail chega na etapa 11.
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
  (rede fora, erro, tempo esgotado, ou um corpo que não é a resposta completa
  da API, com pelo menos 100 linhas `sufixo:contagem`), a troca é recusada com 503
  `SERVICE_UNAVAILABLE`: falha fechada, nunca "aceita por não saber".
- **Senha fraca atual.** Se a senha em uso não passa nas regras de hoje, o
  login entra e exige a troca, como com o `OWNER_PASSWORD`.
- Uma troca que termina enquanto um login confere a senha antiga vence: o
  login é recusado e não abre sessão.
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
    sessão. A interface põe o cabeçalho só em mudanças (POST, PATCH, DELETE)
    feitas até 10 s depois de um toque ou tecla, e no heartbeat com
    `active: true`; leituras nunca o levam, porque o cache de consultas busca
    de novo sozinho (foco da janela, dado vencido).
  - **5 minutos sem aba aberta.** Qualquer requisição de uma aba conta como
    presença; a interface manda `POST /api/auth/heartbeat` uma vez por minuto.
  - **6 horas** no total, com uso ou sem.

  As faixas configuráveis são 5 a 60 min, 3 a 15 min e 1 a 24 h; um máximo
  menor vale também para as sessões já abertas. Uso e presença são gravados no
  máximo uma vez por minuto (gravações contam no plano Free); por isso o fim
  por falta de uso ou de aba pode chegar até 1 minuto antes do prazo. O fim fica na
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
(`recentAuthUntil`). Com a verificação em duas etapas ligada, um código atual do
aplicativo (`{totp}`) vale no lugar da senha, com os mesmos limites dos códigos
do login; nunca um código de recuperação. Com ela desligada, um código recebe
401 `INVALID_CREDENTIALS` sem gastar tentativa da rede.

## Verificação em duas etapas

Opcional no código e ligada pelo dono em Configurações → Segurança (a tela
chega na etapa 5). Recomendado ligar logo depois do primeiro login.

- **Aplicativo autenticador (TOTP, RFC 6238).** HMAC-SHA-1, 6 dígitos, passos
  de 30 segundos, segredo de 160 bits. Vale o passo atual e um de cada lado
  (relógio do celular um pouco fora). Um passo já aceito, e qualquer anterior,
  nunca vale de novo: o mesmo código não entra duas vezes. O link `otpauth://`
  leva o nome do agente, nunca o e-mail.
- **Segredo cifrado.** Só o texto cifrado (AES-256-GCM, chave derivada por HKDF
  do `PASSWORD_PEPPER`) fica em `zur_mfa_secrets`: uma cópia do banco sozinha
  não gera códigos. A configuração mostra o segredo uma vez e só liga depois de
  um código feito com ele, em até 10 minutos.
- **Códigos de recuperação.** 10 códigos de 80 bits (`ABCD-EFGH-JKLM-NPQR`),
  mostrados uma vez e guardados só como SHA-256. Cada um vale uma vez e some ao
  ser usado; usar um gera evento com alerta. Gerar novos invalida os antigos e
  pede um código do aplicativo.
- **Desafio do login.** Com a verificação ligada, a senha certa não abre
  sessão: responde 200 `{mfaRequired: true, passkey, expiresAt}` e grava o
  cookie `__Host-zuri_mfa` (`HttpOnly`, `Secure`, `SameSite=Strict`, 5 min). O
  banco guarda só `HMAC(SESSION_SECRET, cookie)`. O desafio vale 5 minutos,
  aceita 5 respostas erradas e abre uma sessão só; depois disso, a senha é
  pedida de novo e o cookie é apagado. A tentativa de senha continua contando
  como falha da rede até o segundo passo dar certo. Trocar a senha ou
  redefini-la pelo painel encerra os desafios pendentes.
- **Pausa global.** 10 respostas erradas (códigos ou passkeys) em 15 minutos,
  somando todos os desafios e redes, pausam as redes desconhecidas (sem login
  nos últimos 30 dias) com 429 `RATE_LIMITED` até a janela passar. Quem tem a
  senha não compra mais chutes espalhando pedidos. As redes do dono seguem.
  Os pedidos recusados pela pausa viram uma linha só na atividade por rede e
  janela, e pedir de novo as opções de passkey devolve o mesmo pedido ainda
  válido: insistir não gasta a cota de gravações do plano gratuito.
- **Alertas.** 3 segundos passos errados seguidos, ligar ou desligar a
  verificação, gerar códigos novos, usar um código de recuperação, adicionar ou
  remover uma passkey: eventos com alerta (entregues na etapa 11). Ligar ou
  desligar encerra todas as outras sessões.
- **Mexer na verificação** pede sessão e senha recente (15 min). Desligar pede
  também um código atual ou de recuperação, e apaga segredo, códigos, passkeys e
  desafios pendentes. Os códigos digitados numa sessão gastam as 3 tentativas da
  rede, como a senha.

## Passkeys

- **Segundo passo, não substituto da senha.** Uma passkey (WebAuthn) responde
  ao desafio do login no lugar do código. Ela só pode ser criada com a
  verificação em duas etapas ligada: os códigos de recuperação são o caminho de
  volta se todas as passkeys se perderem. Até 10.
- **Do host onde nasceu.** O `rpId` e a origem vêm sempre do `PUBLIC_URL`,
  nunca do pedido. Uma passkey criada em outro endereço (por exemplo, no
  `workers.dev` antes do domínio próprio) aparece na lista com
  `usableHere: false`, nunca é oferecida e a resposta dela é recusada.
- **Desafio.** 32 bytes aleatórios do servidor (o WebAuthn pede pelo menos
  16), válido por 2 minutos e usado uma vez, certo ou errado. O contador de
  assinatura precisa avançar, para um clone aparecer. Só a chave pública fica
  guardada.
- **Verificação do usuário.** No login, `userVerification: "preferred"`: a
  senha já veio antes, então uma chave de segurança sem PIN também serve. A
  verificação fica em `Passkeys.verifyAssertion`, que recebe o desafio guardado
  por quem chama; as aprovações pelo bot (etapa 16) usam a mesma função com
  `"required"`, e uma resposta sem a marca de verificação (digital, rosto ou
  PIN) é recusada.
- Biblioteca: `@simplewebauthn/server` 14.0.3, atestação `none`, algoritmos
  EdDSA, ES256 e RS256.

## Força bruta

- **Por rede.** Uma rede é o endereço IPv4 do `CF-Connecting-IP`, ou o /64
  inteiro no IPv6 (um assinante costuma ter um /64 e poderia trocar de endereço
  a cada chute). IPv6 com IPv4 mapeado conta como o IPv4. Sem o cabeçalho (só
  fora da Cloudflare), a requisição é recusada, para não cair num balde
  compartilhado; a exceção é o desenvolvimento local.
- **3 falhas por rede em 15 minutos**: a quarta tentativa recebe 429
  `RATE_LIMITED`, com `Retry-After` e `details.retryAfter` em segundos, até a
  falha mais antiga sair da janela. Login, confirmação de senha e troca de senha
  usam o mesmo contador. Um acerto não zera as falhas da janela: a regra é
  literal, 3 erros em 15 minutos.
- **Ataque distribuído.** Com 25 recusas somando todas as redes na janela
  (senhas erradas e verificações Turnstile recusadas), uma rede que não entrou
  com sucesso nos últimos 30 dias tem uma tentativa só, gasta na senha ou no
  Turnstile; com 100, nenhuma até a janela esvaziar. As redes do dono, os
  navegadores que já entraram (cookie de aparelho) e as sessões abertas
  (confirmação e troca de senha) ficam fora dessas duas travas e mantêm as 3 da
  rede. Essa confiança por cookie tem um orçamento próprio: 3 senhas erradas na
  janela, somando todas as redes, e ela deixa de valer até a janela passar
  (um cookie roubado não ganha 3 chutes por rede de uma botnet). O dono recebe um evento com alerta, no máximo a cada 6 horas.
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

Com o Turnstile ligado, a CSP de **todas** as páginas da interface acrescenta
`https://challenges.cloudflare.com` em `script-src` e `frame-src`, e não só a
de `/entrar`. A interface é uma SPA: a CSP vale para o documento carregado
primeiro, e o login também abre por navegação interna (sessão que terminou,
sair). Restringir a origem ao `/entrar` quebraria o widget nesses casos. O
risco aceito é pequeno: a origem é da própria Cloudflare, e a interface não
tem HTML vindo de fora (`dangerouslySetInnerHTML` não é usado).

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

A aba Segurança mostra os 50 eventos mais recentes (`GET /api/auth/activity`,
sessão e CSRF): tipo, hora, cidade, região, país, IP e navegador. A resposta
nunca leva o id da sessão, a chave de rede nem a marca de alerta.

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
  entrou. Passou do teto, a limpeza corta até 45.000, para não contar todas as
  linhas de novo a cada hora. Cada motivo de recusa tem a sua linha.
- **Enquanto toda rede precisa do Turnstile (10 falhas no total) ou durante um
  ataque distribuído**, as recusas repetidas de todas as redes viram uma linha
  só por janela, sem IP nem localização: milhares de redes não
  custam uma gravação cada.
- **Retenção (LGPD).** Os detalhes ficam 90 dias e viram contagens diárias por
  tipo e país, sem IP nem user agent, guardadas por um ano. Base legal:
  legítimo interesse na segurança da conta (LGPD art. 7º, IX, e art. 46). A
  limpeza roda no máximo uma vez por hora, quando a atividade é gravada.
- **Cookie de aparelho.** O login define `__Host-zuri_device` (aleatório, 180
  dias, `HttpOnly`, `Secure`, `SameSite=Strict`). O banco guarda só o HMAC,
  para até 50 navegadores. Ele distingue um navegador conhecido de um novo e o
  deixa fora das travas de ataque distribuído (com o orçamento acima). Trocar a
  senha ou redefini-la pelo painel esquece todos os navegadores. Nunca autentica, nunca dispensa
  senha nem segundo fator e nunca afrouxa o limite de 3 tentativas da rede.
- **Alertas.** Um login de navegador novo ou de rede sem login nos últimos 30
  dias (menos o primeiro login de todos), a troca de senha, a redefinição pelo
  painel e o início de um ataque distribuído ficam marcados com
  `alert_pending = 1`. A etapa 11 entrega esses avisos; o texto será genérico,
  para não mostrar onde nem como numa tela bloqueada.
- **Não registrado:** o que os portões do Worker recusam antes do agente (host
  errado, Access) e as recusas de CSRF. Registrar custaria uma requisição ou uma
  gravação no Durable Object por pedido de lixo.

## Custo de um ataque no plano Free

O Durable Object tem cotas diárias de linhas lidas e gravadas no plano Free;
passou delas, o app inteiro para até a meia-noite UTC. Por isso uma recusa
custa quase nada:

- a contagem global da janela fica na memória do objeto (lida uma vez quando
  ele acorda), e não é relida a cada pedido;
- a limpeza das tentativas antigas roda no máximo uma vez por minuto, e a da
  atividade no máximo uma vez por hora;
- passado o limite de 100, uma verificação Turnstile recusada que volta
  atrasada não grava mais nada;
- as recusas repetidas são agrupadas, como descrito acima.

Recomendado na instalação, sem custo: uma regra de rate limiting do WAF da
Cloudflare (o plano Free inclui uma) para `/api/auth/*`, que barra a enxurrada
na borda, antes de contar como requisição do Worker. O guia de instalação
(`docs/instalacao-cloudflare.md`, etapa 24) traz o passo a passo.

## Logs da Cloudflare

Os logs do Worker (`observability` no `wrangler.jsonc`) guardam cada
requisição. A Cloudflare troca por `REDACTED` o valor de cabeçalhos como
`Cookie`, `Set-Cookie` e os que têm "auth" no nome, então o token de sessão não
aparece. O IP do visitante e a localização aparecem, como em qualquer log de
acesso, e ficam pelo prazo dos Workers Logs da conta. O código do Zuri só
escreve nos logs nomes e códigos, nunca valores.
