# Plano · Nova organização da interface

Situação: modelo 2 aprovado pelo Pablo em 03/11/2026, com atualização em tempo real (WebSocket com hibernação, numa PR própria). Implementação em 3 PRs; a PR 1 (organização, textos e carregamento) está pronta, veja a seção 15.
Origem: pedidos do Pablo em 03/11/2026, com a barra lateral do ChatGPT como referência
Dependências: nenhuma para aprovar. A implementação espera a etapa 18 sair da `AppShell` (outra thread mexe no app agora).

## 1. Resumo

O Pablo quer a organização do ChatGPT (busca à mão, menu que recolhe, conversas recentes e a conta no rodapé) com o visual de hoje da Zuri. O modelo 2 traz isso em todas as telas que existem hoje, com os menus, os submenus e as sete seções de Configurações. Ele também traz três propostas novas:

1. Textos revisados em todas as telas do modelo.
2. Animação de carregamento.
3. Atualização automática só do que mudou, sem recarregar a página.

Nada no app muda até o Pablo aprovar.

Modelo navegável: `docs/planos/propostas-ui/exemplo.html`. Capturas: `docs/capturas/pr/propostas-ui/exemplo/`.

## 2. Contexto no sistema

- Moldura de hoje: `apps/web/src/components/AppShell.tsx`. Rotas em `apps/web/src/App.tsx`: Início, Conversa, Tarefas, Notas, Memória, Automações, Acessos e Configurações (`/configuracoes/:tab`, com Conta, Segurança, IA, Avisos, Integrações, Dados e Diagnóstico).
- Visual: tokens em `apps/web/src/styles.css`, logomarca em `components/Logo.tsx` (já tem o modo `working`).
- Textos: catálogo em `packages/shared/i18n/` (pt-BR e en). As regras de microcopy e o glossário estão em `docs/planos/revisao-de-textos-e-experiencia.md` (etapa 26).
- Carregamento hoje: `Spinner` (círculo girando e "Carregando…") em 28 arquivos e no `fallback` das telas sob demanda.
- Dados hoje: TanStack Query com `staleTime` de 15 s e nova busca quando a aba volta ao foco. Cada tela invalida a própria chave depois de uma mudança (`TasksPage`, `NotesPage`, `AutomationsPage` e outras), e a conversa invalida tarefas, notas e memórias só depois de uma aprovação (`pages/chat/cards.tsx`). O que muda fora da tela aberta (Telegram, rotinas, outro aparelho, a própria Zuri durante a conversa) só aparece quando a pessoa troca de tela ou volta para a aba.
- Sinal de vida: uma aba só (a "líder", por `navigator.locks`) chama `POST /auth/heartbeat` a cada 60 s (`components/SessionGuard.tsx`), e as abas conversam por `BroadcastChannel` (`lib/activity.ts`).
- O Worker recusa WebSocket de propósito (portão da etapa 1, `apps/agent/src/agent/zuri-agent.ts`), e a regra P5 pede um Durable Object sempre hibernável.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Organização da proposta A, sem projetos na lateral, com as recentes dentro de Conversa | Pablo |
| CA2 | Cores, fonte, ícones e logomarca de hoje | Pablo |
| CA3 | Todas as telas, menus, submenus e as sete seções de Configurações de hoje | Pablo |
| CA4 | Textos revisados com o glossário, as regras de microcopy e a passada da `humanizer` | Pablo |
| CA5 | Ao criar, mudar, apagar ou atualizar tarefas, rotinas e workflows, a tela mostra a mudança sem recarregar a página, só onde mudou | Pablo |
| CA6 | Animação de carregamento | Pablo |
| CA7 | Zero violações do axe (WCAG 2.1 AA e boas práticas) | plano |
| CA8 | Sem custo novo no plano Free e sem passar do teto de JS inicial | regras P |

## 4. Escopo

**Entra:**

- O modelo navegável e 41 capturas.
- Este plano, com o mapa de menus, os textos novos e o desenho da atualização automática.

**Fica fora (e onde vai parar):**

- Mudar `AppShell.tsx`, as telas e o catálogo → PR de implementação, depois da aprovação e da etapa 18.
- Textos que não aparecem no modelo (mensagens do servidor, do bot e erros raros) → etapa 26, com as mesmas regras.
- Workflows (etapa 22) → entram na mesma atualização automática quando existirem.

