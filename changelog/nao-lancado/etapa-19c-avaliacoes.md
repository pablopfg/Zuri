<!-- versao: minor -->
### Adicionado

- Aba **Avaliações** em Contatos (`/contatos/avaliacoes`): a Zuri lê as
  avaliações do seu Perfil da Empresa no Google a cada 15 minutos (até 3
  perfis) e mostra o que precisa de você, o que já foi respondido e tudo o
  mais, com filtro por nota. **Conferir agora** lê na hora.
- Avaliação de 1 a 3 estrelas avisa a equipe no tópico "Avaliações" do grupo
  do Telegram, mesmo com a IA fora do ar, e ganha um rascunho cuidadoso para
  você revisar. Sem solução em 48 horas, a Zuri avisa mais uma vez.
- Avaliação de 4 ou 5 estrelas ganha rascunho: com um dos seus modelos quando
  não tem texto, ou escrito por um agente próprio, sem ferramentas, quando o
  texto é só elogio. Queixa, assunto de saúde ou outro idioma vão para a
  equipe.
- Você edita o rascunho e toca em **Aprovar e publicar**. Também dá para
  escrever de novo, descartar o rascunho, marcar como resolvida fora da Zuri
  e apagar uma resposta que a Zuri publicou.
- Em **Configurações › Integrações**, o cartão do Google ganha a seção
  **Avaliações do Google**: perfis, assinatura, tom, 3 a 5 modelos de
  agradecimento e palavras proibidas. A primeira leitura guarda o que já
  existe como histórico, sem aviso.
- `/status` no Telegram mostra as avaliações, e `/pausar_rotinas` também
  pausa as respostas.

### Segurança

- Nada é publicado sem a sua aprovação. Toda resposta, inclusive a que você
  escreve, passa por uma conferência fixa: tamanho, idioma, sem números,
  links ou contatos, sem nomes além do primeiro nome de quem avaliou, sem
  promessas, preços, saúde ou assunto jurídico, e com a sua assinatura no
  fim. O rascunho da IA passa ainda por uma segunda leitura.
- Antes de publicar, a Zuri lê a avaliação de novo no Google. Se ela mudou,
  sumiu ou já tem resposta, nada sai. A aprovação vale 72 horas, só para a
  versão vista, e duas abas nunca publicam duas vezes.
- A IA só deixa uma avaliação mais cautelosa, nunca menos. Texto com cara de
  ordem, link ou contato vai para a equipe e a IA não o lê. O texto da
  avaliação entra no prompt marcado como dado.
- Nome, texto e ids das avaliações ficam fora do log. No modo de bloqueio
  nada lê o Google nem publica. Desligar as avaliações ou desconectar o
  Google apaga a cópia guardada.

### Atualização

- O banco ganha a migration 26 (configuração, perfis, avaliações e a
  auditoria de 180 dias). Ela roda sozinha e só acrescenta. Nenhum secret
  novo e nenhum recurso novo da Cloudflare.
- Para ligar, o projeto do Google Cloud precisa das três APIs do Perfil da
  Empresa, do Basic API Access aprovado pelo Google e do escopo
  `business.manage` na tela de consentimento. Passo a passo em
  `docs/avaliacoes-google.md`.
