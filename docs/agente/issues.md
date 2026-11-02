# Issues de erro

Como um erro do Zuri vira issue no GitHub, de forma padronizada, com o erro
descrito e uma possível solução, para alguém implementar depois. Pedido do
Pablo em 02/11/2026.

O repositório é **público**. Issue nunca leva domínio, e-mail, ids do
Telegram, IP, tokens, chaves, nem texto de conversa, nota, memória ou resposta
da IA. Falha de segurança não vira issue: vai para **Security → Report a
vulnerability** (`SECURITY.md`).

## O modelo

Toda issue de erro usa o formulário `.github/ISSUE_TEMPLATE/erro.yml` (no
GitHub: **New issue → Erro**). As seções, nesta ordem:

| Seção | O que vai |
| --- | --- |
| Onde aconteceu | Interface, servidor, IA, automações e avisos, Telegram, CI ou desenvolvimento |
| Contexto | O que estava sendo feito, tela ou rota, versão ou commit |
| Passos para reproduzir | Lista numerada, do estado inicial ao erro |
| Esperado | O comportamento certo |
| Obtido | O que aconteceu, sem dados pessoais |
| Código do erro | Código da API (`INTERNAL_ERROR`…), `cf-ray`, impressão digital do Diagnóstico ou link da execução da CI |
| Possível solução | Causa provável, arquivos envolvidos e o teste que provaria a correção |
| Impacto | Alto, médio ou baixo (definições no formulário) |

Quem abre por linha de comando ou pela API escreve o corpo com esses mesmos
títulos `### …`. O script da CI faz isso, e um teste confere que os títulos
batem com o formulário.

## Rótulos

| Rótulo | Quando |
| --- | --- |
| `erro` | Toda issue de erro (o formulário põe sozinho) |
| `falha-automatica` | Aberta pelo job `report-failure`, sem pessoa por trás |

O script cria os dois rótulos na primeira vez que precisa deles. Impacto fica
no corpo, não em rótulo, para não multiplicar rótulos.

## De onde vêm as issues

### 1. Automações do GitHub que falham sem dono

Falha em PR é da thread dona da PR, que corrige na própria branch, e nunca
abre issue. O que ninguém vê é a execução agendada ou de push na `develop`.
Para essas, o job `report-failure` do `update-prs.yml` roda
`scripts/issue-de-falha.ts` quando o job `update` falha ou estoura o tempo:

- abre uma issue `[falha automática] <workflow>` com o modelo preenchido:
  jobs e passos que falharam, commit, link da execução e a possível solução
  conhecida para aquele workflow;
- se a issue já está aberta, comenta a nova execução, no máximo uma vez por
  dia (o workflow roda a cada 15 minutos e não pode encher o tracker);
- a issue é achada pelo título e pelo rótulo `falha-automatica`: não renomeie
  nem tire o rótulo enquanto ela estiver aberta, ou a próxima falha abre outra;
- qualquer atividade na issue (um comentário seu, por exemplo) reinicia a
  janela de um dia;
- usa só o `GITHUB_TOKEN` do job, com `issues: write` e `actions: read`;
  nenhum segredo, nenhum log copiado para a issue.

O CodeQL semanal não ganhou o mesmo job: o workflow também roda em PR, e PR
não recebe permissão de escrita (`tests/repo/workflows.test.ts`). O alerta
dele já aparece em **Security → Code scanning**.

### 2. Threads do Claude durante o desenvolvimento

Use a skill `abrir-issue` (`.claude/skills/abrir-issue/`). Em resumo:

- Erro **dentro** do escopo da PR: corrija na PR, sem issue.
- Erro **fora** do escopo (outra área, etapa futura, teste instável herdado,
  algo visto na `develop`): procure duplicada e abra a issue com o modelo.
- Na PR que corrigir, escreva `Closes #N` na descrição.

Busca de duplicadas: `gh api -X GET search/issues -f q='repo:pablopfg/Zuri is:issue is:open label:erro <termos>'`.

### 3. A Zuri em produção: botão "Relatar no GitHub"

Escolha do Pablo (02/11/2026). Na aba **Configurações > Diagnóstico**, cada
falha ainda não resolvida tem o botão **Relatar no GitHub**. Ele abre, numa
aba nova, o formulário `erro.yml` deste repositório já preenchido
(`apps/web/src/lib/issue-report.ts`):

- título `[erro] <código> <nome do erro> (<origem>)`;
- contexto com a origem, a rota (ids já trocados por `id` ou `:id`) e as
  datas em UTC, arredondadas para o minuto;
- obtido com as contagens; código do erro com o `cf-ray` (sem o sufixo do
  data center, que indicaria a região do dono) e o id do registro.

Fica de fora a versão da implantação: é um id da conta do dono que não
aponta para nenhum commit. O GitHub só preenche campos de texto pelo link,
então "Onde aconteceu", passos, esperado, possível solução e impacto ficam
para o dono completar.
Nada sai sem ele conferir e apertar **Submit** no GitHub: não há token, nem
chamada do servidor ao GitHub, e só entram campos que o Diagnóstico já
guarda, nunca texto do dono. O texto vai em pt-BR, o idioma do tracker,
qualquer que seja o idioma da interface.

Descartadas: abertura automática pelo servidor com um token (segredo novo,
exceção na regra de HTTP e risco de vazamento num repositório público) e não
ter nada em produção.
