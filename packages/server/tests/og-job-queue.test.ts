import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetOgJobQueueForTests,
  __setOgJobQueueConcurrencyForTests,
  __waitForOgJobQueueIdleForTests,
  enqueueOgJob,
  getOgJobQueueStats,
} from "../src/lib/og-job-queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGate(): { wait: Promise<void>; open: () => void } {
  let release: (() => void) | null = null;
  return {
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    open: () => release?.(),
  };
}

describe("og job queue", () => {
  beforeEach(() => {
    __resetOgJobQueueForTests();
    __setOgJobQueueConcurrencyForTests(3);
  });

  it("caps concurrent jobs at configured concurrency", async () => {
    __setOgJobQueueConcurrencyForTests(2);

    let running = 0;
    let maxRunning = 0;

    for (let i = 0; i < 8; i += 1) {
      enqueueOgJob(`event-${i}`, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await delay(20);
        running -= 1;
      });
    }

    await __waitForOgJobQueueIdleForTests();

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(getOgJobQueueStats().depth).toBe(0);
  });

  it("coalesces repeated jobs for the same event key", async () => {
    __setOgJobQueueConcurrencyForTests(1);

    const firstStarted = createGate();
    const releaseFirst = createGate();
    const calls: string[] = [];

    enqueueOgJob("remote:event-a", async () => {
      calls.push("first");
      firstStarted.open();
      await releaseFirst.wait;
    });

    await firstStarted.wait;

    enqueueOgJob("remote:event-a", async () => {
      calls.push("second");
    });

    enqueueOgJob("remote:event-a", async () => {
      calls.push("third");
    });

    enqueueOgJob("remote:event-b", async () => {
      calls.push("other");
    });

    releaseFirst.open();
    await __waitForOgJobQueueIdleForTests();

    expect(calls[0]).toBe("first");
    expect(calls).toContain("other");
    expect(calls).toContain("third");
    expect(calls).not.toContain("second");
    expect(getOgJobQueueStats().coalesced).toBe(2);
    expect(getOgJobQueueStats().depth).toBe(0);
  });

  it("defers and coalesces jobs enqueued for an active key", async () => {
    __setOgJobQueueConcurrencyForTests(2);

    const firstStarted = createGate();
    const releaseFirst = createGate();
    const calls: string[] = [];
    let runningForKey = 0;
    let maxRunningForKey = 0;

    enqueueOgJob("remote:event-a", async () => {
      calls.push("first");
      runningForKey += 1;
      maxRunningForKey = Math.max(maxRunningForKey, runningForKey);
      firstStarted.open();
      await releaseFirst.wait;
      runningForKey -= 1;
    });

    await firstStarted.wait;

    enqueueOgJob("remote:event-a", async () => {
      calls.push("second");
      runningForKey += 1;
      maxRunningForKey = Math.max(maxRunningForKey, runningForKey);
      await delay(5);
      runningForKey -= 1;
    });

    enqueueOgJob("remote:event-a", async () => {
      calls.push("third");
      runningForKey += 1;
      maxRunningForKey = Math.max(maxRunningForKey, runningForKey);
      await delay(5);
      runningForKey -= 1;
    });

    enqueueOgJob("remote:event-b", async () => {
      calls.push("other");
      await delay(5);
    });

    releaseFirst.open();
    await __waitForOgJobQueueIdleForTests();

    expect(maxRunningForKey).toBe(1);
    expect(calls[0]).toBe("first");
    expect(calls).toContain("other");
    expect(calls).toContain("third");
    expect(calls).not.toContain("second");
    expect(getOgJobQueueStats().coalesced).toBe(2);
    expect(getOgJobQueueStats().depth).toBe(0);
  });
});
