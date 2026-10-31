---
paths:
  - "apps/web/**"
---

# Interface web

- React + Vite + Tailwind + TanStack Query + React Router; nada de segredo no bundle.
- Sem `dangerouslySetInnerHTML` com conteúdo do dono; Markdown renderizado com sanitização.
- CSP estrita espelhada em `_headers` e conferida por teste. Nenhuma página dispara violação (`tests/e2e/csp.spec.ts`); nada de `eval`, `new Function` ou script inline, nem dentro de dependência (o Zod roda `jitless` por isso).
- Toda tela tem estados de carregando, vazio, erro e sucesso, com chave de i18n e e2e.
- Acessibilidade: WCAG 2.1 AA, axe sem violações sérias, navegação por teclado, foco visível, toque mínimo de 44 px. Lighthouse na CI: acessibilidade e boas práticas ≥ 95.
- Datas e "hoje" vêm sempre do fuso do dono (configurações), nunca do fuso do aparelho.
- Respostas da API com `Cache-Control: no-store`; o service worker não guarda respostas da API.
