# Configuração na Cloudflare

O que o Pablo faz no painel da Cloudflare para o login funcionar com a
verificação contra robôs (Turnstile) e para o registro de acessos guardar o IP
certo. Tudo aqui é gratuito. Nenhum valor real entra no repositório: os
exemplos usam `zuri.exemplo.com.br`.

## Segredos do Worker

Lista completa em [arquitetura.md](arquitetura.md#configuração). Os dois do
Turnstile são novos e, fora do ambiente local, **obrigatórios**: sem eles o
login fica fechado e responde "falta configurar a verificação contra robôs".

| Nome | Onde pegar | Tipo no Worker |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | Chave do site do widget (pública) | segredo (para o deploy não apagar) |
| `TURNSTILE_SECRET_KEY` | Chave secreta do widget | segredo |

## Criar o widget do Turnstile

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
