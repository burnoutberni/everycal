/**
 * SSR Data Store - stores data to be passed from server to client during SSR.
 * Uses a global store to hold data during the request lifecycle.
 */

const store = new Map<string, any>();

export function getStore(): Map<string, any> {
  return store;
}

export function setStoreData(key: string, value: any): void {
  store.set(key, value);
}

export function getStoreData<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function clearStore(): void {
  store.clear();
}

/**
 * Extract user from session cookie for SSR
 */
export async function getUserFromSession(
  cookieHeader: string | null,
  baseUrl: string
): Promise<any | null> {
  if (!cookieHeader) return null;
  
  try {
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: {
        Cookie: cookieHeader,
      },
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
