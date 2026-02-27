/**
 * Client entry point - works for both SPA and SSR hydration.
 */

import "./i18n";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./hooks/useAuth";
import "./index.css";

const rootElement = document.getElementById("root");
const ssrData = (window as any).__SSR_DATA__;

// Check if there's already content from SSR
if (rootElement && rootElement.innerHTML && rootElement.innerHTML.trim() !== "") {
  // SSR was done - hydrate the existing content
  hydrateRoot(
    rootElement,
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>
  );
} else {
  // No SSR - render from scratch
  createRoot(rootElement!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>
  );
}
