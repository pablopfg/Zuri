### Corrigido

- PRs verdes não ficam mais paradas atrás da `develop` depois que entra a PR
  automática do README ou a de versão. O merge feito pelo próprio GitHub
  Actions não dispara nenhum workflow, e o agendamento de 15 minutos quase
  nunca rodava. Agora o workflow novo `Seguir merge` espera essas PRs entrarem
  e chama em seguida o `Update PRs`, o `Branches` e o outro workflow
  automático (README ou Versão).