## 5. Como funciona para o Pablo

Abra o modelo no navegador (ou o link publicado na conversa). A barra escura do topo tem três controles:

- **Simular carregamento:** liga a animação por 3 segundos na tela aberta.
- **Simular mudança feita fora daqui:** a cada clique, chega algo do Telegram, de uma rotina ou de outro aparelho. Primeiro uma tarefa, depois uma execução de automação, uma memória e uma nota.
- **Claro / Escuro:** troca o tema.

Tudo é clicável: concluir tarefa (com Desfazer), aprovar o plano da Zuri na conversa (as quatro tarefas aparecem em Tarefas), aprovar a rotina sugerida, rodar e pausar automações, trocar as abas de Tarefas e os filtros de Memória, abrir uma nota, alternar as seções de Configurações, buscar com Ctrl K, abrir o sino e o menu da conta.

### Mapa de menus

| Lugar | O que tem | Muda em relação a hoje |
| --- | --- | --- |
| Lateral | Nova conversa (Ctrl ⇧ O), Início, Conversa, Tarefas (com a contagem do dia), Notas, Memória, Automações. No topo: logomarca, busca (Ctrl K) e recolher. No pé: a conta | Configurações e Sair saem da lateral e vão para o menu da conta; Acessos vai junto |
| Menu da conta | Configurações, Acessos, tema claro ou escuro, Sair e a versão | novo |
| Topo | Nome da tela e o sino. No celular, também o botão do menu e "Nova conversa" | no celular, sai a barra de baixo; o menu abre como gaveta |
| Conversa | Recentes à esquerda (Hoje, Ontem, Esta semana, Mais antigas) com busca; a conversa à direita | as recentes saem da lista solta e ganham grupos por data |
| Tarefas | Projetos e Lixeira no topo; campo rápido com "Prazo, projeto e prioridade"; abas Hoje, Próximas, Atrasadas, Concluídas e Todas, com contagem; busca e filtro de projeto | as abas mostram quantas tarefas há em cada uma |
| Notas | Lista com busca e "Nova nota"; editor com Escrever e Visualizar | igual, com a lista sempre à vista no computador |
| Memória | Para revisar; Guardar uma memória; filtros Atuais, Incertas, Passadas e Todas, com contagem; tipo e busca | igual, com os filtros em abas |
| Automações | Sugestões da Zuri para aprovar; Suas automações (rodar agora, pausar, editar, apagar); Últimas execuções | igual |
| Acessos | Período e resultado; lista das tentativas | sai da lateral |
| Configurações | Submenu com as sete seções: Conta, Segurança, IA, Avisos, Integrações, Dados e Diagnóstico | no computador, o submenu fica à esquerda da página (hoje são abas); no celular, continua a lista de seções |

### Textos revisados

Regras usadas: as de `docs/planos/revisao-de-textos-e-experiencia.md` (frase curta, verbo no botão, estado vazio que convida a agir, sem ponto de exclamação em texto de sistema, sem citar infraestrutura) e o glossário (Apagar, Adicionar, Criar, Aprovar e Recusar, Configurações). Inspirações: Todoist e Things para Tarefas ("Hoje", "Próximas"), Google Agenda para os próximos dias por data, Notion e Linear para Configurações em submenu com uma linha de descrição, e as regras de texto do ChatGPT e do Claude que já estão no plano da etapa 26. Por fim, a passada da `humanizer` tirou as marcas de texto de IA.

