import { cors } from "hono/cors";

const PUBLIC_FEED_PATH_RE = /^\/api\/v1\/feeds\/([^/]+)\.(json|ics)$/;

function isPublicEmbeddableFeedRequest(path: string, method: string): boolean {
  if (method !== "GET" && method !== "OPTIONS") return false;
  const match = path.match(PUBLIC_FEED_PATH_RE);
  if (!match) return false;
  const [, username] = match;
  return username !== "calendar";
}

export function createApiCorsMiddleware(allowedOrigins: string[]) {
  const strictCors = cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : ""),
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
    return strictCors(c, next);
  };
}
