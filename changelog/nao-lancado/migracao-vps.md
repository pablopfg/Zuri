### Adicionado

- Avaliação de como instalar o Zuri numa VPS e sair da Cloudflare se for
  preciso, em `docs/planos/portabilidade-vps.md`: o que depende da Cloudflare,
  o equivalente de cada peça, dois caminhos de migração, custo estimado de uma
  VPS (⚠ nada contratado) e três cuidados para as próximas etapas.
- Plano detalhado da migração para VPS em `docs/planos/migracao-vps.md`,
  pronto para quando for preciso: o que preparar desde já (o que o backup não leva,
  domínio fora da Cloudflare, backup), dez PRs com arquivos, testes e critério
  de pronto, montagem da VPS, dia da troca e como voltar atrás.
- Planejado para a etapa 23: backup automático diário, cifrado, num bucket R2
  da própria conta (⚠ recurso novo; ligar o R2 pede cartão cadastrado, sem
  custo dentro da faixa grátis), guardando as 7 cópias mais novas, e uma cópia
  por mês enviada ao dono pelo Telegram, fora da Cloudflare.