| Onde | Hoje | Proposta |
| --- | --- | --- |
| Início, cartão 1 (do protótipo anterior) | Para hoje | **Hoje**, com "3 tarefas, 1 atrasada" embaixo e o link "Ver tarefas" |
| Início, cartão 2 (do protótipo anterior) | Vem aí | **Próximos dias**, com "Tarefas com prazo e automações marcadas" e os itens agrupados por dia (Amanhã, Quinta, 5) |
| Início, bloco do app de hoje | A conversa com a Zuri chega em breve | sai; no lugar, o campo "Escreva para a Zuri" e três sugestões |
| Início, sem tarefas | — | Nada para hoje. Quer adiantar algo dos próximos dias? |
| Rodapé da lateral | Conta e ajustes | nome e e-mail ("Ajustes" não está no glossário) |
| Busca da conversa | Procurar nas conversas | Buscar conversas (igual a "Buscar tarefas" e "Buscar notas") |
| Tarefas, descrição | O que vence hoje, o que vem depois e o que você já concluiu. | O que vence hoje, o que vem depois e o que já foi feito. |
| Tarefas, vazio de Hoje | Nada para hoje. Aproveite! | **Nada para hoje.** Aproveite o tempo livre ou adiante algo de Próximas. |
| Tarefas, vazio de Todas | Nenhuma tarefa. Crie a primeira acima. | **Nenhuma tarefa ainda.** Adicione a primeira no campo acima ou peça para a Zuri na conversa. |
| Tarefas, campo rápido | Adicionar uma tarefa para hoje | Adicionar tarefa para hoje |
| Memória, descrição | O que a Zuri sabe sobre você. Fatos que mudam guardam o histórico, e nada é trocado ou apagado sem você saber. | O que a Zuri sabe sobre você. Corrija ou apague o que quiser; nada muda sem você saber. |
| Memória, autor | Anotada pela assistente | anotada pela Zuri numa conversa |
| Memória, guardar | Um fato por vez, nas suas palavras. Se ele muda algo que já está guardado, a Zuri pergunta… | Um fato por vez, com as suas palavras. Se ele mudar algo já guardado, a Zuri pergunta antes. |
| Automações, descrição | Lembretes, o resumo das suas tarefas e as rotinas da Zuri. Tudo no seu fuso horário. | Lembretes, resumos e rotinas que rodam sozinhos, sempre no seu fuso. |
| Automações, botão | Nova automação | Criar automação (glossário: Criar para o que se configura) |
| Automações, ação | Executar agora / Excluir | Rodar agora / Apagar |
| Automações, sugestões | Rotinas esperando sua aprovação | A Zuri sugeriu uma rotina (ou "sugeriu 2 rotinas") |
| Automações, sugestão, botão | Aprovar e ativar | Aprovar |
| Automações, histórico | Histórico de execuções | Últimas execuções |
| Acessos, descrição | Cada tentativa de entrar na Zuri: o IP, o lugar e a rede que a Cloudflare viu, o navegador e o que aconteceu. Fica guardado por 90 dias. | Cada tentativa de entrar na sua conta: aparelho, lugar aproximado e resultado. Fica guardado por 90 dias. (Sem citar a infraestrutura; o IP continua no detalhe.) |
| Configurações, descrição | Conta, segurança e o que a Zuri pode usar. | Sua conta, a segurança e o que a Zuri pode usar. |
| Configurações › Conta | Idioma, fuso horário, aparência e senha | Nome, idioma, fuso, tema e senha |
| Configurações › Segurança | Duas etapas, passkeys e saída automática | Verificação em duas etapas, passkeys e saída automática |
| Configurações › IA | Modelo e limites de uso | Uso do dia, limites e busca por significado |
| Configurações › Avisos | Resumo do dia e o que a Zuri avisa | Resumo do dia, canais e o que chega em cada um |
| Configurações › Integrações | Serviços externos que a Zuri pode usar | Serviços que a Zuri pode consultar |
| Configurações › Dados | Lixeira, backup e armazenamento | Lixeira: restaurar ou apagar de vez (backup e armazenamento ainda não existem nessa seção) |
| Configurações › Diagnóstico | Falhas recentes e saúde do sistema | Falhas recentes e versão |
| Conta, preferências | Valem para a interface, as mensagens do servidor e, depois, o bot. | Valem para as telas, os avisos e o bot do Telegram. |
| IA, modelo e limites | Quando um limite chega, a Zuri recusa o pedido com um aviso antes de chamar a IA. Nada pago é ligado. | Quando um limite chega, a Zuri avisa e não chama a IA. Nada pago é ligado. |
| Avisos, canais | O sino sempre recebe tudo. A notificação no aparelho já funciona; o e-mail chega na próxima atualização e o Telegram logo depois. | O sino do app sempre recebe tudo. (Cada canal mostra se está ligado; o e-mail aparece como "Em breve".) |
| Integrações | Cada ferramenta começa desligada e só é usada se você ligar. | Cada ferramenta começa em "Perguntar sempre" (decisão da etapa 18b). |
| Busca Ctrl K, sem resultado | Nada encontrado para "…". | Nada com "…" · Tente outra palavra. Se for uma pergunta, escreva a frase inteira e a Zuri responde. |
| Busca Ctrl K, campo | — | Busque uma tela, tarefa, nota ou conversa |
| Conversa, plano da Zuri | Plano proposto | Plano proposto: 4 tarefas no projeto Mudança · Nada é criado antes de você aprovar. |
| Toasts | variados | no particípio e sem "com sucesso": "Tarefa adicionada.", "Rotina aprovada.", "Avisos marcados como lidos." |

