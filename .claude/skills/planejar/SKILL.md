---
name: planejar
description: Escreve o plano detalhado de uma etapa, ajuste ou estudo do Zuri no modelo de docs/planos/modelo-de-plano.md, com o contexto do sistema e entrevista com o Pablo quando faltar decisão dele. Use antes de codar qualquer etapa (iniciar-etapa chama esta skill) ou quando o Pablo pedir um plano, estudo ou viabilidade.
---

# Planejar

O plano é o contrato da entrega: quem o lê sabe o que o Pablo vai ver, o que
muda no código, quanto custa e como se prova que funciona. Sai em
`docs/planos/<assunto>.md` (etapa: `etapa-NN-<assunto>.md`), no modelo
`docs/planos/modelo-de-plano.md`, versionado no mesmo PR da entrega.

## 1. Juntar o contexto (fato é trabalho seu)

Leia só o que a entrega toca, achando com `grep -n` antes de abrir:

- `.claude/memoria/progresso.md`, `.claude/memoria/decisoes.md` e
  `.claude/memoria/glossario.md`.
- Da especificação, o bloco da etapa, "Contratos, constantes e referências" e
  as seções citadas (índice: `grep -n '^## \|^### \|^\*\*Etapa ' docs/especificacao.md`).
- O bloco da etapa em `docs/agente/prompts-das-etapas.md`.
- Os planos de `docs/planos/` e os docs de `docs/` da mesma área.
- O código que vai mudar e os testes vizinhos. Liste caminhos reais; nunca
  invente nome de módulo, rota ou tabela.
- Limites e preços: `docs/arquitetura/orcamento-free-tier.md` e a
  documentação oficial (skills `cloudflare:*`, `mattpocock-skills:research`).
  Anote a fonte.
- Referência no Talorys, se a etapa indicar (clone de leitura fora do repo).

Não pergunte ao Pablo nada que dê para descobrir lendo.

## 2. Separar o que é do Pablo

Classifique cada ponto em aberto:

| Tipo | Exemplo | Quem decide |
| --- | --- | --- |
| Produto | o que aparece na tela, texto, fluxo, o que entra e o que fica fora | Pablo |
| Custo | recurso que pode cobrar, uso perto da cota | Pablo (⚠️) |
| Segurança com troca de usabilidade | pedir senha de novo, quanto tempo dura uma trava | Pablo |
| Integração com conta dele | qual conta Google, quais etiquetas, qual bot | Pablo |
| Técnico | nome de módulo, índice, biblioteca já aprovada | você, em "Suposições" |

Já decidido em `decisoes.md`, num plano anterior ou na especificação não é
pergunta: cite a decisão.

## 3. Entrevistar (só quando houver ponto do Pablo)

Siga o formato de rodadas da `mattpocock-skills:grilling`, com estes limites:

- Até 3 perguntas por rodada, numeradas, cada uma com a sua recomendação, as
  opções e o que muda em cada uma. Escreva de modo que "sim" aceite a
  recomendação.
- Só pergunte o que a resposta anterior já destravou.
- Um ponto só com 2 a 4 saídas claras: cartão de decisão
  (`request_decision`) em vez de mensagem.
- No máximo 3 rodadas. Depois disso, o que sobrou vai para "Perguntas
  abertas" com a sua recomendação.
- Enquanto espera, siga escrevendo o plano na recomendação. Nada que não se
  desfaz (custo, conta de produção, dado do dono) avança sem a resposta.
- Toda resposta entra na seção "Entrevista com o Pablo" do plano, e decisão
  nova vai para `decisoes.md` no mesmo PR (sem dados pessoais).

Sem ponto do Pablo, pule a entrevista e diga no plano: "Sem perguntas: tudo
coberto por <decisões>".

## 4. Escrever o plano

Preencha todas as seções do modelo. Para cada uma, confira:

- **Contexto**: caminhos reais e decisões citadas com data.
- **Critérios de aceite**: numerados, verificáveis, cada um com teste na
  seção 10.
- **Fluxos**: passo a passo do que o Pablo faz e vê, com todos os estados de
  tela, celular, tema escuro, teclado e leitor de tela. Tela nova ou
  redesenho: `frontend-design:frontend-design`.
- **Textos**: pt-BR e en com chave do catálogo, passados pela
  `humanizer:humanizer`.
- **Limites**: número exato, comportamento no limite e código de erro.
- **Custo**: uso típico e pior caso contra a cota, com fonte.
- **Segurança**: ameaça, defesa e teste em cada linha.
- **Desenho**: `mattpocock-skills:codebase-design` para as fronteiras e
  `mattpocock-skills:domain-modeling` para termos e ADR.
- **Escopo**: o que fica fora diz para onde vai.

Correção pequena (até uns 3 arquivos, sem tela, migration nem rota nova) usa
a versão curta do modelo.

## 5. Revisar antes de fechar

- [ ] Nenhuma seção vazia; a que não se aplica diz por quê.
- [ ] Todo CA tem teste; todo limite tem teste n−1, n, n+1.
- [ ] Nenhum nome inventado (confira cada caminho com `ls` ou `grep`).
- [ ] Nada de domínio, e-mail, id, token ou dado pessoal (use `exemplo.com.br`).
- [ ] Item com custo marcado ⚠️ e com a alternativa grátis.
- [ ] As regras invioláveis de `AGENTS.md` estão respeitadas.

## 6. Situação e próximo passo

- Teve pergunta de produto, custo ou segurança ainda sem resposta:
  "esperando o Pablo". Não implemente a parte que depende dela.
- Respostas dadas ou nenhuma pergunta: "aprovado" (com a data das respostas)
  e siga com a implementação. O Pablo revisa o plano no PR.
- No PR, a seção "Plano" do modelo traz o link do arquivo e um resumo de até
  5 linhas.
- Na mensagem ao Pablo, só o resumo, as perguntas (se houver) e o link do
  plano. O plano inteiro fica no arquivo.
