import { lazy, Suspense, useCallback, useState } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/AppShell.tsx";
import { RequireSession, SessionChecking } from "./components/RequireSession.tsx";
import { ScreenLoading } from "./components/ui.tsx";
import { useSession } from "./hooks/session.tsx";
import { APPROVE_PATH, FIRST_ACCESS_PATH, LOGIN_PATH, RECOVERY_PATH } from "./lib/next.ts";
import { HomePage } from "./pages/HomePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";

// Settings carry the QR code and passkey code, notes the Markdown renderer: loaded only when opened.
const SettingsPage = lazy(() => import("./pages/SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const TasksPage = lazy(() => import("./pages/productivity/TasksPage.tsx").then((m) => ({ default: m.TasksPage })));
const MemoryPage = lazy(() => import("./pages/memory/MemoryPage.tsx").then((m) => ({ default: m.MemoryPage })));
const AccessLogPage = lazy(() => import("./pages/security/AccessLogPage.tsx").then((m) => ({ default: m.AccessLogPage })));
const ChatPage = lazy(() => import("./pages/chat/ChatPage.tsx").then((m) => ({ default: m.ChatPage })));
const AutomationsPage = lazy(() => import("./pages/automations/AutomationsPage.tsx").then((m) => ({ default: m.AutomationsPage })));
// The screens that lock the rest of the app are rare: each comes only when needed.
const PasswordChangePage = lazy(() => import("./pages/PasswordChangePage.tsx").then((m) => ({ default: m.PasswordChangePage })));
const SecondStepPage = lazy(() => import("./pages/setup/SecondStepPage.tsx").then((m) => ({ default: m.SecondStepPage })));
const FirstAccessPage = lazy(() => import("./pages/setup/FirstAccessPage.tsx").then((m) => ({ default: m.FirstAccessPage })));
const RecoveryPage = lazy(() => import("./pages/setup/RecoveryPage.tsx").then((m) => ({ default: m.RecoveryPage })));
const ApprovePage = lazy(() => import("./pages/ApprovePage.tsx").then((m) => ({ default: m.ApprovePage })));
const AgendaPage = lazy(() => import("./pages/agenda/AgendaPage.tsx").then((m) => ({ default: m.AgendaPage })));
const ContactsPage = lazy(() => import("./pages/contacts/ContactsPage.tsx").then((m) => ({ default: m.ContactsPage })));
const NotesPage = lazy(() => import("./pages/productivity/NotesPage.tsx").then((m) => ({ default: m.NotesPage })));

/** While the password must change, the second step must be turned on or a lockdown is on, the server refuses everything else: so does the interface. */
function SignedIn() {
  const { session } = useSession();
  // Turning the second step on opens the server's session at once, while the recovery codes are
  // still on screen: a session check then (back from another app) must not swap them for the app.
  // The screen holds itself until the owner says the codes are kept.
  const [held, hold] = useState(false);
  // A lockdown (step 16b) opens the same lazy screen, which then shows "Sair do bloqueio".
  const locked =
    session?.passwordChangeRequired || session?.lockdown ? <PasswordChangePage /> : held || session?.secondStepRequired ? <SecondStepPage hold={hold} /> : null;
  if (locked) return <Suspense fallback={<SessionChecking />}>{locked}</Suspense>;
  return <AppShell />;
}

/** The router stays out of the lazy screen (.claude/memoria/armadilhas.md, "Pacote da interface"): it gets `go`. */
function FirstAccess() {
  const navigate = useNavigate();
  const go = useCallback((path: string) => navigate(path, { replace: true }), [navigate]);
  return <FirstAccessPage go={go} />;
}

/** Password recovery by e-mail (step 11c): the same shape, the router stays outside. */
function Recovery() {
  const navigate = useNavigate();
  const go = useCallback((path: string) => navigate(path, { replace: true }), [navigate]);
  return <RecoveryPage go={go} />;
}

export function App() {
  return (
    <Routes>
      <Route path={LOGIN_PATH} element={<LoginPage />} />
      <Route
        path={FIRST_ACCESS_PATH}
        element={
          <Suspense fallback={<SessionChecking />}>
            <FirstAccess />
          </Suspense>
        }
      />
      <Route
        path={RECOVERY_PATH}
        element={
          <Suspense fallback={<SessionChecking />}>
            <Recovery />
          </Suspense>
        }
      />
      {/* The bot's confirmation by passkey (step 15): no session, the token in the fragment is the key. */}
      <Route
        path={APPROVE_PATH}
        element={
          <Suspense fallback={<SessionChecking />}>
            <ApprovePage />
          </Suspense>
        }
      />
      <Route
        element={
          <RequireSession>
            <SignedIn />
          </RequireSession>
        }
      >
        <Route index element={<HomePage />} />
        <Route
          path="configuracoes/:tab?"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route
          path="conversa/:id?"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <ChatPage />
            </Suspense>
          }
        />
        <Route
          path="tarefas"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <TasksPage />
            </Suspense>
          }
        />
        <Route
          path="notas/:id?"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <NotesPage />
            </Suspense>
          }
        />
        <Route
          path="agenda"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <AgendaPage />
            </Suspense>
          }
        />
        <Route
          path="contatos"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <ContactsPage />
            </Suspense>
          }
        />
        <Route
          path="automacoes"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <AutomationsPage />
            </Suspense>
          }
        />
        <Route
          path="memoria"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <MemoryPage />
            </Suspense>
          }
        />
        <Route
          path="acessos"
          element={
            <Suspense fallback={<ScreenLoading />}>
              <AccessLogPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
