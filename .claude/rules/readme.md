---
paths:
  - "apps/**"
  - "packages/**"
  - "docs/**"
  - ".claude/memoria/progresso.md"
  - "README.md"
  - "CHANGELOG.md"
  - "changelog/**"
---

# README sempre atualizado

Decisão do Pablo (31/10/2026): o `README.md` é a vitrine do Zuri e anda junto com o código. Ele nunca fica atrás da `develop`.

## Quando o PR atualiza o README

Todo PR que muda um destes itens atualiza o README **no mesmo PR**, junto com o arquivo do changelog em `changelog/nao-lancado/`:

| O PR muda | O que mexer no README |
| --- | --- |
| Funcionalidade visível (tela, rota, comando do bot, integração) | Tabela "O que já funciona"; tire o item de "O que vem a seguir" quando ele chegar |
| Etapa concluída (`proxima-etapa`) | O `progresso.md` e o resumo do aviso do topo (o que já existe): a coluna Situação do mapa, o selo de etapas, "A Zuri sai em N etapas", "As etapas 0 a X" e "steps 0 to X" de "In English" são automáticos (veja abaixo). Etapa nova ou dividida (22a, 22b…) ganha a linha dela no mapa, dentro dos marcadores |
| Tela que aparece nas capturas | Rode `node scripts/capturas-do-readme.ts` com o servidor do e2e numa base vazia e faça commit de `docs/capturas/` |
| Tela criada ou alterada (qualquer uma) | Capturas na descrição do PR, em `docs/capturas/pr/<assunto>/` (`.claude/rules/capturas.md`) |
| Tela nova importante | Acrescente a tela ao script e ao quadro "Telas" (claro e escuro com `<picture>`) |
| Arquitetura, stack, recurso da Cloudflare ou cota | "Como funciona", "Plano Free, sem surpresa na fatura" e o diagrama Mermaid |
| Comando, requisito ou passo de instalação | "Rodar localmente" e o `CONTRIBUTING.md` |
| Documento novo de entrada em `docs/` | Tabela "Documentação" |

PR só interno (refatoração, teste, CI) não mexe no README. Na dúvida, mexa.

## O que se atualiza sozinho

O workflow `README` (`.github/workflows/readme.yml`, `scripts/readme.ts`) roda a cada merge na `develop` e a cada 10 minutos. Ele reescreve:

- a coluna Situação do mapa, entre `<!-- inicio:etapas … -->` e `<!-- fim:etapas -->`: ✅ quando o `progresso.md` diz "mesclada" (ou diz "em revisão" e a PR da etapa já mesclou), 🚧 com PR `feat/etapa-NN-…` aberta ou "em andamento"/"em revisão", ⬜ no resto;
- o selo `etapas-N de T` (T = linhas do mapa), "A Zuri sai em T etapas", "As etapas 0 a X estão na `develop`" e "in T steps; steps 0 to X are merged".

Quando algo muda, ele abre (ou refaz) a PR `docs(readme): atualiza o estado das etapas (automático)` na branch `chore/readme-automatico`, com auto-merge (autorizado pelo Pablo). Essa PR não vira versão. Não edite essas partes à mão: mude o `progresso.md` ou as linhas do mapa e deixe o workflow fazer o resto. As frases com contagem ficam cada uma na sua linha, para que um PR que mude o resto do parágrafo não entre em conflito com a PR do workflow. `node scripts/readme.ts` só mostra a coluna calculada a partir do `progresso.md`, sem a rede e sem gravar nada (etapa "em revisão" aparece 🚧 nele, porque só o workflow vê que a PR mesclou).

Branch de sub-PR de uma etapa usa o número da etapa e um sufixo depois do hífen (`feat/etapa-11-push`), nunca uma letra colada (`feat/etapa-11b-…` seria lida como a etapa 11b). Se o script não achar um marcador ou uma dessas frases, o workflow falha e abre a issue "[falha automática] README": devolva o marcador ou ajuste o padrão em `scripts/readme.ts`, com teste.

Os selos CI e CodeQL apontam para a `develop` (`?branch=develop`): os dois workflows também rodam a cada push na `develop` para isso.

O selo de versão (pedido do Pablo, 03/11/2026) é dinâmico: o shields.io lê a tag mais nova das releases e pré-releases que o workflow `Versão` publica (`include_prereleases&sort=semver`), então segue cada merge sozinho, inclusive na fase 0.x de desenvolvimento, e fica laranja enquanto for pré-release. Não troque por um selo fixo. O `scripts/readme.ts` só confere que ele continua no README (`VERSION_BADGE`): se ele sumir, o workflow `README` falha e o teste `tests/repo/readme.test.ts` também.

## Como escrever

- Mantenha o desenho: banner Sinal com `<picture>` claro/escuro, selos, sumário, tabelas com ícone, capturas que seguem o tema, Mermaid, seção curta "In English".
- Descreva o que existe na `develop`. O que ainda não foi feito fica em "O que vem a seguir" ou no mapa, nunca em "O que já funciona".
- Números do README (cota, limites, coberturas, etapas) batem com a especificação e com o código. Confira antes de escrever.
- Capturas com dados de exemplo, sem dado real. Nada de domínio, e-mail, id ou chave: use `exemplo.com.br`.
- Passada final com a skill `humanizer:humanizer`, sem mudar fatos nem termos técnicos.
