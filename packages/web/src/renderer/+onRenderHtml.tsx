import React from "react";
import { renderToString } from "react-dom/server";
import { escapeInject, dangerouslySkipEscape } from "vike/server";
import { Router } from "wouter";
import { App } from "../App";
import { AuthProvider } from "../hooks/useAuth";
import { getPageContextBootstrap, PageContextProvider } from "./PageContext";
import type { PageContextServer } from "vike/types";
import { i18n, initI18n } from "../i18n";
import { bootstrapViewerToUser } from "@everycal/core";
import type { EverycalPageContext } from "./PageContext";
import { isAppBootstrap } from "@everycal/core";

type SeoData = {
  title?: string;
  description?: string;
  ogImageUrl?: string | null;
};

export async function onRenderHtml(pageContext: PageContextServer) {
  const { urlPathname } = pageContext;
  const typedPageContext = pageContext as EverycalPageContext;
  const bootstrap = await resolveBootstrapForRender(typedPageContext);
  const startupLocale = bootstrap?.locale || "en";
  const initialUser = bootstrapViewerToUser(bootstrap?.viewer);
  await initI18n(startupLocale);

  // Render the app using wouter's SSR mode
  const appHtml = renderToString(
    <React.StrictMode>
      <PageContextProvider pageContext={typedPageContext}>
        <AuthProvider initialUser={initialUser} initialBootstrap={bootstrap}>
          <Router ssrPath={urlPathname}>
            <App />
          </Router>
        </AuthProvider>
      </PageContextProvider>
    </React.StrictMode>
  );

  // Derive OG tags and titles from data
  // data comes from the specific page's +data.ts
  const seo = typedPageContext.data as SeoData | undefined;
  const title = seo?.title || "EveryCal";
  const desc = seo?.description || "A calendar for everyone.";
  const ogImageUrl = seo?.ogImageUrl || "";
  const serializedBootstrap = bootstrap
    ? JSON.stringify(bootstrap).replace(/</g, "\\u003c")
    : "";
  const serializedStartupLocale = JSON.stringify(startupLocale).replace(/</g, "\\u003c");

  if (process.env.NODE_ENV !== "production" && process.env.SSR_BOOTSTRAP_DEBUG === "1") {
    console.log(
      `[SSR][renderer] bootstrap=${bootstrap ? "present" : "missing"} startupLocale=${startupLocale} i18n=${i18n.language || "unknown"}`
    );
  }

  return escapeInject`<!DOCTYPE html>
    <html lang={startupLocale}>
      <head>
        <meta charset="UTF-8" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" />

        <title>${title}</title>
        <meta name="description" content="${desc}" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${desc}" />
        <meta name="twitter:title" content="${title}" />
        <meta name="twitter:description" content="${desc}" />
        <meta name="twitter:card" content="summary_large_image" />

        ${ogImageUrl ? escapeInject`<meta property="og:image" content="${ogImageUrl}" />
        <meta name="twitter:image" content="${ogImageUrl}" />` : ""}

        <!-- Disable Vike client routing to let Wouter handle SPA natively -->
        <meta name="vike-client-routing" content="false" />
      </head>
      <body>
        <div id="root">${dangerouslySkipEscape(appHtml)}</div>
        <script id="everycal-startup-locale" type="application/json">${dangerouslySkipEscape(serializedStartupLocale)}</script>
        ${serializedBootstrap
          ? escapeInject`<script id="everycal-bootstrap" type="application/json">${dangerouslySkipEscape(serializedBootstrap)}</script>`
          : ""}
      </body>
    </html>`;
}

async function resolveBootstrapForRender(pageContext: EverycalPageContext) {
  const existing = getPageContextBootstrap(pageContext);
  if (existing) return existing;

  const headersOriginal = pageContext.headersOriginal || {};
  const cookie = typeof headersOriginal.cookie === "string" ? headersOriginal.cookie : undefined;
  const acceptLanguage =
    typeof headersOriginal["accept-language"] === "string"
      ? headersOriginal["accept-language"]
      : undefined;

  const port = process.env.PORT || "3000";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
      },
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const parsed = await response.json();
    return isAppBootstrap(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