### Atualização automática só do que mudou

**O que a pessoa vê:** ao criar, mudar, concluir, apagar ou rodar alguma coisa, a mudança aparece na hora, só na linha ou no cartão que mudou. Esse trecho acende de leve em verde por 2 segundos. A página não pisca, a rolagem fica onde estava e o foco do teclado não se perde. Quando a mudança vem de fora (Telegram, uma rotina que rodou, outro aparelho, a Zuri durante a conversa), a linha nova chega com uma etiqueta de onde veio ("Pelo Telegram"). As contagens da lateral e das abas se atualizam juntas. O leitor de tela ouve uma frase curta, como "Tarefa nova pelo Telegram: Comprar ração do Thor".

**Como fazer, em quatro camadas (da mais rápida para a mais ampla):**

1. **O que a pessoa faz na tela: atualização otimista.** A lista muda no mesmo instante, antes da resposta do servidor (`setQueryData` do TanStack Query). Se o servidor recusar, a lista volta ao que era e um toast diz o que houve. Depois da resposta, só a chave daquela área é buscada de novo (`invalidateQueries` com a chave exata), nunca a página. Já é assim em parte; falta o passo otimista em concluir tarefa, pausar e retomar automação e restaurar da lixeira.
2. **O que a Zuri faz durante a conversa: aviso no próprio fluxo.** O fluxo da resposta já manda eventos (`tool`, `approval`, `plan`). Cada evento de ferramenta que gravou algo passa a levar a área que mudou (`tasks`, `notes`, `automations`, `memories`), e a tela invalida só essa área no mesmo momento. Hoje isso só acontece depois de uma aprovação.
3. **O que muda fora da tela: carona no sinal de vida.** A resposta do `POST /auth/heartbeat`, que a aba líder já chama a cada 60 s, ganha um campo pequeno com a versão de cada área, por exemplo `{ "tasks": 41, "automations": 7 }`. O servidor sobe a versão da área na mesma transação da mudança, venha ela de onde vier. A tela compara com as versões que tem, busca de novo só as áreas que mudaram e repassa as versões às outras abas pelo `BroadcastChannel` que já existe. Não há requisição nova.
4. **Ao voltar para a aba:** o TanStack Query já busca de novo o que está na tela quando a janela volta ao foco. Isso continua e cobre o celular que ficou no bolso.

**Por que não WebSocket nem polling:** o Worker recusa WebSocket de propósito (portão da etapa 1), e um WebSocket comum impede o Durable Object de hibernar (regra P5). A versão com hibernação seria possível, mas abre uma porta nova para proteger e testar. Um polling por tela somaria requisições por aba aberta, contra a regra P11. A carona no sinal de vida custa zero requisição e uma escrita pequena por mudança.

**Tempo até aparecer:** o que a pessoa faz aparece na hora; o que a Zuri faz na conversa também; o que vem de fora aparece em até 60 s com a aba aberta, ou na hora ao voltar para ela. Se o Pablo quiser menos que 60 s, o sinal de vida pode ir para 20 s só enquanto uma lista estiver na tela, o que triplica essas chamadas. Recomendo começar com 60 s.

**Tempo real (pergunta do Pablo, 03/11).** É possível, sem custo no plano gratuito para um dono só: o Durable Object aceita WebSocket com hibernação (`ctx.acceptWebSocket`), que fica parado sem cobrar duração enquanto nada muda e só acorda para avisar "tarefas mudaram". A tela recebe o aviso e busca só aquela área, como na camada 3. Pede três cuidados: (1) muda um portão da etapa 1, que hoje recusa WebSocket, então a conexão exige sessão válida, `Origin` igual ao site e o mesmo bloqueio do destravamento, com testes de segurança; (2) o código da conexão fica num pedaço carregado depois da primeira tela, para não tocar no teto de JS; (3) se a conexão cair, volta para o sinal de vida de 60 s. Seria uma PR própria, depois da PR da atualização automática.

