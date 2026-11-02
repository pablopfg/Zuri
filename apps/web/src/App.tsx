import { lazy, Suspense, useCallback, useState } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/AppShell.tsx";
import { RequireSession, SessionChecking } from "./components/RequireSession.tsx";
import { Spinner } from "./components/ui.tsx";
import { useSession } from "./hooks/session.tsx";
import { FIRST_ACCESS_PATH, LOGIN_PATH, RECOVERY_PATH } from "./lib/next.ts";
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
const NotesPage = lazy(() => import("./pages/productivity/NotesPage.tsx").then((m) => ({ default: m.NotesPage })));

/** While the password must change, or the second step must be turned on, the server refuses everything else: so does the interface. */
function SignedIn() {
  const { session } = useSession();
  // Turning the second step on opens the server's session at once, while the recovery codes are
  // still on screen: a session check then (back from another app) must not swap them for the app.
  // The screen holds itself until the owner says the codes are kept.
  const [held, hold] = useState(false);
  const locked = session?.passwordChangeRequired ? <PasswordChangePage /> : held || session?.secondStepRequired ? <SecondStepPage hold={hold} /> : null;
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
            <Suspense fallback={<Spinner />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route
          path="conversa/:id?"
          element={
            <Suspense fallback={<Spinner />}>
              <ChatPage />
            </Suspense>
          }
        />
        <Route
          path="tarefas"
          element={
            <Suspense fallback={<Spinner />}>
              <TasksPage />
            </Suspense>
          }
        />
        <Route
          path="notas/:id?"
          element={
            <Suspense fallback={<Spinner />}>
              <NotesPage />
            </Suspense>
          }
        />
        <Route
          path="automacoes"
          element={
            <Suspense fallback={<Spinner />}>
              <AutomationsPage />
            </Suspense>
          }
        />
        <Route
          path="memoria"
          element={
            <Suspense fallback={<Spinner />}>
              <MemoryPage />
            </Suspense>
          }
        />
        <Route
          path="acessos"
          element={
            <Suspense fallback={<Spinner />}>
              <AccessLogPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
