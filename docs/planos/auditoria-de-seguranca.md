# Plano · Auditoria de segurança recorrente (pentest do próprio sistema)

Situação: aprovado em 03/11/2026 (pedido do Pablo; sem pergunta de produto pendente)
Origem: pedido do Pablo em 03/11/2026
Dependências: nenhuma; usa a skill `auditoria-seguranca` e a etapa 25 que já existem

## 1. Resumo

Hoje cada etapa termina com a skill `auditoria-seguranca`, que revisa o diff
com um subagente. É uma leitura: ninguém tenta de fato quebrar o que foi
feito. Este plano transforma essa revisão num pentest do próprio sistema, que
roda depois de toda funcionalidade nova: o agente mapeia o que mudou, escolhe
os atacantes que alcançam aquilo, escreve cada ataque como teste, corrige o
que passar e prova que a correção pega o ataque. A primeira execução é um
passe completo do sistema atual (etapas 0 a 18b), com as correções em PRs
pequenas.

## 2. Contexto no sistema

- Skill `.claude/skills/auditoria-seguranca/SKILL.md`: diff, subagentes
  `auditor-seguranca` e `revisor-cloudflare`, skill
  `cloudflare-security-audit:security-audit` (modo orientação em toda etapa,
  completo nas etapas 3, 4, 12, 16, 18, 20 e 25), varredura de segredos,
  correção com teste.
- Subagente `.claude/agents/auditor-seguranca.md`: checklist por área, só
  relata.
- `docs/qa/estrategia-de-testes.md`: segurança testada como comportamento,
  prova do vermelho (princípio 7), portões de cada etapa.
- `docs/seguranca.md`: os controles de cada área (login, sessão, 2FA,
  passkeys, força bruta, CSRF, prompt, ferramentas, MCP, bot, logs).
- `SECURITY.md` e `docs/agente/issues.md`: falha de segurança não vira issue
  pública.
- Etapa 25 da especificação: auditoria final do repositório inteiro.
- Testes de segurança existentes nomeados `SEC-<etapa>-<nn>`
  (`apps/agent/test/auth-mfa.test.ts`, `apps/agent/test/productivity.test.ts`).
- Decisões que valem: parar e chamar o Pablo em achado alto ou médio
  (instruções do agente, modo contínuo); PR verde mescla sozinha na `develop`
  (30/10/2026); só plano gratuito.

## 3. Objetivo e critérios de aceite

| Nº | Critério | Origem |
| --- | --- | --- |
| CA1 | Existe um procedimento de pentest escrito, com atacantes, passo a passo, gravidade e registro (`docs/qa/pentest.md`) | Pablo |
| CA2 | O procedimento cobre todas as áreas do sistema: Worker e API, banco, login e sessões, bloqueio e aprovações, Telegram, IA, MCP e OAuth, automações, avisos e push, interface, CI, segredos e custo | Pablo |
| CA3 | Toda PR que muda código que roda passa pelo passe da funcionalidade antes de mesclar: skill, instruções do agente, prompts das etapas, travas da `proxima-etapa` e modelo de PR dizem isso | Pablo |
| CA4 | Cada achado corrigido tem teste com o id `SEC-<área>-<nn>` no nome, e a prova de que o teste fica vermelho sem a correção | plano |
| CA5 | Um passe completo do sistema atual rodou, com relatório em `docs/qa/auditorias/` e as correções mescladas ou levadas ao Pablo | Pablo |
| CA6 | Nenhum detalhe de exploração de achado alto ou crítico aberto fica público | plano |

## 4. Escopo

**Entra:**

- `docs/qa/pentest.md` (procedimento e catálogo de ataques por área).
- Mudanças na skill `auditoria-seguranca`, no subagente
  `auditor-seguranca`, em `docs/agente/instrucoes-do-agente.md`,
  `docs/agente/prompts-das-etapas.md`, `.claude/skills/proxima-etapa`,
  `.github/pull_request_template.md` e `docs/qa/estrategia-de-testes.md`.
