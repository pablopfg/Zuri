---
name: auditoria-seguranca
description: Auditoria de segurança independente obrigatória ao terminar qualquer ajuste no Zuri - revisa o diff, aplica correções e testa tudo de novo. Use depois da revisão de QA e antes de abrir ou mesclar o PR.
---

# Auditoria de segurança ao fim de cada ajuste

Nenhum ajuste está pronto antes desta auditoria.

1. **Contexto.** Leia as "Regras de segurança" e as seções da especificação ligadas ao que mudou, e `git diff origin/develop...HEAD`.
2. **Revisão independente.** Peça ao subagente `auditor-seguranca` que audite o diff, passando só o escopo (branch e áreas).
3. **Cloudflare.** Se tocar Workers, Durable Objects, Workflows, Workers AI, wrangler ou limites, peça também ao `revisor-cloudflare` e use as skills do plugin `cloudflare`.
4. **Skill de auditoria da Cloudflare** (`cloudflare-security-audit:security-audit`):
   - **toda etapa, modo orientação:** aplique as classes de ataque que tocam o diff (em especial `AI-AND-LLM`, `WEB-PROTOCOL-AND-AUTH`, `PROTOCOLS-RPC-AND-MESSAGING`, `RESOURCE-EXHAUSTION-AND-AVAILABILITY` e `CLOUD-AND-DEPLOYMENT`), sem criar arquivos;
   - **etapas 3, 4, 12, 16, 18, 20 e 25, auditoria completa:** peça explicitamente o modo completo, com a pasta de saída fora do repositório (padrão da skill). Leve ao PR só o resumo e os achados confirmados; nada de `findings.json` no repositório.
5. **Comandos nativos.** Rode `/security-review` quando disponível.
6. **Varredura rápida:**
   - `git diff origin/develop...HEAD | grep -nEi "(api[_-]?key|secret|token|password|senha|bearer)\s*[:=]"` → nenhum valor real;
   - nada de domínio, e-mail ou id real em arquivos versionados;
   - `npm audit --audit-level=high` sem vulnerabilidade nova.
7. **Corrija** cada achado confirmado, com teste que falhava antes (id do achado no nome do teste). Confirme o vermelho quebrando a correção de propósito e desfazendo.
   Controles que precisam de teste sempre que a etapa os toca: CSP sem violação (`csp.spec.ts`), XSS do conteúdo do dono, senha recente, cabeçalhos de IP forjados, corpo acima do limite em fluxo, rotas no teste de `app.routes`.
8. **Teste tudo** com a skill `verificar`.
9. **Registre** no PR (seção "Segurança"): o que foi auditado, achados, correções ou "nenhum achado" com o que foi coberto. Correção de vulnerabilidade entra no changelog em `### Segurança`.
