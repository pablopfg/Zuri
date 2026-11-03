import { ptBRMemory } from "./pt-BR-memory.ts";
import { ptBRPalette } from "./pt-BR-palette.ts";
import { ptBRProductivity } from "./pt-BR-productivity.ts";
import { ptBRAi } from "./pt-BR-ai.ts";
import { ptBRChat } from "./pt-BR-chat.ts";
import { ptBRSecurity } from "./pt-BR-security.ts";
import { ptBRServer } from "./pt-BR-server.ts";
import { ptBRSettings } from "./pt-BR-settings.ts";
import { ptBRGreeting } from "./pt-BR-greeting.ts";
import { ptBRNotices } from "./pt-BR-notices.ts";
import { ptBRSetup } from "./pt-BR-setup.ts";
import { ptBRAutomations } from "./pt-BR-automations.ts";
import { ptBRMarkdown } from "./pt-BR-markdown.ts";
import { ptBRAlerts } from "./pt-BR-alerts.ts";
import { ptBRApprove } from "./pt-BR-approve.ts";
import { ptBRShell } from "./pt-BR-shell.ts";
import { ptBRSettingsTabs } from "./pt-BR-settings-tabs.ts";

// Default and fallback catalog. Every key must also exist in en.ts and be used in the code (npm run lint).
// The texts of the lazy screens live in their own files (pt-BR-memory.ts, pt-BR-productivity.ts,
// pt-BR-security.ts), so the interface loads them with those screens (rule P11).
export const ptBRCore = {
  "app.name": "Zuri",
  "error.internal": "Algo deu errado. Seus dados estão seguros; tente de novo.",
  "format.dateTime": "{date} às {time}",
  "web.loading": "Carregando…",
  "web.retry": "Tentar de novo",
  "web.cancel": "Cancelar",
  "web.close": "Fechar",
  "web.save": "Salvar",
  "web.saved": "Salvo.",
  "web.error.network": "Sem conexão com a Zuri. Confira a internet e tente de novo.",
  "web.session.checking": "Conferindo a sua sessão…",
  "web.nav.main": "Navegação principal",
  "web.nav.skip": "Pular para o conteúdo",
  "web.nav.home": "Início",
  "web.nav.homeLink": "Zuri, página inicial",
  "web.nav.settings": "Configurações",
  "web.search.open": "Buscar",
  "web.nav.signOut": "Sair",
  "web.nav.signOutConfirmTitle": "Sair da Zuri?",
  "web.nav.collapse": "Recolher menu",
  "web.nav.expand": "Expandir menu",
  "web.nav.version": "Versão {version}",
  "web.login.email": "E-mail",
  "web.login.password": "Senha",
  "web.login.submit": "Entrar",
  "web.login.waitSeconds": "Tente de novo em {seconds} s",
  "web.login.ended": "Sua sessão terminou. Entre de novo para continuar.",
  "web.login.endedIdle": "Sua sessão terminou por falta de uso. Entre de novo para continuar.",
  "web.login.humanHint": "Confirme que é você para continuar.",
  "web.login.humanBroken": "A verificação de segurança não carregou. Tente de novo para entrar.",
  "web.login.humanRetry": "Recarregar a verificação",
  "web.login.secure": "Conexão protegida",
  "web.login.headline": "Tudo o que importa, num só lugar.",
  "web.login.lead": "Tarefas, notas e lembranças organizadas por um assistente que aprende com você.",
  "web.login.pointTwoStep": "Entrada protegida em duas etapas",
  "web.login.pointPrivate": "Suas informações, só para você",
  "web.login.pointFast": "Rápido em qualquer aparelho",
  "web.login.welcome": "Que bom te ver de novo.",
  "web.login.humanLoading": "Preparando a verificação de segurança…",
  "web.login.emailRequired": "Digite o seu e-mail.",
  "web.login.passwordRequired": "Digite a sua senha.",
  "web.login.codeRequired": "Digite o código.",
  "web.login.codeTitle": "Verificação em duas etapas",
  "web.login.codeHint": "Digite o código de 6 dígitos do seu aplicativo autenticador.",
  "web.login.recoveryHint": "Digite um dos seus códigos de recuperação. Cada código vale uma vez.",
  "web.login.code": "Código do aplicativo",
  "web.login.recoveryCode": "Código de recuperação",
  "web.login.verify": "Confirmar",
  "web.login.signInWithPasskey": "Usar uma passkey",
  "web.login.passkeyCancelled": "A passkey não foi usada. Tente de novo ou digite o código.",
  "web.login.back": "Voltar",
  "web.login.useRecovery": "Usar um código de recuperação",
  "web.login.useApp": "Usar o código do aplicativo",
  "web.login.forgot": "Esqueci minha senha",
  "web.guard.title": "Sua sessão vai terminar",
  "web.guard.idle": "Por falta de uso, a sessão termina em {time}. Quer continuar?",
  "web.guard.max": "A sessão chegou ao tempo máximo e termina em {time}. Depois disso, entre de novo.",
  "web.guard.stay": "Continuar conectado",
  "web.notifications.open": "Abrir avisos",
  "web.notifications.title": "Avisos",
  "web.notifications.openUnread": "Abrir avisos, {count} sem ler",
  "web.home.emptyTitle": "A conversa com a Zuri chega em breve",
  "web.home.emptyBody": "A conversa com ela entra numa próxima etapa. Enquanto isso, deixe a sua conta protegida.",
  "web.home.securityLink": "Revisar a segurança da conta",
  "web.home.securityTitle": "Segurança",
  "web.home.mfaOn": "Verificação em duas etapas ligada",
  "web.home.mfaOff": "Verificação em duas etapas desligada",
  "web.home.sessionTitle": "Sessão",
  "web.home.sessionUntil": "Aberta até {time}",
  "web.home.sessionHint": "Ela termina antes se você ficar sem usar a Zuri pelo tempo definido nas configurações.",
  "web.notFound.title": "Página não encontrada",
  "web.notFound.body": "Este endereço não existe na Zuri.",
  "web.notFound.home": "Voltar ao início",
  "web.crash.title": "Algo deu errado",
  "web.crash.body": "Esta tela parou por causa de um erro. Recarregue para tentar de novo; o que já estava salvo continua na Zuri.",
  "web.crash.reload": "Recarregar",
  "web.password.show": "Mostrar senha",
  "web.password.hide": "Ocultar senha",
  "web.account.signOutHint": "Encerra esta sessão. As outras abas deste navegador saem junto.",
  "web.nav.accessLog": "Acessos",
  "web.nav.tasks": "Tarefas",
  "web.nav.notes": "Notas",
  "web.nav.memory": "Memória",
  "web.nav.chat": "Conversa",
  "web.nav.automations": "Automações",
} as const;

/** The intersection of every part's type, so each key stays a literal key. */
type Joined<T extends readonly object[]> = T extends readonly [infer Head, ...infer Rest extends readonly object[]]
  ? Head & Joined<Rest>
  : unknown;

/** Joins catalog parts. Marked pure so a bundle that never uses the whole catalog drops the call. */
function join<const T extends readonly object[]>(...parts: T): Joined<T> {
  return Object.assign({}, ...parts) as Joined<T>;
}

/**
 * The whole pt-BR catalog: what the server, the tests and the lint use. One
 * part per line: a screen that adds its part adds one line at the end, so two
 * pull requests never edit the same line.
 */
export const ptBR = /* @__PURE__ */ join(
  ptBRCore,
  ptBRMemory,
  ptBRProductivity,
  ptBRSecurity,
  ptBRAi,
  ptBRChat,
  ptBRSettings,
  ptBRServer,
  ptBRPalette,
  ptBRGreeting,
  ptBRSetup,
  ptBRNotices,
  ptBRAutomations,
  ptBRMarkdown,
  ptBRAlerts,
  ptBRApprove,
  ptBRShell,
  ptBRSettingsTabs,
);
