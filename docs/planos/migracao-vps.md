# Migração do Zuri para uma VPS: plano detalhado

Situação: **plano pronto para usar, sem código.** Pedido do Pablo em
02/11/2026: "Deixe pronto o planejamento de migração de forma detalhada, caso
futuramente sejam necessários esses ajustes." A avaliação que levou a este
plano (por que não migrar agora, custos, o que depende da Cloudflare) está em
[portabilidade-vps.md](portabilidade-vps.md).

Este documento é o roteiro de quem for migrar: o que preparar antes, a ordem
das PRs com arquivos, testes e critério de pronto de cada uma, como montar a
VPS, como fazer a troca sem perder dados e como voltar atrás. Foi escrito sobre
o código da `develop` de 02/11/2026 (etapas 0 a 9 e o primeiro acesso) e sobre
a PR #46 (etapa 10, automações). Quem for executar confere primeiro o que mudou
desde então nas peças da tabela "Onde o código toca a Cloudflare".

Nada aqui liga recurso pago. A VPS, o armazenamento do backup fora dela e
qualquer API de IA paga são ⚠ e só entram com OK do Pablo.

## Quando usar este plano

| Situação | Caminho | Prazo realista |
| --- | --- | --- |
| A Cloudflare suspende a conta, muda o plano Free de um jeito que inviabiliza o Zuri ou fica fora do ar por dias | **A (emergência)** já; **B** depois, com calma | A em 1 a 3 dias; B em umas 2 a 4 semanas de PRs |
| O Pablo decide sair da Cloudflare sem pressa (custo, privacidade, controle) | **B** direto | 2 a 4 semanas de PRs |
| Uma cota do Free aperta (CPU, linhas, Neurons) mas o resto vai bem | Nenhum: primeiro otimizar (`.claude/rules/performance.md`), depois decidir | — |

Quem decide migrar é o Pablo. A thread que perceber um dos gatilhos para e
chama o Pablo com este documento e uma recomendação.

## Preparação que vale desde já (sem custo)

Estes itens não mudam código e são o que separa "migração em dias" de "perda
de dados". Recomendo fazer já, mesmo sem plano de migrar.

1. **Guardar cópia dos segredos fora da Cloudflare.** Worker secrets não podem
   ser lidos de volta pelo painel. O Pablo guarda num gerenciador de senhas os
   valores de `SESSION_SECRET`, `PASSWORD_PEPPER` e, quando existirem,
   `MCP_CREDENTIAL_KEY`, `TELEGRAM_BOT_TOKEN`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
   e `TURNSTILE_SECRET_KEY`. Por quê:
   - o segredo do TOTP (2FA) é cifrado com chave derivada do `PASSWORD_PEPPER`
     (`apps/agent/src/auth/mfa.ts`), e a senha usa o mesmo pepper. Pepper
     diferente na VPS é tratado como "redefinição completa de credenciais":
     senha e 2FA deixam de abrir e o dono precisa do código de recuperação;
   - as sessões, os tokens do 2FA e o segredo do webhook do Telegram saem de
     HMAC com o `SESSION_SECRET`. Com o mesmo valor, nada disso muda;
   - credenciais MCP e do Google (etapas 18 e 19) são cifradas com
     `MCP_CREDENTIAL_KEY`; sem a chave, precisam ser cadastradas de novo;
   - as chaves VAPID trocadas invalidam todas as assinaturas de push.
2. **Domínio fora da conta que pode ser suspensa.** O registro do domínio fica
   num registrador que não seja a Cloudflare (domínio `.com.br` já fica no
   Registro.br). Os nameservers podem continuar na Cloudflare: em emergência,
   troca-se o nameserver no registrador e o DNS passa para outro serviço. O
   Pablo anota onde o domínio está registrado e como entrar lá.
