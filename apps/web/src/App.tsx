import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell.tsx";
import { RequireSession } from "./components/RequireSession.tsx";
import { Spinner } from "./components/ui.tsx";
import { useSession } from "./hooks/session.tsx";
import { LOGIN_PATH } from "./lib/next.ts";
import { HomePage } from "./pages/HomePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { PasswordChangePage } from "./pages/PasswordChangePage.tsx";

// Settings carry the QR code and passkey code, notes the Markdown renderer: loaded only when opened.
const SettingsPage = lazy(() => import("./pages/SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const TasksPage = lazy(() => import("./pages/productivity/TasksPage.tsx").then((m) => ({ default: m.TasksPage })));
const MemoryPage = lazy(() => import("./pages/memory/MemoryPage.tsx").then((m) => ({ default: m.MemoryPage })));
const AccessLogPage = lazy(() => import("./pages/security/AccessLogPage.tsx").then((m) => ({ default: m.AccessLogPage })));
const ChatPage = lazy(() => import("./pages/chat/ChatPage.tsx").then((m) => ({ default: m.ChatPage })));
const NotesPage = lazy(() => import("./pages/productivity/NotesPage.tsx").then((m) => ({ default: m.NotesPage })));

/** While the password must change, the server refuses everything else: so does the interface. */
function SignedIn() {
  const { session } = useSession();
  if (session?.passwordChangeRequired) return <PasswordChangePage />;
  return <AppShell />;
}

export function App() {
  return (
    <Routes>
      <Route path={LOGIN_PATH} element={<LoginPage />} />
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
