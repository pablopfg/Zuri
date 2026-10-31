---
name: revisao-qa
description: Revisão de QA sênior da etapa ou do diff atual do Zuri - matriz de rastreabilidade, casos de borda, abuso, acessibilidade, i18n e regressão. Use depois de verificar e antes da auditoria de segurança e do PR.
---

# Revisão de QA sênior

Siga `docs/qa/estrategia-de-testes.md`.

1. **Matriz de rastreabilidade.** Liste cada critério de aceite da etapa (inclusive os da tabela "Critérios de aceite adicionais") e o teste que o cobre (`arquivo › nome do teste`). Critério sem teste = lacuna: escreva o teste.
2. **Revisão independente.** Peça ao subagente `qa-senior` que revise o diff passando só a branch e o número da etapa. Não passe as suas conclusões.
3. **Padrões e especificação.** Rode `mattpocock-skills:code-review` com ponto fixo `origin/develop` e, como especificação, o bloco da etapa em `docs/especificacao.md`. Ele revisa em paralelo os padrões do repositório e a aderência à etapa.
4. **Exigências por área e portões.** Percorra as "Exigências por área" e os "Portões obrigatórios de cada etapa" de `docs/qa/estrategia-de-testes.md` e marque, para cada item que a etapa tocou, o teste que o cobre.
5. **Prova de que o teste pega a falha.** Para cada controle de segurança ou correção nova, quebre o código de propósito (tire a checagem, inverta a condição), rode só aquele teste, confirme o vermelho e desfaça (`git checkout` do arquivo). Teste que continua verde é teste fraco: reescreva.
6. **Casos que sempre se testam**, quando a etapa tocar a área:
   - limites exatos (n−1, n, n+1) de tamanho, quantidade e tempo;
   - entrada vazia, enorme, malformada, Unicode, emoji, RTL;
   - repetição, concorrência e ordem trocada (duplo clique, duas abas, webhook repetido);
   - fuso, horário de verão, virada de dia e de mês;
   - IA indisponível, cota esgotada, rede lenta, resposta interrompida;
   - usuário não autenticado, sessão expirada, token de outro escopo;
   - textos em pt-BR e en, leitor de tela e teclado nas telas novas;
   - aparelho em outro fuso que o do dono (e2e com `timezoneId: "Asia/Tokyo"`).
7. **Regressão.** Rode a suíte completa e compare com a `develop`. Teste instável é bug: ache a corrida.
8. **Exploratório.** Para telas e bot, rode o app (`npm run dev`) e percorra o roteiro da etapa; anote o que encontrar.
9. **Relatório no PR** (seção "QA"): matriz, exigências por área cobertas, provas de falha, cobertura (antes e depois), notas do Lighthouse, achados e correções, o que ficou de fora e por quê.
