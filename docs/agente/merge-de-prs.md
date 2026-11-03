# Merge das PRs abertas para a `develop`

Pedido do Pablo (02/11/2026): verificar com frequência as PRs abertas para a
`develop`, corrigir conflitos e mesclar as que estiverem prontas, na ordem
certa. PR parada vira conflito com as próximas. Este é o procedimento que a
thread de merge e a rotina agendada seguem.

Nunca mescle na `main`, nunca faça release ou deploy. Isso é do Pablo.

## 1. Levantar o que está aberto

Liste as PRs abertas com base `develop`, da mais antiga para a mais nova. Para
cada uma, anote:

- estado da CI no último commit (todos os checks exigidos);
- `mergeable_state`: `clean`, `behind` (atrás da `develop`, sem conflito),
  `dirty` (conflito) ou `blocked`;
- se é rascunho;
- qual thread é dona da PR e se ela ainda está trabalhando nela;
- os arquivos que ela muda (para achar PRs que se cruzam).
- se o check `merge-order` está vermelho (ela espera uma PR mais antiga; veja a
  seção 3) e se tem o comentário "Conflito com a develop que precisa de uma
  pessoa" do `Update PRs`. Essas PRs vêm primeiro: ninguém mais pega o aviso.

## 2. Quando uma PR pode ser mesclada

Todas as condições, sem exceção:

- [ ] Não é rascunho.
- [ ] CI toda verde no último commit, com a branch em dia com a `develop`
      (o ruleset exige branch atualizada).
- [ ] QA e auditoria de segurança registradas no corpo, sem achado alto ou
      médio aberto. PR de etapa também cumpre as travas da skill
      `proxima-etapa`.
- [ ] Nenhuma pergunta ou decisão pendente do Pablo na PR ou na thread dona.
- [ ] Nada marcado com ⚠️ (custo) sem o OK explícito do Pablo.
- [ ] A thread dona terminou. Se ela ainda está mexendo na PR, não mescle:
      ela mescla sozinha quando ficar verde. Só intervenha se a PR ficar
      parada (verde e sem movimento) ou com conflito, e avise a thread dona
      antes, para ninguém agir duas vezes.

Faltou alguma: a PR fica aguardando e o motivo entra no relatório.

## 3. Ordem de merge

Uma PR por vez, sempre por squash.

1. PRs que mudam os mesmos arquivos entram na ordem em que foram abertas.
2. Entre as independentes, primeiro as menores e as mais antigas: correções e
   docs antes de etapas grandes.
3. Uma etapa nunca entra antes das etapas de que ela depende (tabela
   "Dependências entre etapas" da especificação).

O auto-merge do GitHub não conhece ordem: ele mescla a PR que ficar verde
primeiro. Por isso a regra 1 virou um check exigido, o `merge-order`
(`.github/workflows/merge-order.yml`, `scripts/ordem-de-merge.ts`). Ele fica
vermelho enquanto existir uma PR **mais antiga** (número menor), aberta para a
`develop`, fora de rascunho e deste repositório (PR de fork nunca segura
ninguém), que muda algum dos mesmos arquivos. Não contam os arquivos em que o
`Update PRs` junta acréscimos sozinho (changelog, `README.md`, memória,
`docs/**/*.md` e os catálogos de texto `pt-BR*.ts` e `en.ts`). Se nesses
arquivos as duas PRs mudarem a mesma linha, o conflito ainda aparece, mas é
texto e se resolve rápido; contar o `README.md`, que quase toda PR muda,
enfileiraria todas as PRs. Com o check vermelho, o auto-merge espera.

Quando o resultado muda:

- **A mais antiga entra:** a `develop` muda, o `Update PRs` traz a `develop`
  para a mais nova, aprova a CI e o `merge-order` do commit novo, e o check
  passa.
- **A mais antiga é fechada, sai do rascunho ou passa a mudar outros
  arquivos:** nada acontece na PR mais nova, então o `Update PRs` também roda
  a cada 15 minutos e, a cada rodada, recalcula o `merge-order` de toda PR
  aberta para a `develop`. Onde o último resultado não bate, ele reexecuta a
  execução de `pull_request` do check naquela branch. Isso também cobre a PR com o
  rótulo `sem-atualizacao-automatica` e a `develop` que mudou workflows. Fica
  uma janela de até 15 minutos em que uma PR mais nova, já verde, pode entrar
  na frente de uma mais antiga que acabou de sair do rascunho.
