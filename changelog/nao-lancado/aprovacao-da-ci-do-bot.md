### Corrigido

- A atualização automática das PRs (`Update PRs`) não deixa mais a CI parada
  esperando aprovação. O GitHub segura as execuções que o push do bot cria, e
  o ruleset não aceitava os checks disparados à mão, então o merge ficava em
  "Expected" mesmo com tudo verde. Agora o workflow aprova as execuções que o
  próprio push criou e não dispara mais a CI por fora. O `merge-order` velho
  é reexecutado no lugar de disparado.
