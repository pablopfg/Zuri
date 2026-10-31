# Como contribuir

O Zuri é um projeto de dono único, construído em etapas a partir de
`docs/especificacao.md`. Contribuições são bem-vindas, desde que sigam as
regras abaixo.

## Antes de começar

1. Leia `AGENTS.md` (regras invioláveis e convenções) e a etapa da
   especificação que a mudança toca.
2. Use o Node.js da versão em `.nvmrc` e instale com `npm ci`.
3. Para falha de segurança, não abra issue: siga o `SECURITY.md`.

## Fluxo

1. Crie a branch a partir da `develop` atualizada: `feat/etapa-NN-<assunto>`
   para uma etapa, `fix/<assunto>` para correção.
2. Escreva o teste junto com o código. Bug corrigido vem com o teste que
   falhava antes.
3. Rode antes de abrir o PR:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run i18n
   npm run build
   npm run test:e2e
   npm audit --audit-level=high
   ```

4. Abra o PR **para a `develop`** e preencha o modelo inteiro, inclusive a
   matriz de rastreabilidade e a seção de segurança. A `main` só recebe
   releases vindas da `develop`.

## Convenções

- Título do PR e commits em Conventional Commits: prefixo em inglês e o resto
  em pt-BR (`feat(telegram): adiciona o comando /hoje`).
- Código, identificadores, comentários e mensagens de teste em inglês.
  Documentação, changelog e PRs em pt-BR.
- Todo texto visível sai do catálogo `packages/shared/i18n`, em pt-BR e en.
- Mudança visível entra no `CHANGELOG.md`, em "Não lançado".
- Dependência nova só com motivo claro, com versão exata.
- Nada de domínio real, e-mail, id do Telegram, token ou chave no repositório.
  Use `exemplo.com.br` nos exemplos.
- Nunca use `.skip`, `.only`, `retries` ou timeout maior para a CI passar.
