import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { App } from "./App.tsx";
import { SessionProvider } from "./hooks/session.tsx";
import { ApiError } from "./lib/api.ts";
import { I18nProvider } from "./lib/i18n.tsx";
import { initTheme } from "./lib/theme.ts";
import "./styles.css";

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Refusals (4xx) are answers, not hiccups: only server and network failures repeat.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

// A data router, though the routes stay in <App />: only it lets a page hold a
// navigation back (useBlocker), as the note editor does with unsaved text.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <I18nProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </I18nProvider>
    ),
  },
]);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// The service worker makes the app installable and, from step 11, shows push
// notices. It caches nothing: every page and every API answer comes from the network.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Without it the app still works; it just can't be installed.
    });
  });
}
