# Plano · Nova organização da interface

Situação: organização escolhida em 03/11/2026 e visual atual mantido; exemplo único e animação de carregamento esperando a aprovação do Pablo
Origem: pedido do Pablo em 03/11/2026, com a barra lateral do ChatGPT como referência
Dependências: nenhuma para aprovar. A implementação espera a etapa 18 sair da `AppShell` (outra thread mexe no app agora).

## 1. Resumo

O Pablo quer uma organização parecida com a do ChatGPT: busca à mão, menu que recolhe, seções, conversas recentes e a conta no rodapé. Depois de três rodadas de protótipos, ele escolheu a organização da proposta A e decidiu manter o visual de hoje: paleta "Sinal", fonte do sistema, ícones da lucide e a logomarca atual. Este plano traz um exemplo único dessa combinação, mais uma proposta de animação para quando a Zuri carrega dados. Nada no app muda até ele aprovar.

Exemplo navegável: `docs/planos/propostas-ui/exemplo.html`. Capturas: `docs/capturas/pr/propostas-ui/exemplo/`.

## 2. Contexto no sistema

- Moldura de hoje: `apps/web/src/components/AppShell.tsx`. Barra lateral de 240 px que recolhe para 72 px (`lib/sidebar.ts` guarda a escolha), botão Buscar com Ctrl/⌘ K, sete seções, rodapé com Recolher, Configurações, Sair e versão. No celular: barra do topo com busca, sino, engrenagem e sair, e barra de baixo com cinco seções.
- Visual: tokens em `apps/web/src/styles.css` (verde `#15803d` no claro e `#4ade80` no escuro, neutros cor de tinta), logomarca em `components/Logo.tsx`, que já tem o modo `working` (sinal pulsando).
- Carregamento hoje: `Spinner` em `components/ui.tsx` (círculo girando e "Carregando…"), usado em 28 arquivos e como `fallback` das telas carregadas sob demanda em `App.tsx`. Na conversa, três pontos piscando em `pages/chat/ChatPage.tsx`.
- Paleta Ctrl/⌘ K: `components/CommandPalette.tsx`, carregada só quando abre (regra P11). Avisos: `components/NotificationCenter.tsx`. Toasts: `components/Toaster.tsx`.
- Conversas já têm lista paginada (`GET /conversations`), então as recentes não precisam de rota nova.
- A Início de hoje ainda mostra "A conversa com a Zuri chega em breve", que ficou velho desde a etapa 8.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Organização da proposta A, sem o grupo Projetos e com as conversas recentes dentro da tela Conversa | Pablo |
| CA2 | Cores, fonte, ícones e logomarca iguais aos de hoje | Pablo |
| CA3 | Animação de carregamento enquanto os dados chegam, com estudo de viabilidade | Pablo |
| CA4 | Exemplo navegável e capturas de computador e celular, claro e escuro | regra de capturas |
| CA5 | Zero violações do axe (WCAG 2.1 AA e boas práticas), também com o carregamento ligado | plano |
| CA6 | Sem custo novo de JS inicial que passe do teto | regra P de performance |

## 4. Escopo

**Entra:**

- Um exemplo em HTML estático, sem dependências: `docs/planos/propostas-ui/exemplo.html`.
- 19 capturas, incluindo os estados de carregamento.
- Este plano.

**Sai do repositório:** os protótipos das rodadas 1 a 3 (cinco propostas, sete modelos e oito paletas) e as capturas deles, a pedido do Pablo, para não acumular arquivos. O histórico continua no Git.

**Fica fora (e onde vai parar):**

- Mudar `AppShell.tsx` e as telas → PR seguinte, depois da aprovação e da etapa 18.
- Conteúdo de Memória, Automações, Acessos e Configurações → continua igual.
- Revisão completa dos textos do app → etapa 26.

## 5. Como funciona para o Pablo

Abra o exemplo no navegador (ou o link publicado na conversa). A barra escura do topo troca o tema e tem o botão "Simular carregamento", que liga a animação por 3 segundos em qualquer tela. Enviar uma mensagem no campo também mostra a Zuri pensando.

**Organização (proposta A):**

