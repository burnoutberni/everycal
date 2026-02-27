import { renderToString } from "react-dom/server";
import { escapeInject, dangerouslySkipEscape } from "vike/server";
import { PageShell } from "./PageShell";
import type { PageContext } from "./types";
import type { OnRenderHtmlAsync } from "vike/types";

export { onRenderHtml };

const onRenderHtml: OnRenderHtmlAsync = async (pageContext): ReturnType<OnRenderHtmlAsync> => {
  const pageContextTyped = pageContext as PageContext;
  const { documentProps, pageProps, locale, user } = pageContextTyped;

  const title = documentProps?.title || "EveryCal";
  const description = documentProps?.description || "Federated event calendar — self-host, discover events, connect via ActivityPub.";
  const ogImage = documentProps?.ogImage || "/og-image.png";

  const pageHtml = renderToString(
    <PageShell pageContext={pageContextTyped} />
  );

  // Serialize pageContext for client-side hydration
  const pageContextSerialized = JSON.stringify({
    locale,
    user,
    pageProps,
  }).replace(/</g, '\\u003C');

  const documentHtml = escapeInject`<!DOCTYPE html>
<html lang="${locale || "en"}">
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
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${ogImage}" />
  </head>
  <body>
    <div id="root">${dangerouslySkipEscape(pageHtml)}</div>
    <script id="__VIKE_PAGE_CONTEXT__" type="application/json">${dangerouslySkipEscape(pageContextSerialized)}</script>
  </body>
</html>`;

  return {
    documentHtml,
    pageContextSerialized: {
      locale,
      user,
      pageProps,
    },
  };
};
