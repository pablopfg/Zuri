### Adicionado

- Modelo reserva em Configurações › IA. Quando o modelo de conversa está
  ocupado, fora do ar ou demora mais de 20 segundos para começar, outro
  modelo grátis responde no lugar, e a resposta mostra "Respondida pelo
  modelo reserva". Ele usa o mesmo teto de Neurons do dia e não entra em
  ação no seu limite diário, quando você aperta Parar, depois que a resposta
  começou ou depois que uma ferramenta rodou. Vem ligado com o Qwen3 30B A3B;
  dá para trocar ou desligar. Um modelo que falha seguido fica de lado por um
  tempo e volta a ser testado na próxima mensagem, sem chamadas extras.

### Segurança

- O prompt da Zuri agora é montado só por um contrato: cada parte diz de onde
  vem e se é instrução ou conteúdo guardado, e conteúdo fora dos blocos de
  dados derruba a resposta em vez de chegar ao modelo. Há uma lista fechada
  do que nunca vai para a IA (e-mail, senha, segredos, sessões, Acessos,
  códigos do 2FA, ids do Telegram, credenciais de MCP). Um teste novo grava
  valores marcados em todos esses lugares e confere que nenhum aparece no que
  a IA recebe. Se um segredo do servidor escapasse mesmo assim, ele seria
  trocado por "[removido]" antes de sair.

### Atualização

- Migration 10 acrescenta a coluna `fallback` em `zur_messages`, para marcar
  a resposta do modelo reserva. As mensagens antigas ficam sem a marca. A
  configuração nova "Modelo reserva" começa no Qwen3 30B A3B.
