---
paths:
  - "apps/web/**"
  - "packages/shared/src/i18n/**"
  - "tests/e2e/**"
  - "scripts/capturas-*.ts"
  - ".github/pull_request_template.md"
---

# Capturas de tela no PR

Decisão do Pablo (31/10/2026): todo PR que cria ou muda uma tela mostra, na descrição, como a tela ficou. Assim dá para acompanhar a evolução do sistema sem rodar nada.

## Quando vale

O PR precisa de capturas quando muda o que o dono vê: tela ou rota nova, layout, componente visível, estado novo (vazio, carregando, erro), texto de interface ou tema. PR só de servidor, teste, CI ou documentação não precisa; escreva "Sem mudança visível" na seção do modelo. Na dúvida, capture.

## O que capturar

- Cada tela criada ou alterada, no estado em que o dono mais a vê, com os dados de exemplo (`--exemplos`).
- Quatro variações por tela: computador e celular, cada um no tema claro e no escuro. Tela que só existe num tamanho (por exemplo, a lista de seções de Configurações no celular) fica só nele; diga isso na legenda.
- Estado novo que importa (vazio, erro, confirmação) ganha captura própria quando não aparece na principal.
- Mudou uma tela existente: mostre antes e depois, lado a lado. O "antes" sai da `develop` com o mesmo comando.

## Como gerar

1. Suba o servidor dos e2e numa base vazia: o comando `webServer` do `playwright.config.ts` (`wrangler dev --local` na porta 4173).
2. Rode `node scripts/capturas-da-interface.ts docs/capturas/pr/<assunto> --exemplos <nome>=<rota> ...`, por exemplo `node scripts/capturas-da-interface.ts docs/capturas/pr/etapa-10-agenda --exemplos agenda=/agenda`. O nome `entrar` captura a tela de entrar.
3. Telas que precisam de clique (diálogo aberto, item selecionado) entram como um passo a mais no script ou num teste e2e com `page.screenshot`, sempre gravando na mesma pasta.

O script usa o Turnstile de teste, adia o lembrete do 2FA, fixa o fuso de São Paulo e espera a rede e as animações pararem. Nunca use a conta de produção nem dados reais.

## Onde ficam

- Pasta `docs/capturas/pr/<assunto>/`, em que `<assunto>` é o nome da branch sem o prefixo (`feat/etapa-10-agenda` → `etapa-10-agenda`). Arquivos `<tela>-<computador|celular>-<claro|escuro>.png`; o "antes" leva `-antes` no fim do nome.
- Faça commit das imagens na branch do PR. Só as telas que o PR mudou; nada de capturas repetidas de telas que não mudaram.
- As capturas do README continuam em `docs/capturas/` (raiz) e seguem `.claude/rules/readme.md`. Se a tela mudada aparece no README, refaça as duas.

## Como mostrar no PR

Preencha a seção "Capturas de tela" do modelo com uma tabela por tela. Use o link fixado no commit, que continua valendo depois da mesclagem:

```markdown
| | Claro | Escuro |
| --- | --- | --- |
| Computador | <img src="https://raw.githubusercontent.com/pablopfg/Zuri/<sha>/docs/capturas/pr/<assunto>/<tela>-computador-claro.png" width="420"> | <img src="…/<tela>-computador-escuro.png" width="420"> |
| Celular | <img src="…/<tela>-celular-claro.png" width="200"> | <img src="…/<tela>-celular-escuro.png" width="200"> |
```

`<sha>` é o commit que gravou as imagens (`git rev-parse HEAD` depois do push). Refez as capturas: troque o `<sha>` na descrição. Ao avisar o Pablo na conversa, anexe as capturas também.

## Cuidados

- Só dados de exemplo: nada de domínio, e-mail real, id, token, IP real ou conteúdo do dono. O e-mail das capturas é `dono@exemplo.com.br`.
- Confira cada imagem antes do commit: sem texto cortado, sem chave de i18n crua, sem estado de carregamento preso, sem o quadro do Turnstile de teste.
- Captura não substitui teste: o e2e e o axe da tela continuam obrigatórios (`.claude/rules/web-ui.md`).
