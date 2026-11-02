### Adicionado

- Versão do sistema em Configurações > Diagnóstico ("Versão da Zuri") e no
  formulário de "Relatar no GitHub". Cada merge na `develop` vira uma versão
  0.x com tag `vX.Y.Z` e uma pré-release no GitHub, criadas sozinhas logo
  depois do merge.

### Alterado

- O `CHANGELOG.md` agora tem uma seção por versão, da mais nova para a mais
  antiga, com a hora do merge no horário de Brasília (UTC-3), o commit e a PR.
  O histórico foi refeito desde a primeira PR: as etapas 0 a 13 viraram as
  versões 0.1.0 a 0.17.0. Cada PR continua escrevendo a sua parte em
  `changelog/nao-lancado/`, e a que conclui uma etapa marca
  `<!-- versao: minor -->` na primeira linha.
- O código da publicação no Diagnóstico passou a se chamar "Código da
  publicação", para não se confundir com a versão.