- **Rótulo novo na PR** (veja abaixo): o check roda sozinho.

- **Passar na frente de propósito** (a mais antiga está parada, esperando o
  Pablo ou com conflito que vai demorar): ponha o rótulo `fora-de-ordem` na
  PR mais nova e diga o motivo na PR. Só a rotina de merge ou o Pablo decidem
  isso; a thread dona da PR mais nova não se autoriza. Quem fica para trás
  resolve o conflito depois, como na seção 4.
- O check só lê a lista de PRs abertas e os arquivos de cada uma: não comenta,
  não mescla, não muda nada. O script vem sempre da `develop`, então uma PR
  não consegue mudar a regra que a julga.

## 4. Depois de cada merge

O workflow `Versão` (`.github/workflows/versao.yml`) dá o número da versão ao
merge, cria a tag e a pré-release e abre ou refaz a PR `chore(release):` com
as seções do `CHANGELOG.md`. Essa PR tem auto-merge e o rótulo
`sem-atualizacao-automatica`; trate-a como qualquer outra PR verde e nunca
edite a branch `chore/versao` à mão (`docs/agente/versionamento.md`).

O merge dessas PRs automáticas (a `chore(release):` e a
`docs(readme): … (automático)`) é feito pelo `GITHUB_TOKEN`, e o GitHub não
dispara workflow nenhum por evento que esse token causou: a `develop` anda sem
execução de `push`. Os agendamentos também não cobrem; o GitHub descarta
quase todos (em 03/11/2026, 4 execuções agendadas do `Update PRs` em 26 horas,
em vez de umas 100). Por isso o `README` e o `Versão` terminam toda execução
chamando o workflow `Seguir merge` (`.github/workflows/seguir-merge.yml`,
`scripts/seguir-merge.ts`). Ele espera a PR da própria branch entrar (até
40 minutos, lendo a cada 30 s) e chama por `workflow_dispatch`, o único evento
que o `GITHUB_TOKEN` sempre consegue disparar, o `Update PRs`, o `Branches` e o
outro workflow automático, cuja PR também ficou atrás. Sem PR aberta, termina
na hora; PR fechada sem merge não chama nada. Ele só lê PRs e dispara
workflows na `develop`. Caso que motivou: #140 e #141 atrás da `develop`
depois da #139.

O workflow `Update PRs` (`.github/workflows/update-prs.yml`) cuida da maior
parte sozinho. Cada vez que a `develop` muda, ele roda
`scripts/atualizar-prs.ts` a partir da `develop` e, para cada PR aberta com
base `develop` (menos rascunho, branch de fork e PR com o rótulo
`sem-atualizacao-automatica`):

1. Traz a `develop` para a branch com um commit de merge (nunca rebase, nunca
   force push).
2. Se o conflito é só acréscimo dos dois lados no mesmo lugar (duas entradas
   de changelog, duas linhas de tabela no README, duas chaves no catálogo de
   textos, dois itens na memória), mantém os dois: primeiro o da `develop`,
   depois o da PR. Isso vale para `CHANGELOG.md`, `README.md`,
   `changelog/**`, `.claude/memoria/*.md`, `docs/**/*.md` e
   os catálogos `packages/shared/i18n/{pt-BR*,en}.ts`. Linha mudada ou
   apagada, a mesma linha acrescentada dos dois lados, arquivo apagado ou
   criado dos dois lados, link simbólico, quebra de linha CRLF e qualquer
   outro arquivo (inclusive `i18n/index.ts`, que tem lógica) ficam para uma
   pessoa. Se um arquivo precisa de pessoa, nada é resolvido naquela rodada.
