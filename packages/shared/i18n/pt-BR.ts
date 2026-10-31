// Default and fallback catalog. Every key must also exist in en.ts and be used in the code (npm run lint).
export const ptBR = {
  "app.name": "Zuri",
  "app.tagline": "Seu assistente pessoal de IA, na sua conta Cloudflare.",
  "app.underConstruction": "Em construção: a interface chega na etapa {stage}.",
  "error.unauthorized": "Entre para continuar.",
  "error.forbidden": "Você não tem permissão para fazer isso.",
  "error.httpsRequired": "Use uma conexão segura (HTTPS).",
  "error.websocketNotSupported": "Este endereço não aceita WebSocket.",
  "error.accessRequired": "Entre pelo Cloudflare Access para continuar.",
  "error.hostNotAllowed": "Este endereço não atende o Zuri.",
  "error.notFound": "Não encontrado.",
  "error.notConfigured": "O Zuri ainda não foi configurado por completo.",
  "error.internal": "Algo deu errado. Seus dados estão seguros; tente de novo.",
  "error.validationFailed": "Confira os dados enviados.",
  "format.dateTime": "{date} às {time}",
} as const;
