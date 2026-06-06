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
  maxEntries?: number;
}): void {
  if (input.ttlMs <= 0) return;
  const cacheableHeaders = input.headers.filter(([name]) => name.toLowerCase() !== "set-cookie");
  input.cache.set(input.key, {
    body: input.body,
    statusCode: input.statusCode,
    headers: cacheableHeaders,
    expiresAt: Date.now() + input.ttlMs,
  });
  // Evict oldest entries if cache exceeds max size
  const maxEntries = input.maxEntries ?? 500;
  if (input.cache.size > maxEntries) {
    const entries = [...input.cache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toRemove = entries.slice(0, entries.length - maxEntries);
    for (const [key] of toRemove) input.cache.delete(key);
  }
}
