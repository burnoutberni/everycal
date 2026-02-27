import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./hooks/useAuth";
import "./index.css";

// SSR hydration or SPA mount
const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

// Get initial context from SSR if available
function getInitialPageContext() {
  const scriptTag = document.getElementById("__VIKE_PAGE_CONTEXT__");
  if (scriptTag?.textContent) {
    try {
      return JSON.parse(scriptTag.textContent);
    } catch {
      // Ignore parse errors
    }
  }
  return undefined;
}

const initialPageContext = getInitialPageContext();
const initialUser = initialPageContext?.user;
const initialLocale = initialPageContext?.locale;

// Initialize i18n with server-provided locale
if (initialLocale) {
  import("./i18n").then(({ initializeLocale }) => {
    initializeLocale(initialLocale);
  });
}

const app = (
  <StrictMode>
    <AuthProvider initialUser={initialUser}>
      <App />
    </AuthProvider>
  </StrictMode>
);

// Hydrate if SSR, otherwise mount
if (initialPageContext) {
  hydrateRoot(container, app);
} else {
  createRoot(container).render(app);
}

