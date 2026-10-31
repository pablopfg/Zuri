# Prompts das etapas seguintes (1 a 25)

Depois que o PR da etapa 0 estiver mesclado, envie um prompt por vez, na ordem.

- **Mande o próximo só depois de mesclar o PR anterior.** A exceção são as etapas marcadas como *paralela*, que você pode pedir em conversas separadas.
- **Copie só o bloco da etapa.** O agente já tem as instruções do projeto e a especificação, e cada prompt aponta a seção certa.
- **Responda antes de continuar** quando o prompt disser "▶ Antes, você fornece". Nunca cole token, senha ou id no chat. O agente explica onde colocar cada um: segredo do Worker no painel da Cloudflare ou ambiente `production` do GitHub.

> **Com o modo contínuo ligado (padrão), você não precisa mandar estes prompts.** O agente fecha cada etapa, mescla na `develop` e abre sozinho uma thread nova com o bloco da etapa seguinte, tirado da cópia deste arquivo no repositório (`docs/agente/prompts-das-etapas.md`). Ele só para quando precisa de você. Veja `06-modo-continuo.md`. Use os blocos abaixo para rodar uma etapa à mão, refazer uma etapa ou depois de desligar o modo contínuo.

## Ordem e paralelismo

| Fase | Etapas | Pode rodar em paralelo |
| --- | --- | --- |
| A · Fundação | 1 → 2 → 3 → 4 → 5 | Não |
| B · Assistente na web | 6, 7, 8 → 9 → 10 → 11 | 6, 7 e 8 entre si |
| C · Bot do Telegram | 12 → 13, 14, 15 → 16 | 13 e 14 entre si, depois da 12 |
| D · Paridade | 17, 18, 19, 20, 22 (21 só com OK) | Todas entre si, depois da 11 |
| E · Fechamento | 23 → 24 → 25 | A 24 pode começar depois da 5 |

---

## Fase A · Fundação

### Etapa 1 · Worker, Durable Object e portões

```text
Execute a etapa 1 da especificação ("Worker, Durable Object e portões").

- Antes de codar, confira que a etapa 0 está mesclada na develop e leia as seções "Arquitetura na Cloudflare" (portões, bindings) e "Contratos, constantes e referências" (rotas, códigos de erro).
- Use as skills do plugin cloudflare (workers-best-practices, durable-objects, wrangler) para confirmar a configuração atual do wrangler.jsonc, a data de compatibilidade e run_worker_first. Não confie na memória.
- Siga o fluxo de sempre: skill iniciar-etapa, plano no PR, testes junto, verificar, revisao-qa, auditoria-seguranca (com revisor-cloudflare), PR para develop com a matriz de rastreabilidade.
- Me mande o link do PR, o resultado real dos testes e qualquer decisão de produto pendente, com a sua recomendação.
```

### Etapa 2 · Banco, configurações e i18n

```text
Execute a etapa 2 da especificação ("Banco, configurações e i18n").

- Leia antes .claude/rules/migrations.md, .claude/rules/i18n.md e a skill nova-migration.
- A migration 1 nasce aqui. Teste anti-DROP, banco vazio e reaplicação idempotente.
- O lint de literais visíveis precisa falhar de verdade: inclua um teste com um literal plantado de propósito, que o lint pega.
- Fluxo completo de etapa (verificar, revisao-qa, auditoria-seguranca), PR para develop. Me mande o link e o resultado dos testes.
```

### Etapa 3 · Login e sessões

```text
Execute a etapa 3 da especificação ("Login e sessões").

- Leia antes as "Regras de segurança que valem para todo código" e, no Talorys, o docs/security.md (autenticação, sessão, força bruta). Reescreva limpo; não copie.
- Cubra com teste cada limite exato (n−1, n, n+1): 3 falhas por rede em 15 min, Turnstile depois de 1 falha, expiração de 30 min, 5 min e 6 h, senha de 15 caracteres, e a falha fechada do HIBP sem rede.
- Os alertas desta etapa ficam gravados com alert_pending (entrega na etapa 11).
- Fluxo completo de etapa, com atenção dobrada na auditoria: é a porta de entrada. PR para develop, link e resultado dos testes.
```

