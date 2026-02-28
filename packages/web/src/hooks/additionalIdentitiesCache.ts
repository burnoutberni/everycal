import { identities as identitiesApi } from "../lib/api";

const countCache = new Map<string, number>();
const inflightByUser = new Map<string, Promise<number>>();

export function getCachedAdditionalIdentityCount(userId: string): number | undefined {
  return countCache.get(userId);
}

export function invalidateAdditionalIdentitiesCache(userId?: string): void {
  if (userId) {
    countCache.delete(userId);
    inflightByUser.delete(userId);
    return;
  }
  countCache.clear();
  inflightByUser.clear();
}

export async function loadAdditionalIdentityCount(userId: string): Promise<number> {
  const cached = countCache.get(userId);
  if (cached !== undefined) return cached;

  const inflight = inflightByUser.get(userId);
  if (inflight) return inflight;

  const request = identitiesApi
    .list()
    .then((res) => {
      const count = res.identities.length;
      countCache.set(userId, count);
      return count;
    })
    .finally(() => {
      inflightByUser.delete(userId);
    });

  inflightByUser.set(userId, request);
  return request;
}
