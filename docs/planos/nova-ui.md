# Plano · Nova moldura da interface (cinco propostas)

Situação: moldura escolhida em 03/11/2026 (A, sem projetos, recentes em Conversa); rodada 3 com oito paletas de conforto e a logomarca atual; esperando o Pablo escolher a paleta
Origem: pedido do Pablo em 03/11/2026, com a barra lateral do ChatGPT como referência
Dependências: nenhuma para escolher. A implementação espera a etapa 18 sair da `AppShell` (outra thread mexe no app agora).

## 1. Resumo

O Pablo quer uma organização parecida com a do ChatGPT: busca à mão, menu que recolhe, seções, conversas recentes e a conta no rodapé. Este plano traz cinco propostas para a moldura da Zuri (menu, barra do topo, busca, avisos e conta), todas com a mesma marca e os mesmos dados de exemplo, para comparar lado a lado. Nada no app muda até o Pablo escolher uma, ou uma mistura. O protótipo navegável está em `docs/planos/propostas-ui/index.html` e as capturas em `docs/capturas/pr/propostas-ui/`.

## 2. Contexto no sistema

- Moldura de hoje: `apps/web/src/components/AppShell.tsx`. Barra lateral de 240 px que recolhe para 72 px (`lib/sidebar.ts` guarda a escolha), botão Buscar com Ctrl/⌘ K, sete seções, rodapé com Recolher, Configurações, Sair e versão. No celular: barra do topo com busca, sino, engrenagem e sair, e barra de baixo com cinco seções.
- Paleta Ctrl/⌘ K: `components/CommandPalette.tsx`, carregada só quando abre (regra P11).
- Avisos: `components/NotificationCenter.tsx`. Toasts no pé: `components/Toaster.tsx`.
- Conversas já têm lista paginada (`GET /conversations`, usada em `pages/chat/ChatPage.tsx`), então "Recentes" não precisa de rota nova.
- Decisões que valem aqui (`.claude/memoria/decisoes.md`, 31/10/2026): D1 paleta Ctrl/⌘ K, D2 casca estática, D7 toasts, D8 Configurações em lista no celular, identidade Sinal, teto de JS inicial.
- A Início de hoje ainda mostra "A conversa com a Zuri chega em breve", que ficou velho desde a etapa 8. Todas as propostas trocam esse bloco por um campo para falar com a Zuri e pelo resumo do dia.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Cinco propostas distintas, cada uma com capturas de computador e celular, claro e escuro | Pablo |
| CA2 | Cada proposta tem busca à mão, forma de recolher ou esconder o menu, seções, recentes e conta | Pablo (referência do ChatGPT) |
| CA3 | Textos de campos, botões, avisos, estados vazio e erro revisados para não soarem como texto de IA | Pablo |
| CA4 | Protótipo navegável com dados de exemplo, sem mudar o app | coordenador |
| CA5 | Cada proposta diz o impacto em acessibilidade e no teto de JS inicial | plano |
| CA6 (novo) | Protótipo sem violações do axe (WCAG 2.1 AA e boas práticas) nas cinco propostas, computador e celular, dois temas, quatro telas | plano |

## 4. Escopo

**Entra:**

- Protótipo em HTML estático, um arquivo, sem dependências, em `docs/planos/propostas-ui/index.html`.
- 25 capturas: as 20 do padrão (5 × computador/celular × claro/escuro) e 5 de estados que importam (menu recolhido, gaveta no celular, painel de conversas, busca com pergunta, conversa rápida).
- Este plano, com a recomendação.

**Fica fora (e onde vai parar):**

- Mudar `AppShell.tsx` e as telas → PR seguinte, depois da escolha do Pablo e da etapa 18.
- Conteúdo de Memória, Automações, Acessos e Configurações → continua igual; o protótipo mostra só a moldura nessas telas.
- Revisão completa dos textos do app → etapa 26 (`docs/planos/revisao-de-textos-e-experiencia.md`). Aqui entram só os textos da moldura e da Início.