### Etapa 4 · 2FA e passkeys

```text
Execute a etapa 4 da especificação ("2FA e passkeys").

- Confirme na documentação oficial do WebAuthn e na biblioteca escolhida (versão exata) os parâmetros de userVerification e do desafio. A passkey também vai servir às aprovações do bot (etapa 16), então deixe a verificação reutilizável.
- Testes de reuso de código TOTP, de código de recuperação, de desafio vencido e de passkey de outro host.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 5 · Casca da interface

```text
Execute a etapa 5 da especificação ("Casca da interface").

- Leia antes .claude/rules/web-ui.md e a seção "Telas e estados". Faça uma revisão de UX (estados vazio, carregando, erro, teclado, leitor de tela) e registre no PR.
- Proponha a identidade visual do Zuri (logo, cores, favicon) em até 3 opções e me pergunte qual prefiro antes de fechar. Enquanto isso, siga com a sua recomendação.
- Aceite: e2e de login, logout e expiração, axe sem violação séria, Lighthouse de acessibilidade ≥ 90, PWA instalável, /api/* com Cache-Control: no-store.
- Fluxo completo de etapa, PR para develop, link, capturas de tela (claro e escuro, celular e computador) e resultado dos testes.
```

---

## Fase B · Assistente na web

### Etapa 6 · Tarefas, notas e projetos *(paralela com 7 e 8)*

```text
Execute a etapa 6 da especificação ("Tarefas, notas e projetos").

- Contratos da API e limites por tipo vêm da seção "Contratos, constantes e referências". Migration nova pela skill nova-migration.
- Casos de borda obrigatórios: datas impossíveis (inclusive com fuso explícito), 29/02, busca com % e _ no LIKE, FTS5 com aspas e operadores, lixeira e restauração, limite exato por tipo.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 7 · Memória e histórico *(paralela com 6 e 8)*

```text
Execute a etapa 7 da especificação ("Memória e histórico").

- Leia no Talorys o docs/memory-history.md e transforme cada caso descrito em teste.
- Cuidado com ciclos de substituição e com memória que tenta virar instrução: conteúdo guardado é dado.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 8 · Provedor de IA e medição de uso *(paralela com 6 e 7)*

```text
Execute a etapa 8 da especificação ("Provedor de IA e medição de uso").

- Confirme com a skill do plugin cloudflare os nomes e parâmetros atuais dos modelos da seção "Modelos do Workers AI" e o preço em Neurons. Se algo mudou, me avise com a sua recomendação antes de trocar o modelo.
- Teste de concorrência: N requisições simultâneas não passam do limite diário. Chamada abortada no meio do stream ainda é contada.
- Nenhum modelo pago aqui (decisão N7).
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 9 · Chat com ferramentas

```text
Execute a etapa 9 da especificação ("Chat com ferramentas"). Confira antes que as etapas 6, 7 e 8 estão mescladas.

- Leia .claude/rules/ferramentas.md e use a skill nova-ferramenta para cada ferramenta. Toda ferramenta tem schema Zod, permissão, limite por turno, e as destrutivas viram proposta.
- Os cenários de prompt injection do docs/security.md do Talorys viram testes com o MockAIProvider. Inclua injeção vinda de nota, de memória e de resultado de ferramenta.
- A voz tem os limites da especificação (60 s por clipe, 60 min por dia, um por vez).
- Fluxo completo de etapa. A auditoria precisa cobrir agência excessiva e vazamento de prompt. PR para develop, link e resultado dos testes.
```

### Etapa 10 · Automações

```text
Execute a etapa 10 da especificação ("Automações").

- Testes com relógio falso e fuso America/Sao_Paulo: virada de horário de verão histórico, dia 31, fim de mês, reconciliação que roda uma vez só depois de reinício.
- A rotina criada pelo chat nasce pendente de aprovação. Teste os limites de 1 hora mínima e 50 ativas.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 11 · Central de avisos, push e e-mail

```text
Execute a etapa 11 da especificação ("Central de avisos, push e e-mail").

▶ Antes, você fornece: se ainda não estiver pronto, o domínio na Cloudflare e o Email Routing com o meu e-mail verificado. Me diga exatamente o que configurar no painel. O e-mail entra só como variável do ambiente production, nunca no repositório.

- Confirme com o plugin cloudflare o formato atual do binding send_email com destination_address.
- Entregue os alertas pendentes desde a etapa 3 e a recuperação de senha por e-mail. A interface AlertChannel tem que ficar pronta para o Telegram.
- Teste: alerta de segurança sai por todos os canais mesmo com a categoria desligada, os 4 e-mails reservados para segurança são respeitados e a insistência funciona com relógio falso.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

---

## Fase C · Bot do Telegram

### Etapa 12 · Fundação do bot

```text
Execute a etapa 12 da especificação ("Fundação do bot"). Leia por inteiro a seção "Bot do Telegram do administrador" e .claude/rules/telegram.md.

▶ Antes, você fornece: crie o bot no @BotFather e me diga o nome de usuário escolhido. Me explique onde colocar o TELEGRAM_BOT_TOKEN e o TELEGRAM_ADMIN_ID como segredos do Worker, sem colar nada no chat.

- Confirme na documentação oficial da Bot API (core.telegram.org/bots/api) setWebhook com secret_token, allowed_updates, drop_pending_updates e max_connections.
- O processamento é no Durable Object com keepAliveWhile, nunca em ctx.waitUntil. O webhook é registrado pelo próprio Worker; o GitHub Actions nunca recebe o token.
- Testes: sem cabeçalho = 403, corpo acima de 64 KB recusado, update_id repetido ignorado, conta estranha não grava nada, código de vínculo errado 10 vezes é invalidado.
- Fluxo completo de etapa (auditor-seguranca com o checklist de Telegram), PR para develop, link e resultado dos testes.
```

### Etapa 13 · Avisos no Telegram *(paralela com 14)*

```text
Execute a etapa 13 da especificação ("Avisos no Telegram").

- Canal Telegram plugado na AlertChannel da etapa 11. Grupo opcional (N9) com tópico por categoria; o chat privado é o padrão.
- Testes: link desarmado em todo texto, só o dono aciona botões no grupo, segundo toque responde "já tratado", insistência +15/+60 com relógio falso, o grupo nunca recebe sozinho um alerta de segurança.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 14 · Conversa e voz *(paralela com 13)*

```text
Execute a etapa 14 da especificação ("Conversa e voz").

- Texto do Telegram é dado: entra no prompt em bloco <data> neutralizado. Escape para o HTML do Telegram e divida em blocos de 4.096 caracteres sem cortar tags nem entidades.
- Voz até 5 min e 5 MB, mesmo teto diário do app, áudio nunca guardado. Com a conversa desligada, o bot nem baixa o arquivo (teste que prova que getFile não é chamado).
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 15 · Comandos administrativos

```text
Execute a etapa 15 da especificação ("Comandos administrativos"). Confira antes que as etapas 6, 7, 10, 11 e 12 estão mescladas.

- Cada comando da lista tem teste, e nenhum gasta pedido de IA (teste que confere o contador). Siga a "Gramática de datas do bot" para /nova e /lembrar.
- Inclua a trava de leitura de 12 h (N10), /destravar e /backup (só o link para a tela). Fotos e documentos seguem N4: a legenda vira nota e o arquivo não é guardado.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 16 · Aprovações seguras e modo de bloqueio

```text
Execute a etapa 16 da especificação ("Aprovações seguras e modo de bloqueio"). É a etapa mais sensível do bot.

- Releia "Aprovação pelo bot" e "Modo de bloqueio". Confirmação por passkey (página /aprovar com token de uso único) ou código de 6 dígitos por e-mail, nunca TOTP, validade de 5 min, presa ao hash da proposta. A prévia vem do banco, nunca do texto do modelo.
- Cada item de aceite da etapa vira teste, inclusive: /bloquear com a IA fora do ar, alerta causado pelo bot que não se reconhece pelo bot, e rebloqueio em 24 h que suspende o vínculo.
- Rode a auditoria com o auditor-seguranca e também /security-review. Corrija tudo que for alto ou médio antes do PR.
- PR para develop com o relatório de auditoria completo, link e resultado dos testes.
```

---

## Fase D · Paridade com o Talorys (paralelas entre si)

### Etapa 17 · Busca semântica

```text
Execute a etapa 17 da especificação ("Busca semântica"). É opcional e fica desligada por padrão.

- Confirme com o plugin cloudflare o modelo de embeddings e o custo em Neurons. Vetores no SQLite do Durable Object; nada de Vectorize (seria recurso novo).
- Testes: desligada, o comportamento é idêntico ao de antes; a busca híbrida acha "carro" na memória "automóvel" com o mock; o teto diário é respeitado.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 18 · Servidores MCP remotos

```text
Execute a etapa 18 da especificação ("Servidores MCP remotos").

- Leia no Talorys o docs/mcp.md e a parte de MCP do docs/security.md. Os testes de lá viram testes aqui.
- O fetch protegido é reutilizado pela etapa 22. Teste trava de origem, DNS para IP privado, redirecionamento recusado, limite de tamanho, tempo de 35 s, e que a troca de URL zera a confiança e a credencial.
- Resultado de MCP é dado, nunca instrução. Ferramentas desligadas por padrão, com prefixo mcp_.
- Fluxo completo de etapa (auditoria de SSRF e injeção indireta), PR para develop, link e resultado dos testes.
```

### Etapa 19 · Google Agenda

```text
Execute a etapa 19 da especificação ("Google Agenda").

▶ Antes, você fornece: o cliente OAuth gratuito do Google. Me diga o passo a passo no Google Cloud Console e onde guardar o client id e o secret como segredos do Worker.

- delete_calendar_event é proposta. Agendas só leitura não aceitam escrita (teste). Eventos da agenda são dados.
- /hoje no bot passa a incluir a agenda. As rotinas de briefing (07:00) e fechamento (19:00) usam o fuso do dono.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 20 · Acesso remoto e eventos

```text
Execute a etapa 20 da especificação ("Acesso remoto e eventos").

- Tokens zur_pat_ com escopo, 90 dias, só hash. Teste que percorre todas as rotas: token read recebe 403 em toda escrita, e nenhum token alcança /api/telegram, aprovações nem planos.
- POST /api/remote/events com limites de 60 por hora e 100 por dia. O conteúdo do evento é dado.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 21 · Modelos pagos ⚠️

```text
Não execute a etapa 21 sem a minha aprovação explícita nesta conversa. Ela gera cobrança.

Primeiro me mande, em até 10 linhas: o que a etapa faz, quanto pode custar por dia com o teto padrão de US$ 2, quais segredos eu teria de criar e a sua recomendação (fazer agora, depois ou nunca). Só implemente se eu responder "aprovado". Nesse caso, siga a etapa 21 da especificação com ⚠️ no PR e no changelog.
```

### Etapa 22 · Workflows (monitor de sites)

```text
Execute a etapa 22 da especificação ("Workflows").

- Confirme com o plugin cloudflare a API atual do Cloudflare Workflows e os limites do plano Free. Se algo sair do gratuito, pare e me pergunte.
- Endereços só pela tela, com senha recente. Nenhuma ferramenta do agente, comando do bot ou token remoto altera a lista (teste para cada caminho).
- Reutilize o fetch protegido da etapa 18. Nada do corpo da resposta vai ao modelo. /status no bot mostra os monitores.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

---

## Fase E · Fechamento

### Etapa 23 · Backup, importação e retenção

```text
Execute a etapa 23 da especificação ("Backup, importação e retenção").

- A importação segue as regras de entrada não confiável. Um backup malicioso (automação ligada, MCP, 11 MB, 10.001 memórias) é recusado inteiro, sem gravar nada (teste).
- Teste de ida e volta: exportar, importar num banco vazio e comparar. O bot avisa quando o último backup tem mais de 30 dias, e o arquivo nunca vai pelo Telegram.
- Fluxo completo de etapa, PR para develop, link e resultado dos testes.
```

### Etapa 24 · Deploy e guia de instalação

```text
Execute a etapa 24 da especificação ("Deploy e guia de instalação").

▶ Antes, você fornece: conta Cloudflare, id da conta e um token de API com as permissões mínimas que você listar. Me diga como criar o token e onde colocá-lo (ambiente production do GitHub, só para a main), e me passe a lista dos segredos do Worker que eu crio no painel.

- Deploy só em push para a main, ambiente production protegido. O deploy falha se workers.dev ou preview_urls estiverem ligados com domínio próprio (teste).
- O docs/instalacao-cloudflare.md tem o passo a passo só pelo navegador, inclusive o @BotFather e a regra de Bypass do Access para o webhook do Telegram. O docs/instalacao-cloudflare.md do Talorys é a referência.
- Use o revisor-cloudflare e confira as permissões do token e das Actions (fixadas por SHA, permissions mínimas).
- PR para develop, link e resultado dos testes. Depois de mesclado, me diga como abrir o PR de release develop → main e o que conferir no primeiro deploy.
```

### Etapa 25 · Auditoria final e testes de ponta a ponta

```text
Execute a etapa 25 da especificação ("Auditoria final e testes de ponta a ponta").

- Auditoria completa do repositório inteiro com as skills auditoria-seguranca e revisao-qa, os subagentes auditor-seguranca, qa-senior e revisor-cloudflare, e /security-review. Não é só o diff.
- E2E de todas as telas, teste do webhook do Telegram com atualizações reais gravadas (sem token real), e uma matriz de rastreabilidade final: cada critério de aceite das 26 etapas ligado ao seu teste.
- Corrija tudo que for alto ou médio. O que ficar baixo vai para uma lista no PR com a sua recomendação.
- PR para develop com o relatório completo, link e resultado dos testes.
```

---

## Prompts de manutenção (use quando precisar)

**Pausar o modo contínuo**
```text
Pause o modo contínuo: termine só o passo atual, faça commit, marque "Situação: pausado" em .claude/memoria/progresso.md com o motivo "pedido do Pablo" e me diga em que ponto parou.
```

**Retomar o modo contínuo**
```text
Retome o modo contínuo: marque "Situação: ligado" em .claude/memoria/progresso.md, confira o que estava em "Esperando o Pablo" (já forneci <o quê>) e siga pela próxima etapa numa thread nova.
```

**Revisar um PR antes de mesclar**
```text
Revise o PR <link> como QA sênior independente: confira a matriz de rastreabilidade, rode verificar, revisao-qa e auditoria-seguranca na branch, e me diga se está pronto para mesclar ou o que falta.
```

**CI vermelha ou conflito**
```text
O PR <link> está com a CI vermelha (ou com conflito). Reproduza a falha, corrija a causa sem enfraquecer teste nem segurança, traga a develop se precisar, rode tudo de novo e me avise quando estiver verde.
```

**Bug encontrado em uso**
```text
Encontrei este problema: <descrição, passos, o que esperava>. Escreva primeiro um teste que reproduz, corrija, rode a auditoria e abra um PR fix(...) para develop.
```

**Mudança de escopo**
```text
Quero mudar <o quê>. Antes de codar, me diga o impacto na especificação, nas etapas e no custo, e a sua recomendação. Se eu aprovar, atualize docs/especificacao.md e .claude/memoria/decisoes.md no mesmo PR.
```

**Release para a main**
```text
Prepare a release: confira se a develop está verde, monte o changelog da versão em pt-BR, abra o PR develop → main e me passe o que conferir depois do deploy.
```

**Retomar depois de uma pausa**
```text
Retome o projeto: leia docs/especificacao.md, .claude/memoria/decisoes.md e os PRs abertos e mesclados, e me diga em até 10 linhas em que etapa estamos, o que está pendente e qual é o próximo prompt.
```