- O primeiro passe completo e as PRs de correção.

**Fica fora (e onde vai parar):**

- Pentest contra a instalação em produção → depois do primeiro deploy, só com
  o OK do Pablo (mexe na conta dele).
- Ferramentas novas de varredura na CI (Semgrep, gitleaks) → não agora:
  CodeQL e o secret scanning do GitHub já rodam de graça; uma dependência
  nova na CI precisa de motivo claro (`AGENTS.md`).
- Proteção contra DNS rebinding no MCP → continua na etapa 22, salvo se o
  passe completo provar risco real antes.

## 5. Como funciona para o Pablo

Sem tela nova: muda só o processo do agente.

### Fluxo 1 · Funcionalidade nova

1. A thread termina a implementação e roda `verificar` e `revisao-qa`.
2. A skill `auditoria-seguranca` faz o passe da funcionalidade
   (`docs/qa/pentest.md`): áreas tocadas, atacantes, ataques como teste,
   correção, revisão de fora.
3. Achado crítico, alto ou médio: a thread para e manda ao Pablo o achado, a
   gravidade e a correção recomendada. Baixo: corrige na PR ou lista.
4. A seção "Segurança" do PR mostra o que foi atacado e o resultado. A PR
   mescla sozinha se tudo estiver verde.

### Fluxo 2 · Passe completo

1. No fim de cada fase, nas etapas marcadas, antes do primeiro deploy ou a
   pedido, a thread usa o prompt "Pentest completo" de
   `docs/agente/prompts-das-etapas.md`.
2. Um auditor por grupo de áreas ataca em paralelo; a thread confirma cada
   achado no código e corrige em PRs pequenas, uma por área.
3. O relatório vai para `docs/qa/auditorias/` e o Pablo recebe um resumo
   curto com o que achou, o que corrigiu e o que precisa dele.

### Textos visíveis

Sem texto novo na interface.

## 6. Regras de negócio e limites

| Regra | Valor | No limite | Erro |
| --- | --- | --- | --- |
| Auditores em paralelo no passe completo | até 6 | os grupos se juntam | — |
| Auditores no passe da funcionalidade | 1 por área tocada, até 3 | áreas vizinhas no mesmo auditor | — |
| Achado crítico, alto ou médio aberto | 0 para mesclar | a PR não mescla; Pablo chamado | — |
| Correção de achado baixo na mesma PR | até uns 3 arquivos | acima disso, lista no PR com recomendação | — |

## 7. Desenho técnico

### Arquivos

| Arquivo | Cria ou muda | Para quê |
| --- | --- | --- |
| `docs/qa/pentest.md` | cria | Procedimento, atacantes T1 a T8, gravidade, divulgação, mapa de áreas A1 a A13, catálogo de ataques, varredura e registro |
| `docs/planos/auditoria-de-seguranca.md` | cria | Este plano |
| `.claude/skills/auditoria-seguranca/SKILL.md` | muda | O passe de pentest vira o corpo da skill |
| `.claude/agents/auditor-seguranca.md` | muda | Lê o catálogo da área e devolve achados com id e atacante |
| `.claude/skills/proxima-etapa/SKILL.md` | muda | Trava: passe feito e nenhum achado crítico, alto ou médio aberto |
| `docs/agente/instrucoes-do-agente.md` | muda | Seção de segurança aponta para o pentest |
| `docs/agente/prompts-das-etapas.md` | muda | Regra geral e o prompt de manutenção "Pentest completo" |
| `docs/qa/estrategia-de-testes.md` | muda | Ciclo do QA e portões citam o pentest |
| `.github/pull_request_template.md` | muda | Seção "Segurança" no formato do passe |
| `docs/qa/auditorias/2026-11-03-passe-completo.md` | cria | Relatório do primeiro passe |

### Rotas e contratos

Nenhuma rota nova.

### Banco

Nenhuma migration.

### Ferramentas do agente