**Edição em andamento:** se uma nota aberta no editor mudar em outro lugar, a tela não troca o texto. Ela mostra "Esta nota mudou em outro aparelho" com "Ver a versão nova" e "Manter a minha". Isso é a mesma proteção de "Sair sem salvar?" que já existe.

### Animação de carregamento

Esqueleto no formato do conteúdo (com brilho suave), linha verde fina no topo enquanto uma tela abre, e a Zuri pensando com o sinal da logomarca pulsando. Só aparece depois de 300 ms. Fica parada com "reduzir movimento". O leitor de tela ouve "Carregando as tarefas…" uma vez.

### Viabilidade

| Ponto | Avaliação |
| --- | --- |
| JS inicial | Moldura: a medir no primeiro commit. Carregamento: CSS, menos de 200 B de JS. Atualização automática: a lógica das versões cabe em `lib/` (com teste) e o resto fica nas telas sob demanda; estimativa abaixo de 0,5 kB no pacote inicial |
| Servidor | Uma tabela pequena de versões por área (migration só de acréscimo) e uma escrita a mais por mudança, na mesma transação. A leitura entra na resposta do sinal de vida, que já existe |
| Plano Free | Nenhuma requisição nova; escritas sobem pouco (uma por mudança do dono) |
| Segurança | Nenhuma porta nova; as versões não carregam conteúdo, só números |
| Testes | Unitário da comparação de versões; teste do servidor para cada área subir a versão; e2e com uma tarefa criada "por fora" aparecendo sem recarregar; axe com o destaque ligado; atraso do carregamento |

Conclusão: tudo é viável no plano grátis, sem dependência nova. Recomendo implementar em dois PRs depois da etapa 18: (1) moldura, menus, textos e carregamento; (2) atualização automática, que mexe no servidor e pede migration.

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Recentes em Conversa | páginas de 20, como hoje | "Carregar mais" no fim da lista | sem conversa: estado vazio com "Nova conversa" |
| Estado do menu recolhido | por aparelho, como hoje (`lib/sidebar.ts`) | duas abas seguem a última escolha | — |
| Atraso antes da animação | 300 ms | abaixo disso nada aparece | — |
| Destaque de item que mudou | 2,4 s | some sozinho; não rouba o foco | — |
| Mudança vinda de fora | até 60 s com a aba aberta | na hora ao voltar para a aba | sem conexão: nada muda e a próxima volta da rede atualiza |
| Opção "Perguntar à Zuri" | texto com espaço, até 4.000 caracteres | acima disso a opção some | — |

## 7. Desenho técnico

Só na implementação. Nenhum módulo, rota ou tabela muda neste PR.

### Arquivos

| Arquivo | Cria, muda ou apaga | Para quê |
| --- | --- | --- |
| `docs/planos/nova-ui.md` | cria | este plano |
| `docs/planos/propostas-ui/exemplo.html` | cria | modelo navegável |
| `docs/capturas/pr/propostas-ui/exemplo/*.png` | cria | 41 capturas |
| `.claude/memoria/decisoes.md` | muda | decisão da organização e do visual |

### Rotas e contratos

Na implementação: a resposta de `POST /auth/heartbeat` ganha `versions` (objeto de área para número), validado com Zod em `packages/shared`. Os eventos `tool` do fluxo da conversa ganham `area`.

### Banco

Na implementação: tabela de versões por área (migration nova, só de acréscimo).

### Ferramentas do agente

Nenhuma muda; as que gravam passam a subir a versão da área.

### Agendamentos, IA e integrações externas

Rotinas, Telegram e MCP sobem a versão da área quando gravam. Nada mais muda.

## 8. Custo e cotas do plano Free

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| JS inicial | a medir; estimativa abaixo de 1 kB somando tudo | a medir no primeiro commit | cerca de 0,9 kB depois da PR #110 | `scripts/check-bundle-size.ts` |
| Requisições | nenhuma nova | igual | sobra larga | `docs/arquitetura/orcamento-free-tier.md` |
| Escritas no banco | +1 por mudança feita pelo dono ou pela Zuri | poucas centenas por dia | sobra larga | idem |

