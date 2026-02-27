import type { Config } from "vike/types";

export default {
  // Don't use ssr preset since we're doing custom rendering
  meta: {
    documentProps: {
      env: { server: true, client: true },
    },
    pageProps: {
      env: { server: true, client: true },
    },
    locale: {
      env: { server: true, client: true },
    },
    user: {
      env: { server: true, client: true },
    },
  },
} satisfies Config;
