# Primeira mensagem para o agente

Copie o texto entre as linhas e envie como primeira mensagem no projeto do Zuri.

---

Vamos começar o Zuri. Antes de qualquer código:

1. Leia por inteiro as instruções do projeto, a `03-especificacao-zuri.md` e a `02-memoria-inicial.md`.
2. Clone o Talorys (`https://github.com/pablopfg/talorys`, branch `develop`) fora do repositório do Zuri, só para leitura, e confira que os arquivos citados na especificação existem.
3. Confira a disponibilidade do nome (usuário de bot `@zuri_<algo>_bot` no Telegram e um domínio) e me diga o que achou, sem registrar nada.
4. Me mande um resumo de no máximo 10 linhas com o seu entendimento do produto, as perguntas que bloqueiam a etapa 0 (se houver) e os riscos que você vê.

Em seguida, execute a **etapa 0** no repositório `zuri`:

- Crie a branch `feat/etapa-00-repositorio` a partir da `develop`.
- Copie os arquivos de `repositorio-inicial/` para a raiz (inclusive `.claude/`, `.github/`, `README.md` e `docs/assets/`), confira que a especificação está em `docs/especificacao.md`, os prompts das etapas em `docs/agente/prompts-das-etapas.md` e a memória em `.claude/memoria/` (`decisoes.md`, `progresso.md`, `armadilhas.md`, `glossario.md`).
- Monte o monorepo, a CI, os rulesets em `.github/rulesets/` (na `develop`: PR obrigatório, checks exigidos e nenhuma aprovação humana, para o modo contínuo poder mesclar; na `main`: só PR vindo da `develop`, mesclado pelo Pablo), o Dependabot e o restante pedido na etapa 0 da especificação.
- Confira que as skills externas carregaram (`scripts/instalar-skills.sh` roda no início da sessão; `claude plugin list` deve mostrar `cloudflare`, `mattpocock-skills`, `nateherk-design`, `cloudflare-security-audit` e `humanizer`). Se não, rode o script e me diga o erro.
- Rode as skills `verificar`, `revisao-qa` e `auditoria-seguranca`, corrija o que aparecer e abra o PR para `develop` com o modelo preenchido, a matriz de rastreabilidade e o relatório de auditoria.
- Atualize `.claude/memoria/progresso.md` no PR. A etapa 0 é a única exceção ao modo contínuo: não mescle até eu confirmar que importei os rulesets e que a proteção da `develop` e da `main` está ativa. Depois da minha confirmação, mescle e siga com a skill `proxima-etapa` (thread nova para a etapa 1).
- Me mande o link do PR e a lista do que eu preciso configurar no GitHub (rulesets, ambientes, proteções), com o caminho exato de cada tela.

Com o modo contínuo ligado, o agente segue sozinho a partir daqui. Use `05-prompts-das-etapas.md` só se quiser mandar uma etapa à mão ou para pausar, retomar e corrigir algo.
