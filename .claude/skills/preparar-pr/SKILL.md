---
name: preparar-pr
description: Prepara título, changelog e descrição do PR do Zuri em pt-BR, com matriz de QA e relatório de segurança. Use quando a etapa estiver verificada, revisada e auditada.
---

# Preparar o PR

1. **Título** em Conventional Commits: prefixo em inglês, resto em pt-BR, imperativo, até 72 caracteres (ex.: `feat(telegram): adiciona comandos de consulta e ação rápida`).
2. **Changelog**: entrada em `## Não lançado`, no grupo certo, citando o PR. Recurso que pode sair do plano gratuito leva ⚠️. Mudança só interna leva o rótulo `sem-changelog`.
3. **Descrição** com o modelo `.github/pull_request_template.md`: o que muda e por quê, etapa da especificação, matriz de rastreabilidade, QA, segurança, como foi testado (comandos e resultados reais), migrations e segredos novos, ⚠️ de custo, decisões novas registradas em `.claude/memoria/decisoes.md`.
4. **Revisão do texto.** Passe a descrição, o changelog e as docs novas pela `humanizer:humanizer`: tire marcas de escrita de IA sem mudar fatos, números, nomes do código nem o modelo do PR. Esta skill vence a `mattpocock-skills:pr` em formato e idioma.
5. Confira que a branch está atualizada com `develop`, sem conflitos, e que a CI está verde antes de pedir revisão.
