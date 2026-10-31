---
paths:
  - "docs/**"
  - "README.md"
  - "CHANGELOG.md"
---

# Documentação

- Tudo em pt-BR, frases curtas, exemplos com `exemplo.com.br`.
- Cada funcionalidade tem seu documento em `docs/`; `docs/instalacao-cloudflare.md` é o passo a passo único, só pelo navegador, e muda junto com qualquer variável, segredo ou produto novo.
- `docs/especificacao.md` só muda com decisão do dono; registre a mudança em `.claude/memoria/decisoes.md`.
- O `README.md` anda junto com o código: quando e como atualizar está em `.claude/rules/readme.md`. Tire o aviso "em construção" na etapa 25.
- Identidade visual Sinal: `docs/assets/zuri-logo.svg` e os banners `docs/assets/zuri-banner-{claro,escuro}.svg` usam as mesmas cores de `apps/web/src/styles.css`. Trocou a identidade, troque os três.
- Imagens do README têm texto alternativo descritivo em pt-BR. As capturas do README ficam em `docs/capturas/` e saem de `scripts/capturas-do-readme.ts` (app em pt-BR, claro e escuro). As capturas de cada PR ficam em `docs/assets/etapa-NN/`.
- Changelog à mão em "Não lançado"; o release copia a seção para a versão.
