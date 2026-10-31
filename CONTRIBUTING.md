<div align="center">

<img src="docs/assets/zuri-logo.svg" alt="" width="56" height="56">

# Como contribuir com o Zuri

</div>

O Zuri é um assistente de um único dono, construído em 26 etapas a partir da
[especificação](docs/especificacao.md). Contribuições são bem-vindas, desde que
sigam as regras abaixo.

## Antes de começar

1. Leia o [`AGENTS.md`](AGENTS.md) (regras invioláveis e convenções) e a etapa
   da especificação que a mudança toca.
2. Use o Node.js da versão em [`.nvmrc`](.nvmrc) e instale com `npm ci`.
3. Achou uma falha de segurança? Não abra issue: siga o
   [`SECURITY.md`](SECURITY.md).

## Fluxo

1. Crie a branch a partir da `develop` atualizada: `feat/etapa-NN-<assunto>`
   para uma etapa, `fix/<assunto>` para correção, `docs/<assunto>` para
   documentação.
2. Escreva o teste junto com o código. Bug corrigido vem com o teste que
   falhava antes.
3. Atualize o `CHANGELOG.md` e, quando couber, o `README.md` (veja abaixo).
4. Rode antes de abrir o PR:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run i18n
   npm run build
   npm run test:e2e
   npm audit --audit-level=high
   ```

5. Abra o PR **para a `develop`** e preencha o modelo inteiro, inclusive a
   matriz de rastreabilidade, a seção de segurança e o custo no plano Free.
   A `main` só recebe releases vindas da `develop`.

## README sempre em dia

Se o seu PR muda uma funcionalidade, conclui uma etapa, muda uma tela que
aparece nas capturas ou mexe na arquitetura, atualize o README **no mesmo PR**:

- **Etapa concluída:** marque ✅ no mapa das etapas, 🚧 na próxima, e ajuste o
  selo de etapas, o aviso do topo e o resumo em inglês.
- **Funcionalidade nova:** acrescente à tabela "O que já funciona" e tire de
  "O que vem a seguir".
- **Tela mudou:** suba o servidor do e2e numa base vazia (o comando
  `webServer` do [`playwright.config.ts`](playwright.config.ts)) e rode
  `node scripts/capturas-do-readme.ts`. As imagens novas vão para
  `docs/capturas/`.

A regra completa está em [`.claude/rules/readme.md`](.claude/rules/readme.md).

## Capturas de tela no PR

PR que cria ou muda uma tela mostra na descrição como ela ficou, no computador
e no celular, nos temas claro e escuro. Com o servidor do e2e rodando numa base
vazia:

```sh
node scripts/capturas-da-interface.ts docs/capturas/pr/<assunto> --exemplos <tela>=<rota>
```

Faça commit das imagens e preencha a seção "Capturas de tela" do modelo de PR.
A regra completa está em [`.claude/rules/capturas.md`](.claude/rules/capturas.md).

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
- Recurso da Cloudflare que pode gerar cobrança só com aprovação do dono,
  marcado com ⚠️ no PR e no changelog.
