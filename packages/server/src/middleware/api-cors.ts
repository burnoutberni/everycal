import { cors } from "hono/cors";
import { getBaseUrl } from "../lib/base-url.js";

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

  let canonicalOrigin: string | null = null;
  try {
    canonicalOrigin = new URL(getBaseUrl()).origin;
  } catch {
    // Ignore
  }

  return async (c: Parameters<typeof strictCors>[0], next: Parameters<typeof strictCors>[1]) => {
    if (isPublicEmbeddableFeedRequest(c.req.path, c.req.method)) {
      return publicFeedCors(c, next);
    }

    const origin = c.req.header("origin");
    if (origin) {
      if (c.req.path.startsWith("/api/v1/admin")) {
        let isAllowed = false;
        if (canonicalOrigin && origin === canonicalOrigin) {
          isAllowed = true;
        } else if (process.env.NODE_ENV !== "production") {
          if (origin === "http://localhost:5173") {
            isAllowed = true;
          } else if (process.env.BASE_URL) {
            try {
              if (origin === new URL(process.env.BASE_URL).origin) {
                isAllowed = true;
              }
            } catch {}
          }
        }

        if (isAllowed) {
          return strictCors(c, next);
        }
      } else if (allowedOriginSet.has(origin)) {
        return strictCors(c, next);
      }
    }

    await next();
    return undefined;
  };
}