3. **Etapa 23 com backup portável e periódico.** Hoje não existe exportação: o
   SQLite do Durable Object só sai pelo próprio código do Zuri. Se a conta for
   suspensa antes da etapa 23, os dados ficam presos. Por isso a etapa 23
   precisa, além do que a especificação já pede:
   - exportação completa (todas as tabelas `zur_*`, inclusive automações,
     configurações, 2FA e passkeys cifrados), com número de versão do formato
     e o número da última migration;
   - teste que exporta, importa num banco vazio e confere linha a linha;
   - um lembrete mensal para o dono baixar o arquivo (aviso da central da
     etapa 11 e, com o bot, envio como documento no Telegram, dentro dos 50 MB
     de envio do bot). O arquivo fica com o dono, fora da Cloudflare.
4. **Código da Cloudflare só nas pontas** (cuidado 2 da avaliação). As etapas
   11 (e-mail), 17 (vetores) e 22 (Workflows) colocam uma interface pequena na
   frente do binding, como já fazem `Database`, `AIProvider` e o `AlarmClock`
   da etapa 10.

## Onde o código toca a Cloudflare

Levantado na `develop` de 02/11/2026. É a lista de pontos que as PRs abaixo
trocam; o resto do código (rotas, serviços, ferramentas, interface) não muda.

