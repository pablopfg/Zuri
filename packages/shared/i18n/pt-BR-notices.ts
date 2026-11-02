// The pt-BR notices about secrets left behind once they are no longer needed. They name the
// hosting dashboard, so they live apart from the public first access (decision of 31/10/2026)
// and come only with the signed-in app, when one of them shows (rule P11).
export const ptBRNotices = {
  "web.shell.removePlainSecret": "A senha já está guardada na Zuri. Apague o segredo OWNER_PASSWORD no painel da Cloudflare (Workers › zuri › Configurações › Variáveis e segredos).",
  "web.shell.removeSetupCode": "Por segurança, apague o segredo SETUP_CODE no painel da Cloudflare (Workers › zuri › Configurações › Variáveis e segredos). Se um dia precisar recuperar o acesso, é só gravar um código novo.",
} as const;
