import React, { createContext, useContext } from "react";
import type { PageContext } from "vike/types";
import { isAppBootstrap, isAppLocale, type AppBootstrap, type AppLocale } from "@everycal/core";
import type { SsrInitialData } from "@everycal/core";

export type EverycalPageContext = PageContext & {
  bootstrap?: AppBootstrap;
  data?: {
    bootstrap?: unknown;
  };
  initialData?: SsrInitialData;
  headersOriginal?: Record<string, string | string[] | undefined>;
};

const Context = createContext<EverycalPageContext | undefined>(undefined);

export function PageContextProvider({
  pageContext,
  children,
}: {
  pageContext: EverycalPageContext;
  children: React.ReactNode;
}) {
  return <Context.Provider value={pageContext}>{children}</Context.Provider>;
}

export function usePageContext() {
  const pageContext = useContext(Context);
  if (!pageContext) {
    throw new Error(
      "<PageContextProvider> is needed for usePageContext()"
    );
  }
  return pageContext;
}

export function useOptionalPageContext() {
  return useContext(Context);
}

export function getPageContextBootstrap(pageContext: EverycalPageContext | undefined): AppBootstrap | undefined {
  const directBootstrap = pageContext?.bootstrap;
  const dataBootstrap = pageContext?.data?.bootstrap;
  const bootstrap = directBootstrap ?? dataBootstrap;
  return isAppBootstrap(bootstrap) ? bootstrap : undefined;
}

export function useBootstrap() {
  return getPageContextBootstrap(usePageContext());
}

export function readBootstrapFromDom(): AppBootstrap | undefined {
  if (typeof document === "undefined") return undefined;
  const el = document.getElementById("everycal-bootstrap");
  if (!el?.textContent) return undefined;
  try {
    const parsed = JSON.parse(el.textContent) as unknown;
    return isAppBootstrap(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readStartupLocaleFromDom(): AppLocale | undefined {
  if (typeof document === "undefined") return undefined;
  const el = document.getElementById("everycal-startup-locale");
  if (!el?.textContent) return undefined;
  try {
    const parsed = JSON.parse(el.textContent) as unknown;
    return typeof parsed === "string" && isAppLocale(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
