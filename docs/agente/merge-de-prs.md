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

As PRs que sobraram ficam atrás da `develop`. Para cada uma, na ordem acima:

- **`behind`, sem conflito:** atualize a branch com a `develop` (botão
  "Update branch" ou a API) e espere a CI rodar de novo. Só mescle com a CI
  verde nesse commit novo.
- **`dirty`, com conflito:** traga a `develop` para a branch e resolva
  preservando os dois lados. No `CHANGELOG.md` e no `README.md`, as duas
  entradas ficam. Migration nunca é editada nem reordenada: se as duas PRs
  criaram a mesma posição, a que entrou depois ganha o próximo número numa
  migration nova. Antes do push, rode `npm run typecheck`, `npm run lint` e os
  testes das áreas tocadas; quando o conflito for em código, `npm test`
  completo. Se a resolução pedir decisão de produto, pare e pergunte ao Pablo.
- Se a thread dona ainda existe, avise o que foi feito na branch dela.

## 5. O que nunca fazer

- Mesclar com check vermelho, pendente ou pulado.
- Desligar, pular ou afrouxar teste ou regra de segurança para a CI passar.
- Reescrever o histórico de uma branch que não é sua (sem force push).
- Fechar e reabrir PR ou mandar commit vazio para disparar a CI.
- Mesclar na `main`, fazer release ou deploy.

## 6. Relatório

Ao fim de cada passada, em pt-BR e curto:

- o que foi mesclado, com o link;
- o que ficou aguardando e por quê (CI rodando, thread dona trabalhando,
  decisão do Pablo, conflito que precisa de produto);
- conflitos resolvidos e os comandos rodados.

Sem nada para fazer, não precisa avisar o Pablo.
