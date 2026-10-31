# Revisão de segurança do login

Data: 31/10/2026. Pedido do Pablo: revisar todo o procedimento de login, sem
deixar brecha, incluir a verificação contra robôs da Cloudflare na tela de
login e registrar o IP de cada tentativa numa área do sistema.

## Escopo e método

Revisado o fluxo inteiro na `develop` (até o PR #15):

- senha (PBKDF2 com pepper, HMAC do e-mail, `OWNER_PASSWORD` e
  `OWNER_PASSWORD_HASH`, troca e redefinição pela rotação de segredo);
- segundo fator (TOTP, códigos de recuperação, passkeys) e o desafio em cookie;
- sessões (inatividade, presença, duração máxima, heartbeat, revogação),
  cookies `__Host-`, CSRF, cabeçalhos e CSP;
- limitador de força bruta (3 falhas por rede em 15 minutos, travas globais
  de 25 e 100, confiança por cookie de aparelho), pausa global dos códigos;
- Turnstile, saída, registro de atividade e a tela de login.

Duas leituras independentes: a minha e a do subagente `auditor-seguranca`, que
recebeu só o escopo. Cada achado confirmado virou teste que falha antes da
correção e passa depois.

## Achados e correções

| Id | Gravidade | Achado | Situação | Teste |
| --- | --- | --- | --- | --- |
| LOGIN-01 | média | O Turnstile era adaptativo: a primeira tentativa de cada rede nova não passava pela verificação. Uma botnet com muitos IPs ganhava um chute por rede até as travas globais (25 e 100 recusas) entrarem. | Corrigido: verificação em **toda** tentativa, antes de contar a tentativa e antes do PBKDF2 (decisão do Pablo). | `auth-limits.test.ts` › "Turnstile on every sign-in" |
| LOGIN-02 | média | Sem as chaves do Turnstile o login seguia sem verificação em produção (falha aberta por configuração). | Corrigido: fora do local, sem chaves o login responde `NOT_CONFIGURED` antes de qualquer limite ou hash. | "closes the sign-in where it is mandatory and off" |
| LOGIN-03 | média | As chaves de teste da Cloudflare, se gravadas por engano em produção, aceitariam o token público `XXXX.DUMMY.TOKEN.XXXX`. | Corrigido: em produção valem como chave ausente; no local são respondidas sem rede. | `auth-client.test.ts` › "refuses Cloudflare's test keys outside local development"; `gates.test.ts` › "sign-in options" |
| LOGIN-04 | baixa | `safeNext` decidia antes de resolver os segmentos de ponto: `?next=/..//site` virava `//site`. O roteador recusava a navegação externa, mas a tela ficava em branco depois do login. | Corrigido: o caminho resolvido também não pode começar com `//`. | `apps/web/test/next.test.ts` (4 casos novos) |
| LOGIN-05 | baixa | O alerta de códigos errados saía só no 3º erro seguido; um chute lento ao TOTP por dias não avisava mais o dono. | Corrigido: alerta a cada 3 erros seguidos, entre desafios. | `auth-mfa.test.ts` › "every 3rd wrong answer in a row" |
| LOGIN-06 | baixa | A pausa global dos códigos isentava qualquer pedido vindo de uma rede onde o dono entrou. Numa rede compartilhada (CGNAT da operadora, Wi-Fi público, relay), quem tem a senha seguia chutando códigos sem a pausa. | Corrigido: no login, a isenção exige a rede do dono **e** um cookie de aparelho que já entrou. | `auth-mfa.test.ts` › "10 wrong codes in 15 minutes pause unknown networks" |
| LOGIN-07 | baixa | Segunda rodada (auditoria das correções): uma rajada de pedidos simultâneos com token falso passava junto pela trava e gravava uma linha de recusa cada, acima das 10 por rede. | Corrigido: a recusa só é gravada enquanto a rede está abaixo das 10. | `auth-limits.test.ts` › "a burst that passed the check together writes no more than the network's 10" |
| LOGIN-08 | baixa | Segunda rodada (QA): sem as chaves do Turnstile em produção o login fechava calado; o `/api/health` respondia "ok". | Corrigido: o health responde 503 `NOT_CONFIGURED` e o log do dono nomeia os dois segredos (sem valores). | `gates.test.ts` › "says in the health check, outside development, that the sign-in is closed" |
| LOGIN-09 | baixa | Segunda rodada (QA): um motivo gravado como `constructor` ou `__proto__` lia o protótipo de objeto na tela de acessos. | Corrigido: só chaves próprias do catálogo de motivos. | `apps/web/test/activity.test.ts` |

Nenhum achado crítico ou alto, nas duas rodadas.

## Verificado sem problema

- PBKDF2 com pepper e comparação em tempo constante; e-mail errado e senha
  errada demoram o mesmo e respondem igual (sem enumeração).
- Tentativa contada no mesmo passo síncrono da checagem do limite: pedidos
  simultâneos não passam juntos (teste "10 at once still get only 3 guesses").
- Desafio do segundo fator e da passkey de uso único; contador da passkey; RP
  sempre do `PUBLIC_URL`.
- Sessão nova a cada login, a anterior revogada (sem fixação); rotação de
  senha ou pepper pelo painel encerra tudo.
- Cookies `__Host-`, `HttpOnly`, `SameSite=Strict`, `Secure`; CSRF com
  cabeçalho próprio mais `Origin` ou `Sec-Fetch-Site`.
- `siteverify` com tempo limite, sem seguir redirecionamento, conferindo ação
  e host; HIBP falha fechado.
- Nenhum dado pessoal em `console.*` (novo teste para o IP nas tentativas).

## Registro de tentativas com IP

O registro já existia desde a etapa 3 (`zur_auth_events`): cada login, senha
errada, bloqueio e verificação recusada grava o IP (`CF-Connecting-IP`), país,
região, cidade, ASN, data center, navegador, resultado e hora, por 90 dias, com
teto de 50.000 linhas e recusas repetidas dobradas numa linha. Esta revisão
não precisou de migration. Entregou a área própria na interface, a página
**Acessos**, com filtros de período, tipo e IP e páginas de 50.

## Decisão pendente com o Pablo

- **Ataque lento ao código do 2FA** (levantado também pela thread de QA, PR
  #16): com a senha vazada, alguém em muitas redes ainda testa centenas de
  códigos por dia, limitado pela pausa global (10 erros em 15 minutos). Esta
  revisão já faz o aviso se repetir a cada 3 erros seguidos e tira a isenção de
  quem só divide a rede com o dono. A proposta de suspender o segundo passo
  para redes desconhecidas acima de 100 erros em 24 horas espera a decisão do
  Pablo e fica com a thread de QA.

## Riscos aceitos

- **Vizinho na mesma rede.** As 3 falhas por rede em 15 minutos valem também
  para o navegador do dono: alguém no mesmo IPv4 compartilhado pode mantê-lo
  esperando. O cookie de aparelho continua sem afrouxar esse limite (é a regra
  da especificação). Agora o vizinho também precisa passar no Turnstile a cada
  tentativa, o que encarece o abuso.
- **Enxurrada anônima.** Toda chamada a `/api/*` sem sessão ainda chega ao
  Durable Object e conta na cota diária do plano Free. Responder 401 no Worker
  mudaria o idioma dos erros (o idioma do dono está no banco). A recomendação é
  a regra gratuita de rate limiting do WAF, em
  [configuracao-cloudflare.md](../configuracao-cloudflare.md).
- **Filtro de IP sem índice.** O filtro pelo começo do IP percorre as linhas
  do período pelo índice de tempo; no pior caso (90 dias, teto de 50.000
  linhas, nenhum resultado) uma página lê a tabela inteira. Só o dono, com
  sessão, faz essa busca; um índice novo custaria uma escrita a mais em cada
  tentativa de login, que é a cota mais apertada.
- **Pseudo IPv4.** Com "Overwrite headers" na zona, o IP registrado seria
  inventado e o agrupamento por /64 se perderia. A configuração recomendada
  está em [configuracao-cloudflare.md](../configuracao-cloudflare.md).