## 5. Como funciona para o Pablo

Abra `docs/planos/propostas-ui/index.html` no navegador (ou o link publicado na conversa). A barra escura do topo troca de proposta e de tema. Tudo é clicável: seções, busca (Ctrl K), sino, conta, recolher o menu, marcar tarefa (gera um toast com Desfazer). A tela Notas passa pelo erro, pelo carregando e pelo vazio. No celular, a mesma página mostra o layout de celular.

Comum às cinco propostas:

- Busca: a paleta Ctrl/⌘ K atual ganha a opção "Perguntar à Zuri: <texto>" quando o texto parece uma frase. Setas escolhem, Enter abre, Esc fecha.
- Conta: o avatar (inicial do nome) abre Configurações, Acessos e segurança, Tema, Sair e a versão. "Sair" sai do lugar onde o polegar erra no celular.
- Início: saudação com o resumo do dia em uma frase, campo para falar com a Zuri, "Para hoje" e "Vem aí".
- Teclado e leitor de tela: link "Pular para o conteúdo" mantido, `aria-current` na seção ativa, `aria-expanded` em tudo que abre e fecha, Esc fecha qualquer camada.

### Proposta A · Lateral clássica (a mais parecida com o ChatGPT)

Barra lateral de 268 px com a marca, a lupa e o botão de recolher no topo; "Nova conversa" em destaque; Início, Tarefas, Notas, Memória e Automações; grupos que abrem e fecham para Projetos e Recentes (conversas); a conta no rodapé. Recolhida, vira um trilho de 68 px só com ícones. No celular, não há barra de baixo: o botão de menu abre a lateral como gaveta, e o topo tem o nome da tela, o sino e "Nova conversa".

- Prós: é o padrão que o Pablo já usa todo dia; recentes e projetos ficam a um clique; libera a barra de baixo do celular.
- Contras: no celular toda troca de seção custa dois toques; a lista de recentes pede uma consulta a mais quando o app abre.
- Acessibilidade: gaveta precisa prender o foco e devolver ao botão ao fechar; no trilho recolhido, cada ícone mantém nome acessível e dica.
- JS inicial: estimo +2,5 a 3,5 kB gzip (quatro ícones novos, grupos, menu da conta e a consulta de recentes). Dá para trazer para perto de +0,8 kB carregando Recentes e o menu da conta sob demanda. Passa do teto de 139,1 kB nos dois casos.

### Proposta B · Trilho e painel

Trilho escuro de 76 px com ícone e nome de cada seção, e um painel de 272 px que muda com a seção: atalhos e conversas recentes na Início, busca e lista na Conversa, filtros (Hoje, Próximos 7 dias, Atrasadas, Concluídas) e projetos em Tarefas. O painel esconde com um botão. No celular, barra de baixo com Início, Conversa, Tarefas, Notas e Mais, e atalhos rápidos em pílulas no topo da Início.

- Prós: cada seção ganha a navegação que precisa; o trilho nunca some, então a troca é sempre um clique; o celular fica parecido com o de hoje.
- Contras: duas colunas fixas tiram 348 px da tela; o painel de cada seção é trabalho novo em cada tela.
- Acessibilidade: o trilho e o painel são dois `nav`/`aside` com nomes diferentes; textos de 11 px no trilho precisam de contraste alto (passam no axe).
- JS inicial: estimo +0,3 a 0,6 kB. O conteúdo do painel vem junto com o pacote de cada tela, que já é carregado sob demanda. É a que menos pesa.

### Proposta C · Busca no centro

Sem barra lateral fixa. O topo tem o menu (abre uma gaveta com as oito seções), a marca, uma busca larga "Pergunte à Zuri ou procure qualquer coisa", o sino e a conta. A Início vira uma página de começo: "Boa noite, Ana. Por onde começamos?", um campo grande e sugestões prontas. No celular, uma pílula fixa no pé "Pergunte ou procure" abre a busca.

