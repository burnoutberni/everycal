import type { ReactNode } from "react";
import { PageContextProvider } from "./PageContextProvider";
import { App } from "../App";
import { AuthProvider } from "../hooks/useAuth";
import type { PageContext } from "./types";

export function PageShell({
  pageContext,
}: {
  pageContext: PageContext;
}) {
  return (
    <PageContextProvider pageContext={pageContext}>
      <AuthProvider initialUser={pageContext.user}>
        <App />
      </AuthProvider>
    </PageContextProvider>
  );
}
