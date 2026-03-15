import { cors } from "hono/cors";

const PUBLIC_FEED_PATH_RE = /^\/api\/v1\/feeds\/([^/]+)\.(json|ics)$/;

function isPublicEmbeddableFeedRequest(path: string, method: string): boolean {
  if (method !== "GET" && method !== "OPTIONS") return false;
  return PUBLIC_FEED_PATH_RE.test(path);
}

export function createApiCorsMiddleware(allowedOrigins: string[]) {
  const allowedOriginSet = new Set(allowedOrigins.filter(Boolean));

  const strictCors = cors({
    origin: (origin) => origin,
    credentials: true,
  });

  const publicFeedCors = cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  });

  return async (c: Parameters<typeof strictCors>[0], next: Parameters<typeof strictCors>[1]) => {
    if (isPublicEmbeddableFeedRequest(c.req.path, c.req.method)) {
      return publicFeedCors(c, next);
    }

    const origin = c.req.header("origin");
    if (origin && allowedOriginSet.has(origin)) {
      return strictCors(c, next);
    }

    await next();
    return undefined;
  };
}