| Ponto | Arquivo | O que usa | Troca na VPS |
| --- | --- | --- | --- |
| Entrada HTTP | `apps/agent/src/index.ts` | `ExportedHandler`, `env.ASSETS.fetch`, `env.AGENT.getByName`, `request.cf` | B1 |
| Instância do agente | `apps/agent/src/agent/zuri-agent.ts` | `Agent` do Agents SDK; só `fetch`, `onRequest`, `ctx.storage`, `this.schedule`/`cancelSchedule` (etapa 10) | B4 |
| Banco | `apps/agent/src/db/database.ts` | `ctx.storage.sql.exec`, `transactionSync`, `databaseSize`, `rowsRead`/`rowsWritten` | B2 |
| Despertador das automações | `apps/agent/src/automations/service.ts` (PR #46) | interface `AlarmClock` (`schedule`, `cancel`, `exists`) implementada com o Agents SDK | B3 |
| IA de conversa | `apps/agent/src/ai/index.ts`, `workers-ai.ts`, `workers-ai-usage.ts` | binding `AI` via `workers-ai-provider` | B5 |
| Voz | `apps/agent/src/ai/transcription.ts` | `binding.run` do Whisper | B5 |
| IP e cidade | `apps/agent/src/auth/client.ts` | `cf-connecting-ip`, `request.cf` repassado no cabeçalho `x-zuri-client-geo` | B6 |
| Id de requisição | `apps/agent/src/log.ts`, `http/errors.ts` | `cf-ray` | B6 |
| Robô no login | `apps/agent/src/auth/turnstile.ts` | siteverify da Cloudflare por HTTPS | nenhuma (ou B6, se sair de vez) |
| Cloudflare Access | `apps/agent/src/gates/access.ts` | JWT do Access | fica desligado |
| Tipos | `worker-configuration.d.ts`, `env.ts` | `Env` gerado pelo `wrangler types` | B1 |
| Testes | `apps/agent/vitest.config.ts` | `@cloudflare/vitest-plugin` (workerd) | B2 |
| Configuração | `apps/agent/wrangler.jsonc` | bindings, `observability`, segredos | B7 |

## Arquitetura de destino

```
Internet ──443──▶ Caddy (HTTPS automático, Let's Encrypt)
                   │  header_up X-Zuri-Client-IP {remote_host}
                   │  header_up X-Forwarded-Proto https
                   ▼
             127.0.0.1:8787  processo Node do Zuri (usuário zuri, sem root)
                   │  app Hono (mesmos portões e rotas)
                   │  agente único criado na partida
                   │  agendador no próprio processo
                   ▼
             /var/lib/zuri/zuri.db  (SQLite, modo WAL)
                   │
                   ├── backup diário: VACUUM INTO → /var/backups/zuri, cifrado, cópia fora da VPS ⚠
                   └── IA: Workers AI pela API REST, ou Ollama em 127.0.0.1:11434, ou API paga ⚠
```

Regras desta arquitetura:

- **Um processo só abre o banco.** É o que substitui a garantia de "um Durable
  Object, um escritor". Nada de cluster, PM2 em modo cluster ou duas réplicas.
  O processo trava o arquivo com um lock (`/var/lib/zuri/zuri.lock`) e sai com
  erro se outro já estiver rodando.
- **O Node só escuta em 127.0.0.1.** Só o Caddy alcança o Zuri, então os
  cabeçalhos que o Caddy põe são confiáveis e os que vêm da internet são
  sobrescritos.
- **Mesmo domínio de antes.** As passkeys pertencem ao domínio (`rpId` = host
  do `PUBLIC_URL`). Mudar de domínio invalida todas; com o mesmo domínio, elas
  seguem funcionando. O Turnstile também é ligado ao nome do site.

## Caminho A: emergência com `workerd`

Objetivo: o Zuri no ar numa VPS em poucos dias, com o mínimo de código novo.
É o mesmo motor dos testes (`workerd`), rodando com configuração própria.

Passos:

1. **Prova de conceito (antes de precisar, se der).** Num diretório fora do
   repositório, gerar o bundle com `npm run build` (sai em
   `apps/agent/dist`) e escrever um `zuri.capnp` com: o Worker principal, a
   classe `ZuriAgent` como Durable Object com `durableObjectStorage =
   (localDisk = "zuri-do")`, os arquivos de `apps/web/dist` servidos por um
   serviço de disco no lugar de `ASSETS`, as variáveis e os segredos. Conferir
   três coisas, nessa ordem: o SQLite grava e sobrevive a reinício; o alarme
   das automações dispara depois de reiniciar o processo; o SSE da conversa
   chega ao navegador.
2. **IA.** O binding `AI` não existe fora da Cloudflare. Duas saídas, sem
   código novo de regra de negócio:
   - Workers AI pela API REST (enquanto a conta da Cloudflare existir): o
     `workers-ai-provider` aceita conta e token no lugar do binding. O token
     tem só a permissão do Workers AI e vira segredo na VPS. A cota de 10.000
     Neurons por dia continua valendo e o teto de 9.000 continua sendo
     aplicado pelo `MeteredAI`;
   - sem conta da Cloudflare: o provedor de B5.
3. **Borda.** Caddy na frente; um ajuste de poucas linhas no `index.ts` lê o
   IP de `X-Zuri-Client-IP` quando a variável `TRUST_PROXY_HEADERS=1` estiver
   ligada (o mesmo de B6, só que mínimo).
4. **Dados.** Restaurar o backup da etapa 23 pela importação. Sem etapa 23,
   não há de onde restaurar: por isso ela é a peça mais importante da
   preparação.
5. **Troca.** Seguir "Dia da troca", abaixo.

Riscos do Caminho A: pouca documentação do modo auto-hospedado do `workerd`
para Durable Objects; o comportamento do Agents SDK fora da Cloudflare não é
garantido pelo projeto; o próprio `workerd` avisa que não é uma sandbox
endurecida (aqui só roda código do Zuri). Por isso A é ponte, não destino.

Esforço: 2 a 3 PRs (prova de conceito com o `zuri.capnp` e o guia, ajuste da
borda, provedor de IA pela API REST).

## Caminho B: Node na VPS, PR por PR

Cada PR vai para a `develop`, segue o fluxo normal (testes primeiro,
`verificar`, `revisao-qa`, `auditoria-seguranca`) e **não quebra o deploy na
Cloudflare**: até a B9, o Zuri continua rodando nas duas plataformas. As
dependências novas entram com versão exata e só onde a PR diz.

### B1. Ponto de entrada Node

- **Objetivo:** o mesmo app servindo pela porta 8787 do Node.
- **Arquivos:** `apps/agent/src/node/main.ts` (novo), `apps/agent/src/node/env.ts`
  (lê e valida o ambiente com Zod, no lugar do `Env` do wrangler),
  `apps/agent/src/index.ts` (o `handle` passa a receber um objeto com o que
  hoje vem de `env`, para os dois pontos de entrada usarem a mesma função).
- **Dependência nova:** `@hono/node-server`.
- **Detalhes que não podem faltar:**
  - atrás do Caddy, a requisição chega ao Node como `http://`. O portão 2
    reconstrói a URL com `https:` só se `X-Forwarded-Proto: https` vier e
    `TRUST_PROXY_HEADERS=1`; senão, recusa como hoje;
  - o portão 1 continua conferindo o host contra o `PUBLIC_URL`;
  - a interface sai de `apps/web/dist` com `serveStatic`, passando pelos
    mesmos cabeçalhos de segurança de `gates/headers.ts`, com o fallback de SPA
    igual ao `not_found_handling` de hoje;
  - o corpo continua lido inteiro antes de seguir (`gates/body.ts`), com os
    mesmos tetos por rota;
  - o Node aceita só `127.0.0.1` por padrão.
- **Testes:** um projeto novo do Vitest em Node (`vitest.node.config.ts`) que
  sobe o app numa porta aleatória e roda os testes de portões
  (`gates.test.ts`, `http-hardening.test.ts`, `headers-file.test.ts`) contra
  ele; teste de que `X-Forwarded-Proto` é ignorado sem `TRUST_PROXY_HEADERS`.
- **Pronto quando:** `node apps/agent/dist-node/main.js` responde
  `/api/health` e entrega a tela de login, com os testes de portões passando
  nas duas plataformas.

### B2. Banco em arquivo

- **Objetivo:** `Database` com duas implementações e a mesma interface.
- **Arquivos:** `apps/agent/src/db/database.ts` vira a interface e a versão do
  Durable Object; `apps/agent/src/db/database-node.ts` (novo) com
  `node:sqlite` (`DatabaseSync`). Se a versão do Node da época ainda marcar
  `node:sqlite` como experimental ou faltar FTS5, usar `better-sqlite3`
  (dependência nova, versão exata).
- **Detalhes:**
  - `all`, `one`, `run`: mesmos parâmetros posicionais, nunca interpolação;
  - `transaction(fn)`: `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` em volta de
    `fn`, síncrono como o `transactionSync`;
  - `size()`: `page_count * page_size` pelos `PRAGMA`;
  - `usage.rowsRead`/`rowsWritten`: ficam em zero no Node (só existem para a
    cota da Cloudflare); o teste de orçamento (`free-tier-budget.test.ts`)
    continua só no projeto do workerd;
  - na abertura: `journal_mode = WAL`, `synchronous = NORMAL`,
    `foreign_keys = ON`, `busy_timeout = 5000`, e o lock de processo único;
  - permissões do arquivo: `0600`, dono `zuri`.
- **Testes:** a suíte do banco (`migrations.test.ts`, `database-*.test.ts`,
  `productivity.test.ts`, `memory.test.ts`) roda também no projeto Node.
  Teste novo: duas aberturas do mesmo arquivo, a segunda falha.
- **Pronto quando:** todas as migrations aplicam do zero no Node, com FTS5, e
  os testes de repositório passam nas duas plataformas.

### B3. Despertador das automações

- **Objetivo:** `AlarmClock` (da etapa 10) implementado no processo.
- **Arquivos:** `apps/agent/src/automations/node-alarm.ts` (novo).
- **Detalhes:**
  - um alarme pendente por vez, como hoje (regra P8): `schedule(at)` cria um
    id aleatório e um `setTimeout` para `at`, quebrado em partes de no máximo
    24 h (o `setTimeout` do Node não passa de uns 24,8 dias e estoura antes);
  - `exists(id)` responde pelo id em memória. Depois de reiniciar, nenhum id
    existe, e o `rearm({ verify: true })` que o serviço já faz na partida
    agenda de novo. Esse é exatamente o caso "alarme perdido" que a etapa 10
    já trata;
  - na partida, rodar logo o que venceu enquanto o processo estava parado,
    com a mesma regra de atraso máximo da etapa 10;
  - relógio do sistema em UTC; fuso só nas regras, como hoje.
- **Testes:** com relógio falso do Vitest: dispara na hora, cancela, alarme
  além de 24,8 dias, reinício com execução vencida, horário de verão (já
  coberto pela regra de recorrência).
- **Pronto quando:** os testes de automações da etapa 10 passam com o
  despertador do Node.

### B4. Agente sem Agents SDK

- **Objetivo:** a mesma `ZuriAgent` sem herdar de `Agent`.
- **Arquivos:** `apps/agent/src/agent/zuri-core.ts` (novo) com tudo o que hoje
  está na classe e não depende do SDK (o `store`, `ai()`, `runner()`,
  `transcribe`, `locale`, o `#api`); `zuri-agent.ts` continua sendo o Durable
  Object e passa a delegar ao núcleo; `node/main.ts` cria o núcleo uma vez.
- **Detalhes:**
  - o núcleo recebe `Database`, `AlarmClock` e o ambiente por parâmetro, sem
    `this.ctx` e sem `this.env`;
  - no Node, `request.signal` funciona: o botão Parar e o envio interrompido
    passam a ser vistos pelo sinal (no DO não eram). Testar os dois;
  - WebSocket e `/sub/` continuam recusados;
  - o SSE da conversa usa o mesmo `ReadableStream`; conferir que o Caddy não
    segura o fluxo (`flush_interval -1`).
- **Testes:** `chat-routes.test.ts`, `chat-runner.test.ts` e
  `agent.test.ts` no projeto Node; teste de que só uma instância existe.
- **Pronto quando:** conversa com ferramentas, aprovações e voz funcionam no
  Node com a IA simulada, nas duas plataformas.

### B5. IA fora do binding

- **Objetivo:** escolher o provedor por variável, sem tocar no `MeteredAI`.
- **Arquivos:** `apps/agent/src/ai/index.ts` (o `chooseProvider` ganha a opção
  pela variável `AI_BACKEND`), `ai/workers-ai-rest.ts`, `ai/openai-compatible.ts`
  e um transcritor para cada backend.
- **Opções, da mais barata para a mais cara:**

  | `AI_BACKEND` | Como | Custo | Privacidade |
  | --- | --- | --- | --- |
  | `workers-ai-rest` | `workers-ai-provider` com conta e token; Whisper e bge-m3 pela mesma API | Grátis até 10.000 Neurons/dia | Igual à de hoje |
  | `ollama` | `@ai-sdk/openai-compatible` apontado para `http://127.0.0.1:11434/v1`; modelo pequeno com ferramentas (família Qwen ou Llama de 7 a 8 B quantizada); `bge-m3` no Ollama; voz pelo servidor do `whisper.cpp` | Grátis, mas pede VPS de 16 GB ⚠ e responde devagar só com CPU | Tudo fica na VPS |
  | `anthropic` / `openai` | Etapa 21 | Pago ⚠ | Plano de proteção de dados |

- **Detalhes:**
  - o medidor de Neurons só vale para `workers-ai-rest`; nos outros, o
    `MeteredAI` mede pedidos e tokens (os limites de pedidos por dia, tokens
    de saída e áudio continuam);
  - o Ollama escuta só em `127.0.0.1`; nunca exposto;
  - o prompt e as regras de `<data>` não mudam; o teste canário do plano de
    proteção de dados roda com cada backend;
  - modelo local erra mais chamadas de ferramenta: rodar o conjunto de
    conversas de teste com o modelo escolhido e registrar a taxa de acerto
    antes de adotar.
- **Testes:** cada provedor com um servidor falso (sem rede de verdade),
  erros mapeados para os códigos `error.ai*` de hoje, prazo de 120 s.
- **Pronto quando:** o Zuri conversa, transcreve e (com a etapa 17) gera
  vetores pelo backend escolhido, com o teto do dia valendo.

### B6. Borda sem Cloudflare

- **Objetivo:** IP, cidade, id de requisição e robô no login sem a borda.
- **Arquivos:** `auth/client.ts`, `log.ts`, `http/errors.ts`, `node/geo.ts`
  (novo), `auth/turnstile.ts` (só se sair do Turnstile).
- **Detalhes:**
  - IP: de `X-Zuri-Client-IP` só com `TRUST_PROXY_HEADERS=1`; sem isso, o IP
    do socket. Nunca `X-Forwarded-For` cru (qualquer um forja e escapa do
    limite de tentativas);
  - cidade e rede: base GeoLite2 City e ASN (cadastro grátis na MaxMind) ou
    DB-IP Lite (CC BY 4.0, sem cadastro), lida no servidor; atualização mensal
    por um timer do sistema. Sem base, a página Acessos mostra só o IP, como
    no desenvolvimento local. O IP continua sem ir para o log;
  - id de requisição: o Zuri gera 16 dígitos hexadecimais por requisição e põe
    no mesmo campo que hoje recebe o `cf-ray`, para o formato do log e a aba
    Diagnóstico não mudarem;
  - Turnstile: continua igual, ele não depende de o site estar na
    Cloudflare. Se a conta da Cloudflare deixar de existir, trocar pela
    ALTCHA (código aberto, prova de trabalho, sem serviço externo) atrás da
    mesma interface `Turnstile`, falhando fechado como hoje.
- **Testes:** forja de `X-Forwarded-For` e de `X-Zuri-Client-IP` sem a
  variável; IP inválido; base de geolocalização ausente; teste de campos
  proibidos do log com o id novo.
- **Pronto quando:** página Acessos e limite de tentativas funcionam no Node
  com os mesmos testes de segurança.

### B7. Empacotamento e instalação

- **Objetivo:** instalar com poucos comandos e atualizar sem perder dados.
- **Arquivos:** `deploy/vps/Dockerfile`, `deploy/vps/compose.yaml`,
  `deploy/vps/Caddyfile`, `deploy/vps/zuri.env.exemplo` (só nomes, sem
  valores), `docs/instalacao-vps.md`.
- **Detalhes:**
  - imagem a partir de `node:<versão do .nvmrc>-slim`, build em duas fases,
    usuário sem root, sistema de arquivos só leitura, só `/var/lib/zuri`
    gravável, `cap_drop: ALL`, `no-new-privileges`;
  - o compose sobe `zuri` e `caddy` (e `ollama`, se escolhido), com o Zuri
    numa rede interna sem porta publicada;
  - Caddyfile: o domínio do `PUBLIC_URL`, `reverse_proxy 127.0.0.1:8787` (ou
    o serviço interno), os `header_up` da arquitetura, `flush_interval -1`
    para o SSE, limite de corpo igual ao maior teto das rotas;
  - alternativa sem Docker: `systemd` com `DynamicUser`, `ProtectSystem=strict`
    e `ReadWritePaths=/var/lib/zuri`;
  - segredos num arquivo `zuri.env` com permissão `0600` fora do repositório,
    os mesmos nomes de hoje mais `AI_BACKEND`, `TRUST_PROXY_HEADERS` e, se
    usado, `CLOUDFLARE_AI_ACCOUNT_ID`/`CLOUDFLARE_AI_TOKEN`.
- **Pronto quando:** numa VPS limpa, o guia leva do zero ao login em menos de
  uma hora, e `docker compose pull && docker compose up -d` atualiza sem
  perder dados.

### B8. Backup e operação

- **Objetivo:** fazer na VPS o que a Cloudflare fazia sozinha.
- **Arquivos:** `deploy/vps/backup.sh`, timers do `systemd` ou serviço no
  compose, seção no `docs/instalacao-vps.md` e no `docs/solucao-de-problemas.md`.
- **Detalhes:**
  - backup diário com `VACUUM INTO` (cópia consistente com o Zuri rodando),
    conferido com `PRAGMA integrity_check`, cifrado com `age` (chave pública
    na VPS, privada só com o dono) e guardado 7 diários, 4 semanais e 3
    mensais;
  - cópia fora da VPS ⚠: armazenamento de objetos ou outra máquina; na falta,
    o arquivo da etapa 23 baixado pelo dono. Sem cópia fora, perder o disco é
    perder tudo;
  - teste de restauração mensal num diretório temporário;
  - logs pelo `journald` ou pelo Docker com rotação (o formato do `log.ts`
    não muda); retenção de 7 dias;
  - saúde: o alerta de "health" da etapa 11 passa a ser feito por um timer
    local que chama `/api/health` e manda o aviso pelo Telegram;
  - VPS endurecida: só portas 80, 443 e SSH; SSH só com chave, sem senha e
    sem root; atualizações de segurança automáticas; relógio sincronizado.
- **Pronto quando:** restaurar o backup de ontem numa VPS nova funciona pelo
  guia.

### B9. Workflows e e-mail (se as etapas 11 e 22 já existirem)

- **Workflows (etapa 22):** fila na própria base (`zur_workflow_runs`, que a
  especificação já prevê), com passos, até 3 tentativas e espera crescente,
  rodando pelo mesmo despertador de B3. O fetch protegido do monitor não muda.
- **E-mail (etapa 11):** SMTP de um provedor com faixa grátis, atrás da
  interface de envio da etapa 11, com o mesmo teto de 10 por dia. Conta e
  senha do SMTP viram segredos.
- **Pronto quando:** os testes das duas etapas passam no projeto Node.

### B10. Ensaio geral

- **Objetivo:** provar a migração antes de precisar dela.
- **Passos:** VPS de teste ⚠ (ou uma máquina local), backup real da
  produção, importação, e2e do Playwright contra a VPS, conversa pelo bot com
  o webhook apontado para um domínio de teste.
- **Pronto quando:** o e2e passa inteiro contra a VPS e o checklist do "Dia da
  troca" foi seguido uma vez sem surpresa.

## Dia da troca

Com B (ou A) pronto e ensaiado:

1. **Uma semana antes:** baixar o TTL do registro DNS do domínio para 300 s.
   Conferir a cópia dos segredos (preparação, item 1).
2. **Na VPS:** subir o Zuri com os mesmos segredos e o mesmo `PUBLIC_URL`,
   ainda sem DNS. Conferir pelo `curl --resolve` que o certificado e o
   `/api/health` respondem.
3. **Congelar:** avisar no Telegram, pausar automações (modo de bloqueio da
   etapa 16, se existir) e esperar terminar a conversa em curso.
4. **Exportar** pela etapa 23 na Cloudflare e **importar** na VPS. Conferir a
   contagem de itens por tela.
5. **Apontar o DNS** para o IP da VPS. Com o domínio em outro DNS, trocar os
   nameservers no registrador.
6. **Telegram:** chamar `setWebhook` com o mesmo endereço (o segredo do
   cabeçalho é o mesmo, porque sai do `SESSION_SECRET`).
7. **Conferir:** login com senha e 2FA, uma passkey, Início, tarefas, notas,
   memórias, conversa com ferramenta, voz, uma automação que vence em poucos
   minutos, `/status` no bot, página Acessos mostrando o IP.
8. **Desligar a Cloudflare só depois de 7 dias** sem problema: remover a rota
   do domínio do Worker, mantendo o Worker e os dados como estão.

## Como voltar atrás

Até o passo 8, voltar é apontar o DNS de novo para a Cloudflare e o webhook do
Telegram também. O que foi criado na VPS nesse meio tempo volta pela
exportação da VPS e importação na Cloudflare (a mesma etapa 23, nos dois
sentidos). Por isso a etapa 23 precisa de uma importação que aceite um arquivo
com dados que já existem do outro lado, sem duplicar.

## O que muda para o dono

- Login, 2FA, passkeys, dados e bot ficam iguais, desde que os segredos e o
  domínio sejam os mesmos.
- Some o Cloudflare Access (se estava ligado) e a proteção contra DDoS da
  Cloudflare; o resto dos portões continua igual.
- Com Ollama, as respostas ficam mais lentas e a qualidade das ferramentas
  pode cair; com Workers AI pela API, nada muda.
- Passa a existir uma conta mensal da VPS ⚠ e uma rotina de manutenção
  (atualizações e conferência do backup), que o guia de B7 e B8 descreve.

## Esforço total

| Bloco | PRs | Observação |
| --- | --- | --- |
| Preparação (segredos, domínio) | 0 | Só ação do Pablo |
| Etapa 23 com os itens da preparação | dentro da etapa | Sem PR extra |
| Caminho A | 2 a 3 | Emergência |
| Caminho B | 10 (B1 a B10) | B1 a B4 são a maior parte; B5 depende do backend escolhido |

Ordem recomendada se o Pablo decidir sair de vez: B1 → B2 → B3 → B4 → B6 → B5
→ B7 → B8 → B9 → B10. Se for emergência: A primeiro, depois B na mesma ordem,
com a produção já na VPS rodando sobre o A.
