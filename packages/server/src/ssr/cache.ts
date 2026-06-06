import type { AppLocale } from "@everycal/core";

export type CachedSsrResponse = {
  body: string;
  statusCode: number;
  headers: Array<[string, string]>;
  expiresAt: number;
};

export function buildSsrCacheKey(url: string, locale: AppLocale, authenticated: boolean): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}::locale=${locale}::auth=${authenticated ? "yes" : "no"}`;
  } catch {
    return `${url}::locale=${locale}::auth=${authenticated ? "yes" : "no"}`;
  }
}

export function getCachedSsrResponse(cache: Map<string, CachedSsrResponse>, key: string): CachedSsrResponse | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return cached;
}

export function cacheAnonymousSsrResponse(input: {
  cache: Map<string, CachedSsrResponse>;
  key: string;
  body: string;
  statusCode: number;
  headers: Array<[string, string]>;
  ttlMs: number;
}): void {
  if (input.ttlMs <= 0) return;
  const cacheableHeaders = input.headers.filter(([name]) => name.toLowerCase() !== "set-cookie");
  input.cache.set(input.key, {
    body: input.body,
    statusCode: input.statusCode,
    headers: cacheableHeaders,
    expiresAt: Date.now() + input.ttlMs,
  });
}
