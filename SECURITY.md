# Política de segurança

O Zuri roda na conta Cloudflare do próprio dono e guarda conversas, memórias,
tarefas e dados de acesso. Uma falha pode expor os dados pessoais de alguém.
Obrigado por relatar de forma responsável.

## Versões com suporte

Só a versão mais recente da branch `main` recebe correções de segurança.

## Como relatar uma vulnerabilidade

**Não abra uma issue pública.** Use o relato privado do GitHub: aba
**Security → Report a vulnerability** deste repositório
([como funciona](https://docs.github.com/pt/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Inclua, se puder:

- a parte afetada (Worker, Durable Object, interface web, bot do Telegram, CI);
- os passos para reproduzir ou uma prova de conceito;
- o impacto e uma sugestão de correção.

A meta é confirmar o recebimento em até 3 dias úteis e publicar a correção em
até 30 dias, conforme a gravidade. O crédito é seu, a menos que prefira o
contrário.

## Escopo

Dentro do escopo, por exemplo:

- contornar login, sessão, 2FA, passkey, CSRF ou o limite de tentativas;
- alcançar o Durable Object, os dados ou a IA sem a credencial certa;
- fazer o bot do Telegram obedecer a outra conta ou aprovar algo sem a
  confirmação por passkey ou e-mail;
- vazar segredo ou dado pessoal para o navegador, os logs ou o repositório;
- injeção de prompt que leve o agente a executar ação de escrita ou destrutiva
  sem aprovação do dono;
- qualquer coisa que ligue em silêncio um recurso pago da Cloudflare;
- falha na cadeia de suprimentos (workflows, dependências, Actions).

Fora do escopo:

- falhas da própria plataforma da Cloudflare ou do Telegram (relate a elas);
- ataques que exigem a conta Cloudflare ou o aparelho do dono já
  comprometidos;
- o próprio dono passar das cotas do plano gratuito.

## Como o projeto se protege

As regras completas estão em `docs/especificacao.md` (seção "Regras de
segurança que valem para todo código") e em `AGENTS.md`. Toda etapa passa por
auditoria de segurança antes de entrar na `develop`.