- Prós: a tela mais limpa das cinco; deixa a conversa com a Zuri no centro de tudo; boa no celular, com o polegar perto da busca.
- Contras: seções ficam escondidas atrás do menu e da busca; quem prefere clicar a digitar sente falta da lista sempre visível.
- Acessibilidade: a busca vira o caminho principal, então a paleta precisa ser impecável no leitor de tela (`combobox` com `aria-activedescendant`, já no protótipo).
- JS inicial: estimo de −0,5 a 0 kB. Some a lateral do pacote inicial, e o que é novo fica na paleta, que já é sob demanda. Cabe no teto.

### Proposta D · Polegar primeiro

Pensada a partir do celular: barra de baixo com Início, Tarefas, um botão central da Zuri, Notas e Mais (que abre uma folha com o resto e Sair). O botão central abre uma conversa rápida por cima de qualquer tela. No computador, as seções viram abas no topo, com "Mais" num menu, busca compacta, sino e conta, e um botão "Falar com a Zuri" fixo no canto.

- Prós: falar com a Zuri fica a um toque de qualquer tela; a Início ganha números do dia em destaque; no computador sobra a largura toda para o conteúdo.
- Contras: abas no topo do computador cabem poucas seções (Memória, Automações e Acessos ficam em "Mais"); não há lugar natural para recentes no computador.
- Acessibilidade: a conversa rápida é um diálogo modal (foco preso, Esc fecha); o botão central precisa de nome claro ("Zuri" visível e no leitor).
- JS inicial: estimo +0,5 a 1 kB, com a conversa rápida e a folha "Mais" carregadas sob demanda.

### Proposta E · Compacta por grupos

Lateral de 240 px com linhas mais baixas (34 px) e seções em grupos que abrem e fecham: Dia a dia, Memória e rotinas, Conta, e Conversas recentes (fechado, com o número ao lado). Contadores mostram o que pede atenção (tarefas de hoje, automações do dia). A Início tem uma faixa de números curtos. No celular, as oito seções viram pílulas que rolam de lado logo abaixo do topo.

- Prós: mostra mais coisa sem rolar; os contadores avisam sem abrir a tela; cresce bem quando vierem CRM e contatos (etapas 22).
- Contras: mais densa, cansa mais em tela pequena; pílulas que rolam de lado escondem seções no celular.
- Acessibilidade: linhas de 34 px passam no mínimo de 24 px do WCAG 2.2, mas no celular voltam para 44 px; contadores precisam de texto acessível ("3 para hoje").
- JS inicial: estimo +1 a 1,5 kB (grupos, contadores e a consulta das contagens).

### Comparação

| | A Lateral clássica | B Trilho e painel | C Busca no centro | D Polegar primeiro | E Compacta |
| --- | --- | --- | --- | --- | --- |
| Parecida com o ChatGPT | muito | média | pouco | pouco | média |
| Recentes à vista | sim | sim (Início e Conversa) | só na Início | não | sim (grupo) |
| Celular | gaveta | barra de baixo | pílula de busca | barra com botão da Zuri | pílulas no topo |
| JS inicial (estimativa) | +0,8 a 3,5 kB | +0,3 a 0,6 kB | −0,5 a 0 kB | +0,5 a 1 kB | +1 a 1,5 kB |
| Trabalho | médio | alto | médio | médio | médio |

### Recomendação

A, com duas peças de outras: a busca com "Perguntar à Zuri" da C e a barra de baixo do celular da B no lugar da gaveta. Fica o que o Pablo pediu (lateral do ChatGPT no computador) e o celular não perde a troca de seção em um toque. Para caber no teto, Recentes e o menu da conta entram sob demanda; mesmo assim deve passar uns 0,8 kB do teto, e isso precisa do OK do Pablo.

### Rodada 2 · sete modelos visuais da proposta A

