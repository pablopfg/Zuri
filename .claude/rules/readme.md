---
paths:
  - "apps/**"
  - "packages/**"
  - "docs/**"
  - ".claude/memoria/progresso.md"
  - "README.md"
  - "CHANGELOG.md"
---

# README sempre atualizado

Decisão do Pablo (31/10/2026): o `README.md` é a vitrine do Zuri e anda junto com o código. Ele nunca fica atrás da `develop`.

## Quando o PR atualiza o README

Todo PR que muda um destes itens atualiza o README **no mesmo PR**, junto com a entrada do `CHANGELOG.md`:

| O PR muda | O que mexer no README |
| --- | --- |
| Funcionalidade visível (tela, rota, comando do bot, integração) | Tabela "O que já funciona"; tire o item de "O que vem a seguir" quando ele chegar |
| Etapa concluída (`proxima-etapa`) | "Mapa das etapas" (✅, 🚧 na próxima), o selo `etapas-N de 26`, o aviso do topo e a frase "steps 0 to N" de "In English" |
| Tela que aparece nas capturas | Rode `node scripts/capturas-do-readme.ts` com o servidor do e2e numa base vazia e faça commit de `docs/capturas/` |
| Tela nova importante | Acrescente a tela ao script e ao quadro "Telas" (claro e escuro com `<picture>`) |
| Arquitetura, stack, recurso da Cloudflare ou cota | "Como funciona", "Plano Free, sem surpresa na fatura" e o diagrama Mermaid |
| Comando, requisito ou passo de instalação | "Rodar localmente" e o `CONTRIBUTING.md` |
| Documento novo de entrada em `docs/` | Tabela "Documentação" |

PR só interno (refatoração, teste, CI) não mexe no README. Na dúvida, mexa.

## Como escrever

- Mantenha o desenho: banner Sinal com `<picture>` claro/escuro, selos, sumário, tabelas com ícone, capturas que seguem o tema, Mermaid, seção curta "In English".
- Descreva o que existe na `develop`. O que ainda não foi feito fica em "O que vem a seguir" ou no mapa, nunca em "O que já funciona".
- Números do README (cota, limites, coberturas, etapas) batem com a especificação e com o código. Confira antes de escrever.
- Capturas com dados de exemplo, sem dado real. Nada de domínio, e-mail, id ou chave: use `exemplo.com.br`.
- Passada final com a skill `humanizer:humanizer`, sem mudar fatos nem termos técnicos.
