---
paths:
  - "apps/agent/src/db/**"
---

# Migrations do Durable Object

- **Só acréscimo.** Nunca edite, reordene, renumere ou apague uma entrada de `MIGRATIONS`. A próxima versão é a última + 1, conferida lendo o fim do array.
- Tabelas com prefixo `zur_`, nunca tocando nas `cf_agents_*` do Agents SDK. `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- `ADD COLUMN ... NOT NULL` precisa de `DEFAULT`.
- Nunca apague dados do dono; nunca `DROP` (há teste que recusa).
- Decida se a tabela entra no backup. Segredos, tokens, passkeys, sessões, vínculo do Telegram e credenciais nunca entram.
- Dados sensíveis cifrados (AES-GCM com `MCP_CREDENTIAL_KEY`) ou guardados só como hash/HMAC.
- Teste que aplica a migration num banco na versão anterior.
- Changelog em `### Atualização` e seção "Modelo de dados" da documentação atualizadas.