Este PR não muda nada no Worker nem no pacote. Se o JS da moldura passar do teto, a implementação para e pede o OK do Pablo.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Título de conversa ou tarefa com HTML | React escapa por padrão; nada de `dangerouslySetInnerHTML` | e2e com título `<img onerror>` |
| Versões revelarem conteúdo | só números por área, na rota autenticada que já existe | teste do contrato |
| Dado real no modelo | só dados de exemplo e `dono@exemplo.com.br` | revisão deste PR |

O modelo é HTML estático em `docs/`, fora do pacote servido. Auditoria em modo orientação.

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1 a CA6 | 41 capturas geradas com Playwright a partir do modelo | manual | `docs/capturas/pr/propostas-ui/exemplo/` |
| CA7 | axe-core 4.10.3 em 29 estados (todas as telas, as sete seções de Configurações, carregando, atualização de fora, busca, gaveta e menu recolhido) × computador e celular × claro e escuro (116 páginas): zero violações | a11y | roteiro no PR |
| Implementação | e2e de navegação, menus, carregamento lento, mudança vinda de fora sem recarregar e axe | e2e | a definir |

## 11. Entrega

- **Ordem:** (1) este PR, só docs; (2) moldura, menus, textos e carregamento; (3) atualização automática.
- **Capturas:** `docs/capturas/pr/propostas-ui/exemplo/`.
- **Docs:** este plano. README e changelog só na implementação.
- **Instalação e portabilidade:** nada novo.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| A moldura nova passa do teto de JS | média | CI falha | recentes e paleta sob demanda; o que sobrar vai para o Pablo aprovar |
| Conflito com a etapa 18 na `AppShell` | média | retrabalho | implementar só depois do merge da 18 |
| Uma escrita esquecer de subir a versão | média | a mudança só aparece ao voltar para a aba | um ponto único de escrita por área e teste para cada uma |
| Mudança de fora sobrescrever edição em curso | baixa | perda de texto | aviso "mudou em outro aparelho", nunca troca o texto sozinha |

## 13. Suposições

- O visual (paleta "Sinal", fonte do sistema, ícones da lucide e logomarca) fica como está.
- Projetos continuam existindo em Tarefas e Notas; só saem da lateral.
- "Nova conversa" usa o ícone `Plus`, que o app já carrega.

## 14. Entrevista com o Pablo

| Data | Pergunta | Resposta |
| --- | --- | --- |
| 03/11/2026 | Qual proposta de organização (cinco opções)? | A, sem projetos e com as recentes dentro de Conversa |
| 03/11/2026 | Qual modelo visual ou paleta? | Nenhum: manter as cores atuais e aproveitar só a organização |
| 03/11/2026 | Aprova o modelo 2 (menus, textos, carregamento e atualização automática)? Recomendação: sim, em dois PRs depois da etapa 18 | aguardando |
| 03/11/2026 | O modelo 2 está aprovado? | aprovado (Pablo, 03/11 02:44) |
| 03/11/2026 | Mudança de fora em até 60 s, 20 s ou em tempo real? Recomendação: tempo real com WebSocket hibernável, com os 60 s como reserva | tempo real (Pablo, 03/11 02:55) |

### Perguntas abertas

- As duas acima.

## 15. Implementação

### PR 1: organização, textos e carregamento

Entrou: a barra lateral nova (topo com marca, busca e recolher; "Nova conversa" com Ctrl/⌘ ⇧ O; seis telas; conta no pé com Configurações, Acessos, tema, Sair e versão), a gaveta no celular no lugar da barra de baixo, o sino na barra do topo, o Início com o campo para a Zuri, três ideias e os cartões Hoje e Próximos dias (sob demanda), as recentes por dia com busca própria, o submenu de Configurações no computador, os textos da tabela da seção 5, a paleta com "Conversa", "Nova conversa" e "Perguntar à Zuri", e o carregamento só em CSS (`Loading` e `ScreenLoading` no lugar do `Spinner`, balão "A Zuri está pensando").

