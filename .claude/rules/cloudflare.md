---
paths:
  - "apps/agent/wrangler*.jsonc"
  - "apps/agent/src/index.ts"
  - "apps/agent/src/workflows/**"
  - "apps/agent/src/semantic/**"
---

# Cloudflare

- **Plano gratuito.** Em uso: Workers, Durable Objects (SQLite), Workers AI, Workflows, assets, Email Routing (`send_email`), Turnstile e, opcional, Cloudflare Access. KV, D1, R2, Vectorize, Queues e Workers Paid **não** estão em uso; qualquer um exige aprovação do dono e ⚠️.
- Consulte as skills do plugin `cloudflare` ou a documentação oficial antes de usar uma API. Confira limites do plano Free (subrequisições por invocação, CPU, armazenamento do Durable Object, Neurons) e registre no PR.
- Um único Durable Object de nome fixo guarda tudo. Não crie outra instância.
- Trabalho longo (bot, transcrição) roda no Durable Object com `keepAliveWhile`, nunca em `ctx.waitUntil` do Worker.
- Vigias por `this.schedule` (cron do Agents SDK), sem Cron Trigger do Worker.
- Segredos só como Worker secrets, nunca em `vars`.
- `run_worker_first: true`, `preview_urls: false`, `workers_dev: false` com domínio próprio, publicação como Custom Domain.
