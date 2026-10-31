---
name: nova-migration
description: Passo a passo seguro para criar uma migration do SQLite do Durable Object do Zuri. Use sempre que precisar criar ou alterar uma tabela ou coluna.
---

# Nova migration

1. Leia `.claude/rules/migrations.md` e o fim de `MIGRATIONS` em `apps/agent/src/db/migrations.ts`. A nova versão é a última + 1.
2. Confira na especificação ("Tabelas por domínio" e "Tabelas do Telegram") o nome e as colunas esperados. Divergência = pergunte antes.
3. Escreva só acréscimos (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN` com `DEFAULT`), com comentário em inglês explicando o porquê.
4. Decida backup (entra ou não) e sensibilidade (hash, HMAC ou cifra).
5. Testes: aplica num banco na versão anterior; idempotência; o teste anti-`DROP` continua passando.
6. Atualize a documentação do modelo de dados e o changelog (`### Atualização`).