O Pablo escolheu a A em 03/11/2026, com duas mudanças: sem o grupo Projetos e com as conversas recentes dentro da tela Conversa (lista à esquerda, agrupada por Hoje, Ontem, Esta semana e Mais antigas, com busca própria). No celular, a lista abre primeiro e a conversa abre por cima, com botão de voltar.

Protótipo: `docs/planos/propostas-ui/modelos.html` (a barra do topo troca o modelo e o tema). Capturas em `docs/capturas/pr/propostas-ui/modelos/`, incluindo `mosaico-claro.png` e `mosaico-escuro.png` com os sete lado a lado.

O que mudou em relação à A da primeira rodada, em todos os modelos:

- Ícones próprios, desenhados na mesma grade de 24 px, com espessura de traço por modelo e versão preenchida (duotom) em um deles. Saem os ícones da lucide na moldura.
- Um logo por modelo, todos com a mesma ideia de símbolo simples num quadro, para funcionar de 16 px (aba do navegador) a 512 px (ícone do app).
- "Nova conversa" virou o botão cheio da lateral; a conta no rodapé mostra nome e "Conta e ajustes"; Configurações sai da lista e fica no menu da conta, como no ChatGPT.
- Início: data num selo, saudação maior, campo para falar com a Zuri com sugestões prontas, "Para hoje" com etiqueta do projeto, "Vem aí" como linha do tempo.
- Paletas montadas como nas Radix Colors e no sistema de cores da Atlassian: um cinza puxado para o matiz do destaque e um par claro/escuro escolhido junto, nunca um tema invertido do outro. Um único destaque por modelo; vermelho só para atraso e erro.

| Nº | Modelo | Destaque (claro / escuro) | Neutro | Fonte | Raio | Ícones | Lateral | Logo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Sinal | verde `#2a7e3b` / `#46a758` | grafite | Geist | 12 px | traço 1,75 | clara | o "i" com o sinal verde de hoje |
| 2 | Lagoa | verde-água `#008573` / `#12a594` | sálvia | Figtree | 16 px | traço 1,5 | tingida de verde-água | Z com o traço de cima em onda |
| 3 | Ameixa | ameixa `#953ea3` / `#ab4aba` | cinza lilás | Plus Jakarta Sans | 14 px | duotom | flutuante | lua crescente com um ponto |
| 4 | Mel | âmbar `#ffc53d` (texto escuro) | areia | Manrope | 10 px | traço 2,2 | clara | Z num favo |
| 5 | Íris | índigo `#5b5bd6` | grafite | Onest | 10 px | traço 1,75 | escura nos dois temas | brilho de quatro pontas |
| 6 | Pitanga | vermelho `#d13415` / `#ec6142` | areia | Sora | 8 px | traço 2, pontas retas | flutuante | Z num balão de fala |
| 7 | Céu | azul `#0d74ce` / `#3b9eff` | cinza azulado | Albert Sans | 18 px | traço 1,75 | tingida de azul | planeta com órbita |

Leitura crítica:

- **Sinal** é a escolha segura: mantém a marca e o README, e é a que menos muda para quem já usa.
- **Lagoa** é a mais calma para uso longo; o verde-água não briga com o vermelho de atraso.
- **Ameixa** é a mais marcante; a lateral flutuante custa uns 10 px de largura e um pouco de sombra a mais para desenhar.
- **Mel** tem a melhor leitura no escuro, mas o amarelo pede texto escuro em todo botão cheio, e isso precisa de cuidado em cada tela nova.
- **Íris** tem a cara mais "de IA" e a lateral escura separa bem menu e conteúdo; é também a mais parecida com outros produtos.
- **Pitanga** é a mais quente e enérgica; o vermelho como destaque fica perto do vermelho de erro, então "Venceu ontem" e o botão principal ficam parecidos.
- **Céu** é a mais leve e arejada; azul é o destaque mais comum em apps, então diferencia menos a Zuri.

