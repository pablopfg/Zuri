# Configuração na Cloudflare

O que o dono faz no painel da Cloudflare: gravar os segredos, criar a
verificação contra robôs (Turnstile), fazer o primeiro acesso com o código de
instalação e deixar o registro de acessos guardar o IP certo. Tudo aqui é
gratuito. Nenhum valor real entra no repositório: os exemplos usam
`zuri.exemplo.com.br`.

Ordem para uma instalação nova:

1. [Segredos obrigatórios](#segredos-obrigatórios).
2. [Criar o widget do Turnstile](#criar-o-widget-do-turnstile).
3. [Primeiro acesso com o código de instalação](#primeiro-acesso-com-o-código-de-instalação).
4. [IP certo no registro de acessos](#ip-certo-no-registro-de-acessos) e, se
   quiser, a [proteção extra](#proteção-extra-contra-enxurrada-opcional-e-gratuita).

O deploy pelo GitHub Actions chega na etapa 24. Até lá, o Worker já precisa
estar publicado na sua conta com o domínio próprio.

## Segredos obrigatórios

Todos ficam em **Workers e Pages > zuri > Configurações > Variáveis e
segredos**, sempre do tipo **Secret**: o deploy apaga variáveis comuns que não
estão no `wrangler.jsonc`, mas não apaga segredos. Pelo terminal, o equivalente
é `npx wrangler secret put <NOME>` dentro de `apps/agent`. A lista completa,
com as regras de cada um, está em [arquitetura.md](arquitetura.md#configuração).

| Nome | O que gravar |
| --- | --- |
| `PUBLIC_URL` | Só a origem, em HTTPS: `https://zuri.exemplo.com.br` |
| `SESSION_SECRET` | 48 caracteres aleatórios ou mais |
| `PASSWORD_PEPPER` | 48 caracteres aleatórios ou mais, diferente do anterior |
| `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` | As chaves do widget (seção seguinte) |
| `SETUP_CODE` | Só na hora do primeiro acesso (veja abaixo) |

Para gerar um valor aleatório, use o gerador do seu gerenciador de senhas
(64 caracteres, letras e números) ou, num terminal,
`openssl rand -base64 48`. Guarde o `PASSWORD_PEPPER` no gerenciador de
senhas: trocá-lo depois apaga a senha e desliga a verificação em duas etapas
(é a redefinição completa).

O que acontece quando falta algo (detalhes em
[arquitetura.md](arquitetura.md#configuração)):

- `PUBLIC_URL` ausente ou malformado: tudo, inclusive a interface, responde 503
  `NOT_CONFIGURED`, sem log.
- Outro segredo ausente ou curto: a interface abre, mas a API responde 503
  `NOT_CONFIGURED`. O log do Worker, ao chamar
  `https://zuri.exemplo.com.br/api/health`, lista só os **nomes** do que falta,
  nunca os valores (se faltarem as chaves do Turnstile, elas aparecem primeiro;
  corrija e chame de novo).
- `SETUP_CODE` só é preciso enquanto não há senha: sem ele, a instalação nova
  fica em 503 até você gravá-lo.

## Criar o widget do Turnstile

Fora do ambiente local, as duas chaves são **obrigatórias**: sem elas o login
e o primeiro acesso ficam fechados com "falta configurar a verificação contra
robôs". A chave do site é pública, mas fica como segredo para o deploy não
apagá-la.

1. No painel da Cloudflare, abra **Turnstile** e clique em **Add widget**.
2. Nome: `Zuri`. Hostname: só o domínio do Zuri (o mesmo host do
   `PUBLIC_URL`, como `zuri.exemplo.com.br`). Não acrescente outros hosts: o
   Worker recusa um token resolvido em outro host.
3. Modo do widget: **Managed** (a Cloudflare decide quando mostrar o desafio).
4. Pré-autorização (pre-clearance): **desligada**. O Zuri não usa o cookie
   `cf_clearance`.
5. Salve e copie a **Site Key** e a **Secret Key**.
6. Em **Workers e Pages > zuri > Configurações > Variáveis e segredos**,
   acrescente as duas como **Secret** (`TURNSTILE_SITE_KEY` e
   `TURNSTILE_SECRET_KEY`). Pelo terminal, o equivalente é
   `npx wrangler secret put TURNSTILE_SITE_KEY` e
   `npx wrangler secret put TURNSTILE_SECRET_KEY`.
7. Abra `https://zuri.exemplo.com.br/entrar`: o quadro "Confirme que você não
   é um robô" aparece logo abaixo da senha.

Para trocar as chaves (rotação), gere outra Secret Key no mesmo widget
(**Rotate secret key**), grave o novo segredo e faça um deploy. Logins que
estavam com o widget aberto pedem a verificação de novo.

### Chaves de teste

As chaves de teste da Cloudflare (`1x00000000000000000000AA` e
`1x0000000000000000000000000000000AA`) aceitam um token que qualquer pessoa
conhece. O Zuri as usa só no `npm run dev` e nos testes e2e, e **as recusa em
produção**: com elas o login fica fechado como se não houvesse chave.

## Primeiro acesso com o código de instalação

O código de instalação prova que quem abre o primeiro acesso é o dono da conta
na Cloudflare. Ele vale **1 hora**, contada da primeira vez que alguém digita
o código certo, e **uma vez só**. Por isso, grave-o só quando for usar.

1. Gere um código aleatório de 32 a 256 caracteres, com pelo menos 10
   caracteres diferentes (no gerenciador de senhas, ou com
   `openssl rand -base64 32`). Um código fora disso, curto, longo demais ou
   repetitivo (`aaaa…`, `abcabc…`), deixa a API inteira em 503 até você
   trocá-lo.
2. Grave-o como segredo `SETUP_CODE`.
3. Abra `https://zuri.exemplo.com.br/entrar`. Numa instalação nova, a tela
   leva sozinha a `/primeiro-acesso`.
4. **Código.** Cole o código e passe pela verificação contra robôs. Cinco
   tentativas erradas em 15 minutos fazem a sua rede esperar; vinte em 24
   horas bloqueiam a rede até a mais antiga delas completar 24 horas. Uma
   verificação contra robôs que falha também conta. Errar não gasta a hora do
   código.
5. **Seus dados.** Seu nome (opcional, aparece no cumprimento), e-mail, senha
   (15 caracteres ou mais, sem partes previsíveis nem senha que já vazou),
   idioma e fuso. Este formulário fica aberto por até 15 minutos.
6. **Segurança.** Ligue a verificação em duas etapas com um aplicativo
   autenticador. Ela é obrigatória: até ser ligada, nada mais abre, nem
   depois de sair e entrar de novo. Guarde os códigos de recuperação antes de
   tocar em "Já guardei".
7. **Apague o `SETUP_CODE`** do painel. O Início mostra esse lembrete
   enquanto o segredo continuar gravado. O código já está gasto, mas não há
   motivo para deixá-lo lá.

Se os 15 minutos do formulário passarem, a tela diz que o tempo para concluir
acabou: digite o **mesmo** código de novo, que ele ainda vale até completar a
hora. Se a hora toda passar, a tela diz que o código é inválido ou venceu:
grave um código **novo** e comece de novo.

### Recuperar o acesso

Esqueceu a senha? Grave um `SETUP_CODE` **diferente** de todos os anteriores e
abra `https://zuri.exemplo.com.br/primeiro-acesso`. Com o dono já criado, a
tela só recupera o acesso: o código novo, o e-mail cadastrado e uma senha
nova. Os dados e as configurações ficam, todas as sessões terminam, os
navegadores conhecidos são esquecidos e a verificação em duas etapas continua
valendo no login seguinte. Depois, apague o segredo de novo.

Perdeu também o aplicativo autenticador e os códigos de recuperação? Só a
redefinição completa resolve: troque o `PASSWORD_PEPPER` e grave junto um
`SETUP_CODE` novo. O pepper novo apaga a senha e desliga a verificação em duas
etapas e as passkeys; o código recupera o acesso, como acima. Os dados ficam.
Até você ligar a verificação em duas etapas de novo em Configurações, a conta
fica protegida só pela senha, então faça isso logo. Se a instalação ainda tiver
`OWNER_PASSWORD` ou `OWNER_PASSWORD_HASH` gravado, apague-o: com o pepper novo,
esse segredo voltaria a valer como senha.

### Instalações anteriores ao primeiro acesso

Quem já entrava com `OWNER_EMAIL` e `OWNER_PASSWORD` (ou
`OWNER_PASSWORD_HASH`) continua entrando do mesmo jeito: o Zuri trata a
instalação como já tendo dono, e um `SETUP_CODE` ali só recupera o acesso.
Instalação nova não precisa desses segredos. Detalhes em
[arquitetura.md](arquitetura.md#configuração).

### Camada extra (opcional)

Com o Cloudflare Access ligado (`ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`), o
`/primeiro-acesso` fica atrás dele como o resto do Zuri, sem exceção. É
gratuito para uma pessoa e recomendado, mas não obrigatório.

## IP certo no registro de acessos

O registro usa o cabeçalho `CF-Connecting-IP`, que a Cloudflare define na
borda. Para ele trazer o endereço real:

- Em **Rede** (Network), deixe **Pseudo IPv4** em **Off** ou **Add header**.
  Nunca em **Overwrite headers**: essa opção troca o IPv6 do visitante por um
  IPv4 inventado, e o limite de tentativas, que agrupa IPv6 por bloco /64,
  deixaria de reconhecer o mesmo visitante.
- O Zuri só atende pelo domínio próprio (o `workers.dev` fica desligado).

## Proteção extra contra enxurrada (opcional e gratuita)

Cada pedido à API conta nas cotas diárias do plano Free. Uma regra de rate
limiting do WAF (uma é gratuita) segura um robô antes de chegar ao Worker:
em **Segurança > WAF > Regras de limitação de taxa**, crie uma regra para
`/api/` com, por exemplo, 60 pedidos por 10 segundos por IP, ação **Block**.
