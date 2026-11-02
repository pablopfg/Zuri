# Revisão de textos e experiência (etapa 26)

Pedido do Pablo em 02/11/2026, em duas mensagens que este plano junta:

1. Depois de todas as etapas, uma fase de melhoria do frontend: reorganizar a
   UI/UX, reescrever textos, alertas e notificações, deixar o sistema mais
   humano e sem marcas de texto de IA, com inspiração (sem copiar) no
   ChatGPT, no Gemini e no Claude.
2. Ao término das elaborações, uma revisão dos textos do sistema (botões,
   ações, notificações, alertas, menus), padronizados e sem cara de IA. Exemplo
   dele: a central de avisos tinha "Fechar" em texto no pé; o certo é um X no
   canto superior direito.

O exemplo já foi corrigido no PR que criou este plano (central de avisos com
X no canto, teste em `tests/e2e/notices.spec.ts`). O resto fica para a etapa
26. As regras de escrita valem desde já para texto novo:
`.claude/rules/textos-da-interface.md`.

## Quando roda

Depois da etapa 24 e antes da 25. A 26 só começa quando todas as telas e
mensagens existem (etapas 0 a 24, inclusive as que entrarem no cronograma
depois). A auditoria final (25) vem por último para cobrir os textos e telas
revistos no e2e, no axe e na matriz de rastreabilidade.

## Escopo

Entra tudo o que o dono lê:

| Superfície | Onde está |
| --- | --- |
| Interface web | `packages/shared/i18n/pt-BR*.ts` e `en.ts`, componentes em `apps/web/src` |
| Mensagens do servidor (erros, avisos, resumos, e-mails) | `pt-BR-server.ts`, `pt-BR-alerts.ts`, `pt-BR-notices.ts` e o que vier |
| Bot do Telegram | textos do bot no catálogo (etapas 12 a 16) |
| Notificação push | só "Zuri: você tem um novo aviso" (decisão de 02/11, não muda) |
| Fala da Zuri | prompt de personalidade (`apps/agent/src/agent/prompt.ts`) e frases do Início |
| PWA | `manifest`, título das páginas, tela "Conferindo a sua sessão" |

Fica de fora: código, logs (inglês, formato único), documentação técnica em
`docs/` e o README, que seguem as próprias regras.

## Referência: como fazem ChatGPT, Gemini e Claude

Inspiração no comportamento, sem copiar texto, ícone ou layout:

- Fechar é sempre um X no canto superior direito de diálogos, painéis e
  avisos, com nome acessível "Fechar". Esc e clique fora também fecham
  quando nada se perde.
- Botões são verbos curtos no infinitivo: "Copiar", "Compartilhar",
  "Apagar", "Renomear". Nada de "Clique aqui" ou "OK".
- Confirmação perigosa diz o que acontece e repete o verbo no botão:
  "Apagar conversa?" / "Isso apaga a conversa e as respostas." /
  [Cancelar] [Apagar].
- Toasts curtos, no passado, sem ponto de exclamação: "Copiado", "Conversa
  apagada". Desfazer aparece no toast quando dá para desfazer.
- Erro diz o que houve e o que fazer, sem culpar a pessoa e sem jargão:
  "Não deu para enviar. Confira a conexão e tente de novo."
- Menus de ação ficam num botão "Mais opções" (⋯), com a ação destrutiva por
  último, separada e em vermelho.
- Tom calmo e direto. Pouco entusiasmo, nenhum emoji em texto de sistema.

## Regras de microcopy

Valem para pt-BR e en. O pt-BR é a fonte; o inglês acompanha o sentido, não a
tradução palavra por palavra.

1. **Frase curta, voz ativa, segunda pessoa implícita.** "Salve antes de
   sair", não "É necessário que as alterações sejam salvas".
2. **Botão = verbo no infinitivo + objeto quando precisa.** "Apagar",
   "Apagar tarefa", "Criar automação". Até 3 palavras. Sem "Sim/Não" em
   confirmação.
3. **Título de diálogo é a pergunta ou a ação.** "Apagar a automação
   “Resumo”?"; "Renomear conversa".
4. **Toast de sucesso no particípio, sem "com sucesso".** "Tarefa criada",
   "Aviso apagado". Ponto final só se tiver duas frases.
5. **Erro em duas partes: o que houve + o que fazer.** Nunca "Erro!",
   "Ops", "Falha inesperada" ou código cru na frente. O código do erro
   (Diagnóstico) fica em texto menor, depois.