Fontes: cada modelo usa uma fonte do Google Fonts no protótipo. No app, a escolhida vira um arquivo `woff2` servido pela própria Zuri (nada de chamada ao Google, regra 7), com subconjunto latino e só dois pesos: cerca de 25 a 35 kB por peso, fora do JS (não conta no teto de 139,1 kB, mas pesa na primeira carga e no Lighthouse). Manter a fonte do sistema é a alternativa sem custo.

Acessibilidade: axe-core 4.10.3 sem violações em 280 páginas (7 modelos × 2 temas × computador e celular × 5 telas). O contraste mínimo de texto ficou em 4,5:1 em todas as combinações.

### Rodada 3 · oito paletas de conforto visual

Depois da rodada 2, o Pablo pediu mais combinações bonitas e confortáveis para os olhos, todas com a logomarca atual. A moldura, os ícones e os textos são os da rodada 2; muda a paleta, a fonte e o raio.

Protótipo: `docs/planos/propostas-ui/conforto.html`. Capturas em `docs/capturas/pr/propostas-ui/conforto/`, com `mosaico-claro.png` e `mosaico-escuro.png`.

Regras que as oito seguem:

- Nada de branco puro nem preto puro. O claro é papel (creme, areia, cinza tingido); o escuro é um cinza com o matiz da paleta, nunca `#000`.
- Texto principal entre 10:1 e 12,5:1 sobre o fundo. Passa do AAA (7:1) sem o brilho de 18:1 a 21:1 do preto no branco, que cansa em leitura longa. Na rodada 2 esse número ficava perto de 16:1.
- Destaques menos saturados, sobretudo no escuro, onde cores vivas "vibram" sobre fundo escuro. Texto secundário, links e estados com pelo menos 4,5:1; bordas de controle com 3:1.
- Logomarca de hoje (`apps/web/src/components/Logo.tsx`): o mesmo "i" com o sinal, só com o quadro, o traço e o sinal afinados a cada paleta. O sinal continua verde em todas, num tom que combina com a paleta.

Inspirações: temas de editor feitos para muitas horas de tela (Flexoki, Everforest, Nord, Rosé Pine, Catppuccin, Kanagawa, Gruvbox Material e Solarized), o modo sépia dos leitores de livro digital e o iA Writer. Os valores são nossos; nenhum tema foi copiado.

| Nº | Paleta | Ideia | Destaque (claro / escuro) | Fundo (claro / escuro) | Fonte | Contraste do texto (claro / escuro) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Papel | papel de livro e tinta sépia | ocre `#8a5a1c` / `#d6a35c` | `#f4f0e6` / `#1e1c18` | Manrope | 12,5 / 12,5 |
| 2 | Sálvia | verde-sálvia, conversa com o sinal | sálvia `#3f7356` / `#8fc49b` | `#eff1ea` / `#1b201d` | Figtree | 11,9 / 12,5 |
| 3 | Maré | creme e verde-mar; escuro petróleo | verde-mar `#1d6f73` / `#5cbdb5` | `#f5f1e4` / `#10272c` | Albert Sans | 11,9 / 11,9 |
| 4 | Neblina | cinza azulado e azul geada; escuro ardósia | azul `#47679a` / `#88b4d6` | `#eceff4` / `#252a33` | Onest | 11,2 / 11,3 |
| 5 | Nanquim | papel de arroz e lateral em nanquim; escuro azul-tinta com dourado | índigo `#3b4f8c` / dourado `#e0b872` | `#f2efe6` / `#1f1f28` | Geist | 12,1 / 11,4 |
| 6 | Lavanda | lilás suave, ícones preenchidos de leve | lilás `#6c4fb5` / `#c3a6f2` | `#f0eff6` / `#24273a` | Plus Jakarta Sans | 10,9 / 11,1 |
| 7 | Crepúsculo | rosa queimado e ameixa | rosa `#b0566e` / `#ea9ab2` | `#f8f1ea` / `#232136` | Sora | 11,2 / 12,0 |
| 8 | Cerâmica | argila e terracota; escuro pedra morna | terracota `#b0532b` / `#e3946a` | `#f3ede4` / `#252321` | Manrope | 12,2 / 11,4 |

