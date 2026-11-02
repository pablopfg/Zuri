# Modelo de plano

Base de todo plano do Zuri: etapa da especificação, ajuste pedido pelo Pablo ou
estudo de viabilidade. Quem preenche é a skill `planejar`
(`.claude/skills/planejar/SKILL.md`), que também diz quando entrevistar o
Pablo. Copie este arquivo para `docs/planos/<assunto>.md` (etapa:
`etapa-NN-<assunto>.md`), apague os comentários e preencha.

Regras do preenchimento:

- **Nenhuma seção some.** Seção que não se aplica fica com uma linha dizendo
  por quê ("Sem tela nova: a etapa só muda o servidor"). Seção vazia é plano
  incompleto.
- **Fato com fonte.** Limite, nome de API, preço ou comportamento da
  Cloudflare cita a página oficial ou o arquivo do repositório de onde saiu.
  Palpite vai para "Suposições".
- **Número exato.** "Até 50 rotinas ativas", nunca "um limite razoável". Cada
  número vira um teste n−1, n, n+1.
- **O que o Pablo vê vem antes do código.** Fluxos, textos e estados de tela
  ficam fechados no plano; arquivos e funções são consequência.
- Plano de **correção pequena** (até uns 3 arquivos, sem tela nova, sem
  migration, sem rota nova) pode usar a versão curta no fim deste arquivo.

---

