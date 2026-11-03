### Adicionado

- Tempo real: o que muda fora da tela (Telegram, rotinas, outro aparelho)
  aparece na hora, sem esperar o minuto do sinal de vida e sem recarregar a
  página. Cada navegador mantém uma conexão só, parada enquanto nada muda.
  Se ela cair, a Zuri tenta de novo sozinha e, enquanto isso, o sinal de vida
  de 1 minuto continua trazendo as mudanças.

### Segurança

- A conexão de tempo real é o único WebSocket aceito, num endereço só. Ela
  exige login válido e a origem do próprio site, leva só números (nunca o
  conteúdo), fecha quando a sessão termina e não abre durante o bloqueio
  (/bloquear), com senha a trocar ou com o segundo passo pendente.