- Lateral com a logomarca, a lupa (Ctrl/⌘ K) e o botão de recolher no topo; "Nova conversa" em destaque (Ctrl ⇧ O); Início, Conversa, Tarefas (com a contagem do dia), Notas, Memória e Automações.
- Rodapé da lateral com a conta: nome e "Conta e ajustes". O menu da conta tem Configurações, Acessos e segurança, Tema, Sair e a versão.
- Recolhida, a lateral vira um trilho só com ícones. No celular não há barra de baixo: o botão do topo abre a lateral como gaveta, e o topo mostra o nome da tela, o sino e "Nova conversa".
- Conversa em dois painéis: à esquerda as recentes, agrupadas em Hoje, Ontem, Esta semana e Mais antigas, com busca própria; à direita a conversa. No celular a lista abre primeiro e a conversa abre por cima, com botão de voltar.
- Início: data num selo, saudação, campo para falar com a Zuri com sugestões prontas, "Para hoje" e "Vem aí".

**Animação de carregamento (proposta):**

1. **Esqueleto no formato do conteúdo.** Enquanto a lista não chega, aparecem linhas cinza no lugar das tarefas, das conversas e das notas, com um brilho suave passando da esquerda para a direita. A tela não "pula" quando os dados chegam, porque o esqueleto já ocupa o espaço certo.
2. **Linha verde no topo.** Uma linha fina, na cor de destaque, corre no alto da área principal enquanto uma tela carrega. Avisa que algo está acontecendo sem cobrir nada.
3. **A Zuri pensando.** Na conversa, a resposta que ainda não chegou vira um balão com a logomarca e o sinal verde pulsando, o texto "A Zuri está pensando" e três pontos. É o modo `working` que a `Logo` já tem, agora com um anel que se expande.

Regras que valem para as três:

- Só aparece se demorar mais de 300 ms. Carregamento rápido não pisca nada na tela.
- Com "reduzir movimento" ligado no aparelho, tudo fica parado: o esqueleto aparece sem brilho e o sinal não pulsa.
- Leitor de tela ouve "Carregando as tarefas…" (ou o que for) uma vez, por uma região `role="status"`, e a área fica com `aria-busy="true"`. O esqueleto em si fica escondido do leitor.

### Viabilidade

| Ponto | Avaliação |
| --- | --- |
| Custo em JS inicial | Quase zero. As animações são CSS (`@keyframes` em `styles.css`), que não conta no teto de 139,1 kB. O componente de esqueleto é pequeno e pode morar no pedaço de cada tela; a linha do topo entra no `fallback` que já existe em `App.tsx`. Estimativa: menos de 200 B no pacote inicial, a medir no primeiro commit |
| Custo no servidor e no plano Free | Nenhum. Nada de requisição nova |
| Desempenho | Só `transform`, `opacity` e `background-position` animam; o navegador faz isso sem refazer o layout. Sem biblioteca de animação |
| Onde troca | `Spinner` vira esqueleto ou linha conforme o lugar (28 usos), o `fallback` das telas sob demanda ganha a linha verde, e os três pontos da conversa viram o balão da Zuri pensando |
| Testes | Unitário do atraso de 300 ms, e2e com resposta lenta simulada (o esqueleto aparece e some), axe com o carregamento ligado, e conferência de "reduzir movimento" |
| Risco | Esqueleto que não bate com o conteúdo final faz a tela pular; por isso cada lista tem o seu formato |

Conclusão: é viável e barato. Recomendo implementar junto com a nova organização, no mesmo PR da `AppShell`.

### Textos visíveis

Revisados com a `humanizer`. Entram no catálogo (pt-BR e en) só na implementação.

| pt-BR | Onde aparece |
| --- | --- |
| Nova conversa | lateral, topo do celular, Conversa |
| Recolher o menu / Abrir o menu | botão da lateral |
| Procurar nas conversas | busca da lista de recentes |
| Perguntar à Zuri: <texto> | primeira opção da busca Ctrl/⌘ K |
| Nada com "<texto>" · Tente outra palavra. Se for uma pergunta, escreva a frase inteira que a Zuri responde. | busca sem resultado |
| Faltam três tarefas para hoje, e o resumo da manhã chega às 7h. | subtítulo da Início |
| Nada pendente para hoje. Bom descanso! | subtítulo da Início, tudo feito |
| Pergunte ou peça algo à Zuri | campo da Início |
| Para hoje · Vem aí · Ver todas | Início |
| Conta e ajustes | rodapé da lateral |
| A Zuri está pensando | resposta a caminho |
| Carregando as tarefas… / as conversas… / as notas… | leitor de tela, durante o carregamento |
| Tarefa concluída. [Desfazer] | toast |
| Não deu para abrir as notas · A conexão caiu no meio do caminho. Suas notas estão guardadas; é só tentar de novo. · Tentar de novo | estado de erro |
| Nenhuma nota por aqui · Anote uma ideia ou a lista do mercado. Se preferir, peça para a Zuri anotar durante a conversa. · Escrever a primeira nota | estado vazio |

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Recentes em Conversa | páginas de 20, como hoje | "Carregar mais" no fim da lista | sem conversa: estado vazio com "Nova conversa" |
| Estado do menu recolhido | por aparelho, como hoje (`lib/sidebar.ts`) | duas abas seguem a última escolha | — |
| Atraso antes da animação | 300 ms | abaixo disso nada aparece | — |
| Opção "Perguntar à Zuri" | texto com espaço, até 4.000 caracteres (limite da mensagem) | acima disso a opção some | — |

