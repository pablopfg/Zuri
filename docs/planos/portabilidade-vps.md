# Instalar o Zuri numa VPS: avaliação

Situação: **avaliação, sem código.** Escrita em 02/11/2026 a partir do pedido do
Pablo: "Avalie se é possível e viável a instalação do nosso sistema em uma VPS.
Caso tenhamos problemas com a Cloudflare, conseguimos fazer a migração?"

Preços de VPS mudam muito (a Hetzner, por exemplo, reajustou duas vezes em
2026). Os valores abaixo são faixas tiradas de páginas públicas em 02/11/2026;
quem for contratar confere de novo no site do provedor. Todo item com custo
está marcado com ⚠ e nada aqui é contratado ou ligado.

## Resposta curta

Sim, é possível migrar, e o código atual facilita mais do que parece: o banco
já passa por um único módulo (`Database`), a IA por uma interface própria
(`AIProvider`) e a API é Hono, que roda igual no Node. O que prende o Zuri à
Cloudflare são quatro peças: o Durable Object com o Agents SDK, o Workers AI,
os dados que a borda da Cloudflare entrega prontos (IP, cidade, `cf-ray`,
HTTPS) e, mais adiante, Workflows e Email Routing.

Há dois caminhos de saída:

- **Caminho A, `workerd` na VPS** (o mesmo motor que roda os testes): quase
  nenhuma mudança de código, mas o Workers AI não vem junto e o modo
  auto-hospedado do `workerd` é pouco usado em produção. Serve de plano de
  emergência.
- **Caminho B, Node na VPS**: o Zuri vira um processo Node com SQLite em
  arquivo, atrás de um proxy com HTTPS. É o caminho limpo para ficar de vez
  fora da Cloudflare, e custa umas 8 a 10 PRs.

