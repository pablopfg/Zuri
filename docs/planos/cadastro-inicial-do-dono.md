# Plano · Cadastro inicial do dono (primeiro acesso)

Situação: **aprovado pelo Pablo em 31/10/2026** (opção E, como está). A
decisão está em `.claude/memoria/decisoes.md` e na especificação (N13). A
implementação segue os três PRs do passo a passo.

## Ajustes feitos na implementação do servidor

O que mudou em relação ao texto abaixo, depois do QA e da auditoria. Onde os
dois divergem, vale esta lista e a seção de primeiro acesso de
[seguranca.md](../seguranca.md#primeiro-acesso-e-recuperação-com-o-código-de-instalação).

- `GET /api/setup` responde `{ setup }` e não grava nada. A hora do código
  começa na primeira tentativa que passa pela verificação contra robôs, não na
  primeira visita, para um robô não gastar a hora do dono.
- `POST /api/setup/code` responde 200 `{ mode, expiresAt }` com o cookie. Depois
  do cadastro, `/api/setup/owner` responde 409 `CONFLICT` (não 404), e o mesmo
  código responde como código inválido.
- Limites por rede, e não pelo código inteiro: 5 tentativas em 15 minutos
  pausam a rede, 20 em 24 horas a bloqueiam pelo resto do dia. A cada 20 erros
  somando todas as redes, um alerta. Assim, o palpite de um atacante não trava
  o dono. A vaga é reservada antes de qualquer espera.
- A impressão digital do código usa um sal aleatório guardado no banco, e não
  o `SESSION_SECRET`: trocar o segredo não reabre um código gasto. Um código
  gravado de novo guarda a hora da primeira vez.
- O segundo passo obrigatório é o 2FA (aplicativo autenticador). A passkey
  exige o 2FA ligado antes, então vem depois.
- Eventos: `setup_failure`, `setup_locked`, `owner_created` e
  `access_recovered`. Não há evento para o código aceito.
- Sem tabela `zur_owner`: o e-mail fica numa chave interna, e o nome
  (`ownerName`) entra no PR da tela.
- Instalações antigas (`OWNER_EMAIL` nos segredos) contam como dono existente:
  um `SETUP_CODE` lá abre só a recuperação, que confere o e-mail. Elas não
  ganham a trava do 2FA.
- O cookie `__Host-zuri_setup` precisa de `Path=/` (exigência do prefixo); ele
  só tem efeito nas rotas `/api/setup/*`.

## O pedido

Depois da instalação, o sistema abre uma tela de cadastro do administrador
(o dono), onde ele informa os próprios dados. O cadastro tem de ser seguro:
ninguém além do dono pode conseguir usar essa tela para tomar o controle da
Zuri.

## Como é hoje

- O dono grava no painel os segredos `OWNER_EMAIL` e `OWNER_PASSWORD` (20+
  caracteres) ou `OWNER_PASSWORD_HASH`. O primeiro login com `OWNER_PASSWORD`
  obriga a troca da senha, grava o hash no banco e pede para apagar o segredo
  (`apps/agent/src/auth/service.ts`, `docs/seguranca.md`).
- O e-mail não fica no banco: o login compara o digitado com `OWNER_EMAIL` por
  HMAC.
- Trocar o segredo de senha ou o `PASSWORD_PEPPER` no painel redefine a senha e
  encerra as sessões (impressão digital dos segredos em `auth_secret_fingerprint`).
- Turnstile em todo login, limitador de tentativas, registro em Acessos, 2FA e
  passkeys já existem (etapas 3 e 4, PR #19 e #23).

O que falta é a experiência: hoje o dono precisa inventar uma senha provisória
no painel e não existe nenhum lugar para o nome dele.

## O risco principal

Um sistema que nasce "sem dono" e aceita o primeiro cadastro que chegar pode
ser tomado por quem chegar antes. Isso acontece de verdade: todo certificado
HTTPS novo aparece em minutos nos registros públicos de transparência de
certificados, e há robôs que leem esses registros atrás de instalações recém
publicadas (o caso clássico é o instalador do WordPress). O repositório da Zuri
é público, então qualquer um sabe como a tela funciona. A tela de cadastro
precisa de uma prova que só o dono da conta Cloudflare tem.

## Opções avaliadas

| Opção | Como funciona | Prós | Contras | Veredito |
| --- | --- | --- | --- | --- |
| A. Primeiro que chegar | Tela aberta enquanto não há dono | Simples | Tomada de controle trivial (registros de certificados, robôs) | Rejeitada |
| B. Janela curta sem prova | Tela aberta só nos primeiros N minutos após o deploy | Sem passo extra | Ainda é corrida: o robô chega em minutos; o deploy pelo GitHub é público | Rejeitada |
| C. Código mostrado nos logs | O Worker sorteia um código e escreve no log | Dono não inventa nada | Viola a regra de nunca pôr token em log; logs ficam guardados e visíveis a quem lê a conta | Rejeitada |
| D. Cloudflare Access obrigatório | Tela atrás do Access | Forte | Configuração pesada para quem instala; Access é opcional na especificação | Camada extra opcional, não a principal |
| **E. Código de instalação como segredo** | O dono grava `SETUP_CODE` (32+ caracteres aleatórios) no painel junto com os outros segredos; a tela só abre o formulário com o código certo | Só quem controla a conta Cloudflare tem o código; mesmo modelo de confiança de hoje (segredos), sem log, sem corrida; serve também para recuperar o acesso | Um segredo a mais para gravar (o dono já grava `SESSION_SECRET` e `PASSWORD_PEPPER`) | **Recomendada** |

## Recomendação: opção E, em detalhe

### Estados do sistema (no Durable Object)

```
sem_dono ──código certo + cadastro──▶ falta_segundo_passo ──2FA ou passkey──▶ pronto
   ▲                                                                            │
   └──────────── nunca volta (o cadastro só acontece uma vez) ◀─────────────────┘
```

- `sem_dono`: não há dono. Só a tela de primeiro acesso responde; login,
  API e o resto devolvem `NOT_CONFIGURED`.
- `falta_segundo_passo`: dono criado, sessão aberta, mas toda rota além de
  ativar o 2FA ou cadastrar uma passkey responde 403 (mesmo mecanismo da troca
  obrigatória de senha, `passwordChangeRequired`).
- `pronto`: funcionamento normal. As rotas de primeiro acesso respondem 404,
  para sempre.

O estado é lido e mudado dentro de uma transação no Durable Object, que é
único e processa uma requisição por vez nas partes síncronas. Dois cadastros
ao mesmo tempo: o segundo recebe 409 `CONFLICT`.

### O código de instalação

- Segredo `SETUP_CODE`, 32 caracteres ou mais. O guia de instalação mostra
  como gerar um aleatório pelo gerador de senhas do navegador ou do
  gerenciador de senhas. Códigos curtos ou de um caractere só repetido são
  recusados pela configuração (falha fechada, como os outros segredos).
- Comparação por HMAC das duas partes, em tempo constante.
- **Uso único:** depois do cadastro, a impressão digital do código fica
  marcada como gasta. O mesmo código nunca abre nada de novo.
- **Validade:** 1 hora contada da primeira vez que o sistema vê aquele
  código (decisão do Pablo, 31/10/2026; antes eram 24 h). Passou disso sem
  cadastro, a tela diz que o código venceu e o dono grava outro no painel.
  Por isso o guia manda gravar o código só na hora de abrir o primeiro acesso.
  O cookie de cadastro nunca passa do fim dessa hora.
- **Tentativas:** Turnstile em cada tentativa (validado antes do código,
  falha fechado) e limite próprio: 5 erros em 15 minutos pausam a tela por 15
  minutos; 20 erros com o mesmo código o travam, e só um código novo destrava.
  Com 32 caracteres aleatórios, adivinhar é impossível na prática; o limite
  existe para não gastar cota e para gerar aviso.
- Nunca vai para log, URL de consulta, `localStorage` ou resposta da API. O
  formulário manda o código no corpo JSON, por POST, na mesma origem.

### Fluxo na tela (interface)

Rota `/primeiro-acesso`. A tela de entrar redireciona para ela quando o
sistema responde que ainda não há dono.

1. **Código.** Um campo "Código de instalação" e o botão Continuar, com a
   verificação humana discreta. Erro genérico ("Código inválido ou vencido"),
   sem dizer qual dos dois.
2. **Seus dados.** Aparece só depois do código certo, que abre um cookie
   `__Host-` de cadastro com 15 minutos de validade, assinado, `HttpOnly`,
   `SameSite=Strict`. Campos:
   - Como prefere ser chamado (até 40 caracteres). É o mesmo campo que a
     área logada vai ter em Configurações > Conta para os cumprimentos;
     o cadastro só preenche esse campo, sem criar outro (`ownerName`, chave
     `owner_name`, com `normalizeOwnerName` e `OWNER_NAME_MAX` de
     `packages/shared/src/settings.ts`).
   - E-mail (vira o login e o endereço de recuperação).
   - Senha e confirmação, com as regras de hoje: 15+ caracteres, partes
     previsíveis não contam (nome e e-mail entram na lista), conferência de
     vazamento por k-anonimato com falha fechada, medidor de força.
   - Idioma e fuso, já preenchidos pelo navegador, editáveis. Gravados nas
     configurações que já existem (idioma e fuso da etapa 2), as mesmas que os
     cumprimentos usam.
3. **Segundo passo obrigatório.** Ao salvar, o sistema abre a sessão e leva
   direto para ativar o 2FA (QR code e códigos de recuperação, com
   confirmação de que foram guardados) ou cadastrar uma passkey. Sem isso, nada
   mais abre. Fechar a aba no meio não estraga nada: o próximo login cai de
   novo nesse passo.
4. **Pronto.** Leva ao Início com um aviso curto para apagar o código de
   instalação no painel. O aviso some sozinho quando o segredo deixa de
   existir.

Os textos não citam Cloudflare, Worker, Turnstile ou qualquer parte da
infraestrutura (decisão de 31/10/2026). O guia de instalação é que explica
onde gravar o código.

### Rotas novas

| Rota | Proteção | Corpo | Respostas |
| --- | --- | --- | --- |
| `GET /api/setup` | pública, sem dado sensível | — | 200 `{ needed: boolean }` |
| `POST /api/setup/code` | Origin + Turnstile + limitador | `{ code, turnstileToken }` | 204 com cookie de cadastro; 401 `INVALID_CREDENTIALS`; 429 `RATE_LIMITED`; 404 depois do cadastro |
| `POST /api/setup/owner` | Origin + cookie de cadastro | `{ name, email, password, locale, timeZone }` | 201 com cookie de sessão; 400 `VALIDATION_FAILED`; 409 `CONFLICT`; 404 depois do cadastro |

Todos os corpos com schema Zod em `packages/shared/src/setup.ts`. O 2FA e a
passkey usam as rotas que já existem (`/api/auth/mfa/*`,
`/api/auth/passkeys/*`); a senha recente que elas pedem vem do próprio
cadastro.

### Dados (migration só de acréscimo)

- Sem migration (ajuste feito na implementação): o e-mail fica na chave
  interna `owner_email` de `zur_settings`, ao lado do hash da senha
  (`auth_password_hash`). Nenhuma das duas sai do banco nem entra no backup, e
  o login compara o e-mail por HMAC, como antes.
- O nome não ganha coluna nova aqui: vai para o campo "Como prefere ser
  chamado" das configurações, criado pelo trabalho dos cumprimentos. O fuso e
  o idioma vão para as chaves que já existem.
- Chaves novas no estado interno: `setup_state`, `setup_code_seen`
  (impressão digital e primeira vez visto), `setup_code_spent`.
- Nada é apagado. Instalação que já tem senha (pelo caminho antigo) passa
  direto para `falta_segundo_passo` ou `pronto`, conforme o 2FA, e o nome fica
  vazio até o dono preencher em Configurações > Conta.

### O que muda nos segredos

- `OWNER_EMAIL` deixa de ser obrigatório: o e-mail passa a morar no banco do
  dono. Se existir, continua valendo até o cadastro, por compatibilidade.
- `OWNER_PASSWORD` sai do guia (o código de instalação o substitui). O código
  continua aceito por uma versão, com aviso no log de que está obsoleto, e sai
  depois.
- `OWNER_PASSWORD_HASH` continua como caminho avançado.
- Obrigatórios passam a ser `SESSION_SECRET`, `PASSWORD_PEPPER`, as chaves do
  Turnstile e, enquanto não houver dono, `SETUP_CODE`. Sem eles, o health
  check responde 503 como hoje.

### Recuperar o acesso (mesmo mecanismo, sem porta nova)

Gravar um `SETUP_CODE` **diferente** depois do cadastro abre a tela em modo
"recuperar acesso": o código novo mais o e-mail cadastrado permitem definir
uma senha nova. Os dados ficam, todas as sessões caem, e o 2FA continua
exigido no login seguinte (como hoje, quando o dono troca o segredo de senha).
Só um `PASSWORD_PEPPER` novo, a redefinição completa que já existe, desliga
também o 2FA. Isso substitui a redefinição por `OWNER_PASSWORD` novo.

### Registro em Acessos e avisos

Eventos novos em `zur_auth_events`, visíveis na página Acessos com IP,
cidade, país, rede e navegador, como o login:

- `setup_code_failure` (código errado), `setup_locked` (limite atingido,
  marcado para aviso), `setup_code_accepted`, `owner_created` (marcado para
  aviso), `setup_recovery` (recuperação pelo código novo, marcado para aviso).

Os avisos chegam pelo Telegram e pelo e-mail quando essas etapas existirem;
até lá ficam destacados em Acessos.

### Camada extra opcional

Com o Cloudflare Access ligado, `/primeiro-acesso` fica atrás dele como o
resto do app (sem bypass). O guia recomenda, mas não exige.

## Passo a passo da implementação (depois do OK)

Três PRs pequenos para `develop`, cada um com testes antes do código, QA e
auditoria completa (a área é autenticação).

1. **`feat(agent): cadastro inicial do dono com código de instalação`**
   - Máquina de estados, rotas `/api/setup*`,
     limitador e Turnstile, eventos novos, trava de rotas em
     `falta_segundo_passo`, e-mail vindo do banco no login, `SETUP_CODE` na
     configuração e no health check.
   - Testes no workerd: código certo, errado, vencido (59min59s e 1h00min01s), gasto,
     trocado; limites exatos (4, 5 e 6 erros; 19, 20 e 21); dois cadastros
     simultâneos; cookie de cadastro vencido, adulterado, de outra origem;
     corpo enorme, vazio, JSON malformado, e-mail com maiúsculas e espaços,
     nome com controle Unicode e tags; senha fraca, vazada e serviço de
     vazamento fora do ar; rotas de primeiro acesso depois do cadastro (404);
     toda rota da API em `falta_segundo_passo` (403); nada do código em log,
     resposta ou cabeçalho; orçamento por rota (P1–P14).
2. **`feat(web): tela de primeiro acesso e segundo passo obrigatório`**
   - Tela lazy `/primeiro-acesso` (três passos), textos em pt-BR e en pelo
     catálogo, redirecionamento a partir da tela de entrar, aviso para apagar o
     código no Início. O JS inicial não pode subir (teto de 139,5 kB): a tela
     carrega sob demanda.
   - e2e: instalação nova do começo ao fim, código errado, recarregar no meio,
     fechar no segundo passo e voltar; axe; teclado; leitor de tela; celular e
     computador; claro e escuro.
   - Capturas de cada passo na descrição do PR (computador e celular, claro e
     escuro, com dados de exemplo), geradas por
     `scripts/capturas-da-interface.ts` em `docs/capturas/pr/primeiro-acesso/`
     com link preso ao commit, como pede `.claude/rules/capturas.md`.
3. **`docs: guia de instalação com código de instalação`**
   - `docs/configuracao-cloudflare.md`, `docs/seguranca.md`,
     `docs/arquitetura.md`, especificação (tabela de segredos, contrato da API,
     etapa 3), README e CHANGELOG.

Os PRs 1 e 2 também atualizam README e CHANGELOG no que mudam.

## Riscos e como ficam cobertos

| Risco | Cobertura |
| --- | --- |
| Alguém chega antes do dono | Sem o código, a tela não passa do primeiro campo |
| Código vaza (print, histórico) | Uso único, vale 1 h, e o Início lembra de apagar o segredo |
| Força bruta no código | 32+ caracteres aleatórios, Turnstile, 5/15 min e trava em 20 erros por código |
| Sessão de cadastro roubada | Cookie `__Host-`, `HttpOnly`, `SameSite=Strict`, 15 min, só para `/api/setup/owner` |
| Dono para no meio e alguém usa a sessão | Sem 2FA ou passkey nada abre; sessão segue os limites normais |
| Cadastro duplo ou corrida | Transação no Durable Object e 409 |
| Texto da tela entregar a infraestrutura | Revisão dos textos e teste que procura nomes proibidos no catálogo das telas públicas |
| Custo | Nada pago: só segredos, Durable Object e Turnstile, todos no plano Free |

## O que o Pablo confirmou (31/10/2026)

1. Aprovada a opção E (código de instalação como segredo).
2. Confirmados os campos do cadastro: como prefere ser chamado, e-mail, senha,
   idioma e fuso. Nome completo, foto ou telefone ficam de fora, a não ser que
   ele queira.
3. Confirmado que o segundo passo (2FA ou passkey) é obrigatório já no
   cadastro.