3. Envia o commit e aprova as execuções que o próprio push criou. O push do
   `github-actions[bot]` gera as execuções de `pull_request` (CI, CodeQL e
   Merge order), mas o GitHub as segura como "action_required" até alguém
   aprovar, porque o repositório pede aprovação para colaborador de fora e o
   bot conta como um. O script espera elas aparecerem (até uns 40 s) e aprova
   só as do bot, no commit que ele enviou, da própria branch (nunca de fork).
   Disparar a CI por `workflow_dispatch` não serve: os checks aparecem verdes
   no commit, mas o ruleset só conta os de `pull_request`, e o merge fica em
   "Expected" (caso da #60, 02/11/2026).
4. Deixa um único comentário na PR, editado a cada rodada (edição não
   notifica): o que resolveu sozinho, ou os arquivos que precisam de uma
   pessoa. Quando a `develop` muda arquivos de `.github/workflows/`, o token
   não pode enviar; o comentário avisa e a atualização fica manual. Push
   recusado pelo GitHub também vira aviso.
5. Uma PR que falha não para as outras; a rodada termina vermelha para
   alguém ver. Se a aprovação falhou ou alguma execução não apareceu, o
   comentário "A CI deste commit está parada esperando aprovação" avisa, e a
   rodada seguinte (no máximo 15 minutos depois) tenta aprovar de novo. Se
   continuar parado, aprove na mão: Actions, a execução, "Approve and run".
   Quem não pode aprovar (uma thread, por exemplo) tem outra saída: pôr o
   rótulo `sem-atualizacao-automatica` na PR para o bot parar de enviar
   commits nela e trazer a `develop` com o próprio push (`git merge
   origin/develop` ou `node scripts/atualizar-prs.ts --local`). Push de
   pessoa ou de thread roda a CI sem precisar de aprovação. Tire o rótulo
   depois do merge, se a PR continuar aberta.

O workflow só resolve conflito de acréscimo em arquivo de lista. Conflito em
código (duas PRs mudando as mesmas linhas de `prompt.ts`, por exemplo) não
tem resolução mecânica segura: juntar os dois lados às cegas compila e quebra
o comportamento. Isso fica com quem entende a mudança, e o comentário na PR
avisa.

O que continua com a thread dona ou com a passada de merge:

- **Conflito que o workflow não resolveu** (comentário "Conflito com a
  develop que precisa de uma pessoa"): rode
  `node scripts/atualizar-prs.ts --local` na branch. Ele traz a `develop`,
  resolve os acréscimos como o workflow e para nos arquivos que sobraram.
  Resolva esses preservando os dois lados. Migration nunca é editada nem
  reordenada: se as duas PRs criaram a mesma posição, a que entrou depois
  ganha o próximo número numa migration nova. Antes do push, rode
  `npm run typecheck`, `npm run lint` e os testes das áreas tocadas; quando o
  conflito for em código, `npm test` completo. Se a resolução pedir decisão
  de produto, pare e pergunte ao Pablo.
- **Mudança em workflow na `develop`:** botão "Update branch" da PR ou o
  mesmo comando local.
- **Conferir o resultado automático:** a ordem das entradas juntadas e a CI
  verde no commit novo. Mesclar continua sendo a seção 2.
- Se a thread dona ainda existe, avise o que foi feito na branch dela.

Quem trabalha numa branch de PR faz `git pull --no-rebase origin <branch>`
antes de cada push, porque o workflow pode ter enviado um merge nela.

### Por que os conflitos aconteciam

Levantamento das PRs #28 a #46 (02/11/2026): o `CHANGELOG.md` mudou em 17 das
22 últimas PRs, `.claude/memoria/decisoes.md` em 14, o catálogo em inglês em
10 e o `README.md` em 8. Quase todo conflito era duas PRs acrescentando no
mesmo ponto (o topo de "Adicionado", o fim de uma tabela) ou editando a mesma
linha longa (a lista de partes do catálogo em `pt-BR.ts`, `index.ts` e no
teste de i18n). As causas que deu para tirar:

- Changelog em arquivos por PR (`changelog/nao-lancado/<assunto>.md`). O
  `CHANGELOG.md` só muda pela PR `chore(release):` que o workflow `Versão`
  abre depois de cada merge (`docs/agente/versionamento.md`).
- Registro das partes do catálogo uma por linha, e o teste de i18n confere as
  partes exportadas sem lista própria (`.claude/rules/i18n.md`).
- Itens novos de listas e tabelas numa linha nova, sem reescrever a vizinha
  (`.claude/rules/documentacao.md`).

O que sobra de manual: duas PRs mudando a mesma linha (por exemplo, a mesma
linha da tabela "O que já funciona" ou de `progresso.md`), código e
`package-lock.json`.

### O que aconteceu com a #50 e a #52 (02/11/2026)

A #50 (personalidade no prompt, aberta 03:20) e a #52 (modelo reserva, aberta
03:27) mudavam `apps/agent/src/agent/prompt.ts`, `runner.ts` e o `README.md`.
Pelos logs do `Update PRs` e dos checks:

- 03:30, depois da #51: a #50 teve conflito no `README.md` (linha mudada, não
  só acrescentada). O workflow comentou, e a thread dona resolveu às 03:36.