## 7. Desenho técnico

Só na implementação. Nenhum módulo, rota ou tabela muda neste PR.

### Arquivos

| Arquivo | Cria, muda ou apaga | Para quê |
| --- | --- | --- |
| `docs/planos/nova-ui.md` | cria | este plano |
| `docs/planos/propostas-ui/exemplo.html` | cria | exemplo navegável |
| `docs/capturas/pr/propostas-ui/exemplo/*.png` | cria | 19 capturas |
| `.claude/memoria/decisoes.md` | muda | decisão da organização e do visual |

### Rotas e contratos

Nada novo. As recentes usam `GET /conversations` (já existe).

### Banco

Sem migration.

### Ferramentas do agente

Nenhuma.

### Agendamentos, IA e integrações externas

Nenhum.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| JS inicial | moldura nova: a medir; carregamento: menos de 200 B | a medir no primeiro commit | cerca de 0,9 kB depois da PR #110 | `scripts/check-bundle-size.ts` |
| Requisições | nenhuma nova | igual | sobra larga | `docs/arquitetura/orcamento-free-tier.md` |

Este PR não muda nada no Worker nem no pacote.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Título de conversa com HTML na lista de recentes | React escapa por padrão; nada de `dangerouslySetInnerHTML` | e2e com título `<img onerror>` na implementação |
| Dado real no exemplo | só dados de exemplo e `dono@exemplo.com.br` | revisão deste PR |

O exemplo é HTML estático em `docs/`, fora do pacote servido. Auditoria em modo orientação.

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1, CA2, CA4 | 19 capturas geradas com Playwright a partir do exemplo | manual | `docs/capturas/pr/propostas-ui/exemplo/` |
| CA5 | axe-core 4.10.3 em 9 estados (5 telas e 4 delas carregando) × computador e celular × claro e escuro (36 páginas): zero violações | a11y | roteiro no PR |
| Implementação | e2e de navegação, recolher, gaveta, busca, carregamento lento e axe | e2e | a definir na implementação |

## 11. Entrega

- **Ordem:** (1) este PR, só docs; (2) depois da aprovação e da etapa 18, o PR da nova moldura com a animação; (3) ajustes da Início.
- **Capturas:** `docs/capturas/pr/propostas-ui/exemplo/`.
- **Docs:** este plano. README só muda na implementação.
- **Changelog:** nenhum (sem mudança visível no app).
- **Instalação:** nada novo.
- **Portabilidade:** nenhum binding.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| A moldura nova passa do teto de JS | média | CI falha | recentes e paleta sob demanda; o que sobrar vai para o Pablo aprovar |
| Conflito com a etapa 18 na `AppShell` | média | retrabalho | implementar só depois do merge da 18 |
| Esqueleto diferente do conteúdo faz a tela pular | baixa | incômodo visual | um formato por lista, conferido nas capturas |

## 13. Suposições

- O visual (paleta "Sinal", fonte do sistema, ícones da lucide e logomarca) fica como está; muda a organização.
- "Nova conversa" usa o ícone `Plus`, que o app já carrega, para não somar ícone novo no pacote inicial.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| 03/11/2026 | Qual proposta de organização (rodada 1, cinco opções)? | A, sem projetos e com as recentes dentro de Conversa |
| 03/11/2026 | Qual modelo visual (rodada 2, sete) ou paleta de conforto (rodada 3, oito)? | Nenhum: manter as cores atuais e aproveitar só a organização; apagar os modelos |
| 03/11/2026 | Aprova o exemplo e a animação de carregamento? Recomendação: sim, implementar os dois juntos depois da etapa 18 | aguardando |

### Perguntas abertas

- Aprovação do exemplo e da animação (acima).
