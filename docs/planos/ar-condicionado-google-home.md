# Estudo · Ligar o ar-condicionado quando há compromisso no dia

Situação: estudo de viabilidade, sem código. Esperando o Pablo (marca do ar e
se há Home Assistant em casa).
Origem: pedido do Pablo em 03/11/2026: "uma rotina que verifica se temos
agendamentos hoje no calendário e em seguida solicita autorização pelo
Telegram para ligar o ar-condicionado via Google Home. É possível?"
Dependências: etapa 19 (Google Agenda), 15b/16a (Telegram e aprovações), 18a/18b
(MCP como cliente) e a autonomia por ferramenta (#120). Todas mescladas.

## 1. Resposta curta

**Sim, é possível, e quase tudo já existe no Zuri.** A parte que falta é a
ponte até o ar-condicionado, e ela **não deve ser o Google Home direto**: o
Google não oferece hoje um jeito gratuito e oficial de um servidor ligar um
aparelho comum que está no Google Home. O caminho recomendado é o
**Home Assistant** (grátis, roda num computador da casa), ligado ao Zuri como
**servidor MCP**. A rotina das manhãs lê a agenda; se houver compromisso, a
Zuri prepara a ação "ligar o ar" e ela vira uma **proposta com botão Aprovar no
Telegram**, que é exatamente o fluxo que já funciona para as outras
ferramentas MCP.

O ar continua aparecendo no Google Home normalmente; o Home Assistant só passa
a ser o caminho por onde a Zuri fala com ele.

## 2. O que o Zuri já tem para isso

| Peça | Onde está | Serve para |
| --- | --- | --- |
| Rotinas agendadas com IA e ferramentas de leitura | `apps/agent/src/automations/executor.ts` (`routine`) | "Todo dia às 7h, veja a agenda de hoje" |
| Leitura da Google Agenda como ferramenta | `apps/agent/src/tools/calendar.ts`, `apps/agent/src/google/service.ts` | Saber se há compromisso hoje, no fuso do dono |
| Resposta silenciosa quando não há nada a dizer | `automation.sentinel` / `isQuietAnswer` no executor | Dia sem compromisso não manda mensagem |
| MCP só como cliente, com orçamento por rotina | `apps/agent/src/mcp/`, `ROUTINE_MCP_BUDGET` = 12 | Chamar a ferramenta "ligar" do Home Assistant |
| Autonomia por ferramenta ("Perguntar sempre" é o padrão) | `apps/agent/src/mcp/classify.ts`, decisão #120 | "Ligar o ar" é classificada como Altera dados e vira proposta |
| Aprovar proposta MCP pelo Telegram | `apps/agent/src/telegram/approvals.ts` (`#external`) | O botão Aprovar mostra o servidor, a ferramenta e os argumentos exatos; recusa se algo mudou (409/410/423) |
| Bloqueio de emergência | `auth.lockdown.active()`; o executor pula a rotina | Nada externo roda durante o bloqueio |
| Motor de fluxos com conexões de métodos marcados | `apps/agent/src/flows/` (etapa 22a) | Alternativa sem IA, mas hoje **sem passo de aprovação** (ver 5.2) |

## 3. As opções avaliadas

Critérios: funciona com um ar-condicionado comum; custo (plano gratuito, nada
pago sem ⚠); segurança (credencial como segredo cifrado, chamada só para
serviço cadastrado, nada de HTTP livre); confiabilidade; esforço no Zuri.

| Opção | Ar comum? | Custo | Segurança | Confiável? | Esforço no Zuri | Veredito |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Google Home APIs** (Device, Structure, Automation) | Sim, no app | Grátis | Boa | Boa | **Inviável**: só existem como SDK de app Android e iOS, sem acesso por servidor | ❌ |
| **B. Smart Device Management (Device Access)** | **Não**: só termostatos, câmeras e campainhas Nest e o Nest Hub Max | ⚠ taxa única de US$ 5 por conta | Boa (OAuth do Google) | Boa | Médio | ❌ para ar comum |
| **C. Cloud-to-cloud / Home Graph** | — | — | — | — | É para fabricantes publicarem aparelhos no Google, não para controlar os próprios | ❌ |
| **D. Automações e rotinas do app Google Home** | Sim | Grátis | — | Boa | **Inviável**: o gatilho é hora, presença ou estado de aparelho; não há gatilho por HTTP, nem por agenda, nem chamada externa | ❌ (só como apoio, ver 5.3) |
| **E. Google Home MCP oficial** (`home.googleapis.com/mcp`) | Provável (aparelhos do Google Home; traits marcados como experimentais podem falhar) | ⚠ exige **Google Home Premium Advanced** (US$ 20/mês nos EUA); não achei oferta no Brasil | Boa, mas pede cliente OAuth **confidencial** com segredo, e o MCP do Zuri usa cliente público com registro dinâmico | Acesso antecipado, sujeito a mudança | Médio (novo modo de login no MCP) | ⏸ reavaliar quando chegar ao Brasil sem custo |
| **F. API não oficial do Google Home** (projetos que usam o "master token" da conta) | Sim | Grátis | **Péssima**: o token dá acesso à conta Google inteira e viola os termos | Quebra sem aviso | Baixo | ❌ rejeitada |
| **G. Home Assistant + servidor MCP dele** | **Sim**, por três caminhos (ver 4.1) | Grátis (precisa de um computador ligado em casa); acesso de fora grátis por túnel ⚠ ou pago pela Nabu Casa ⚠ | Boa: token cifrado no Zuri, só as entidades expostas, ação sempre aprovada | Boa (roda em casa; o ar responde mesmo com a internet do Google instável, se o aparelho for local) | **Baixo**: usa o que já existe; um ajuste pequeno no login (ver 5.1) | ✅ **recomendada** |
| **H. API do fabricante direto pelo motor de fluxos** (SmartThings, LG ThinQ, Tuya, Sensibo, Midea) | Sim, se a marca tiver API | Varia: Tuya é teste gratuito renovável a cada 6 meses; Sensibo é um aparelho a comprar | Boa como conexão cadastrada | Varia por marca; SmartThings troca o token a cada 24 h com refresh de uso único, que o motor de fluxos ainda não sabe renovar | Médio, e um caso por marca | ⏸ só se não houver Home Assistant |
| **I. Controle infravermelho** (Broadlink, Tuya IR, Sensibo) | Sim, qualquer ar com controle remoto | Aparelho de R$ 80 a R$ 600 | Igual à G ou H | Boa, mas o comando é "às cegas" (não sabe se o ar já estava ligado) | Entra pela G | ✅ como complemento da G para ar sem Wi-Fi |

Fontes: [Google Home APIs](https://developers.home.google.com/apis) (Android e
iOS), [Device Access](https://developers.home.google.com/device-access/get-started)
(taxa e aparelhos), [Google Home MCP](https://developers.home.google.com/mcp/home)
e [referência](https://developers.home.google.com/reference/home/mcp),
[TechCrunch, 16/09/2026](https://techcrunch.com/2026/09/16/your-ai-agents-can-now-control-your-google-home-devices/),
[Home Assistant MCP Server](https://www.home-assistant.io/integrations/mcp_server/),
[Google Assistant SDK no Home Assistant](https://www.home-assistant.io/actions/google_assistant_sdk.send_text_command/),
[SmartThings, tokens](https://developer.smartthings.com/docs/getting-started/authorization-and-permissions),
[Tuya, fim do teste](https://support.tuya.com/en/help/_detail/K9zsoru2a6r0y),
[Nabu Casa, preço](https://support.nabucasa.com/hc/en-us/articles/26179687501341-How-much-does-a-Home-Assistant-Cloud-subscription-cost).

## 4. Caminho recomendado (G)

### 4.1 Como o ar entra no Home Assistant

Depende de como ele está no Google Home hoje (pergunta 1 da seção 8):

1. **Ar com Wi-Fi de marca que o Home Assistant conhece** (LG ThinQ, Samsung
   SmartThings, Midea, Gree, Daikin, Tuya/Smart Life e outros): integração
   oficial ou da comunidade. É o mais confiável e mostra o estado real.
2. **Ar ligado por controle infravermelho** (Broadlink, Tuya IR, Sensibo):
   integração do aparelho no Home Assistant, que manda o mesmo sinal do
   controle remoto.
3. **Ar que só existe dentro do Google Home** (nenhuma das acima): integração
   oficial **Google Assistant SDK** do Home Assistant, que manda um comando de
   texto ao Google ("ligar o ar do quarto") como se fosse falado. Grátis, usa
   um projeto do Google Cloud, mas é o menos confiável: depende do nome do
   aparelho e da frase, e não devolve o estado.

### 4.2 Como o Zuri alcança o Home Assistant

- O Zuri roda na Cloudflare e **não alcança a rede da casa**; ele também recusa
  endereço privado (`apps/agent/src/mcp/url.ts`, `private_address`). O Home
  Assistant precisa de um endereço https público.
- **Cloudflare Tunnel** (programa `cloudflared` no computador da casa): sem
  custo, sem abrir porta no roteador. É recurso novo da conta, então ⚠ precisa
  do OK do Pablo, mesmo sem cobrança. Recomendado.
- **Nabu Casa (Home Assistant Cloud)**: ⚠ pago (cerca de US$ 6,50/mês ou
  US$ 65/ano, preço varia por país). Mais simples de ligar.
- No Home Assistant: ligar a integração "Model Context Protocol Server",
  expor **só o ar** ao assistente (Configurações → Assistentes de voz →
  Expor), e criar um usuário próprio para a Zuri.

### 4.3 A rotina

Rotina diária às 7h (hora e dias ajustáveis), resposta silenciosa ligada,
com o texto:

> Veja os compromissos de hoje na minha agenda principal. Se houver pelo menos
> um com horário, ligue o ar-condicionado do escritório em 23 °C. Se não houver,
> não diga nada.

O que acontece:

1. A rotina lê a agenda pela ferramenta de leitura.
2. Dia sem compromisso: nenhuma mensagem.
3. Dia com compromisso: a Zuri chama a ferramenta do Home Assistant. Como a
   ferramenta está em "Perguntar sempre", vira proposta e chega no Telegram:
   "Ligar o ar-condicionado (Home Assistant, casa.exemplo.com.br)" com os
   argumentos exatos e os botões **Aprovar** e **Recusar**.
4. Aprovou: o Zuri faz a chamada e mostra a resposta do Home Assistant.
   Recusou ou deixou vencer: nada acontece.

Segurança herdada sem esforço: credencial cifrada com `MCP_CREDENTIAL_KEY`,
chamada só para o servidor cadastrado, resposta do Home Assistant tratada como
dado (`<data>`), definição da ferramenta mudou → volta a "Perguntar sempre",
proposta presa aos argumentos exatos, nada roda no bloqueio.

## 5. O que falta no Zuri (pequeno)

### 5.1 Login no servidor MCP do Home Assistant

O Home Assistant faz OAuth com PKCE e **Client ID Metadata Document**, e diz
que **não aceita registro dinâmico**. O MCP do Zuri (18b) só faz registro
dinâmico ou token fixo. Duas saídas:

- **Token fixo** (token de longa duração do usuário da Zuri no Home Assistant,
  colado na tela de Integrações): sem código novo, **se** o `/api/mcp` aceitar
  esse token como Bearer, que é como as APIs do Home Assistant funcionam, mas a
  página da integração não confirma. Primeiro passo: testar.
- **Suporte a Client ID Metadata Document** no login MCP: PR pequena e útil
  para outros servidores, com teste e auditoria (mexe em OAuth).

### 5.2 Prazo da proposta

Proposta de rotina vence em 24 h. Para o ar, uma aprovação ao meio-dia de algo
pensado para as 7h não faz sentido. Ajuste sugerido: prazo por rotina (por
exemplo 2 h), com o mínimo e o máximo testados. Só muda limite, sem tela nova.

### 5.3 Alternativas para depois

- **Sem IA (determinística), na etapa 22c**: nó "Agenda de hoje" no motor de
  fluxos mais um passo novo "Pedir aprovação no Telegram" antes do `request`
  ao Home Assistant. Não gasta Neurons e não depende da leitura do modelo.
  Hoje o motor de fluxos grava sem perguntar (decisão da 22a), então essa
  versão precisa do passo de aprovação, que ainda não existe.
- **Apoio pelo próprio Google Home**: se o Pablo quiser manter a lógica do ar
  (temperatura, modo, desligar depois de X horas) no app do Google, o Home
  Assistant pode expor ao Google um interruptor virtual que a Zuri liga e que
  dispara uma automação do Google Home. É mais peças e só vale se a lógica já
  estiver pronta lá.

## 6. Custo e cotas

- Uma rotina por dia: 1 execução de IA agendada (dentro de
  `aiScheduledRunsPerDay`), uma leitura da agenda (cota de rotinas do
  GoogleMeter) e até 2 subrequisições MCP (das 12 da rotina). Desprezível no
  plano Free.
- Nada pago no Zuri. Fora dele: computador da casa (já existente ou um
  Raspberry Pi), túnel ⚠ (grátis) ou Nabu Casa ⚠ (pago), aparelho
  infravermelho se o ar não tiver Wi-Fi.

## 7. Riscos

| Risco | Efeito | Mitigação |
| --- | --- | --- |
| A IA lê a agenda errado | Pede para ligar num dia sem compromisso, ou não pede | Sempre passa pela aprovação; versão determinística na 22c |
| Computador da casa ou túnel fora do ar | A aprovação falha | O Zuri já mostra o erro do servidor no Telegram |
| Comando por texto ao Google (4.1, caminho 3) muda de frase | Ar não liga | Preferir integração do fabricante ou infravermelho |
| Expor o Home Assistant à internet | Superfície de ataque em casa | Túnel sem porta aberta, usuário só para a Zuri, só o ar exposto, 2FA no Home Assistant |
| Token do Home Assistant vazar | Controle das entidades expostas | Cifrado no Zuri, nunca no navegador nem no log; revogável no Home Assistant |

## 8. Perguntas ao Pablo

1. **Qual a marca e o modelo do ar, e como ele aparece no Google Home?** (app
   do fabricante, controle infravermelho tipo Broadlink/Tuya, ou outro).
   Recomendação: se tiver Wi-Fi de marca conhecida, integração direta no Home
   Assistant.
2. **Você já usa Home Assistant, ou tem um computador ligado 24 h em casa?**
   Recomendação: Home Assistant num Raspberry Pi ou mini PC, acessado por
   Cloudflare Tunnel (⚠ recurso novo, sem custo).
3. **Prefere começar já pela rotina com IA (seção 4) ou esperar a versão sem
   IA da 22c?** Recomendação: começar pela rotina, que só precisa do teste do
   token (5.1) e do prazo curto (5.2).

## 9. Próximos passos sugeridos

1. Pablo responde as perguntas e instala o Home Assistant com o ar.
2. Teste manual do token fixo no `/api/mcp` cadastrando o servidor na tela de
   Integrações.
3. Se o token não servir: PR `feat` de Client ID Metadata Document no login MCP.
4. PR `feat` do prazo por rotina (5.2).
5. Na 22c: nó de agenda e passo de aprovação no motor de fluxos.
