<!-- versao: minor -->
### Adicionado

- Três passos novos nos fluxos, em **Automações › Fluxos**:
  - **Ler a agenda**: lê os eventos de uma agenda aberta à Zuri (ou de todas),
    de tantos dias a partir de hoje, por 1 a 31 dias. Cada evento vira um item.
  - **Criar evento**: cria um evento por item numa agenda em "ler e editar",
    até 10 por execução. Ninguém é convidado nem recebe e-mail. Uma chave
    opcional, como `{{id}}`, impede que o mesmo item vire um segundo evento.
  - **Buscar contatos**: busca na cópia dos seus contatos do Google por nome,
    telefone, e-mail, etiqueta ou aniversário, sem chamar o Google. Com "um
    por item", cada item ganha o contato que bate com ele.
- O editor lista as agendas abertas e as etiquetas copiadas, e avisa quando o
  Google ou os contatos estão desligados.
- A Zuri também pode sugerir esses passos quando você pede um fluxo na
  conversa. A sugestão continua nascendo desligada.

### Segurança

- Nenhum passo muda ou apaga evento, e uma agenda só de leitura nunca recebe
  evento. O que vem da agenda e dos contatos chega à IA só como dado. As
  chamadas ao Google entram no mesmo teto de chamadas da execução e do
  despertar.

### Corrigido

- No ambiente de desenvolvimento, os eventos de exemplo da Agenda passam a
  seguir o dia de São Paulo mesmo quando o servidor sobe antes da meia-noite
  (#178).

### Atualização

- Nenhuma migration nem secret novo.
