/**
 * Server-side entry point for SSR with vike.
 * This renders the React app to HTML for SSR routes.
 */

import { renderToString } from "react-dom/server";
import { escapeInject, dangerouslySkipEscape } from "vike/server";
import { getStore } from "./src/lib/ssr-store";
import { createI18nServer, getLocaleFromRequest } from "./src/lib/i18n-server";
import { generateOgTags } from "./src/lib/og-tags";

export async function render(pageContext: any) {
  const { url, user, cookies } = pageContext;
  
  // Create a request-like object for locale detection
  const request = {
    headers: {
      get: (header: string) => {
        if (header.toLowerCase() === "accept-language") {
          return pageContext.headers?.["accept-language"];
        }
        return pageContext.headers?.[header.toLowerCase()];
      },
    },
  };
  
  const locale = getLocaleFromRequest(request as any);
  const i18n = createI18nServer(locale);
  
  // Get page data from the data function
  const data = pageContext.data;
  const pageProps = pageContext.pageProps || {};
  
  // Build the page component with data
  const { Page, pageExports } = pageContext;
  
  // Get the page component from vike's pageContext
  const Layout = pageContext.Layout || DefaultLayout;
  const { title, description, ogImage, ogImageType } = generateOgTags(pageContext, locale);
  
  // Render the page with React
  const pageHtml = pageContext.ReactServer
    ? pageContext.ReactServer
    : renderToString(
        <Layout pageContext={pageContext}>
          <Page {...pageProps} />
        </Layout>
      );

  const documentHtml = escapeInject`<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${ogImage || "/og-image.png"}" />
    ${ogImageType ? `<meta property="og:image:type" content="${ogImageType}" />` : ''}
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${ogImage || "/og-image.png"}" />
    <script>window.__SSR_DATA__ = ${JSON.stringify(data)};</script>
  </head>
  <body>
    <div id="root">${dangerouslySkipEscape(pageHtml)}</div>
  </body>
</html>`;

  return {
    documentHtml,
    pageContext: {
      locale,
      user,
    },
  };
}

function DefaultLayout({ children, pageContext }: { children: any; pageContext: any }) {
  return <>{children}</>;
}