Leitura crítica:

- **Sálvia** é a que mais combina com a logomarca: o verde do sinal vira a cor da casa, e o fundo esverdeado é o mais neutro para os olhos. O risco é o par verde e vermelho para quem não distingue as duas cores; "Venceu ontem" continua escrito, então a cor nunca é a única pista.
- **Papel** é a melhor para ler muito: parece livro, e o escuro marrom é o mais macio das oito. O ocre deixa a Zuri com cara de caderno, menos de "app de IA".
- **Maré** tem o escuro mais bonito (petróleo em vez de cinza) e lembra o Solarized, que muita gente usa o dia inteiro.
- **Neblina** é a mais sóbria e a mais parecida com ferramentas de trabalho; diferencia menos a Zuri.
- **Nanquim** é a mais marcante: a lateral escura também no claro e o dourado no escuro. É a que mais pede cuidado em telas novas.
- **Lavanda** e **Crepúsculo** são as mais suaves e afetivas; o rosa da Crepúsculo fica perto do vermelho de erro no claro, então atraso e botão principal ficam parecidos.
- **Cerâmica** é quente e acolhedora, com o mesmo cuidado da Crepúsculo sobre o vermelho.

Acessibilidade: axe-core 4.10.3 sem violações em 160 páginas (8 paletas × 2 temas × computador e celular × 5 telas). Os contrastes da tabela foram medidos pela fórmula da WCAG 2.1, junto com outras 18 combinações por tema (texto secundário, destaque, lateral, aviso de erro, bordas e logomarca), todas dentro do mínimo.

### Textos visíveis

Textos novos da moldura e da Início, já revisados com a `humanizer`. Entram no catálogo (pt-BR e en) só na implementação, com as chaves definidas lá.

| pt-BR | Onde aparece |
| --- | --- |
| Nova conversa | lateral (A, B), topo do celular (A) |
| Recolher o menu / Abrir o menu | botão da lateral |
| Pergunte à Zuri ou procure qualquer coisa | busca (C) |
| Perguntar à Zuri: <texto> | primeira opção da busca |
| Nada com "<texto>" · Tente outra palavra. Se for uma pergunta, escreva a frase inteira que a Zuri responde. | busca sem resultado |
| Terça, 3 de novembro. Faltam três tarefas para hoje e o resumo da manhã sai às 7h. | subtítulo da Início |
| Nada pendente para hoje. Bom descanso! | subtítulo da Início, tudo feito |
| Boa noite, Ana. Por onde começamos? | Início (C) |
| Escreva para a Zuri · Enter envia. Shift + Enter pula linha. | campo da Início |
| Para hoje · Vem aí · Ver todas | Início |
| Tarefa concluída. [Desfazer] | toast |
| Mensagem enviada. A Zuri já está respondendo. | toast |
| Não deu para abrir as notas · A conexão caiu no meio do caminho. Suas notas estão guardadas; é só tentar de novo. · Tentar de novo | estado de erro |
| Nenhuma nota por aqui · Anote uma ideia ou a lista do mercado. Se preferir, peça para a Zuri anotar durante a conversa. · Escrever a primeira nota | estado vazio |
| Entraram na sua conta por um celular novo. Foi você? | aviso de acesso |
| Oi, Ana! Quer anotar algo, marcar um lembrete ou só conversar? | conversa rápida (D) |
| Sua conta e ajustes | rodapé da lateral (A) |

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Recentes na lateral | 5 conversas mais novas | a 6ª some; "Ver todas" leva à Conversa | sem conversa: o grupo mostra "Nenhuma conversa ainda" |
| Projetos na lateral | até 8 | o resto em "Ver todos" | — |
| Estado do menu recolhido | por aparelho, como hoje (`lib/sidebar.ts`) | duas abas seguem a última escolha | — |
| Opção "Perguntar à Zuri" | texto com espaço, até 4.000 caracteres (limite da mensagem) | acima disso a opção some | — |

