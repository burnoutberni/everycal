import type { MiddlewareHandler } from "hono";

const EMBED_SCRIPT_PATH = "/embed/show-on-everycal.js";

function isCrossOriginEmbedScriptRequest(path: string, method: string): boolean {
  if (path !== EMBED_SCRIPT_PATH) return false;
  return method === "GET" || method === "HEAD";
}

export function createEmbedCorpMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    if (isCrossOriginEmbedScriptRequest(c.req.path, c.req.method)) {
      c.header("Cross-Origin-Resource-Policy", "cross-origin");
      c.header("Access-Control-Allow-Origin", "*");
      return;
    }

    c.header("Cross-Origin-Resource-Policy", "same-origin");
  };
}
