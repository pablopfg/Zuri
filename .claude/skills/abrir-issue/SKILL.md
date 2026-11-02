---
name: abrir-issue
description: Abre uma issue de erro padronizada no GitHub do Zuri, com o erro descrito e a possível solução. Use quando achar um erro fora do escopo da PR atual, um teste instável herdado ou uma falha na develop.
---

# Abrir issue de erro

Procedimento completo: `docs/agente/issues.md`.

1. **Decida se é issue.** Erro dentro do escopo da PR: corrija nela e pare aqui. Falha de segurança: não abra issue pública; avise o Pablo e siga `SECURITY.md`.
2. **Procure duplicada**: `gh api -X GET search/issues -f q='repo:pablopfg/Zuri is:issue is:open label:erro <termos>'`. Se existir, comente o que há de novo e pare.
3. **Investigue o bastante para propor a solução**: reproduza, ache o arquivo e a linha, diga qual teste provaria a correção (`mattpocock-skills:diagnosing-bugs` ajuda). Uma issue sem possível solução está incompleta.
4. **Escreva o corpo** com os títulos de `.github/ISSUE_TEMPLATE/erro.yml`, nesta ordem: `### Onde aconteceu`, `### Contexto`, `### Passos para reproduzir`, `### Esperado`, `### Obtido`, `### Código do erro`, `### Possível solução`, `### Impacto`. Título `[erro] <o que quebra, em poucas palavras>`.
5. **Revise antes de enviar**: nada de domínio, e-mail, ids, IP, tokens, chaves ou texto do dono (o repositório é público). Passe o texto pela `humanizer:humanizer`.
6. **Abra** com a ferramenta `issue_write` do GitHub (ou `gh issue create`), rótulo `erro`.
7. **Registre** o número da issue na descrição da sua PR ou em `progresso.md`, se afeta uma etapa. Quem corrigir escreve `Closes #N` na PR.
