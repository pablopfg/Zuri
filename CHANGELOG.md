# Changelog

Todas as mudanças visíveis do Zuri ficam aqui, em pt-BR. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem
o [SemVer](https://semver.org/lang/pt-BR/). Cada PR escreve a sua entrada em
"Não lançado"; a release copia a seção para a versão.

## Não lançado

### Adicionado

- Cumprimento no Início: bom dia, boa tarde ou boa noite pelo horário do seu
  fuso (o das configurações, não o do aparelho), com o seu nome e uma frase
  curta que muda a cada dia. A frase troca sozinha quando o período vira,
  mesmo com a tela aberta, e de madrugada tem frases próprias.
- Campo "Seu nome" em Configurações > Conta. Aceita apelido, até 40
  caracteres; em branco, o cumprimento sai sem nome.

- Paleta de comandos com Ctrl/⌘ K, ou pelo botão Buscar na barra lateral e no
  topo do celular. Ela leva a qualquer página ou seção das configurações, cria
  uma tarefa ou nota e busca tarefas, notas e memórias (a partir de 2 letras,
  com uma pausa curta na digitação). Funciona inteira pelo teclado: setas,
  Enter e Esc. O código e os textos dela só vêm na primeira vez que ela abre.
- README renovado com a identidade visual Sinal: banner que segue o tema
  claro ou escuro do GitHub, selos da CI, capturas das telas atuais, o que já
  funciona e o que vem a seguir, mapa das 26 etapas, arquitetura resumida e um
  resumo em inglês.
- `scripts/capturas-do-readme.ts` refaz as capturas do README em
  `docs/capturas/`, com dados de exemplo.
- Regra permanente `.claude/rules/readme.md`: todo PR que muda
  funcionalidade, conclui etapa, muda uma tela das capturas ou a arquitetura
  atualiza o README junto com o changelog.
- Página **Acessos** na barra lateral: cada tentativa de entrar no Zuri, com
  IP, cidade, país, rede (ASN), navegador e o resultado (login, senha ou código
  errado, bloqueio, verificação contra robôs recusada). Filtros por período,
  tipo e começo do IP, 50 por página. No celular, fica em Configurações >
  Segurança > Ver todos os acessos.
- Repositório preparado: monorepo com npm workspaces (`apps/agent`,
  `apps/web`, `packages/shared`), TypeScript estrito, Biome, Vitest,
  Playwright e o catálogo inicial de traduções em pt-BR e en.
- Integração contínua em todo PR (typecheck, lint, testes, i18n, build, e2e e
  `npm audit`), CodeQL, Dependabot e rulesets para a `develop` e a `main`.
- `LICENSE` (MIT), `NOTICE.md`, `SECURITY.md` e `CONTRIBUTING.md`.
- Worker único com o Durable Object do agente, que serve a interface e a API
  e passa toda requisição pelos portões de segurança: host permitido, HTTP
  para HTTPS, Cloudflare Access opcional, cabeçalhos de segurança e
  autenticação. `GET /api/health` responde se o Zuri está no ar e
  configurado, sem nenhum dado.
- Erros da API no formato `{ code, message }`, com o texto em pt-BR.
- Banco do agente criado sob demanda, com migrations só de acréscimo, e as
  configurações de idioma (`pt-BR` ou `en`) e fuso (`America/Sao_Paulo` por
  padrão). Os erros da API passam a sair no idioma escolhido.
- Formatação de datas e valores no padrão brasileiro ("30/10/2026 às 15:16",
  "US$ 1,25") e plural pelas regras de cada idioma.
- Lint de i18n no `npm run lint` e na CI: falha com texto visível fora do
  catálogo, chave sem tradução ou chave sem uso.
- Login com e-mail e senha (`POST /api/auth/login`), sessão
  (`GET /api/auth/session`), sinal de aba aberta (`POST /api/auth/heartbeat`),
  saída (`POST /api/auth/logout`), confirmação de senha para ações sensíveis
  (`POST /api/auth/confirm`) e troca de senha (`POST /api/auth/password`).
- Saída automática depois de 30 min sem uso, 5 min sem aba aberta ou 6 h no
  total.
- Atividade de acesso por 90 dias (depois, contagens diárias por um ano), com
  os eventos que viram alerta guardados para a central de avisos.
- Verificação em duas etapas opcional com aplicativo autenticador (TOTP) e 10
  códigos de recuperação, ligada pelo dono (`/api/auth/mfa/*`). Com ela
  ligada, o login pede o código depois da senha, e a confirmação para ações
  sensíveis aceita um código atual no lugar da senha.
- Passkeys como segundo passo do login (`/api/auth/passkeys`,
  `/api/auth/mfa/passkey`). A lista marca as passkeys criadas em outro
  endereço, que não funcionam no atual.
- Interface web: login com código ou passkey na segunda etapa, início,
  central de avisos (vazia até a etapa 11) e Configurações com as abas Conta,
  Segurança, IA, Avisos, Integrações e Dados. Tema claro, escuro ou como o
  sistema, layout para celular e computador, em pt-BR e en.
- Casca depois do login no estilo do Talorys: barra lateral de altura total,
  barra superior e navegação inferior no celular, e um lembrete para ligar a
  verificação em duas etapas enquanto ela estiver desligada.
- Identidade visual do Zuri, "Sinal": logo de um i cujo pingo é uma luz
  verde, que pulsa enquanto o Zuri trabalha; favicon, ícones e cores da
  interface nos dois temas.
- App instalável (PWA) no celular e no computador.
- Na aba Conta: idioma, fuso horário, aparência e troca de senha. Na aba
  Segurança: ligar e desligar a verificação em duas etapas com QR code e
  códigos de recuperação, passkeys, tempos de saída automática e a atividade
  de acesso.
- Aviso dois minutos antes de a sessão terminar por falta de uso, com a opção
  de continuar; saída em todas as abas juntas.
- `GET` e `PATCH /api/settings` e `GET /api/auth/activity`.
- Tarefas: criar, editar, concluir e reabrir, com prazo no seu fuso (dia só,
  ou dia e hora), prioridade, projeto e as visões Hoje, Próximas, Atrasadas,
  Concluídas e Todas, além de filtro por projeto e busca. Adição rápida no
  topo: na visão Hoje, uma tarefa sem data vence hoje.
- Notas em Markdown, com editor e visualização (sem HTML, sem imagens de
  fora e só links `http`, `https` e `mailto`), e busca em texto completo que
  acha palavras com ou sem acento. No computador a lista fica ao lado do
  editor, e sair com alterações não salvas pede confirmação, inclusive pelo
  menu lateral e pelo voltar do navegador.
- Menu lateral recolhível no computador: o botão "Recolher menu" deixa só os
  ícones, cada um com o nome ao passar o mouse ou focar pelo teclado. A
  escolha fica guardada neste navegador e vale para todas as abas.
- Projetos para agrupar tarefas e notas. Apagar um projeto não apaga o que
  está nele.
- Lixeira em Configurações › Dados: tarefas, notas e projetos apagados ficam
  30 dias e podem ser restaurados (um projeto volta com as tarefas e notas
  que tinha). Depois de apagar, a tela oferece "Desfazer".
- Rotas `/api/tasks`, `/api/notes`, `/api/projects` e `/api/trash`
  (detalhes em `docs/produtividade.md`).
- Tela de Memória (`/memoria`): fatos duráveis sobre o dono, com estado atual,
  incerto ou passado, busca sem acentos, filtro por categoria, edição,
  "atualizar o fato" (a antiga vira passada e o histórico guarda as duas) e
  exclusão definitiva. Até 10.000 memórias de até 2.000 caracteres.
- Fila "Para revisar": quando um fato novo parece mudar ou contradizer um
  antigo (moradia, carro, emprego, dieta, relacionamento, em pt-BR e en), o
  Zuri pergunta antes de mexer. As regras nunca aposentam uma memória
  sozinhas. A revisão pode ser desligada na própria tela.
- Rotas `/api/memories` (detalhes em `docs/memoria.md`).
- Botão de mostrar e ocultar nos campos de senha (login e troca de senha).
  O campo volta a ficar oculto quando o formulário é enviado.
- Cada página dá nome à aba do navegador, como "Segurança · Configurações ·
  Zuri".
- A lista de notas vazia tem o próprio botão "Nova nota".
- Provedor de IA com medição de uso (etapa 8): o Zuri chama o Workers AI
  (modelo padrão `@cf/zai-org/glm-4.7-flash`, raciocínio desligado, sem novas
  tentativas) e conta cada chamada antes de fazê-la. Com o teto diário único
  de 9.000 Neurons (conversa, voz e busca juntas), o pedido é recusado com um
  aviso claro antes de gastar, e a conta fica dentro da cota grátis de 10.000.
  Chamadas que falham ou são interrompidas no meio também entram na conta.
  Uma resposta que passa de 120 s é cancelada com aviso, e depois do botão
  Parar nenhuma chamada nova ao modelo começa. No desenvolvimento local, uma IA simulada responde sem gastar nada.
- Aba **IA** nas Configurações: uso de hoje (Neurons, pedidos e áudio contra
  os limites, custo estimado, falhas e interrupções), uso por modelo, os
  últimos 7 dias e a hora em que a cota renova. Ali se escolhe o modelo e se
  mudam os limites de pedidos, de Neurons e o tamanho da resposta.
- Rota `GET /api/usage` (detalhes em `docs/ia.md`).

### Alterado

- Os textos que só o servidor diz (recusas e erros da API) saíram do pacote
  inicial da interface, que já recebe essas mensagens prontas na resposta. O
  JS inicial caiu de 139,9 para 139,4 KB, já com a paleta, e o teto da CI desceu
  para 139,5 KB.
- Confirmações em toasts: "Salvo." nas Configurações, a senha trocada, o
  que volta da lixeira e o que se guarda na memória aparecem por alguns
  segundos no pé da tela, com botão de fechar. O toast fica parado enquanto o
  ponteiro ou o foco estão nele, e o leitor de tela lê uma vez. O código só
  vem com as telas que o usam.
- No celular e em telas estreitas, Configurações virou uma lista de seções
  (com o que cada uma guarda) que abre cada seção numa tela, com o caminho de
  volta. No computador, as abas continuam.

- O logo do README e o `CONTRIBUTING.md` usam a identidade Sinal; o
  `CONTRIBUTING.md` explica como manter o README e as capturas em dia.
- Os textos em pt-BR de Tarefas, Notas, Projetos, Lixeira e Acessos chegam
  junto com essas telas, como os da Memória, e não mais no pacote inicial. Com
  isso a tela de Memória entrou sem passar do teto de 140 KB (fica em 139,9 KB).
- Tela de entrar nova (modelo B, escolhido pelo Pablo entre três): no
  computador, um painel escuro da marca à esquerda, com a frase "Tudo o que
  importa, num só lugar.", o que o Zuri faz e três garantias, e o formulário à
  direita; no celular, a marca vira um bloco curto no topo e o formulário fica
  embaixo. O painel é escuro nos dois temas, o botão Entrar leva o sinal verde
  do logo, os campos têm ícones, o formulário entra suave (parado com "reduzir
  movimento") e o sinal do logo pulsa enquanto confere a senha.
- Os textos em pt-BR de Configurações (segundo passo, passkeys, saída
  automática, abas que ainda vão chegar) chegam com essa tela, e não mais no
  pacote inicial. Foi o que abriu espaço para a tela nova sem passar dos 140 KB
  (fica em 139,9 KB).
- A verificação contra robôs ficou discreta: roda sozinha, sem caixa, e só
  aparece quando precisa de um clique, com uma linha dizendo por quê.
- Frases da tela de entrar reescritas, sem citar onde nem em que serviço o
  Zuri roda (também na descrição da página e em dois erros de antes do login).
- O botão Entrar não trava mais com campo vazio: ao tocar, o campo que falta
  é marcado logo abaixo dele, e nada é enviado. O mesmo vale para o código do
  segundo passo e para a verificação contra robôs, cuja linha vira o aviso.
- O logo aparece antes do JavaScript carregar, já no tema do sistema, no
  mesmo lugar onde a tela de conferir a sessão o desenha, sem saltos.
- Abertura ainda mais leve: o JavaScript inicial caiu de 158 para 140 KB
  (gzip). A interface passou a validar as respostas da API com o Zod Mini, e o
  Zod completo ficou só no servidor. As validações são as mesmas.
- Abertura mais leve: o código do QR e das passkeys saiu do pacote inicial,
  que cai cerca de 15 KB (gzip). A biblioteca de passkey só baixa quando o
  segundo passo oferece passkey, e o catálogo em inglês só baixa para quem usa
  inglês.
- No celular, "Sair" no topo pede confirmação, e o lembrete da verificação em
  duas etapas cabe numa linha.
- Os textos de "em breve" não citam mais números internos de etapa.
- No celular, as três opções de tema ficam lado a lado.
- Com a verificação em duas etapas desligada, o cartão de passkeys mostra só
  o motivo de ainda não dar para adicionar uma.
- Na atividade de acesso, as recusas trazem um ícone de alerta, além da cor.
- Revisão de design e UX registrada em `docs/qa/revisao-de-design.md`.

### Alterado

- A CI mede a cobertura dos testes e falha abaixo dos pisos por área (agente,
  `packages/shared` e `apps/web/src/lib`). Os pisos só sobem.
- Novo check `lighthouse` na CI: Entrar, Início, Tarefas, Notas e
  Configurações precisam de acessibilidade e boas práticas ≥ 95.
- Estratégia de testes mais exigente: portões obrigatórios por etapa e
  exigências por área (`docs/qa/estrategia-de-testes.md`).

### Corrigido

- A busca de tarefas e a busca literal de notas não achavam "Água" ao digitar
  "água" (o SQLite só ignora maiúsculas de A a Z). Agora as maiúsculas
  acentuadas também são ignoradas, nos dois sentidos.
- Um texto com um caractere Unicode quebrado (surrogate solto) era aceito e
  guardado alterado, sem aviso. Agora é recusado. Textos passam a ser
  guardados na forma NFC, então "é" digitado de dois jeitos é o mesmo texto.

### Segurança

- Teto diário no segundo passo do login: 30 códigos errados em 24 horas
  suspendem o código e a passkey para redes desconhecidas até o mais antigo
  completar um dia, e o dono recebe um alerta. No seu navegador e na sua rede,
  você continua entrando. Em Acessos, a linha aparece como "limite diário
  atingido".
- Memórias entram no prompt só como dado, em blocos `<data>`: sinais que
  imitam tags (inclusive `‹ › ＜ ＞`) são trocados e caracteres invisíveis
  (bidi, largura zero, "tags" Unicode) somem, então um texto guardado não
  consegue fechar o bloco nem esconder instruções.
- A interface não provoca mais violação de CSP: o Zod deixa de testar
  `new Function` (`jitless`), o que a política já recusava.
- A interface pede aos buscadores que não a indexem (`noindex` e
  `robots.txt`).
- O login pede a verificação contra robôs da Cloudflare (Turnstile) em toda
  tentativa, com o quadro visível assim que a tela abre. Antes ela só aparecia
  depois de um erro.
- Fora do ambiente local, o login fica fechado sem as chaves do Turnstile ou
  com as chaves de teste da Cloudflare (falha fechada).
- Um endereço `?next=/..//outro-site` no login não deixa mais a tela em branco
  depois de entrar.
- O aviso de códigos de dois fatores errados se repete a cada 3 erros
  seguidos, e não só no primeiro trio.
- A pausa dos códigos de dois fatores só isenta o navegador do dono na rede do
  dono: estar na mesma rede (Wi-Fi público, operadora móvel) não basta.
- A interface só mostra dados depois de o servidor confirmar a sessão; sem
  ela, leva ao login com `?next=`, que só aceita caminhos do próprio Zuri.
- O service worker não guarda nada em cache: páginas e respostas da API vêm
  sempre da rede.
- Mudar os tempos de saída automática pede a senha digitada nos últimos 15
  minutos.
- O script do Turnstile só é liberado na CSP quando o Turnstile está ligado.
- Datas impossíveis (30/02, 29/02 fora de ano bissexto, 31/04, hora 24,
  fuso acima de +14:00) são recusadas mesmo com fuso explícito; a busca trata
  `%`, `_`, aspas e operadores do FTS5 como texto comum.
- Limites por tipo (20.000 tarefas, 5.000 notas, 1.000 projetos) e teto de
  900 MB do banco: passar deles responde `STORAGE_LIMIT_REACHED` (507) e nada
  é apagado para abrir espaço. Uma edição que aumenta o texto também respeita
  o teto do banco.

- Conexões WebSocket e caminhos de sub-agente são recusados, e os cabeçalhos
  internos do Agents SDK são removidos antes de chegar ao agente.
- Sem `PUBLIC_URL` válido, o Worker recusa tudo com `NOT_CONFIGURED` em vez de
  atender qualquer host.
- Senha com PBKDF2-SHA-256 (100.000 iterações) e pepper; política de 15+
  caracteres em que partes previsíveis não contam, conferência no Have I Been
  Pwned por k-anonimato com falha fechada, e troca exigida quando a senha atual
  é fraca.
- Sessões em cookie `__Host-zuri_session` (`HttpOnly`, `Secure`,
  `SameSite=Strict`), guardadas só como HMAC; CSRF por cabeçalho e origem em
  toda rota da API.
- Força bruta: 3 falhas por rede em 15 min, limite reduzido num ataque
  distribuído, Turnstile adaptativo opcional depois de 1 falha da rede ou 10 no
  total, sempre antes do PBKDF2 e com falha fechada.
- Redefinir a senha pelo painel da Cloudflare vale já na primeira requisição
  depois do deploy: a senha antiga não entra nem uma vez.
- Segundo passo do login: segredo TOTP cifrado, códigos de recuperação só como
  hash, código usado uma vez só, desafio de 5 minutos em cookie `__Host-` com
  5 respostas, e pausa para redes desconhecidas depois de 10 respostas erradas
  em 15 minutos. Passkeys presas ao host do `PUBLIC_URL`, com desafio de uso
  único e contador de assinatura conferido.
- Durante um ataque distribuído, cada recusa custa quase nenhuma leitura ou
  gravação no banco, para o atacante não esgotar as cotas diárias do plano
  Free. Navegadores que já entraram continuam podendo entrar. Recomendado:
  uma regra gratuita de rate limiting do WAF em `/api/auth/*`
  (`docs/seguranca.md`).

### Atualização

- Migration 7 cria `zur_usage_daily` e `zur_model_usage_daily`, só com
  contadores de uso da IA (nenhum texto), guardados por 90 dias. Nada muda nos
  dados que já existem. O Worker passa a declarar o binding `AI` (Workers AI,
  já previsto na especificação e dentro do plano gratuito).
- ⚠️ **Ação necessária antes do próximo deploy:** crie um widget do Turnstile
  (gratuito) e grave `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` como
  segredos do Worker. Sem eles o login responde "falta configurar a
  verificação contra robôs". Passo a passo em `docs/configuracao-cloudflare.md`.
- Migration 6 cria `zur_memories` (com busca FTS5) e `zur_memory_reviews`,
  além dos contadores de memórias. Nada muda nos dados que já existem.
- Migration 5 cria o índice `zur_tasks_board`, com a ordem da lista de
  tarefas. Com 2.000 tarefas, "Todas" passa a ler 201 linhas do banco em vez
  de 4.001, e "Próximas", 711 em vez de 2.491. As migrations conferidas ao
  acordar o objeto leem 1 linha em vez de 91. Nada muda na tela. Ao rodar, a
  migration grava uma linha de índice por tarefa já guardada, uma vez só.
- Rulesets da `develop` e da `main` mudaram: check novo `lighthouse` e branch
  atualizada com a `develop` antes de mesclar. Importe os dois arquivos de
  `.github/rulesets/` de novo (passo a passo em `docs/configuracao-github.md`).
- Novos valores no painel da Cloudflare: a variável `PUBLIC_URL` e os segredos
  `SESSION_SECRET`, `PASSWORD_PEPPER`, `OWNER_PASSWORD_HASH` e `OWNER_EMAIL`.
  Opcionais: `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`. Detalhes em
  `docs/arquitetura.md`.
- Migration 1 do banco (`zur_settings`, `zur_activity` e
  `zur_schema_version`), aplicada sozinha na primeira requisição. Nada a fazer.
- `OWNER_PASSWORD_HASH` deixou de ser obrigatório: na instalação sem
  instalador, grave `OWNER_PASSWORD` (20+ caracteres); o primeiro login pede a
  troca e, depois dela, o segredo pode ser apagado do painel. Um
  `OWNER_PASSWORD_HASH` presente precisa estar no formato
  `pbkdf2$100000$<sal>$<hash>`. Opcionais novos: `TURNSTILE_SITE_KEY` e
  `TURNSTILE_SECRET_KEY` (grave os dois como segredo).
- Migration 4 do banco (`zur_projects`, `zur_tasks`, `zur_notes` com índice
  FTS5, `zur_trash` e `zur_counts`), aplicada sozinha na primeira requisição.
  Nada a fazer.
- Migration 2 do banco (`zur_sessions`, `zur_login_attempts`,
  `zur_auth_events`, `zur_auth_events_daily` e `zur_devices`), aplicada
  sozinha. Nada a fazer.
- Migration 3 do banco (`zur_mfa_secrets`, `zur_recovery_codes`,
  `zur_passkeys` e `zur_mfa_challenges`), aplicada sozinha. Nada a fazer. Um
  `PASSWORD_PEPPER` novo agora também desliga a verificação em duas etapas
  (redefinição completa); um segredo de senha novo, não.
