---
name: proxima-etapa
description: Fecha a etapa atual e passa o bastão para a próxima no modo contínuo - confere as travas, atualiza o progresso, mescla na develop quando permitido e pede uma conversa nova para a etapa seguinte. Use quando um PR de etapa estiver pronto (CI verde, QA e auditoria feitos).
---

# Fechar a etapa e seguir para a próxima

Objetivo: avançar sem o Pablo precisar mandar o próximo prompt, gastando o
mínimo de contexto. A etapa seguinte **sempre** começa numa conversa nova, que
lê só `progresso.md`, `decisoes.md` e o trecho da especificação dela.

## 1. Travas (todas precisam passar)

- [ ] CI verde no PR, com todos os checks exigidos.
- [ ] `revisao-qa` e `auditoria-seguranca` rodaram nesta etapa; nenhum achado
      alto ou médio aberto; relatórios no corpo do PR.
- [ ] Matriz de rastreabilidade completa (todo critério de aceite com teste).
- [ ] `CHANGELOG.md` e docs atualizados; `progresso.md` atualizado neste PR.
- [ ] `README.md` atualizado neste PR: etapa marcada ✅ no mapa, 🚧 na próxima, selo e "O que já funciona" (`.claude/rules/readme.md`).
- [ ] Etapa com telas: capturas no corpo do PR (computador e celular, claro e escuro) e em `docs/capturas/pr/<assunto>/` (`.claude/rules/capturas.md`).
- [ ] Nenhuma decisão de produto pendente.
- [ ] Os rulesets da `develop` e da `main` estão ativos no GitHub (o Pablo
      confirmou na etapa 0). Sem eles, não mescle sozinho.

Se alguma falhar, corrija. Na mesma causa, no máximo 3 tentativas; depois
pare e chame o Pablo (passo 4).

## 2. Mesclar

Leia a linha "Avanço" em `progresso.md`:

- **mescla sozinho**: mescle o PR na `develop` (squash). Nunca na `main`, nunca
  release, nunca deploy.
- **Pablo mescla**: avise o Pablo que o PR está pronto e espere o evento de
  mesclagem antes do passo 3.

## 3. Decidir a próxima

Na tabela "Dependências entre etapas" da especificação, pegue a menor etapa
cujas dependências estão mescladas. Pare (passo 4) em vez de seguir se:

- o prompt dela em `docs/agente/prompts-das-etapas.md` tem "▶ Antes, você
  fornece" e o item ainda não está pronto (confira em "Esperando o Pablo");
- é a etapa 21 (modelos pagos) sem "aprovado" do Pablo em `decisoes.md`;
- a etapa que acabou fecha uma fase e a linha "Avanço" pede pausa por fase
  (o padrão é não pausar);
- ela exige recurso que pode gerar custo ou mudar a conta de produção;
- `progresso.md` diz "Situação: pausado".

Se puder seguir: peça uma **conversa nova** para a etapa (no projeto do
Claude, peça ao coordenador uma thread nova com o bloco da etapa de
`docs/agente/prompts-das-etapas.md`; no Claude
Code, rode `/clear` antes). Não comece a etapa seguinte nesta conversa.

Se a conversa ficar longa no meio da etapa, use `mattpocock-skills:handoff` para escrever o resumo em `progresso.md` (não em arquivo novo) e peça uma thread nova da mesma etapa.

## 4. Pausar

Escreva em "Pausado por" o motivo e o que falta, e mande ao Pablo uma
mensagem curta: o que foi entregue (links dos PRs), por que parou, o que ele
precisa fazer, e a sua recomendação.

## Resumo de fase

Ao fechar uma fase (etapas 5, 11, 16, 22 e 25), mande ao Pablo um resumo e
siga sem esperar resposta, a não ser que haja pausa por fase. Até 15 linhas: etapas entregues com PRs, testes (contagem), achados de
auditoria corrigidos, dívidas, o que vem na próxima fase e o que ela precisa
do Pablo.