## 7. Desenho técnico

Só na implementação. Nenhum módulo, rota ou tabela muda neste PR.

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `docs/planos/nova-ui.md` | cria | este plano |
| `docs/planos/propostas-ui/index.html` | cria | protótipo navegável |
| `docs/capturas/pr/propostas-ui/*.png` | cria | 25 capturas |

### Rotas e contratos

Nada novo. Recentes usa `GET /conversations` (já existe).

### Banco

Sem migration.

### Ferramentas do agente

Nenhuma.

### Agendamentos, IA e integrações externas

Nenhum.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| JS inicial | ver a comparação | +3,5 kB (A sem carregamento sob demanda) | 20 bytes hoje | `scripts/check-bundle-size.ts` |
| Requisições | +1 por abertura (Recentes em A e E) | igual | sobra larga | `docs/arquitetura/orcamento-free-tier.md` |

Este PR não muda nada no Worker nem no pacote.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Título de conversa com HTML na lateral | React escapa por padrão; nada de `dangerouslySetInnerHTML` | e2e com título `<img onerror>` na implementação |
| Dado real no protótipo | só dados de exemplo e `dono@exemplo.com.br` | revisão deste PR |

Protótipo é HTML estático em `docs/`, fora do pacote servido. Auditoria em modo orientação.

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1, CA4 | 25 capturas geradas com Playwright a partir do protótipo | manual | `docs/capturas/pr/propostas-ui/` |
| CA6 | axe-core 4.10.3 em 5 propostas × 2 tamanhos × 2 temas × 4 telas (80 páginas): zero violações | a11y | roteiro no PR |
| Implementação | e2e de navegação, recolher, gaveta, busca e axe | e2e | a definir na implementação |

## 11. Entrega

- **Ordem:** (1) este PR, só docs; (2) depois da escolha, o PR da moldura escolhida; (3) ajustes da Início.
- **Capturas:** `docs/capturas/pr/propostas-ui/`.
- **Docs:** este plano. README só muda na implementação.
- **Changelog:** nenhum (sem mudança visível no app).
- **Instalação:** nada novo.
- **Portabilidade:** nenhum binding.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| A escolha passa do teto de JS | alta (A e E) | CI falha | carregar sob demanda; o que sobrar vai para o Pablo aprovar |
| Conflito com a etapa 18 na `AppShell` | média | retrabalho | implementar só depois do merge da 18 |
| Estimativas de JS erradas | média | decisão com número ruim | medir com `npm run build` no primeiro commit da implementação |

## 13. Suposições

- A marca (Sinal), as cores e a fonte do sistema ficam como estão; as propostas mudam a organização.
- Os números de JS são estimativas por comparação com o pacote atual; só a implementação mede de verdade.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| 03/11/2026 | Qual proposta (ou mistura)? Recomendação: A + busca da C + barra de baixo da B | A, sem projetos e com recentes dentro de Conversa |
| 03/11/2026 | Qual dos sete modelos visuais? Recomendação: 2, Lagoa (calma para uso longo, contraste bom nos dois temas e sem confusão com o vermelho de atraso) | Pediu mais paletas, de conforto visual e com a logomarca atual (rodada 3) |
| 03/11/2026 | Qual paleta de conforto (rodada 3)? Recomendação: 2, Sálvia (combina com o sinal verde da logomarca, fundo neutro e texto a 12:1 nos dois temas) | aguardando |
| 03/11/2026 | Aceita passar o teto de JS em até ~1 kB para ter Recentes na lateral? | Não se aplica mais: as recentes ficam na tela Conversa, que já carrega sob demanda. Os ícones próprios entram como SVG na moldura no lugar dos da lucide; o tamanho exato sai na implementação. |

### Perguntas abertas

- Modelo visual e teto de JS (acima).
