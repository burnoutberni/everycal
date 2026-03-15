import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./hooks/useAuth";
import { initI18n } from "./i18n";
import { ThemeProvider } from "./hooks/useTheme";
import { applyThemeToDocument, readStoredThemePreference } from "./lib/theme";
import "./index.css";

applyThemeToDocument(readStoredThemePreference());

void initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </StrictMode>
  );
});