Decisões técnicas desta PR:

- As contagens na lateral (Tarefas) e nas abas de Tarefas e Memória ficam para a PR 2, que já atualiza essas contagens junto com o resto. Na PR 1 elas custariam uma busca a mais em toda página.
- A busca das recentes filtra o que já carregou (páginas de 20), sem rota nova; "Carregar mais" continua no fim da lista. Uma busca no servidor fica para quando o volume pedir.
- Próximos dias mostra só tarefas com prazo; as automações marcadas entram quando a PR 2 trouxer as versões por área.
- A linha de resumo embaixo de cada conversa (do modelo) não entrou: a lista não tem esse texto hoje e trazê-lo pediria mudar a rota.
- O texto que chega do Início ou da busca segue o limite da conversa (`CHAT_MESSAGE_MAX`, 8.000 caracteres, não os 4.000 da seção 6): até ele, vai direto; acima, espera no campo da conversa com o contador.
- O tema no menu da conta troca entre claro e escuro desta máquina, como em Configurações › Conta.
- O texto "Avisos, canais" ficou "O sino do app sempre recebe tudo. Cada canal mostra se está ligado.", e "Ideias para começar" nomeia as sugestões do Início.
- JS inicial: 138.992 B depois de trazer a develop 0.25.6 (teto 139.100 B). O corpo do Início vem sob demanda para caber.


### PR 2: atualização automática só do que mudou

Entrou: o número por área (tarefas, projetos, notas, lixeira, memórias, automações e conversas recentes) que sobe a cada mudança e vai junto com a conferência da sessão, a entrada, a troca de senha e o sinal de vida; a busca de novo só da área que mudou, repassada às outras abas; o mesmo número nos eventos de ferramenta da conversa; o brilho verde de 2,4 s na linha que mudou (Tarefas, Notas, Memória, Automações e Últimas execuções), com uma frase curta para o leitor de tela quando a mudança veio de fora; as contagens no menu (tarefas de hoje) e nas abas de Tarefas; o passo otimista em concluir tarefa, pausar e retomar automação e restaurar da lixeira; o aviso "Esta nota mudou em outro aparelho" com "Ver a versão nova" e "Manter a minha"; e as automações marcadas em Próximos dias.

Decisões técnicas desta PR:

- Os números ficam numa tabela de uma linha só (`zur_area_versions`, migration 21) e sobem por gatilhos no banco, não no código de cada escrita. Assim nenhuma origem (app, conversa, bot, rotina, restauração, MCP) esquece de avisar. Custa uma linha lida por batida e uma escrita por mudança (P4); os tetos de `free-tier-budget.test.ts` subiram nessa medida, com o motivo ao lado.
- O evento de ferramenta da conversa leva o conjunto de números (`versions`) depois de uma ferramenta de escrita da própria Zuri, no lugar da `area` da seção 7. O resultado é o mesmo e serve para qualquer ferramenta, inclusive as que mexem em mais de uma área.
- Contagem das abas de Tarefas: rota nova `GET /api/tasks/counts`, que lê só as tarefas abertas com prazo até hoje à noite e os contadores (`tasks` e o novo `tasks_done`). Nunca conta a tabela inteira (P2).
- No modo de bloqueio, com a senha a trocar ou com o segundo passo pendente, os números não vão na resposta: não há tela para atualizar.
- A própria mudança da pessoa volta no sinal de vida seguinte como número novo. A tela busca de novo a área uma vez e, como nada mudou na lista, nada acende. Aceitamos essa busca a mais (no máximo uma por área por minuto) para manter um único caminho.
- A etiqueta de origem ("Pelo Telegram") não entrou: tarefas, notas e automações não guardam de onde vieram, e guardar pediria mudar cada escrita. O leitor de tela ouve "1 item da lista mudou." Fica para quando houver a coluna de origem.
- JS inicial: 139.0xx B de 139.100 B. O código da atualização (`lib/versions.ts`) vem sob demanda, e o brilho mora em `lib/lists.tsx`, junto da busca com espera, para as telas dividirem um arquivo só. Para caber, o texto "Encerra esta sessão…" passou para o catálogo de Configurações e a contagem do menu é lida junto com o nome ("Tarefas 3"). A PR 3 precisa abrir folga antes de crescer.
