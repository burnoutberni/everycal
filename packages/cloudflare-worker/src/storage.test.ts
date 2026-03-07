import { describe, expect, it, vi } from "vitest";
import { CloudflareStorage } from "./storage";

describe("CloudflareStorage", () => {
  it("writes uploads to R2 and metadata to D1", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const first = vi.fn(async () => null);
    const all = vi.fn(async () => ({ results: [] }));
    const bind = vi.fn(() => ({ run, first, all }));
    const prepare = vi.fn(() => ({ bind }));
    const put = vi.fn(async () => undefined);

    const storage = new CloudflareStorage({
      BASE_URL: "https://calendar.example",
      DB: { prepare } as unknown as D1Database,
      UPLOADS: { put } as unknown as R2Bucket,
    });

    const body = new TextEncoder().encode("hello").buffer;
    const url = await storage.putUpload({ key: "avatar.png", contentType: "image/png", body });

    expect(url).toBe("https://calendar.example/uploads/avatar.png");
    expect(put).toHaveBeenCalledWith("avatar.png", body, { httpMetadata: { contentType: "image/png" } });
    expect(prepare).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  it("follows and unfollows remote actors", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const first = vi.fn(async () => null);
    const all = vi.fn(async () => ({ results: [] }));
    const bind = vi.fn(() => ({ run, first, all }));
    const prepare = vi.fn(() => ({ bind }));

    const storage = new CloudflareStorage({
      BASE_URL: "https://calendar.example",
      DB: { prepare } as unknown as D1Database,
      UPLOADS: { put: vi.fn() } as unknown as R2Bucket,
    });

    await storage.followRemoteActor("acct-1", {
      uri: "https://remote.example/users/alice",
      username: "alice",
      displayName: "Alice",
      domain: "remote.example",
      inbox: "https://remote.example/inbox",
      iconUrl: null,
    });
    await storage.unfollowRemoteActor("acct-1", "https://remote.example/users/alice");

    expect(prepare).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("maps followed remote actors", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const first = vi.fn(async () => null);
    const all = vi.fn(async () => ({
      results: [
        {
          uri: "https://remote.example/users/alice",
          preferred_username: "alice",
          display_name: "Alice",
          domain: "remote.example",
          inbox: "https://remote.example/inbox",
          icon_url: "https://remote.example/alice.png",
        },
      ],
    }));
    const bind = vi.fn(() => ({ run, first, all }));
    const prepare = vi.fn(() => ({ bind }));

    const storage = new CloudflareStorage({
      BASE_URL: "https://calendar.example",
      DB: { prepare } as unknown as D1Database,
      UPLOADS: { put: vi.fn() } as unknown as R2Bucket,
    });

    const actors = await storage.searchRemoteActors("alice");
    expect(actors).toHaveLength(1);
    expect(actors[0]?.username).toBe("alice");
    expect(actors[0]?.iconUrl).toBe("https://remote.example/alice.png");
  });
});
