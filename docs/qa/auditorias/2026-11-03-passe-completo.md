# Passe completo de pentest · 03/11/2026

Primeiro passe completo pelo procedimento de `docs/qa/pentest.md`, pedido pelo
Pablo em 03/11/2026, na `develop` depois da etapa 18b (versão 0.25.0).

- **Como:** seis auditores independentes em paralelo, um por grupo de áreas,
  só com o escopo; cada achado foi conferido no código antes de entrar aqui.
  Correções com teste `SEC-<área>-<nn>` e prova do vermelho (a correção
  desligada de propósito deixa o teste vermelho).
- **Alvo:** só o código local (Vitest no workerd). Nenhuma conta, nenhum
  serviço de terceiros, nenhum token real.
- **Resultado:** nenhum achado crítico ou alto; 3 médios, todos corrigidos;
  baixos corrigidos ou listados abaixo com recomendação.

## Áreas e atacantes

| Grupo | Áreas | Atacantes |
| --- | --- | --- |
| Login e sessões | A3, A4 | T1, T5, T6 |
| Borda HTTP e dados | A1, A2, A9, A13 | T1, T6 |
| IA e injeção | A6, A8 | T3, T4 |
| Bot do Telegram | A5, A4 | T2, T3, T5 |
| MCP e OAuth | A7 | T3, T4 |
| Web, CI e segredos | A10, A11, A12 | T1, T7, T8 |

## Achados corrigidos

| Id | Gravidade | Área | O que era | Correção | Teste |
| --- | --- | --- | --- | --- | --- |
| SEC-A3-01 | média | A3, A4 | Com o modo de bloqueio ligado, o "Esqueci minha senha" ainda enviava o link e aceitava o código do app autenticador, até na primeira hora. Quem estivesse com o celular do dono trocava a senha no meio do bloqueio | Recuperação por e-mail desligada no bloqueio inteiro (decisão do Pablo, 03/11): nenhum link sai e um link anterior responde `LOCKDOWN_ACTIVE` | `auth-recovery.test.ts` › SEC-A3-01 |
| SEC-A7-01 | média | A7 | As descrições dentro do schema das ferramentas MCP iam ao modelo sem a limpeza de invisíveis, e o filtro deixava passar tags Unicode e isolamentos bidi. Um servidor escondia uma instrução que o dono não via na revisão | Toda descrição do schema vira uma linha limpa e inerte; nome de campo estranho ou valor de dados com invisível deixa a ferramenta "schema não suportado" | `mcp-units.test.ts` › SEC-A7-01 |
| SEC-A5-01 | média | A5, A6 | Nota de voz encaminhada acima do limite, processada pelo botão **Processar mesmo assim**, entrava como fala do dono, fora de `<data>` | O pedido guardado marca a voz encaminhada como fala de terceiros | `telegram-conversation.test.ts` › SEC-A5-01 |
| SEC-A6-01 | baixa | A6 | Sinais parecidos com `<` e `>` (˂ ᐸ ❬ 《 ⧼ ❰ ⟪…) e as entidades `&lt;`/`&#62;` passavam pelo `<data>` | Lista ampliada e entidades neutralizadas | `memory-rules.test.ts` › SEC-A6-01 |
| SEC-A6-02 | baixa | A6 | Seletores de variação (U+FE00–FE0D, U+E0100–E01EF) escondiam bytes; letras em branco passavam | Removidos (ficam só os que escolhem a cara do emoji); letras em branco viram espaço | `memory-rules.test.ts` › SEC-A6-02 |
| SEC-A4-01 | baixa | A4, A5 | Um turno do bot que ainda baixava ou transcrevia um áudio quando veio o `/bloquear` chegava à Zuri depois | O turno confere o bloqueio antes de chegar ao agente | `telegram-conversation.test.ts` › SEC-A4-01 |
| SEC-A4-02 | baixa | A4, A8 | A resposta de uma rotina com IA pega no meio pelo bloqueio ainda era entregue | O executor confere o bloqueio de novo antes de entregar | `automations.test.ts` › SEC-A4-02 |
| SEC-A5-02 | baixa | A5 | Uso ou destravamento de antes do bloqueio deixava a leitura do bot aberta logo depois da saída | A leitura volta travada ao sair do bloqueio | `telegram-unlock.test.ts` › SEC-A5-02 |
| SEC-A9-01 | baixa | A9, A13 | `POST /api/diagnostics/client` abria um tipo novo por nome inventado, empurrava as falhas reais para fora dos 200 tipos e gerava um aviso "falha nova" por nome | No máximo 20 tipos da interface pelo nome; depois, um nome novo conta como `Error` | `diagnostics.test.ts` › SEC-A9-01 |
| — | baixa | A1, A13 | Toda recusa anônima (sem cookie, CSRF, 404) lia as 26 configurações para achar o idioma | O idioma sai de uma linha só | suíte de rotas existente |

