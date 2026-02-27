import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import type { PageContext } from "./types";

const PageContextContext = createContext<PageContext>(null!);

function getInitialPageContext(): PageContext | null {
  // On server, we'll get the pageContext from props
  if (typeof window === "undefined") {
    return null;
  }
  
  // On client, read from the JSON script tag
  const scriptTag = document.getElementById("__VIKE_PAGE_CONTEXT__");
  if (scriptTag?.textContent) {
    try {
      return JSON.parse(scriptTag.textContent);
    } catch {
      // Ignore parse errors
    }
  }
  return null;
}

export function PageContextProvider({
  pageContext: serverPageContext,
  children,
}: {
  pageContext: PageContext;
  children: ReactNode;
}) {
  const [pageContext, setPageContext] = useState<PageContext>(() => {
    // Use server-provided context if available (SSR)
    if (serverPageContext) {
      return serverPageContext;
    }
    // Otherwise try to get from client (hydration)
    return getInitialPageContext() || { urlOriginal: "", locale: "en", user: null };
  });

  // On hydration, update from the JSON script tag
  useEffect(() => {
    const clientContext = getInitialPageContext();
    if (clientContext && !serverPageContext) {
      setPageContext(clientContext);
    }
  }, [serverPageContext]);

  return (
    <PageContextContext.Provider value={pageContext}>
      {children}
    </PageContextContext.Provider>
  );
}

export function usePageContext() {
  return useContext(PageContextContext);
}
