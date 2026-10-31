---
name: preparar-pr
description: Prepara título, changelog e descrição do PR do Zuri em pt-BR, com matriz de QA e relatório de segurança. Use quando a etapa estiver verificada, revisada e auditada.
---

# Preparar o PR

1. **Título** em Conventional Commits: prefixo em inglês, resto em pt-BR, imperativo, até 72 caracteres (ex.: `feat(telegram): adiciona comandos de consulta e ação rápida`).
2. **Changelog**: entrada em `## Não lançado`, no grupo certo, citando o PR. Recurso que pode sair do plano gratuito leva ⚠️. Mudança só interna leva o rótulo `sem-changelog`.
3. **README**: se o PR muda funcionalidade, conclui etapa, muda uma tela das capturas ou a arquitetura, atualize o `README.md` no mesmo PR seguindo `.claude/rules/readme.md` (mapa das etapas, "O que já funciona", capturas com `node scripts/capturas-do-readme.ts`). Diga na descrição o que mudou no README, ou por que não mudou.
4. **Capturas de tela**: se o PR cria ou muda uma tela, gere as capturas seguindo `.claude/rules/capturas.md` (`node scripts/capturas-da-interface.ts docs/capturas/pr/<assunto> --exemplos <tela>=<rota>`), confira cada imagem, faça commit e preencha a seção "Capturas de tela" do modelo com os links fixados no commit. Sem mudança visível, escreva isso na seção.
5. **Descrição** com o modelo `.github/pull_request_template.md`: o que muda e por quê, etapa da especificação, capturas de tela, matriz de rastreabilidade, QA, segurança, como foi testado (comandos e resultados reais), migrations e segredos novos, ⚠️ de custo, decisões novas registradas em `.claude/memoria/decisoes.md`.
6. **Revisão do texto.** Passe a descrição, o changelog, o README e as docs novas pela `humanizer:humanizer`: tire marcas de escrita de IA sem mudar fatos, números, nomes do código nem o modelo do PR. Esta skill vence a `mattpocock-skills:pr` em formato e idioma.
7. Confira que a branch está atualizada com `develop`, sem conflitos, e que a CI está verde antes de pedir revisão.