## Baixos que ficaram, com recomendação

| Área | O que é | Recomendação |
| --- | --- | --- |
| A10 | Na tela de Notas, um link em Markdown mostra só o texto, sem o destino; uma nota escrita por injeção pode trazer `[Abrir o extrato](https://golpe…)`. O chat já mostra o destino | Ligar `showDestination` também nas notas (decisão de tela, com captura) |
| A3 | Token errado na página `/aprovar` conta no contador global de falhas do login, sem Turnstile; umas 84 redes em 15 min deixam o login mais difícil para redes novas | Contador próprio para `/aprovar`, fora do global do login |
| A3 | No bloqueio estrito com 2FA desligado, a resposta `LOCKDOWN_ACTIVE` só sai depois de a senha conferir | Responder antes de conferir a senha nesse caso |
| A7 | No cartão de aprovação do bot, o título do servidor vem antes do host e o corte de 120 caracteres pode escondê-lo; no chat o rótulo nem traz o host | Servidor e host primeiro e fora do corte |
| A7 | O botão **Entrar no serviço** não mostra para que host leva | Mostrar o host na dica do botão |
| A7 | Resultado de MCP pode levar o modelo a gravar uma memória ou nota sem cartão no mesmo turno | Avaliar na etapa 22: depois de uma resposta externa no turno, gravação de texto livre vira proposta |
| A6 | Lembretes criados por injeção, sem aprovação (a especificação aceita) | Marcar no aviso que a Zuri criou o lembrete |
| A6 | Respostas antigas da Zuri voltam ao histórico sem neutralização | Risco residual aceito: o servidor continua barrando; reavaliar se aparecer injeção persistente |
| A5 | Orçamentos de subrequisição do turno do bot somam 45 + 12, acima de 50 | Passar ao cliente do bot o que sobra dos 50 |
| A5, A13 | Atualização de conta estranha acorda o objeto; a conta pendente recebe uma resposta por mensagem | Descartar no Worker o `from.id` diferente quando `TELEGRAM_ADMIN_ID` existe; limitar a resposta da conta pendente |
| A7 | DNS rebinding no fetch do MCP | Mantido na etapa 22; risco real muito baixo no Workers |
| A7 | O que o SDK MCP confere sozinho (`iss`, `resource`, S256) não foi lido | Conferir na próxima mudança do MCP |
| A11 | `npm audit` da CI só falha em "high" | Somar `npm audit --omit=dev --audit-level=moderate` |
| A11 | Pacotes de skills externas inteiros podem trazer hooks ou `.mcp.json` no commit fixado | Conferir os três pacotes inteiros e restringir com `skills: [...]` |

## O que foi atacado sem achado

- **Login e sessões:** cookies `__Host-`, sessão como HMAC, revogação no
  login, CSRF por cabeçalho e `Origin`, IP só de `CF-Connecting-IP`,
  Turnstile, limitadores com reserva antes do PBKDF2, TOTP sem reuso,
  desafio WebAuthn de uso único, comparações em tempo constante,
  enumeração na recuperação, `WHILE_LOCKDOWN` sem desvio.
- **HTTP e dados:** portões do Worker, corpo contado em fluxo, ids por regex,
  SQL sem texto de fora, FTS5 só com termos entre aspas, `instr` em vez de
  `LIKE`, migrations só de acréscimo, push com allowlist e sem
  redirecionamento, logs com campos fechados, CSP e `no-store`.
- **IA:** prompt só por `composePrompt`, toda origem em `<data>`, segredos
  fora das mensagens, permissões das ferramentas, propostas com hash
  conferido na execução, tetos de passos e chamadas, rotinas só com leitura.
- **Telegram:** ordem das travas, `callback_data` só com id aleatório, uso
  único, trava de leitura em todo comando, vínculo por HMAC, token de
  `/aprovar` no fragmento, HTML escapado, download sem redirecionamento.
- **MCP:** SSRF (privados, mapeados, NAT64, decimal, octal, `.internal`),
  redirecionamento recusado, `state` preso à sessão, AES-GCM com IV
  aleatório, mudança de definição tira a ferramenta de uso.
- **Web, CI e segredos:** nenhum `dangerouslySetInnerHTML`, service worker sem
  cache, ações por SHA, `permissions` mínimas, texto de terceiros só por
  `env:`, nenhum segredo real no repositório nem no histórico,
  dependências com versão exata.