- 03:38: o workflow trouxe a #48 para a #50 sem conflito e disparou a CI.
  A #50 ficou verde e em dia às 03:50; a #52, às 03:51.
- 03:52: o GitHub mesclou a #52. A #50 não entrou antes, embora estivesse
  pronta um minuto antes; a API não diz quando o auto-merge dela foi ligado,
  então o mais provável é que ainda não estivesse. De todo jeito, nada
  impedia a mais nova de passar na frente.
- Na rodada seguinte o conflito da #50 incluía `prompt.ts` e `runner.ts`.
  Código o workflow não resolve, de propósito, e ele comentou pedindo uma
  pessoa. A resolução à mão saiu às 03:58 e a #50 entrou às 04:06.

O workflow fez o que foi desenhado para fazer. Faltava garantir a ordem, e é
isso que o check `merge-order` faz agora.

### Corrida de merge e o que o GitHub oferece

O ruleset da `develop` exige branch em dia (`strict_required_status_checks_policy`)
e a CI leva uns 7 minutos. Com várias threads mesclando em paralelo, uma PR
verde fica atrás de novo antes de terminar a CI seguinte: a #41 perdeu quatro
corridas assim (#38, #39, #40, #43 e #44 entraram no meio). Tirar a exigência
de branch em dia resolveria a corrida, mas deixaria entrar na `develop` uma
combinação que a CI nunca testou; ela fica.

- **Fila de merge (merge queue):** resolveria de vez, mas o GitHub só oferece
  para repositório de organização. O Zuri é de conta pessoal, então não dá.
- **Botão "Update branch" automático:** o GitHub não tem. A opção "Always
  suggest updating pull request branches" só mostra o botão. O workflow
  `Update PRs` faz esse papel.
- **Auto-merge do GitHub** (Settings > General > "Allow auto-merge", grátis em
  repositório público): a PR mescla sozinha, por squash, assim que fica em dia
  e com os checks verdes. Junto com o `Update PRs`, a corrida deixa de gastar
  tempo de thread: depois de cada merge, as outras PRs são atualizadas, a CI
  roda e a primeira que terminar verde entra. Quem perder a corrida é
  atualizada de novo sem ninguém mexer.

**Regra (02/11/2026, o Pablo ligou "Allow auto-merge"):** a thread que
termina uma PR e cumpre a seção 2 em tudo que não é a CI (QA e auditoria
registrados, nada pendente do Pablo, nenhum ⚠️ sem OK) liga o auto-merge na
PR, por squash, em vez de mesclar na mão. O GitHub mescla quando a CI fica
verde com a branch em dia; o `Update PRs` mantém a branch em dia. A rotina de
hora em hora não disputa corrida: ela só cuida das PRs paradas e dos conflitos
que precisam de uma pessoa, e liga o auto-merge nas PRs prontas cuja thread
já terminou. Se o auto-merge estiver desligado no repositório, só a rotina
mescla, uma PR por vez.

## 5. O que nunca fazer

- Mesclar com check vermelho, pendente ou pulado.
- Desligar, pular ou afrouxar teste ou regra de segurança para a CI passar.
- Reescrever o histórico de uma branch que não é sua (sem force push), nem
  desfazer o commit de merge que o workflow `Update PRs` enviou.
- Fechar e reabrir PR ou mandar commit vazio para disparar a CI.
- Mesclar na `main`, fazer release ou deploy.

## 6. Relatório

Ao fim de cada passada, em pt-BR e curto:

- o que foi mesclado, com o link;
- o que ficou aguardando e por quê (CI rodando, thread dona trabalhando,
  decisão do Pablo, conflito que precisa de produto);
- conflitos resolvidos e os comandos rodados.

Sem nada para fazer, não precisa avisar o Pablo.
