---
name: nova-ferramenta
description: Passo a passo seguro para criar uma ferramenta do agente do Zuri (tool calling). Use sempre que o agente ganhar uma ação nova.
---

# Nova ferramenta do agente

1. Leia `.claude/rules/ferramentas.md` e a tabela "Classes de ferramentas" da especificação. Confirme a classe com a especificação; ferramenta fora da tabela exige decisão do dono.
2. Defina nome (snake_case, sem `mcp_`), descrição em inglês, entrada Zod com limites, permissão, rótulo e limite por turno.
3. `destructive`: `prepare` + `commit`, aprovação vinculada ao hash do alvo, prévia montada pelo servidor.
4. Nada de rede, shell, credenciais; só a camada de serviços.
5. Textos no catálogo de i18n.
6. Testes: caminho feliz, validação, limite por turno, aprovação, alvo alterado, injeção vinda de nota ou memória, execução agendada sem acesso (se não for `read`).
