# Etapa 19d · Resposta automática das avaliações positivas

Plano da etapa 19d. Continua `docs/planos/google-business-profile.md` (partes
19d das seções 3 a 10 e a seção 15, que conta o que mudou na 19c). As
decisões do Pablo de 03/11/2026 continuam valendo e não voltam a ser
perguntadas.

## 1. Resumo

O dono ganha um terceiro nível em Configurações › Integrações › Google ›
Avaliações: **Publica sozinha as positivas**. Ele só aparece liberado depois
de 10 rascunhos de avaliações positivas aprovados sem edição entre as últimas
30 decisões do dono, pede a senha digitada há pouco e gera um alerta de
segurança. Nesse nível, a Zuri publica sozinha as respostas de 4 e 5 estrelas
cujo rascunho passou pela conferência fixa e pela segunda leitura, até 3 por
leitura e 10 por dia, e lista na aba Avaliações o que saiu sozinho, com
**Apagar resposta**. Um disjuntor volta para "Perguntar sempre" e avisa o dono.

## 2. Contexto no sistema

- Módulo `apps/agent/src/reviews/` da 19c: `service.ts` (`ReviewService`),
  `guard.ts` (conferência fixa), `responder.ts` (agente sem ferramentas e
  segunda leitura), `triage.ts`, `store.ts`.
- Rotas em `apps/agent/src/api/reviews.ts`, tela em
  `apps/web/src/pages/contacts/reviews/ReviewsPanel.tsx` e
  `apps/web/src/pages/settings/ReviewsSection.tsx`.
- Alerta de segurança pelo registro de acesso (`auth.events.record(..., { alert: true })`),
  como `mcp_tool_autonomy` na autonomia das ferramentas MCP.

## 3. Critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA16 | "Publica sozinha as positivas" fica bloqueado antes de 10 aprovações sem edição entre as últimas 30 decisões do dono (`CONFLICT`); ligar pede senha recente e gera alerta de segurança | plano 19c, Pablo |
| CA16b | IA, bot, token remoto e rotinas não mudam o nível (um teste por caminho) | prompt da etapa |
| CA16c | Só sai sozinha a resposta de avaliação de 4 ou 5 estrelas, sem motivo de cautela, cujo rascunho passou pela conferência fixa e pela segunda leitura (ou um modelo do dono numa avaliação só com nota); o rascunho trocado pelo modelo depois de uma reprovação continua esperando o dono | plano |
| CA16d | Até 3 publicações por leitura e 10 por dia (no fuso do dono); a 11ª fica esperando o dono | plano |
| CA16e | Rajada (5 negativas ou 10 novas em 60 min) pausa a publicação sozinha enquanto durar | plano |
| CA17 | Disjuntor: 3 reprovações seguidas de rascunhos de positivas, 1 recusa do Google numa publicação sozinha ou 1 resposta da Zuri apagada pelo dono (na tela ou direto no Google) voltam o nível para "Perguntar sempre" e avisam o dono no privado | plano |
| CA17b | Pausa, bloqueio e desligar continuam parando tudo; a releitura antes de publicar continua igual | 19c |
| CA18 | Aba "Publicadas sozinha" e o nível novo na tela com estados vazio, carregando e erro, teclado, leitor de tela, celular, tema escuro e axe | padrão |

## 4. Escopo

**Entra:** o nível, o período de experiência, o disjuntor, a publicação
sozinha no alarme, o aviso resumido do que saiu sozinho (privado), a aba
"Publicadas sozinha" com **Apagar resposta**, o alerta de segurança.

**Fica fora (e por quê):**

- **Aprovar pelo bot do Telegram.** Pendente desde a 19c. Pede o fluxo da
  16a inteiro (prévia do servidor, passkey ou código por e-mail presos ao
  hash, `TARGET_CHANGED`), testes de callback no grupo e no privado e textos
  novos do bot. Com o nível automático, o que mais pesa no dia a dia (as
  positivas) deixa de precisar de aprovação. Fica registrado em
  `progresso.md` como pendência para uma PR própria.
