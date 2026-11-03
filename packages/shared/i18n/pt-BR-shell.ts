// The pt-BR texts of the parts of the signed-in frame that come on demand: the
// password confirmation before a sensitive change (also on the lockdown screen)
// and the two-step reminder. Most visits show neither, so they stay out of the
// first load (rule P11).
export const ptBRShell = {
  "web.confirm.title": "Confirme que é você",
  "web.confirm.body": "Para mudar algo sensível, digite a sua senha de novo. A confirmação vale por 15 minutos.",
  "web.confirm.submit": "Confirmar",
  "web.confirm.useCode": "Usar o código do aplicativo",
  "web.confirm.usePassword": "Usar a senha",
  "web.mfaReminder.body": "A verificação em duas etapas está desligada. Ligue para proteger a sua conta.",
  "web.mfaReminder.short": "Duas etapas desligadas",
  "web.mfaReminder.action": "Ligar agora",
  "web.mfaReminder.later": "Lembrar depois",
} as const;
