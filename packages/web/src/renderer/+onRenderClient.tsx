import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { Router } from "wouter";
import { App } from "../App";
import { AuthProvider } from "../hooks/useAuth";
import { bootstrapViewerToUser, isAppLocale } from "@everycal/core";
import {
  getPageContextBootstrap,
  PageContextProvider,
  readBootstrapFromDom,
  readStartupLocaleFromDom,
  type EverycalPageContext,
} from "./PageContext";
import type { PageContextClient } from "vike/types";
import { initI18n } from "../i18n";
import "../index.css";
import { ThemeProvider } from "../hooks/useTheme";

function resolveHydrationLocale(pageBootstrapLocale?: "en" | "de"): "en" | "de" {
  if (pageBootstrapLocale) return pageBootstrapLocale;
  const fromDom = readStartupLocaleFromDom();
  if (fromDom) return fromDom;
  if (typeof document !== "undefined") {
    const docLang = document.documentElement.lang;
    if (docLang === "en" || docLang === "de" || isAppLocale(docLang)) return docLang as "en" | "de";
  }
  return "en";
}

export async function onRenderClient(pageContext: PageContextClient) {
  const typedPageContext = pageContext as EverycalPageContext;
  const bootstrapFromPageContext = getPageContextBootstrap(typedPageContext);
  const bootstrapFromDom = readBootstrapFromDom();
  const bootstrap = bootstrapFromPageContext ?? bootstrapFromDom;
  const startupLocaleFromDom = readStartupLocaleFromDom();
  const startupLocale = bootstrap?.locale || startupLocaleFromDom || resolveHydrationLocale(undefined);

  if (
    pageContext.isHydration &&
    !bootstrapFromPageContext &&
    !bootstrapFromDom &&
    !startupLocaleFromDom &&
    process.env.NODE_ENV !== "production"
  ) {
    console.warn(
      `[Hydration] Missing bootstrap transport, using html fallback locale=${startupLocale}`
    );
  }

  await initI18n(startupLocale);
  const initialUser = bootstrapViewerToUser(bootstrap?.viewer);

  const app = (
    <React.StrictMode>
      <PageContextProvider pageContext={typedPageContext}>
        <ThemeProvider>
          <AuthProvider initialUser={initialUser} initialBootstrap={bootstrap}>
            <Router>
              <App />
            </Router>
          </AuthProvider>
        </ThemeProvider>
      </PageContextProvider>
    </React.StrictMode>
  );

  const container = document.getElementById("root")!;

  if (pageContext.isHydration) {
    hydrateRoot(container, app);
  } else {
    if (!container.innerHTML) {
      createRoot(container).render(app);
    }
  }
}