```markdown
# Plano · <nome>

Situação: rascunho | esperando o Pablo | aprovado em DD/MM/AAAA | implementado (PR #NN)
Origem: etapa NN da especificação | pedido do Pablo em DD/MM/AAAA | achado de QA/auditoria
Dependências: <etapas e PRs que precisam estar mesclados>

## 1. Resumo

<!-- Três a cinco frases: o problema, o que muda para o Pablo e o tamanho da
entrega. Quem ler só isto entende o plano. -->

## 2. Contexto no sistema

<!-- O que já existe e o plano usa ou muda. Liste com caminho:
módulos (`apps/agent/src/...`), telas (`apps/web/src/...`), tabelas e
migrations, rotas, ferramentas do agente, alertas, rotinas, textos do catálogo.
Cite as decisões de `.claude/memoria/decisoes.md` que valem aqui (data e
assunto) e os planos anteriores de `docs/planos/`. Referência no Talorys: os
arquivos lidos e o que se aproveita ou se evita. -->

## 3. Objetivo e critérios de aceite

<!-- Critérios verificáveis, numerados (CA1, CA2…). Os da especificação vêm
primeiro, copiados; os novos ficam marcados "(novo)". Cada um vira linha na
matriz de rastreabilidade do PR. -->

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 |  | especificação / Pablo / plano |

## 4. Escopo

**Entra:**

-

**Fica fora (e onde vai parar):**

- <item> → etapa NN / pendência em `progresso.md` / não faremos, porque…

## 5. Como funciona para o Pablo

<!-- Cada fluxo passo a passo, do gatilho ao resultado, na web, no celular e
no Telegram quando couber. Para cada tela: estados vazio, carregando, erro,
sucesso e sem permissão; teclado e leitor de tela; o que muda no tema escuro e
no celular; onde entra na barra lateral, nas Configurações, na paleta Ctrl/⌘ K
e na central de avisos. Tela nova ou redesenho: plano visual com
`frontend-design:frontend-design` dentro de `docs/interface.md`. -->

### Fluxo 1 · <nome>

1.

### Textos visíveis

<!-- Todo texto novo, em pt-BR e en, com a chave do catálogo. Botões com
verbo, alertas que dizem o que aconteceu e o que fazer, sem citar
infraestrutura (Cloudflare, Worker, cron). Voz da Zuri no feminino e sem tom
robótico. Passe pela `humanizer:humanizer`. -->

| Chave | pt-BR | en | Onde aparece |
| --- | --- | --- | --- |
|  |  |  |  |

## 6. Regras de negócio e limites

<!-- Cada regra com o número exato, o que acontece no limite e o erro
devolvido (código da especificação). Fuso `America/Sao_Paulo`, horário de
verão, datas relativas, concorrência (duas abas, dois pedidos ao mesmo tempo),
repetição e ordem dos eventos. -->

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
|  |  |  |  |

## 7. Desenho técnico

<!-- Módulos e fronteiras (`mattpocock-skills:codebase-design`), termos novos
para `.claude/memoria/glossario.md` e ADR quando houver decisão de
arquitetura (`mattpocock-skills:domain-modeling`). -->

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
|  |  |  |

### Rotas e contratos

<!-- Método, caminho, schema Zod de entrada e saída (em `packages/shared`),
autenticação, teto de corpo, códigos de erro, Cache-Control. -->

### Banco

<!-- Migration nova (número, tabelas, colunas, índices), sempre de acréscimo
(`.claude/rules/migrations.md`). Volume esperado em 1 ano e consulta mais
cara. Nada de apagar dado do dono. -->

### Ferramentas do agente

<!-- Nome, permissão (`read` | `write` | `destructive`), limite por turno,
schema, se vira proposta (`.claude/rules/ferramentas.md`). -->

### Agendamentos, IA e integrações externas

<!-- Alarmes, rotinas, chamadas a `agent.ai()` (modelo, Neurons por chamada),
Telegram, e-mail, APIs de fora (OAuth, escopos, cota delas). -->

## 8. Custo e cotas do plano Free

<!-- Use `docs/arquitetura/orcamento-free-tier.md` e
`.claude/rules/performance.md`. Por uso típico e pior caso: requisições,
CPU, escritas e leituras no SQLite, armazenamento, Neurons (dentro do teto de
9.000/dia), alarmes, subrequests, tamanho do JS inicial (teto da CI). Recurso
que pode gerar cobrança: ⚠️, alternativa grátis e pergunta ao Pablo. -->

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 9. Segurança e privacidade

<!-- Ameaças e defesas: quem pode chamar, injeção (conteúdo guardado entra em
`<data>`), agência excessiva, vazamento de prompt ou de dados, força bruta,
segredos novos (Worker secrets, nunca no repositório nem no navegador), o que
vai e o que não vai para log, alerta de segurança gerado. Seções de
`docs/seguranca.md` relidas. Nível da auditoria: orientação ou completa. -->

| Ameaça | Defesa | Teste |
| --- | --- | --- |
|  |  |  |

## 10. Testes

<!-- Estratégia de `docs/qa/estrategia-de-testes.md`. Cada CA com pelo menos
um teste, na camada certa. Casos de borda obrigatórios: vazio, enorme,
malformado, repetido, concorrente, fora de ordem, fuso e horário de verão,
limites exatos, abuso e injeção. Telas: e2e, axe e Lighthouse. -->

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1 |  | unitário / integração / contrato / e2e / segurança / a11y |  |

## 11. Entrega

- **Ordem:** <passos ou PRs em sequência, cada um mesclável sozinho>
- **Capturas:** <telas e rotas para `scripts/capturas-da-interface.ts`, ou "Sem mudança visível">
- **Docs:** <arquivos de `docs/` que mudam; README (`.claude/rules/readme.md`)>
- **Changelog:** `changelog/nao-lancado/<assunto>.md`
- **Instalação:** <segredo, variável ou passo novo em `docs/configuracao-cloudflare.md`, ou "nada novo">
- **Portabilidade:** <binding novo e como se troca fora da Cloudflare (`docs/planos/portabilidade-vps.md`), ou "nenhum">

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
|  | baixa / média / alta |  |  |

## 13. Suposições

<!-- Decisões técnicas tomadas sem perguntar, com o motivo. O Pablo pode
derrubar qualquer uma no PR. -->

-

## 14. Entrevista com o Pablo

<!-- Perguntas feitas, data e resposta. Pergunta sem resposta fica em
"Perguntas abertas" e, se bloqueia, o plano fica "esperando o Pablo". -->

| Data | Pergunta | Resposta |
| --- | --- | --- |
|  |  |  |

### Perguntas abertas

-
```

---

## Versão curta (correção pequena)

```markdown
# Plano · <nome>

Origem: <issue, pedido ou achado>

- **Problema:** <o que acontece hoje, com o passo a passo para reproduzir>
- **Mudança:** <o que muda e em quais arquivos>
- **Fica fora:** <o que não muda>
- **Testes:** <o teste que falha antes e passa depois; casos de borda>
- **Riscos e custo:** <o que pode quebrar; efeito nas cotas, ou "nenhum">
- **Segurança:** <superfície tocada, ou "nenhuma">
```