**Recomendação:** não fazer a migração agora e não criar camadas de
abstração antecipadas. Seguir na Cloudflare (que é grátis e cabe nas cotas) e
adotar só três cuidados baratos nas etapas que faltam (seção "O que fazer
agora"). O mais importante é a etapa 23 (backup) gerar uma cópia completa que
dê para restaurar fora da Cloudflare: com ela, qualquer problema com a conta
vira trabalho de dias, e nunca perda de dados.

## O que o Zuri usa da Cloudflare

Levantado no código da `develop` (`apps/agent/wrangler.jsonc`, `src/`) e na
especificação ("Arquitetura na Cloudflare" e "Bindings, segredos e variáveis").

| Peça | Para quê | Onde aparece no código | Já existe? |
| --- | --- | --- | --- |
| Worker (`fetch`) com Hono | Portões, API, entrega da interface | `src/index.ts`, `src/api/app.ts` | Sim |
| Durable Object `ZuriAgent` (Agents SDK `Agent`) | Instância única, um processo só por vez escrevendo | `src/agent/zuri-agent.ts` | Sim |
| SQLite do Durable Object (`ctx.storage.sql`, `transactionSync`, `databaseSize`) | Todos os dados do dono, FTS5 | Só em `src/db/database.ts` | Sim |
| Alarmes e `this.schedule` do Agents SDK | Lembretes, resumos, rotinas, vigias | Etapa 10 (PR #46) | Em revisão |
| Workers AI (binding `AI`, `workers-ai-provider`) | Chat, Whisper, embeddings | `src/ai/workers-ai.ts`, `transcription.ts` | Sim |
| Binding `ASSETS` | Arquivos da interface | `src/index.ts` | Sim |
| Turnstile | Verificação de robô em todo login | `src/auth/turnstile.ts` | Sim |
| `request.cf` e `cf-connecting-ip` | Cidade, rede e IP na página Acessos e no limite de tentativas | `src/index.ts`, `src/auth/client.ts` | Sim |
| `cf-ray` | Achar a linha de um erro no log | `src/log.ts`, `src/http/errors.ts` | Sim |
| Workers Logs | Logs por 3 dias | `observability` no `wrangler.jsonc` | Sim |
| Custom Domain e certificado | HTTPS no domínio do dono | Painel da Cloudflare | Sim |
| Cloudflare Access (opcional) | Portão 3 | `src/gates/access.ts` | Sim |
| Worker secrets | Segredos | `wrangler secret` | Sim |
| Workflows (`WORKFLOW`) | Monitor de sites | Etapa 22 | Não |
| Email Routing (`SEND_EMAIL`) | Alertas e recuperação | Etapa 11 | Não |
| Deploy pelo GitHub Actions com `wrangler` | Publicação | Etapa 24 | Não |

Hono, AI SDK (`ai`), Zod, `@simplewebauthn/server`, Web Crypto, React, Vite e
o pacote `shared` não dependem da Cloudflare e rodam igual no Node.

## O que muda em cada peça numa VPS

| Peça | Equivalente numa VPS | Esforço |
| --- | --- | --- |
| Worker + Hono | O mesmo app Hono com `@hono/node-server` (ou Bun) | Baixo |
| Durable Object | Um processo Node só, com a instância do agente criada uma vez na partida. O DO garante um escritor por vez; no Node, o SQLite síncrono numa thread só garante o mesmo, desde que só um processo abra o arquivo | Médio: tirar a classe do Agents SDK e manter a mesma serialização |
| SQLite do DO | `node:sqlite` (embutido no Node) ou `better-sqlite3`, com FTS5. Ambos são síncronos, então `Database` troca só por dentro. Os contadores `rowsRead`/`rowsWritten` não existem lá; só servem para a cota da Cloudflare e podem ficar zerados | Baixo |
| Alarmes e `schedule` | Uma tabela de agendamentos no próprio SQLite e um laço no processo que acorda no próximo horário (ou `setTimeout` reprogramado na partida). O motor da etapa 10 já guarda o próximo disparo no banco; só o "despertador" muda | Médio |
| Workers AI | Três opções: (1) chamar o Workers AI pela API REST da Cloudflare, de fora dela, com a mesma cota grátis (ainda depende da Cloudflare); (2) Ollama na própria VPS com um modelo pequeno, whisper.cpp e bge-m3 (grátis, mas precisa de 16 GB de RAM e responde devagar só com CPU); (3) API paga ⚠ (etapa 21) | Baixo para (1), médio para (2) |
| `ASSETS` | `serveStatic` do Hono, ou o proxy servindo `apps/web/dist` | Baixo |
| HTTPS e domínio | Caddy na frente, com certificado automático do Let's Encrypt (grátis) | Baixo |
| Turnstile | Funciona fora da Cloudflare: é só um script na página e uma chamada HTTPS de verificação. Para sair de vez, ALTCHA (código aberto, prova de trabalho, sem serviço externo) ou hCaptcha | Nenhum, ou baixo para trocar |
| `cf-connecting-ip` | IP vindo do proxy (`X-Forwarded-For`), aceito só quando a conexão vem do próprio Caddy, senão qualquer um forja o IP e escapa do limite de tentativas | Baixo, com teste |
| `request.cf` (cidade, rede) | Base GeoLite2 (MaxMind, grátis com cadastro) ou DB-IP Lite, consultada no servidor e atualizada uma vez por mês | Baixo |
| `cf-ray` | Um id de requisição gerado pelo próprio Zuri no mesmo campo do log | Baixo |
| Workers Logs | `journald` ou os logs do Docker, com rotação; o formato único do `log.ts` continua igual | Baixo |
| Cloudflare Access | Deixar desligado, ou trocar por uma VPN de uso pessoal (Tailscale ou WireGuard) | Baixo |
| Segredos | Arquivo de ambiente com permissão só do usuário do serviço, ou segredos do Docker. Nunca no repositório | Baixo |
| Workflows (etapa 22) | Fila no SQLite com tentativas e prazo, rodando no mesmo laço do agendador | Médio |
| Email Routing (etapa 11) | SMTP de um provedor com faixa grátis | Baixo |
| Deploy | Imagem Docker publicada pela CI e `docker compose pull && up -d` na VPS, ou `rsync` + `systemd` | Baixo |
| Telegram | Webhook continua igual (precisa só do HTTPS); com a VPS dá até para trocar por *long polling* | Nenhum |

### O que se perde ou piora fora da Cloudflare

- **Custo.** O plano Free deixa de valer: a VPS custa todo mês (tabela abaixo).
- **Segurança da borda.** Perde-se a proteção contra DDoS e o isolamento do
  Worker. A VPS precisa de firewall (só 80, 443 e SSH com chave), atualizações
  automáticas do sistema e o processo rodando sem root. O dono passa a cuidar
  de um servidor.
- **Backup.** A Cloudflare guarda o banco do DO com recuperação de 30 dias. Na
  VPS, quem faz backup é o Zuri: cópia diária do arquivo SQLite (`VACUUM INTO`)
  mandada para outro lugar. Sem isso, um disco perdido apaga tudo.
- **IA de graça.** Fora da Cloudflare não existe IA boa e grátis sem enviar o
  texto do dono para alguém. Ollama em CPU é privado e grátis, mas um modelo
  de 7 a 8 bilhões de parâmetros responde a umas poucas palavras por segundo.
  As faixas grátis de outros provedores costumam usar o texto para treinar
  modelos, o que vai contra o plano de proteção de dados
  (`docs/planos/troca-de-provedores-e-protecao-de-dados.md`).

### O que melhora

- Nada de limite de 10 ms de CPU, de 100.000 requisições por dia nem de cobrança
  por linha lida ou escrita. Várias regras de `.claude/rules/performance.md`
  deixam de ser obrigatórias (continuam sendo boa prática).
- Disco e memória maiores para o banco, vetores e anexos.
- Nenhuma dependência da conta de uma empresa: se a Cloudflare suspender a
  conta, mudar o plano Free ou ficar fora do ar, o Zuri continua.

## Os dois caminhos

### Caminho A: `workerd` na VPS (emergência)

O `workerd` é o motor de código aberto da Cloudflare; é ele que roda o
`wrangler dev --local` e os testes do Zuri. Dá para rodá-lo direto numa VPS com
um arquivo de configuração próprio, com o Durable Object guardando o SQLite em
disco local (`localDisk`).

- Muda pouco: um arquivo de configuração do `workerd`, o Workers AI trocado
  pela API REST da Cloudflare ou por Ollama (a interface `AIProvider` já
  permite), o IP e a cidade vindos do proxy, e o Caddy na frente.
- Riscos: o modo auto-hospedado do `workerd` tem pouca documentação e pouca
  gente usando em produção; o próprio projeto avisa que ele não é uma sandbox
  endurecida (aqui só roda código do próprio Zuri, então isso pesa menos).
  Alarmes do DO e o Agents SDK fora da Cloudflare precisam ser provados numa
  prova de conceito antes de confiar.
- Esforço: 2 a 3 PRs, incluindo a prova de conceito.

### Caminho B: Node na VPS (saída definitiva)

O Zuri vira um processo Node que monta o mesmo app Hono, abre um SQLite em
arquivo e roda o agendador no próprio processo.

PRs, nessa ordem:

1. Ponto de entrada Node (`apps/agent/src/node.ts`) com `@hono/node-server`,
   interface servida por `serveStatic` e os portões iguais.
2. `Database` com duas implementações (DO e `node:sqlite`), a mesma suíte de
   testes rodando nas duas.
3. Agendador próprio (tabela + laço) por trás da mesma interface que a etapa
   10 usa, com teste de fuso e de reinício do processo.
4. Agente fora do Agents SDK: a mesma classe sem herdar de `Agent`, com o SSE
   da conversa no Hono.
5. IA: provedor Ollama (ou API REST do Workers AI) atrás do `AIProvider`, com
   o `MeteredAI` medindo em tokens em vez de Neurons.
6. IP, cidade e id de requisição vindos do proxy, com teste de forja de
   cabeçalho.
7. Docker + Caddy + backup diário do SQLite, e guia `docs/instalacao-vps.md`.
8. Workflows e e-mail (se as etapas 11 e 22 já existirem).
9. Importação do backup da etapa 23 e teste de ponta a ponta na VPS.

Esforço: 8 a 10 PRs, mais ou menos o tamanho de uma fase da especificação.
Feito depois da etapa 25, o código já está estável e a lista acima não muda.

## Custo mensal de uma VPS ⚠

Hoje o Zuri custa R$ 0 por mês. Qualquer VPS abaixo é custo novo e só entra
com OK explícito do Pablo.

| Opção | Configuração | Preço aproximado (02/11/2026) | Serve para |
| --- | --- | --- | --- |
| Hetzner (Alemanha/Finlândia) | 2 vCPU, 4 GB | € 4,50 a € 6 por mês, depois dos reajustes de 2026; os planos mais baratos aparecem às vezes como indisponíveis | Zuri com IA externa (Workers AI pela API ou paga) |
| VPS no Brasil (Hostinger, BedHosting e similares) | 1 a 2 vCPU, 4 GB | R$ 28 a R$ 50 por mês (preços de contrato longo; mensal avulso sai mais caro) | Igual, com latência menor |
| VPS com 16 GB (Hetzner ou similar) | 4 a 8 vCPU, 16 GB | Cerca de € 15 a € 30 por mês | Ollama com modelo pequeno, sem GPU |
| VPS com GPU | — | Acima de US$ 100 por mês | Fora de questão para uso pessoal |
| Oracle Cloud Always Free | Até 4 núcleos ARM e 24 GB | Grátis, mas a vaga é disputada, a conta pede cartão e já houve contas suspensas sem aviso | Teste ou emergência, não a casa definitiva |

Para comparar: com o Zuri usando o Workers AI pela API REST, uma VPS de 4 GB
basta e o custo fica em torno de R$ 30 a R$ 50 por mês. Com IA local, passa
de R$ 100 por mês e a resposta fica bem mais lenta.

## O que fazer agora

Abstrair tudo agora (storage, agendador e IA atrás de interfaces genéricas)
custaria umas 4 a 5 PRs sem nenhum ganho visível para o Pablo, e cada etapa
nova teria de manter dois caminhos. Como hoje o Zuri não tem problema com a
Cloudflare, a recomendação é outra: **documentar o caminho (este arquivo) e
adotar três cuidados baratos nas etapas que faltam.**

1. **Etapa 23 (backup) sai portável.** A exportação JSON leva tudo o que o
   dono tem (inclusive automações, configurações e 2FA cifrado), tem versão e
   um teste que importa o arquivo num banco vazio. É o que garante a saída.
2. **Código da Cloudflare fica nas pontas.** Binding, `request.cf`, `ctx` e
   `this.schedule` só aparecem nos módulos de entrada (`index.ts`,
   `zuri-agent.ts`, `database.ts`, `ai/workers-ai.ts` e o agendador da etapa
   10). As regras de negócio recebem essas coisas prontas, como já acontece
   com `Database` e `AIProvider`. Vale para Workflows (22) e e-mail (11): uma
   interface pequena na frente, sem a regra de negócio chamar o binding
   direto.
3. **Recurso novo da Cloudflare pesa também a saída.** Junto do ⚠ de custo,
   todo PR que propor um binding novo diz em uma linha como ele seria trocado
   numa VPS.

E, se um dia a Cloudflare virar problema: Caminho A como emergência (dias) e
Caminho B como mudança definitiva (uma fase), restaurando o backup da etapa 23.
O roteiro detalhado, PR por PR, com a preparação, o dia da troca e como voltar
atrás, está em [migracao-vps.md](migracao-vps.md).

Nenhum desses cuidados muda tela, custo ou cota; entram nos prompts das
etapas quando o Pablo aprovar.
