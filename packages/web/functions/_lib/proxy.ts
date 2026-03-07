export async function proxyToApi(request: Request, env: { API_ORIGIN?: string }, pathOverride?: string): Promise<Response> {
  const apiOrigin = env.API_ORIGIN || env.VITE_API_ORIGIN;
  if (!apiOrigin) {
    return new Response(JSON.stringify({ error: "API_ORIGIN is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const reqUrl = new URL(request.url);
  const upstreamUrl = new URL(pathOverride || reqUrl.pathname + reqUrl.search, apiOrigin);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", reqUrl.host);
  headers.set("x-forwarded-proto", reqUrl.protocol.replace(":", ""));

  return fetch(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}