- **Categoria própria `reviews` na central de avisos.** O `CHECK` de
  `zur_notices.category` não aceita um valor novo sem recriar a tabela (cópia
  de todos os avisos do dono numa migration de acréscimo, com gatilhos e
  índices de novo). O ganho seria só filtrar a central por "Avaliações" e
  silenciar a categoria; o tópico do grupo e o envio no privado já são
  decididos pelo tipo `reviews.*`. Custo e risco maiores que o benefício:
  continua `system`. Reavaliar se o Pablo pedir um filtro na central.

## 5. Como funciona para o Pablo

1. Em Integrações › Google › Avaliações, a lista "O que a Zuri faz" mostra a
   terceira opção. Antes do período de experiência ela fica desligada, com a
   contagem "Você aprovou 4 de 10 rascunhos sem mudar nada".
2. Liberada, escolher e salvar pede a senha (se não foi digitada há pouco) e
   manda um alerta de segurança em todos os canais.
3. A cada leitura, positivas novas com rascunho aprovado nas duas
   conferências saem sozinhas, até 3 por leitura e 10 por dia. A Zuri relê a
   avaliação no Google antes, como na aprovação. Ao fim da leitura, um aviso
   no privado: "A Zuri respondeu sozinha 2 avaliações".
4. A aba **Publicadas sozinha** lista essas respostas, com **Apagar
   resposta**. Apagar uma resposta da Zuri (ali ou no Google) desliga o
   automático, porque é sinal de que algo saiu errado.
5. Disjuntor desarmado: aviso no privado "A Zuri voltou a pedir sua
   aprovação" com o motivo; a tela mostra o motivo até o dono ligar de novo.

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Período de experiência | 10 aprovações sem edição entre as últimas 30 decisões do dono sobre rascunhos de positivas | 9 → bloqueado; 10 → liberado | `CONFLICT` (`error.reviewsAutoLocked`) |
| Decisões que contam | aprovar sem mudar (conta 1), aprovar editado ou descartar (conta 0), só pela tela e só de rascunho de positiva | resposta escrita do zero não conta | — |
| Publicações sozinha por leitura | 3 | a 4ª na próxima leitura | — |
| Publicações sozinha por dia | 10 (fuso do dono) | a 11ª espera o dono | — |
| Quais saem sozinhas | 4 ou 5 estrelas, sem motivo de cautela, rascunho da IA aprovado nas duas conferências ou modelo do dono para avaliação só com nota, proposto depois de ligar o nível, dentro de 14 dias | o resto espera o dono | — |
| Rajada | 5 negativas ou 10 novas em 60 min | nada sai sozinho enquanto durar | — |
| Disjuntor | 3 reprovações seguidas, 1 recusa do Google, 1 resposta da Zuri apagada pelo dono | volta para "Perguntar sempre" | — |

## 7. Desenho técnico

- **Banco (migration 27 `reviews_auto`, só acréscimo):** em
  `zur_review_settings`, `auto` (0/1; o nível continua `approve` por causa do
  `CHECK` da 19c), `auto_since`, `trial` (até 30 caracteres "1"/"0", a
  decisão mais nova no fim), `rejections` (reprovações seguidas),
  `breaker`/`breaker_at` (motivo do último desarme), `auto_day`/`auto_today`.
  Em `zur_reviews`, `auto` (0/1) com índice parcial para a aba. O contador
  fica fora de `zur_review_events`, que some em 180 dias.
- **Nível na API:** `ReviewLevel` ganha `auto`; `configure` recusa `auto`
  sem o período de experiência e devolve se ligou agora; a rota grava
  `reviews_autonomy` com alerta. Nenhuma ferramenta, comando do bot ou rotina
  chama `configure`.
- **Publicação sozinha:** `approve` é dividida: as conferências do dono ficam
  em `approve`, e a releitura, a trava `sending`, o `PUT` e o resultado
  incerto ficam em `publish`, usada pelas duas. `autoPublish` roda no fim de
  `check`, depois da rajada.