6. **Estado vazio convida a agir.** Título curto ("Nenhum aviso por
   enquanto") + uma frase do que fazer ou do que vai aparecer aqui.
7. **Carregando diz o quê.** "Carregando avisos…", com reticências de um
   caractere (…).
8. **Sem marcas de texto de IA** (lista do `humanizer:humanizer`): nada de
   "não é só X, é Y", trios forçados, frase de efeito no fim, travessão (—)
   para enfeitar, "com certeza", "incrível", "perfeito", "vamos lá",
   "aqui está", "espero que ajude", negrito decorativo, ponto de exclamação
   em texto de sistema. A exceção é a voz da Zuri no cumprimento, que pode ter
   um "!" quando natural ("Bom dia, Ana!").
9. **Não citar infraestrutura.** Nada de Cloudflare, Worker, Durable Object,
   Turnstile, cron, SQLite, Neurons fora da aba IA (decisão de 31/10).
10. **Datas e números no formato do idioma.** "02/11/2026 às 05:08", "3
    avisos sem ler" (plural pelo `plural()`), horas no fuso do dono.
11. **A Zuri é "a Zuri", no feminino, e não trata o dono por gênero.** Texto
    de sistema não fala como a Zuri ("Seus avisos", não "Separei seus
    avisos"); quem fala na voz dela é a conversa, o cumprimento, os resumos e
    o bot.
12. **Mesma ação, mesma palavra** em todo o sistema (glossário abaixo).

## Glossário de termos

Usar exatamente estes termos. Os da coluna "Evitar" viram os da esquerda na
etapa 26 (a lista de hoje está no inventário).

| Usar | Quando | Evitar |
| --- | --- | --- |
| Apagar | tirar um item do dono (vai para a lixeira quando ela existe) | Excluir, Deletar, Remover |
| Apagar de vez | tirar da lixeira | Excluir permanentemente |
| Remover | desligar uma ligação, sem perder dado do dono (passkey, aparelho, servidor MCP) | Apagar, Desvincular |
| Salvar | gravar uma edição | Gravar, Aplicar, Confirmar |
| Adicionar | item novo numa lista (tarefa, nota, passkey) | Incluir, Inserir, "Novo" sozinho no botão |
| Criar | algo que se configura (automação, projeto, token) | Gerar, Cadastrar |
| Editar | abrir para mudar | Alterar, Modificar |
| Cancelar | sair de um diálogo sem fazer nada | Voltar, Não |
| Fechar | X no canto; nunca botão de texto no pé | Sair, OK |
| Tentar de novo | depois de um erro | Tentar novamente, Recarregar |
| Ligar / Desligar | chave de liga e desliga | Ativar, Desativar, Habilitar |
| Aprovar / Recusar | proposta da Zuri, rotina pendente, plano | Aceitar, Rejeitar, Negar |
| Ver | ir ao detalhe de algo | Abrir (exceto "Abrir avisos"), Visualizar |
| Desfazer | no toast, quando dá para voltar | Reverter |
| Aviso | item da central (sino) | Notificação, Alerta (alerta é o envio por canal) |
| Automação | rotina agendada | Rotina, Tarefa agendada, Job |
| Conversa | chat com a Zuri | Chat, Sessão |
| Entrar / Sair | login e logout | Logar, Login, Deslogar |
| Verificação em duas etapas | 2FA | 2FA, autenticação de dois fatores |
| Configurações | a página | Ajustes, Preferências |

## Padrões de componente

| Componente | Padrão |
| --- | --- |
| Diálogo | Título à esquerda, X (44 × 44 px, "Fechar") no canto superior direito, ações no pé à direita: secundária ("Cancelar") antes da principal. Esc fecha; clique fora fecha só quando nada se perde. Sem botão "Fechar" em texto. |
| Diálogo de confirmação | Título em pergunta, uma frase do efeito, botão principal com o mesmo verbo do título (perigoso em vermelho). Foco inicial em "Cancelar". |
| Painel (central de avisos, histórico) | Igual ao diálogo; atalho para configurar no pé, à esquerda. |
| Toast | No pé, até 3 empilhados, X no canto, some em 5 s (fica enquanto tem foco ou mouse), "Desfazer" quando couber. Persistente só quando exige ação. |
| Faixa de aviso na página | Ícone, uma frase, ação em link, X para dispensar quando dispensável ("Lembrar depois" vira X + texto da regra). |
| Erro em campo | Abaixo do campo, `role="alert"`, ligado por `aria-describedby`, sem repetir o nome do campo. |
| Menu de ações | Botão ⋯ "Mais opções"; itens com ícone; destrutivo por último, separado, em vermelho. |
| Botões | Principal (um por tela ou diálogo), secundário, fantasma, perigo. Ícone sozinho só com nome acessível e dica. |
| Estado vazio | Ícone, título, uma frase, no máximo uma ação. |
| Carregando | Esqueleto do tamanho final quando a lista é previsível; spinner com texto quando não é. |

Componentes da casa a padronizar: `Dialog` em `apps/web/src/components/ui.tsx`
ganha o X por padrão (com o cuidado do teto do JS inicial, P11),
`Toaster.tsx` (já tem X), `NoticesPanel.tsx` (já tem X), faixas e menus.

## Inventário inicial (achados de 02/11/2026)

Ponto de partida, não lista fechada. A etapa 26 refaz o inventário completo
lendo todos os catálogos e percorrendo todas as telas.

- "Fechar" em texto no pé: histórico da memória (`MemoryPage.tsx`), projetos
  (`ProjectsDialog.tsx`), diálogo compartilhado de produtividade
  (`pages/productivity/shared.tsx`).
- "Excluir" nas automações (`web.automations.delete`, `deleteTitle`,
  aprovação `cancel_automation`) contra "Apagar" no resto.
- Pontos de exclamação fora do cumprimento: "Nada para hoje. Aproveite!",
  "Nada atrasado e nada para hoje. Dia livre!".
- "Algo deu errado" no erro interno e na tela de falha: rever para dizer o que
  fazer primeiro.
- `Dialog` sem X; cada tela põe o próprio botão de fechar.

## Como a etapa trabalha

1. **Inventário.** Script que lista todas as chaves de `pt-BR*.ts`, `en.ts` e
   textos do bot numa planilha Markdown (chave, texto, tela, tipo: botão,
   título, toast, erro, vazio, aviso, push, bot). Captura de todas as telas
   (`scripts/capturas-da-interface.ts`) como "antes".
2. **Lint de microcopy.** Teste no lint de i18n que falha com termo da coluna
   "Evitar", "com sucesso", "Ops", "Por favor", travessão (—), mais de um "!"
   por texto ou "!" fora das chaves permitidas (cumprimento). Começa com a
   lista do glossário; exceções explícitas e comentadas.
3. **Reescrita.** Por superfície, com `humanizer:humanizer` na passada final
   e `design:ux-copy` quando ajudar. O inglês acompanha. Nenhuma chave muda de
   sentido sem o teste da tela mudar junto.
4. **Componentes.** `Dialog` com X padrão, confirmação padrão, menu ⋯,
   faixa dispensável. `frontend-design:frontend-design` no plano das telas que
   mudarem de layout; `ponytail:ponytail` na implementação.
5. **Reorganização de UI/UX.** Só o que o inventário apontar (navegação,
   ordem de seções, hierarquia), com o antes e depois nas capturas. Mudança
   grande de navegação vira pergunta ao Pablo com recomendação.
6. **Revisão.** `revisao-qa`, `auditoria-seguranca` (texto não pode vazar dado
   nem citar infraestrutura) e Lighthouse ≥ 95.

Pode ser dividida em 26a (catálogo e lint), 26b (componentes) e 26c
(reorganização), uma PR cada, se o diff passar de um tamanho revisável.

## Critérios de aceite

- Todo texto visível segue as regras acima e o glossário; o lint de microcopy
  passa sem exceção não comentada.
- Nenhum diálogo, painel ou toast tem "Fechar" em texto; todos têm X no canto
  com nome acessível e Esc funcionando (e2e por componente).
- Confirmação destrutiva repete o verbo no botão e foca "Cancelar" (e2e).
- Toda mensagem de erro do catálogo diz o que fazer (revisão registrada no
  PR, chave por chave).
- pt-BR e en completos (a CI de i18n já exige).
- Capturas antes e depois de todas as telas, computador e celular, claro e
  escuro.
- axe sem violação séria em todas as telas; Lighthouse de acessibilidade e
  boas práticas ≥ 95; JS inicial dentro do teto.
- Nenhum teste enfraquecido; textos de teste e2e atualizados junto com o
  catálogo.

## Checklist do PR

- [ ] Inventário anexado (chaves revistas, antes → depois)
- [ ] Lint de microcopy ligado na CI
- [ ] Glossário aplicado; termos da coluna "Evitar" zerados
- [ ] X no canto em todo diálogo, painel e toast
- [ ] Confirmações no padrão
- [ ] Erros com "o que fazer"
- [ ] Sem marca de texto de IA (passada do `humanizer`)
- [ ] Sem citar infraestrutura
- [ ] en acompanha o pt-BR
- [ ] Capturas antes e depois
- [ ] e2e, axe, Lighthouse e teto do JS inicial
- [ ] README (capturas) e changelog