Nenhuma ferramenta nova.

### Agendamentos, IA e integrações externas

Nenhum.

## 8. Custo e cotas do plano Free

O processo roda só localmente e na CI que já existe. Não liga recurso,
não chama a conta de produção.

| Recurso | Uso típico | Pior caso | Folga | Fonte |
| --- | --- | --- | --- | --- |
| Cotas da Cloudflare | 0 | 0 | total | roda em `wrangler dev --local` e Vitest |
| Minutos de Actions | os testes novos de segurança | idem | repositório público: Actions grátis | docs do GitHub Actions |

## 9. Segurança e privacidade

| Ameaça | Defesa | Teste |
| --- | --- | --- |
| Achado aberto publicado com passo a passo | Seção "Divulgação" de `docs/qa/pentest.md`; detalhe só na thread até corrigir | revisão do PR |
| Pentest atingir produção ou terceiros | Alvo é só o código local; nunca token real | regra no procedimento |
| Auditor confirmar a hipótese de quem pediu | Auditor recebe só o escopo, nunca as conclusões | regra da skill |
| Achado do auditor sem prova | A thread confirma no código antes de aceitar | passo 6 do procedimento |

Nível da auditoria do próprio plano: orientação (só documentação).

## 10. Testes

| CA | Teste | Camada | Arquivo |
| --- | --- | --- | --- |
| CA1, CA2 | Procedimento cobre A1 a A13 e T1 a T8 | revisão | `docs/qa/pentest.md` |
| CA3 | Skill, instruções, prompts, travas e modelo de PR citam o passe | revisão | arquivos da seção 7 |
| CA4 | Testes `SEC-A*-*` das PRs de correção, com prova do vermelho | segurança | PRs de correção |
| CA5 | Relatório do passe completo | revisão | `docs/qa/auditorias/2026-11-03-passe-completo.md` |
| CA6 | PRs de correção sem passo a passo de achado alto aberto | revisão | PRs de correção |

## 11. Entrega

- **Ordem:** (1) esta PR de processo, só documentação; (2) passe completo;
  (3) uma PR `security(<área>)` por grupo de achados, cada uma mesclável
  sozinha; (4) PR do relatório (pode ir junto da última correção).
- **Capturas:** Sem mudança visível.
- **Docs:** os da seção 7. README: sem mudança (processo interno).
- **Changelog:** a PR de processo é interna (rótulo `sem-changelog`); cada
  correção entra em `changelog/nao-lancado/<assunto>.md` no grupo
  `### Segurança`.
- **Instalação:** nada novo.
- **Portabilidade:** nenhum.

## 12. Riscos

| Risco | Chance | Impacto | O que fazemos |
| --- | --- | --- | --- |
| O passe vira formalidade (cópia do catálogo sem atacar) | média | alto | O PR mostra os testes de cada tentativa; QA confere |
| Muitos achados baixos travando etapas | média | baixo | Baixo não trava; vai para a lista |
| Conflito com PRs abertas que mexem nos mesmos docs | baixa | baixo | Mudanças pequenas e só de acréscimo |
| Correção de segurança quebrar o teto de JS | baixa | médio | Correção no servidor sempre que possível; medir o JS inicial |

## 13. Suposições

- Sem pergunta ao Pablo: gravidade e regra de parada seguem as instruções do
  agente; o resto é processo interno.
- O passe da funcionalidade usa os subagentes que já existem; nada de skill
  nova (a `auditoria-seguranca` ganha o passo a passo).
- Os ids `SEC-<área>-<nn>` convivem com os antigos `SEC-<etapa>-<nn>`; nada
  é renomeado.

## 14. Entrevista com o Pablo

Sem perguntas: o pedido de 03/11/2026 cobre o escopo, e gravidade, parada e
custo já estão nas instruções do agente e em `decisoes.md`.

| Data | Pergunta | Resposta |
| --- | --- | --- |
| — | — | — |

### Perguntas abertas

- Nenhuma.
