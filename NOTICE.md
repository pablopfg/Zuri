# Avisos de terceiros

## Talorys (Axis)

O Zuri foi escrito do zero a partir da especificação em `docs/especificacao.md`,
usando como referência de leitura o projeto Talorys (hoje Axis):
<https://github.com/pablopfg/talorys>.

Os trechos reaproveitados ou adaptados do Talorys continuam sob a licença MIT e
com o aviso de copyright abaixo. Cada PR que reaproveitar código de lá cita o
arquivo de origem no corpo.

```text
MIT License

Copyright (c) 2026 The Talorys contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Etapa 0

A configuração da CI, dos rulesets e do Dependabot segue o desenho do Talorys
(`.github/workflows/ci.yml`, `.github/workflows/branch-policy.yml`,
`.github/rulesets/` e `.github/dependabot.yml`), adaptado às regras do Zuri.
