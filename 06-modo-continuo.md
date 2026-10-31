# Modo contínuo: o agente avança sozinho entre as etapas

Com o modo contínuo, o agente termina uma etapa, mescla na `develop` e começa a
seguinte sem você mandar o próximo prompt. Ele só para quando precisa de você.
Ele foi desenhado para gastar poucos tokens sem cortar o que garante qualidade.

Decisão do Pablo (30/10/2026): **mescla sozinho na `develop`, sem pausa por
fase.** A `main`, as releases e o deploy continuam só com você.

## Como funciona

1. A thread da etapa termina o trabalho, roda `verificar`, `revisao-qa` e
   `auditoria-seguranca` e abre o PR.
2. A skill `proxima-etapa` confere as travas. São elas: CI verde, nenhum achado
   alto ou médio, matriz de testes completa, changelog e
   `.claude/memoria/progresso.md` atualizados.
3. Ela mescla o PR na `develop`.
4. Ela pede ao coordenador uma **thread nova** para a próxima etapa, com o bloco
   dela de `docs/agente/prompts-das-etapas.md`.
5. A thread nova lê só `progresso.md`, `decisoes.md` e os trechos da
   especificação que a etapa usa, e recomeça o ciclo.
6. Ao fechar cada fase (etapas 5, 11, 16, 22 e 25), você recebe um resumo
   curto. O agente segue sem esperar.

## Quando ele para e chama você

| Motivo | Exemplo |
| --- | --- |
| Precisa de algo seu | Etapas 11 (e-mail), 12 (bot), 19 (Google) e 24 (Cloudflare) |
| Custo | Etapa 21 (modelos pagos) só com "aprovado"; qualquer recurso que possa sair do plano gratuito |
| Decisão de produto | Algo que muda o que você vê ou o escopo e não tem padrão em `decisoes.md` |
| Falha persistente | A mesma falha resistiu a 3 tentativas de correção |
| Segurança | Ficou achado alto ou médio sem correção segura |
| Proteção do GitHub | Os rulesets ainda não estão ativos (por isso a etapa 0 espera a sua confirmação) |
| Você pediu | Você disse "pausar" |

O motivo fica escrito em `progresso.md`, em "Pausado por", e você recebe uma
mensagem com o que falta e a recomendação dele.

## Por que gasta pouco token sem perder desempenho

| Medida | Efeito |
| --- | --- |
| **Uma etapa por thread** | Cada etapa começa com o contexto limpo. O custo não cresce a cada etapa e o agente não se confunde com o histórico antigo. |
| **`progresso.md` no lugar do histórico** | Um arquivo de até ~80 linhas passa o bastão (o que foi entregue, as migrations, as dívidas, a atenção para a próxima). |
| **Leitura sob medida da especificação** | A especificação tem ~72 KB. Cada etapa lê o índice e só os trechos dela (em geral 15 a 20 KB; 35 KB nas etapas do bot, que leem a seção do Telegram), e não o arquivo inteiro. |
| **Regras por área** | As regras de `.claude/rules/` só carregam quando o agente abre um arquivo daquela área. |
| **Instruções estáveis** | As instruções do projeto, o `AGENTS.md` e o `CLAUDE.md` mudam pouco, então aproveitam o cache do Claude a cada mensagem. |
| **Testes focados** | Durante o trabalho, o agente roda só o teste do arquivo e lê só as falhas. A suíte completa roda uma vez no fim. |
| **Subagentes com escopo curto** | Só os obrigatórios (QA, segurança, Cloudflare). Eles devolvem os achados, não os arquivos que leram. |
| **Logs e Talorys pontuais** | Da CI, só o job que falhou; do Talorys, só os arquivos citados, achados com `grep`. |
| **Thread longa vira thread nova** | Se a etapa crescer demais, o agente faz commit, atualiza o progresso e continua numa thread nova da mesma etapa. |

O que **não** é economizado: ler o código que vai mudar, escrever os testes,
rodar a auditoria e rodar a suíte completa no fim. Esses passos garantem a
qualidade e ficam inteiros.

## O que você precisa configurar

1. **Rulesets no GitHub** (o agente manda os arquivos e o caminho de cada tela na etapa 0):
   - na `develop`: PR obrigatório, checks exigidos e **nenhuma aprovação humana**, para o agente poder mesclar;
   - na `main`: só PR vindo da `develop`, mesclado por você.
2. Confirme ao agente que os rulesets estão ativos. Ele então mescla a etapa 0 e segue.
3. Deixe o app do Claude com permissão de escrita no repositório (necessária para mesclar).

## Comandos rápidos

- **"pausar"**: o agente termina o passo atual, faz commit e marca "pausado".
- **"continuar"**: o agente marca "ligado" e retoma pela próxima etapa.
- **"já forneci X"**: o agente tira o item de "Esperando o Pablo" e segue.
- **"mude para eu mesclo cada PR"**: o agente passa a abrir o PR e esperar você mesclar antes de seguir.
- **"pause ao fim de cada fase"**: além do resumo, o agente espera o seu "continuar".

Os textos completos para pausar e retomar estão no fim de `05-prompts-das-etapas.md`.

## Dicas para acompanhar

- Assine as notificações dos PRs do repositório no GitHub para ver cada mesclagem.
- Para conferir o estado a qualquer hora, abra `.claude/memoria/progresso.md` no GitHub.
- A cada fase, revise o resumo e, se quiser, a `develop` inteira antes da release para a `main`.
