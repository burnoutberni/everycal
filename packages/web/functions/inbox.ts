import { proxyToApi } from "./_lib/proxy";

export const onRequest: PagesFunction<{ API_ORIGIN?: string; VITE_API_ORIGIN?: string }> = async (context) => {
  return proxyToApi(context.request, context.env, "/inbox");
};
