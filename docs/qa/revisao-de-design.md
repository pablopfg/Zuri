# Revisão de design e UX da interface web

Revisão feita em 31/10/2026 sobre a `develop` (commit `83bd9cf`, depois da casca do Talorys no PR #13), com o pedido do Pablo de uma interface "muito bonita, funcional, rápida, bem organizada, bem trabalhada, moderna, muito segura e inteligente". Depois chegou um segundo pedido: velocidade e os limites do plano Free da Cloudflare passam a ser critério de primeira ordem. Por isso a performance aparece primeiro.

Telas revistas: entrar (senha e segundo passo), início, configurações (Conta, Segurança e as abas "em breve"), troca obrigatória de senha e página não encontrada. Cada uma foi vista nos temas claro e escuro, no computador (1440×900) e no celular (390×844). A barra lateral está com outra thread ("Recolher menu lateral e corrigir CI"), então os achados dela foram para lá, sem correção aqui. Tarefas e Notas (PR #12) foram mescladas durante a revisão: esta branch foi atualizada sobre elas, e os ajustes pedidos pela thread da etapa 6 entraram aqui.

## Como foi medido

- O Worker real (`wrangler dev`) servindo o build de produção da interface, com as variáveis de teste de `tests/e2e/worker.env`.
- Capturas com Playwright (Chromium 1243) antes e depois das correções. Elas ficam nos arquivos do projeto, em `revisao-design/antes` e `revisao-design/depois`, fora do repositório.
- Lighthouse 12.8.2 na tela de entrar, três rodadas no perfil de celular (4G lento simulado, CPU 4× mais lenta) e três no de computador.
- Composição do bundle pelos source maps do Vite.
- Headers lidos com `curl` e violações de CSP capturadas pelo protocolo de depuração do Chromium.

## Números

| Medida | Antes | Depois |
| --- | --- | --- |
| JS inicial (index), minificado, antes do PR #12 | 488,1 KB | 456,0 KB |
| JS inicial, gzip, antes do PR #12 | 151,1 KB | 140,2 KB |
| JS inicial, gzip, com Tarefas e Notas (develop `cbb093c`) | 156,3 KB | 145,0 KB |
| JS inicial, gzip, com o menu recolhível (develop `28da556`) | 174,8 KB | 159,3 KB (com D4) |
| Peso total da tela de entrar | 158 KB | 147 KB |
| JS não usado na tela de entrar (Lighthouse) | 80 KiB | 70 KiB |
| Lighthouse celular: performance | 96 a 98 | 97 a 98 |
| Celular: FCP / LCP / TBT | 1,7–1,8 s / 2,0–2,1 s / 120–150 ms | 1,7 s / 2,0–2,1 s / 90–120 ms |
| Lighthouse computador: performance | 100 | 100 |
| Boas práticas | 93 | 96 |
| Acessibilidade | 100 | 100 |
| Violações de CSP por carga | 1 (`script-src eval`) | 0 |
| Login até o início (servidor local) | 74–119 ms | 78 ms |

A nota de SEO caiu de 91 para 63 de propósito: a página agora pede `noindex`. É um assistente privado de um dono só, e nada dele deve aparecer em buscador.

A regra P11 (`.claude/rules/performance.md`) põe o teto do JS inicial em 160 KB gzip, com meta de 150. A `develop` atual passou do teto (174,8 KB) com os últimos PRs, e este PR a traz para 159,3 KB, abaixo do teto: 11 KB das correções e mais 4,4 KB do D4, que deixou o inglês fora do pacote inicial. O que pesa, pelo código-fonte antes da minificação: `react-dom` (620 KB), `zod` (362 KB), `react-router` (357 KB), `@tanstack/query-core` (140 KB) e os dois catálogos de idioma (21 e 20 KB). Testei separar a tela de entrar e a casca em chunks próprios: o Vite juntou React, zod e a UI num chunk comum que a primeira tela baixa de qualquer jeito, e a soma caiu só uns 3 KB, com uma dúzia de requisições a mais. Não compensou. A alavanca que falta para a meta de 150 é D3 (`zod/mini`).

## Achados por critério

Severidade: **alta** (quebra uso, segurança ou acessibilidade), **média** (atrapalha ou contraria uma regra), **baixa** (acabamento). Status: ✅ corrigido neste PR, 🔀 enviado para a thread dona, 🗳️ decisão do Pablo (lista no fim).

### Rapidez e plano Free

| # | Achado | Sev. | Proposta | Status |
| --- | --- | --- | --- | --- |
| P1 | O código do QR (`qrcode-generator`) e o cartão de 2FA entravam no bundle inicial, apesar do comentário em `App.tsx` dizer que só carregavam nas configurações. Início e lembrete de 2FA importavam `MFA_KEY` de `TwoStepCard.tsx`. | média | Chave e consulta do status de 2FA num módulo próprio (`hooks/mfa.ts`). | ✅ |
| P2 | A biblioteca de passkey (`@simplewebauthn/browser`) carregava com a tela de entrar, e a maioria dos logins nunca usa passkey. | baixa | Import dinâmico no toque em "Entrar com passkey". | ✅ |
| P3 | O zod 4 testa `new Function` no primeiro schema de objeto. A CSP recusa, então cada carga gerava uma violação de CSP e um aviso no painel de problemas, sem ganho nenhum. | média | `config({ jitless: true })` em `packages/shared` antes de qualquer schema. Vale também no Worker, onde o eval também é recusado. | ✅ |
| P4 | `GET /api/auth/session` responde 401 sem sessão. Isso aparece como erro no console em toda abertura da tela de entrar e custa pontos em boas práticas. | baixa | Responder 200 com sessão nula. Muda contrato. | 🔀 thread de performance |
| P5 | A tela inteira depende do JS: com o `#root` vazio, o FCP no 4G lento fica em 1,7 s. | média | D2 na lista de decisões. | 🗳️ |
| P6 | Fontes do sistema, ícones de 0,3 a 15 KB, CSS de 5,7 KB gzip, assets com cache imutável de um ano e `index.html` com `no-cache`. | — | Está bom. Manter. | — |

### Segurança no navegador

| # | Achado | Sev. | Proposta | Status |
| --- | --- | --- | --- | --- |
| S1 | CSP estrita sem `unsafe-inline` nem `unsafe-eval`, `frame-ancestors 'none'`, HSTS, COOP, `nosniff`, `Referrer-Policy` e `Permissions-Policy`, conferidos na resposta real. | — | Está bom. | — |
| S2 | `/robots.txt` caía no fallback da SPA e devolvia o `index.html`. Faltava pedir aos buscadores que não indexem um painel privado. | baixa | `robots.txt` próprio, que deixa os robôs lerem a página, e `<meta name="robots" content="noindex, nofollow">`, que pede para tirá-la do índice. Com `Disallow` o robô nunca leria o `noindex`. Um `X-Robots-Tag` no Worker fica com a thread de performance. | ✅ / 🔀 |
| S3 | No navegador só ficam o tema e o adiamento do lembrete de 2FA (`localStorage`). A senha nunca é guardada, e um e2e já confere isso. | — | Está bom. | — |
| S4 | No celular, "Sair" fica no topo, ao lado do sino, e sai com um toque, sem confirmar. | baixa | Confirmação ("Sair do Zuri?") só no botão do topo do celular. Na barra lateral, "Sair" fica no pé, longe de toque acidental, e continua direto. | ✅ |

### Acessibilidade

| # | Achado | Sev. | Proposta | Status |
| --- | --- | --- | --- | --- |
| A1 | Todas as páginas tinham o mesmo título de aba, "Zuri" (WCAG 2.4.2). Abas, histórico e leitor de tela não as diferenciavam. | média | `PageHeader` nomeia a aba ("Segurança · Configurações · Zuri"). Entrar e a troca obrigatória de senha também. | ✅ |
| A2 | Na atividade de acesso, as recusas se destacavam só pela cor vermelha. | baixa | Ícone de alerta junto do texto. | ✅ |
| A3 | Foco visível, alvos de 44 px, `dialog` nativo, link para pular ao conteúdo e axe sem violações sérias. | — | Está bom. | — |
| A4 | O botão de entrar fica desabilitado até preencher os campos, e quem usa leitor de tela não fica sabendo por quê. | baixa | D6. | 🗳️ |

### Visual, hierarquia e consistência com o Talorys

| # | Achado | Sev. | Proposta | Status |
| --- | --- | --- | --- | --- |
| V1 | Paleta "Sinal" coerente nos dois temas, contraste AA, cartões e raios consistentes. A identidade está madura. | — | Manter. | — |
| V2 | A página não encontrada tinha um `h1` solto, fora do `PageHeader`, com peso e espaçamento diferentes das outras páginas. | baixa | Usar `PageHeader`. | ✅ |
| V3 | No celular, o seletor de tema quebrava "Escuro" sozinho numa segunda linha. | baixa | Três colunas iguais no celular, com ícone em cima. | ✅ |
| V4 | Os campos de senha não tinham botão de mostrar, que o Talorys tem. Frases-senha longas (15+ caracteres) são fáceis de errar sem ver. | média | `PasswordField` com mostrar e ocultar no login, na troca de senha e na troca obrigatória. | ✅ |
| V5 | A tela de entrar é correta, mas sem nada que chame atenção: falta a entrada suave e os ícones nos campos que o Talorys usa. | baixa | D5. | 🗳️ |
| V6 | O Talorys tem toasts para confirmar ações; o Zuri deixa um "Salvo" fixo embaixo do cartão, que só some ao recarregar. | baixa | D7. | 🗳️ |

### Organização e textos

| # | Achado | Sev. | Proposta | Status |
| --- | --- | --- | --- | --- |
| O1 | Textos visíveis citavam números internos de etapa ("chegam na etapa 8", "etapa 20"). Isso não significa nada para quem usa. | média | Texto sem número de etapa nas abas IA, Avisos, Integrações, Dados e no "Em breve" de Segurança. | ✅ |
| O2 | Com a 2FA desligada, o cartão de passkeys mostrava "Nenhuma passkey, adicione uma" e logo abaixo dizia que não dava para adicionar. | baixa | Só o aviso do motivo enquanto a 2FA estiver desligada. | ✅ |
| O3 | No celular, as seis abas de configurações passam da largura da tela, e nada indica que dá para rolar ("Integrações" e "Dados" ficam escondidas). | média | D8. | 🗳️ |
| O4 | O fuso horário é um `select` nativo com uns 420 itens, sem busca. | baixa | Campo com busca. Entra junto com D1. | 🗳️ |

### Inteligência

| # | Achado | Sev. | Proposta | Status |
| --- | --- | --- | --- | --- |
| I1 | Não há atalhos de teclado nem busca global. | média | D1. | 🗳️ |
| I2 | O início diz só "Olá! Este é o seu Zuri." | baixa | Saudação pela hora e um resumo do dia quando chegarem tarefas e chat. A saudação pelo horário e pelo nome entrou em 31/10/2026; o resumo do dia fica para a etapa 9. | ✅ |
| I3 | Os estados vazios explicam o que falta, mas nem sempre oferecem a ação. | baixa | Botão "Nova nota" na lista de notas vazia. Em Tarefas a adição rápida já fica logo acima do vazio. | ✅ |

## Decisões para o Pablo (em ordem de prioridade)

Cada item traz a recomendação. Nenhum foi feito porque muda o que você vê ou exige uma mudança grande.

1. **D1 · ✅ aprovado pelo Pablo, feito no PR seguinte ao #27 · Paleta de comandos (Ctrl/⌘ K) com busca global e atalhos.** Recomendo fazer quando Tarefas e Notas entrarem: buscar tarefas, notas e configurações e criar uma tarefa sem tirar a mão do teclado. Carrega sob demanda, sem peso no bundle inicial.
2. **D2 · Casca estática no `index.html`.** ✅ Aprovado pelo Pablo e feito no PR seguinte ao #20. Desenhar logo e fundo em HTML/CSS puros antes do JS, para o primeiro desenho no celular não esperar os 140 KB de JS (hoje 1,7 s; o ganho é estimativa, ainda não medido). Recomendo: é barato, não muda o visual e respeita a CSP (CSS externo, sem script inline).
3. **D3 · `zod/mini`.** Feito em PR próprio: o JS inicial foi de 157,7 para 139,9 KB, abaixo da meta de 150. Não precisou reescrever todos os schemas. Só os cinco que a interface usa em tempo de execução (sessão, segundo passo, opções de login, atividade de acesso e erro da API, com os dois sub-schemas deles) passaram para o mini; os outros ganharam `/* @__PURE__ */`, e o bundler os descarta da interface. O Worker continua com o zod clássico. Um teste novo (`packages/shared/test/wire-schemas.test.ts`) confere as bordas, e passa igual com as versões antigas e as novas. `npm run size` agora falha se o zod clássico voltar ao primeiro carregamento.
4. **D4 · Carregar só o idioma em uso.** ✅ Feito neste PR, com o aval do coordenador dentro do pedido de velocidade do Pablo. O inglês virou um chunk de 6,1 KB gzip que só baixa quando o navegador ou as configurações pedem inglês. A troca de idioma espera o catálogo chegar, sem piscar chaves. Sem rede, o app fica em pt-BR. O Worker continua com os dois catálogos.
5. **D5 · Tela de entrar mais marcante.** ✅ Aprovado; primeira versão (cartão, ícones, brilho, entrada suave) no PR seguinte ao #20, e o Pablo pediu 3 modelos para escolher o visual final; escolheu o B · Painel (marca à esquerda, formulário à direita; no celular, marca no topo), aplicado no PR #24. Entrada suave (respeitando "reduzir movimento"), ícones nos campos e o sinal verde pulsando enquanto confere. Recomendo, porque é a primeira impressão.
6. **D6 · Botão de entrar sempre ativo.** ✅ Aprovado e feito no PR seguinte ao #20. Com campo vazio, mostrar o erro no próprio campo em vez de travar o botão. Recomendo.
7. **D7 · ✅ aprovado pelo Pablo, feito no PR seguinte ao #24 · Toasts para confirmações** ("Salvo", "Passkey criada"), como no Talorys, no lugar das linhas fixas. Recomendo, num componente único.
8. **D8 · ✅ aprovado pelo Pablo, feito (opção A) no PR seguinte ao #24 · Abas de configurações no celular.** Opção A: uma lista de seções que abre cada uma numa tela (padrão de app). Opção B: manter as abas com uma sombra na borda que indica rolagem. Recomendo a A.

## Achados nas áreas com PR aberto (enviados às threads donas)

Barra lateral e casca (o PR #14 foi mesclado durante a revisão, e os dois pontos voltaram para cá):

- "Sair" com um toque no topo do celular: corrigido aqui (S4).
- No celular, barra superior, lembrete de 2FA em três linhas e navegação inferior ocupavam cerca de 30% da altura. Corrigido aqui: no celular o lembrete cabe numa linha ("Duas etapas desligadas", "Ligar agora" e um X para lembrar depois), e o leitor de tela continua ouvindo a frase inteira.
- A navegação inferior tem poucos itens. Quando as seções crescerem (a thread de segurança do login vai pôr Segurança/Acessos), limitar a cinco e pôr um "Mais".

Tarefas e Notas (etapa 6, já na develop), respondido pela thread dona:

- Tarefas e Notas usam `PageHeader` e já ganham o título da aba.
- O estado das tarefas não depende só da cor: atrasada tem texto e ícone, concluída tem ícone, risco e nome acessível.
- `/tarefas` e `/notas` já carregam sob demanda.
- Nota: o chunk de Notas tem 52 KB gzip (Markdown com `react-markdown` e `remark-gfm`). Só baixa ao abrir Notas, mas é o maior da aplicação e vale entrar na conta do orçamento da thread de performance.

## QA e auditoria das correções

Revisão de QA e auditoria de segurança independentes, sobre o diff deste PR. Nenhum achado alto. Os dois médios estavam no botão de mostrar senha e foram corrigidos:

- Corrigido: a senha mostrada continuava visível depois de uma recusa e no envio. Agora o campo volta a ficar oculto quando o formulário é enviado, e o navegador guarda o valor como senha, não no histórico de formulário (teste e2e).
- Corrigido: `autoCorrect="off"` no campo, para o iPhone não corrigir as palavras de uma frase-senha visível. O botão também fica desligado quando o campo está, e o olho próprio do Edge (`::-ms-reveal`) foi escondido.
- Corrigido: a biblioteca de passkey começa a baixar quando o segundo passo oferece passkey, e o toque não espera o download.
- Corrigido: o título da aba volta a "Zuri" nas telas sem título próprio (carregando, erro de sessão).
- Coberto por teste: o pacote inicial não traz o código do QR nem o da passkey, e a troca obrigatória de senha também nomeia a aba.
- Ficou sem mudança (baixo): depois de um deploy, uma aba antiga que tenta passkey recebe erro genérico até recarregar, porque o chunk antigo não existe mais. Código e códigos de recuperação continuam funcionando.
- Ficou sem mudança (baixo): os e2e já gastam 2 das 3 senhas erradas que o limitador aceita da rede local em 15 minutos. Um teste novo com senha errada precisa juntar-se a um dos que já existem.
