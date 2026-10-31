---
name: iniciar-etapa
description: Começa uma etapa da especificação do Zuri - lê a etapa, confere dependências e decisões, estuda a referência no Talorys e escreve o plano antes de codar. Use ao iniciar qualquer etapa (ex. "inicie a etapa 7").
---

# Iniciar uma etapa

1. **Leia só o necessário**, nesta ordem: `.claude/memoria/progresso.md`, `.claude/memoria/decisoes.md` e, da especificação, apenas o bloco da etapa, a seção "Contratos, constantes e referências" e as seções que a etapa cita. Não leia `docs/especificacao.md` inteiro: monte o índice com `grep -n '^## \|^### \|^\*\*Etapa ' docs/especificacao.md` e leia os trechos com `sed -n '<início>,<fim>p'`.
2. **Dependências.** Confira na tabela "Dependências entre etapas" que as anteriores estão mescladas em `develop` (`git log origin/develop --oneline`). Se faltar alguma, pare e avise.
3. **Decisões.** Confira em `.claude/memoria/decisoes.md` as decisões que a etapa usa (N1 a N12). Uma decisão sem padrão bloqueia: pergunte ao dono com uma recomendação.
4. **Referência.** Leia só os arquivos do Talorys indicados (clone de leitura fora deste repositório), achando os trechos com `grep -n` antes de abrir. Anote a decisão de segurança por trás de cada um.
5. **Desenho.** Use `mattpocock-skills:codebase-design` para decidir módulos e fronteiras, e `mattpocock-skills:domain-modeling` para termos novos (glossário) e decisões de arquitetura (ADR em `docs/adr/`). Dúvida de API externa: skills `cloudflare:*` ou `mattpocock-skills:research`.
6. **Plano** (no PR em rascunho ou na conversa): arquivos que vai criar ou mudar, rotas, migrations, chaves de i18n, testes por critério de aceite (matriz), riscos e o que fica fora.
7. Crie a branch `feat/etapa-NN-<assunto>` a partir da `develop` atualizada e implemente com `mattpocock-skills:tdd` (o teste de cada critério de aceite nasce vermelho antes do código).
8. Durante o trabalho, rode só os testes do arquivo que mudou; a suíte completa roda uma vez no fim, pelo `verificar`.
9. Ao terminar: `verificar` → `revisao-qa` → `auditoria-seguranca` → `preparar-pr` → `proxima-etapa`.