- **Disjuntor:** `trip(reason)` zera `auto`, grava o motivo e avisa
  (`reviews.breaker`, privado). Pontos: `draftOne` (reprovação da conferência
  ou da segunda leitura numa positiva), `autoPublish` (recusa do Google),
  `deleteReply` e `applyReply` (resposta da Zuri sumiu no Google).
- **Avisos:** `reviews.auto` (quantas saíram) e `reviews.breaker`, os dois
  só no privado (`REVIEWS_PRIVATE`), categoria `system`.
- **Tela:** aba `auto` ("Publicadas sozinha") e o nível novo no formulário,
  com a contagem do período de experiência e o motivo do disjuntor.

## 8. Custo e cotas do plano Free

Nada novo de IA: a publicação usa o rascunho que já existia. Google: até 3
publicações por leitura, 2 chamadas cada (releitura e `PUT`), dentro do
`WakeBudget` do despertar e do `GoogleMeter` de cada publicação. Escritas no
SQLite: algumas por leitura. JS inicial sem mudança (tudo nas telas sob
demanda). Nenhum recurso pago.

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| IA, bot, token ou rotina liga o automático | só a rota da tela, com sessão, CSRF, senha recente e alerta; sem ferramenta nem comando | `reviews-autonomy.test.ts` e `reviews-routes.test.ts` |
| Avaliação maliciosa sai respondida sozinha | detector de suspeitos, triagem fixa, conferência fixa de novo na hora de publicar, segunda leitura, só rascunho sem reprovação | `reviews-autonomy.test.ts` |
| Rajada de avaliações falsas gasta o perfil | 3 por leitura, 10 por dia, rajada pausa | limites n−1, n, n+1 |
| Resposta ruim publicada | disjuntor, **Apagar resposta**, aviso do que saiu | cada gatilho |
| Dado pessoal em log | logs só com contagens e motivos | teste de logs |

## 10. Testes

| CA | Teste | Arquivo |
| --- | --- | --- |
| CA16 | 9/10 aprovações, editada e descartada contam 0, janela de 30, senha e alerta | `reviews-autonomy.test.ts`, `reviews-routes.test.ts` |
| CA16b | nenhuma ferramenta, comando do bot ou rota fora da sessão muda o nível | `reviews-autonomy.test.ts` |
| CA16c | só positivas aprovadas nas duas conferências; modelo após reprovação e negativa esperam o dono | `reviews-autonomy.test.ts` |
| CA16d | 3/4 por leitura, 10/11 por dia | idem |
| CA16e | rajada pausa | idem |
| CA17 | cada gatilho do disjuntor | idem |
| CA17b | pausa e bloqueio | idem |
| CA18 | aba, nível, axe, celular e escuro | `tests/e2e/avaliacoes.spec.ts` |

## 11. Entrega

Branch `feat/etapa-19d-resposta-automatica`, PR para `develop`. Fragmento
`changelog/nao-lancado/etapa-19d-resposta-automatica.md` com
`<!-- versao: minor -->`. Docs: `docs/avaliacoes-google.md`. Capturas da
aba e do nível (computador e celular, claro e escuro).

## 12. Riscos

| Risco | O que fazemos |
| --- | --- |
| Resposta pública ruim | experiência de 10, duas conferências, disjuntor, apagar |
| Dono não percebe que o automático voltou a perguntar | aviso no privado e motivo na tela |

## 13. Suposições

- "Últimas 30" conta as decisões do dono sobre rascunhos de positivas na tela
  (aprovar sem mudar, aprovar editado, descartar). Resposta escrita do zero,
  sem rascunho, não conta.
- Só o que foi proposto depois de ligar o nível sai sozinho: o que já estava
  na fila continua esperando o dono, que contava com isso.
- O disjuntor não zera o período de experiência: ligar de novo é escolha do
  dono, com senha e alerta.
- Qualquer resposta da Zuri apagada pelo dono com o automático ligado desarma
  o disjuntor, mesmo uma que ele mesmo aprovou.

## 14. Entrevista com o Pablo

Sem perguntas novas: as decisões de 03/11/2026 cobrem a etapa.
