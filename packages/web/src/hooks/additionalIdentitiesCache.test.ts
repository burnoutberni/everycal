import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  identities: {
    list: vi.fn(),
  },
}));

import { identities as identitiesApi } from "../lib/api";
import {
  getCachedAdditionalIdentityCount,
  invalidateAdditionalIdentitiesCache,
  loadAdditionalIdentityCount,
} from "./additionalIdentitiesCache";

describe("additional identities cache", () => {
  beforeEach(() => {
    invalidateAdditionalIdentitiesCache();
    vi.mocked(identitiesApi.list).mockReset();
  });

  it("caches identity counts by user id", async () => {
    vi.mocked(identitiesApi.list)
      .mockResolvedValueOnce({ identities: [{ id: "identity1" }] as any })
      .mockResolvedValueOnce({ identities: [] as any });

    const first = await loadAdditionalIdentityCount("user-a");
    const second = await loadAdditionalIdentityCount("user-a");
    const otherUser = await loadAdditionalIdentityCount("user-b");

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(otherUser).toBe(0);
    expect(vi.mocked(identitiesApi.list)).toHaveBeenCalledTimes(2);
    expect(getCachedAdditionalIdentityCount("user-a")).toBe(1);
    expect(getCachedAdditionalIdentityCount("user-b")).toBe(0);
  });

  it("invalidates per-user and global cache", async () => {
    vi.mocked(identitiesApi.list)
      .mockResolvedValueOnce({ identities: [{ id: "identity1" }] as any })
      .mockResolvedValueOnce({ identities: [{ id: "identity2" }, { id: "identity3" }] as any })
      .mockResolvedValueOnce({ identities: [] as any });

    await loadAdditionalIdentityCount("user-a");
    await loadAdditionalIdentityCount("user-b");

    invalidateAdditionalIdentitiesCache("user-a");
    const userAAfterInvalidate = await loadAdditionalIdentityCount("user-a");
    expect(userAAfterInvalidate).toBe(0);

    invalidateAdditionalIdentitiesCache();
    expect(getCachedAdditionalIdentityCount("user-a")).toBeUndefined();
    expect(getCachedAdditionalIdentityCount("user-b")).toBeUndefined();
  });
});
