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

## 4. Depois de cada merge

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
   lado e qualquer outro arquivo ficam para uma pessoa.
3. Envia o commit e dispara `ci.yml` e `codeql.yml` na branch. O push feito
   pelo token do GitHub Actions não dispara a CI da PR, por isso o disparo
   manual: são os mesmos jobs, e os checks exigidos aparecem no commit novo.
4. Deixa um único comentário na PR, editado a cada rodada (edição não
   notifica): o que resolveu sozinho, ou os arquivos que precisam de uma
   pessoa. Quando a `develop` muda arquivos de `.github/workflows/`, o token
   não pode enviar; o comentário avisa e a atualização fica manual. Push
   recusado pelo GitHub também vira aviso.
5. Uma PR que falha não para as outras; a rodada termina vermelha para
   alguém ver. Se o disparo da CI falhou depois do push, a rodada seguinte
   percebe o commit de merge sem CI e dispara de novo.

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
  `CHANGELOG.md` só muda no release, com `node scripts/changelog.ts --gravar`.
- Registro das partes do catálogo uma por linha, e o teste de i18n confere as
  partes exportadas sem lista própria (`.claude/rules/i18n.md`).
- Itens novos de listas e tabelas numa linha nova, sem reescrever a vizinha
  (`.claude/rules/documentacao.md`).

O que sobra de manual: duas PRs mudando a mesma linha (por exemplo, a mesma
linha da tabela "O que já funciona" ou de `progresso.md`), código e
`package-lock.json`.

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

Recomendação: o Pablo liga "Allow auto-merge". A partir daí, a thread que
termina uma PR (CI, QA e auditoria registrados, nada pendente do Pablo, sem
⚠️ sem OK) liga o auto-merge na PR em vez de mesclar na mão, e a rotina de
hora em hora só confere PRs paradas e conflitos que precisam de pessoa. Sem o
auto-merge ligado, a regra é uma só: **só a rotina "Mesclar PRs prontas para
develop" mescla**, uma PR por vez, e as threads param ao deixar a PR pronta.

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
