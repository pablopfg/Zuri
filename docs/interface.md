# Interface web

A interface do Zuri é um app React servido pelo próprio Worker (binding
`ASSETS`), com React Router, TanStack Query e Tailwind. Ela passa pelos mesmos
portões da API e não guarda segredo nenhum: o bundle só conhece o caminho
`/api`.

## Endereços

| Caminho | Tela | Sessão |
| --- | --- | --- |
| `/entrar` | Login (senha, depois código ou passkey quando a verificação em duas etapas está ligada) | não |
| `/` | Início (o chat chega na etapa 9) | sim |
| `/tarefas` | Tarefas: visões por prazo, filtro por projeto, busca, nova tarefa, edição, conclusão, projetos | sim |
| `/notas` | Notas: lista com busca em texto completo (ao lado do editor em telas largas) | sim |
| `/notas/nova`, `/notas/:id` | Editor de nota em Markdown, com visualização | sim |
| `/configuracoes/:aba` | Configurações: `conta`, `seguranca`, `ia`, `avisos`, `integracoes`, `dados` (lixeira) | sim |
| qualquer outro | Página não encontrada, dentro do app | sim |

Sem sessão, toda página privada leva a `/entrar?next=<caminho>`. Depois do
login o app abre o `next`, mas só se for um caminho deste app: URL absoluta,
`//host`, barra invertida, caractere de controle ou o próprio `/entrar` voltam
para o início (`apps/web/src/lib/next.ts`).

## Sessão no navegador

- **Nada privado aparece antes da resposta do servidor.** `RequireSession`
  pergunta `GET /api/auth/session`; enquanto isso, só o logo e "Conferindo a
  sua sessão…".
- **Uso real.** Clique, tecla, toque ou roda do mouse marcam uso (só a hora).
  Pedidos feitos até 10 s depois levam `x-zuri-activity: 1`; atualizações em
  segundo plano não mantêm a sessão viva.
- **Sinal de aba aberta.** Uma aba por navegador (Web Locks) manda
  `POST /api/auth/heartbeat` a cada minuto.
- **Aviso e saída.** Dois minutos antes do fim por falta de uso aparece um
  aviso com contagem e o botão "Continuar conectado". No fim, todas as abas
  saem juntas (BroadcastChannel) e o login explica o motivo. O prazo conta
  pelo relógio do servidor convertido para o do aparelho, então um relógio
  errado no celular não encerra nem prolonga a sessão.
- **401 em qualquer pedido** (sessão encerrada pelo servidor, cookie apagado)
  limpa os dados da memória e leva ao login com `?next=`.
- **Senha recente.** Quando a API responde `RECENT_AUTH_REQUIRED`, um diálogo
  pede a senha (ou o código do aplicativo, com a verificação ligada) e repete a
  ação uma vez.
- **Troca de senha obrigatória.** Com `passwordChangeRequired`, a única tela é
  a de troca de senha, igual ao que o servidor permite.

## PWA

`manifest.webmanifest`, ícones (192, 512, maskable 512 e o do iOS) e um
service worker (`public/sw.js`) que **não guarda nada em cache e não tem
handler de `fetch`**: toda página e toda resposta da API vêm da rede. Assim um
aparelho compartilhado ou desconectado nunca mostra dado privado de um cache.
Um teste unitário confere o arquivo e um e2e confere no Chromium que o app é
instalável e que, offline, a API falha em vez de responder do cache. Toda
resposta de `/api/*` sai com `Cache-Control: no-store`, e o cliente pede com
`cache: "no-store"`.

## Casca depois do login

Segue a UI do Talorys (decisão do Pablo, 31/10/2026):

- **Computador:** barra lateral de altura total (`AppShell`), com a marca e o
  sino de avisos no topo, as seções do app no meio e Configurações e Sair no
  pé. Uma seção nova é um item a mais em `sections`.
  "Recolher menu", no pé, troca a barra por uma coluna só de ícones. Cada
  ícone mostra o nome numa dica ao passar o mouse ou focar pelo teclado (Esc
  esconde a dica); o nome continua no controle para leitores de tela. A
  escolha fica em `localStorage` (`zuri.sidebar`), só neste navegador, e as
  outras abas acompanham. No celular a barra não existe, então nada muda.
- **Celular:** barra superior com a marca, os avisos e Sair; navegação inferior
  com as seções e Configurações.
- **Páginas:** começam com `PageHeader` (título, uma linha de contexto e ações
  à direita), numa coluna de até 5xl.
- **Lembrete de 2FA:** enquanto a verificação em duas etapas estiver
  desligada, uma faixa acima do conteúdo chama para ligar. "Lembrar depois"
  esconde por 3 dias, só neste navegador; nas Configurações ela não aparece.

## Identidade visual

Opção "Sinal", escolhida pelo Pablo: um "i" claro sobre um quadrado cor de
tinta (`#0b0f19`), com o pingo do i como uma luz verde (`#22c55e`). O verde
quer dizer "trabalhando" na interface toda, por isso é o único destaque. O
`Logo` aceita `working`, que faz a luz pulsar (só com movimento permitido); a
tela "Conferindo a sua sessão" já usa. O desenho passou no recorte redondo do
avatar do Telegram, no favicon de 16 px e em uma cor só (ícone de notificação).

Todas as cores da interface são variáveis em `apps/web/src/styles.css`; trocar
a identidade é trocar esse bloco, o `Logo.tsx`, o `public/favicon.svg` e gerar
os ícones de novo com `node scripts/gerar-icones.ts`.

Fora do app, a mesma identidade aparece no logo `docs/assets/zuri-logo.svg` e
nos banners do README (`docs/assets/zuri-banner-claro.svg` e
`zuri-banner-escuro.svg`), que seguem o tema do GitHub de quem lê.

## Acessibilidade

- WCAG 2.1 AA: contraste de pelo menos 4,5:1 nos dois temas, foco visível em
  todo controle, alvo de toque de 44 px, link "Pular para o conteúdo".
- Diálogos usam `<dialog>` nativo (foco preso, Esc fecha, fundo inerte).
- Campos com `<label>`; erros com `role="alert"` e ligados ao campo por
  `aria-describedby`; carregamentos com `role="status"`.
- O axe roda em todas as telas, nos temas claro e escuro, no computador e no
  celular (`tests/e2e/a11y.spec.ts`). O Lighthouse de acessibilidade fica no
  PR de cada etapa que muda telas.

## Tema e idioma

O tema (como o sistema, claro ou escuro) é escolha do aparelho e fica no
`localStorage`. O idioma e o fuso vêm das configurações da conta; antes do
login, o app usa o último idioma visto neste navegador ou o do próprio
navegador (pt-BR quando não reconhece).

## Capturas de tela

`node scripts/capturas-da-interface.ts <pasta> [--exemplos] [tela=/rota ...]`
tira as capturas das telas pedidas (sem pares, a de entrar e o início), nos
temas claro e escuro, no celular e no computador. `--exemplos` enche a base
com os dados de exemplo de `scripts/dados-de-exemplo.ts`. Precisa do servidor
dos e2e rodando numa base vazia. Todo PR que cria ou muda uma tela usa esse
script e mostra as imagens na descrição: veja `.claude/rules/capturas.md`.
