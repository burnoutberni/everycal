import type { User, CalEvent } from "../lib/api";

export interface PageContext {
  urlOriginal: string;
  urlParsed?: {
    pathname: string;
    search: Record<string, string | undefined>;
  };
  locale: string;
  user: User | null;
  pageProps?: {
    profile?: User;
    profileEvents?: CalEvent[];
    event?: CalEvent;
    error?: string;
  };
  documentProps?: {
    title: string;
    description: string;
    ogImage?: string;
  };
}

declare global {
  interface Window {
    __VIKE_PAGE_CONTEXT__?: PageContext;
  }
}
