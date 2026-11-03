---
name: auditoria-seguranca
description: Auditoria de segurança obrigatória ao terminar qualquer ajuste no Zuri - pentest do próprio sistema (ataca o que mudou, corrige e prova) e revisão independente. Use depois da revisão de QA e antes de abrir ou mesclar o PR, e no passe completo de fim de fase.
---

# Auditoria de segurança ao fim de cada ajuste

Nenhum ajuste está pronto antes desta auditoria. Ela é um pentest do próprio
sistema: o procedimento, os atacantes (T1 a T8), as áreas (A1 a A13), o
catálogo de ataques e a gravidade estão em `docs/qa/pentest.md`. Leia esse
arquivo antes de começar.

Modo: **passe da funcionalidade** em todo PR que muda código que roda;
**passe completo** (todas as áreas, um `auditor-seguranca` por grupo, até 6)
no fim de cada fase, nas etapas abaixo, antes do primeiro deploy e a pedido.
PR só de docs: escreva "Sem superfície nova: pentest dispensado".

1. **Contexto e superfície.** Leia as "Regras de segurança" e as seções da especificação ligadas ao que mudou, e `git diff origin/develop...HEAD`. Cruze os arquivos com o "Mapa de áreas" e liste o que é novo (rotas, ferramentas, comandos, tabelas, segredos, chamadas de rede, telas).
2. **Atacar.** Para cada item novo, escolha os atacantes que o alcançam e escreva cada ataque plausível como teste (catálogo da área como ponto de partida). Teste vermelho é achado: id `SEC-<área>-<nn>` e gravidade pela tabela do `docs/qa/pentest.md`. Achado crítico, alto ou médio: pare e chame o Pablo, sem publicar o passo a passo (seção "Divulgação").
3. **Revisão independente.** Peça ao subagente `auditor-seguranca` que audite as áreas tocadas (um por área, até 3), passando só o escopo (branch e áreas), nunca as suas conclusões. Confirme no código cada achado dele antes de aceitar.
4. **Cloudflare.** Se tocar Workers, Durable Objects, Workflows, Workers AI, wrangler ou limites, peça também ao `revisor-cloudflare` e use as skills do plugin `cloudflare`.
5. **Skill de auditoria da Cloudflare** (`cloudflare-security-audit:security-audit`):
   - **toda etapa, modo orientação:** aplique as classes de ataque que tocam o diff (em especial `AI-AND-LLM`, `WEB-PROTOCOL-AND-AUTH`, `PROTOCOLS-RPC-AND-MESSAGING`, `RESOURCE-EXHAUSTION-AND-AVAILABILITY` e `CLOUD-AND-DEPLOYMENT`), sem criar arquivos;
   - **etapas 3, 4, 12, 16, 18, 20 e 25, auditoria completa:** peça explicitamente o modo completo, com a pasta de saída fora do repositório (padrão da skill). Leve ao PR só o resumo e os achados confirmados; nada de `findings.json` no repositório.
6. **Comandos nativos.** Rode `/security-review` quando disponível.
7. **Varredura rápida** (lista completa em `docs/qa/pentest.md`):
   - `git diff origin/develop...HEAD | grep -nEi "(api[_-]?key|secret|token|password|senha|bearer)\s*[:=]"` → nenhum valor real;
   - nada de domínio, e-mail ou id real em arquivos versionados;
   - `npm audit --audit-level=high` sem vulnerabilidade nova.
8. **Corrija** cada achado confirmado, com teste que falhava antes (id do achado no nome do teste). Confirme o vermelho quebrando a correção de propósito e desfazendo.
   Controles que precisam de teste sempre que a etapa os toca: CSP sem violação (`csp.spec.ts`), XSS do conteúdo do dono, senha recente, cabeçalhos de IP forjados, corpo acima do limite em fluxo, rotas no teste de `app.routes`.
9. **Teste tudo** com a skill `verificar`.
10. **Registre** no PR (seção "Segurança"): áreas atacadas, atacantes, tentativas com o teste de cada uma, achados com id, gravidade, correção e prova do vermelho, riscos aceitos pelo Pablo. Passe completo: relatório em `docs/qa/auditorias/AAAA-MM-DD-<escopo>.md`. Ataque novo que provou valor entra no catálogo de `docs/qa/pentest.md`. Correção de vulnerabilidade entra no changelog em `### Segurança`.
