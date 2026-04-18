type OgJob = {
  key: string;
  run: () => Promise<void>;
};

const parsedConcurrency = Number.parseInt(process.env.OG_JOB_CONCURRENCY || "3", 10);
let concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 3;

const pendingJobsByKey = new Map<string, OgJob>();
const pendingOrder: string[] = [];
const deferredJobsByKey = new Map<string, OgJob>();

let activeJobs = 0;
let coalescedJobs = 0;
let draining = false;
let lastDepthLog = 0;

function queueDepth(): number {
  return activeJobs + pendingJobsByKey.size + deferredJobsByKey.size;
}

function logQueueDepthIfNeeded(): void {
  const depth = queueDepth();
  const threshold = 10;

  if (depth >= threshold && depth !== lastDepthLog) {
    console.warn(
      `[OG] Queue depth ${depth} (active=${activeJobs}, pending=${pendingJobsByKey.size}, deferred=${deferredJobsByKey.size}, coalesced=${coalescedJobs})`
    );
    lastDepthLog = depth;
  } else if (depth < threshold) {
    lastDepthLog = 0;
  }
}

function logCoalescingIfNeeded(): void {
  if (coalescedJobs > 0 && coalescedJobs % 25 === 0) {
    console.warn(`[OG] Coalesced ${coalescedJobs} OG jobs so far`);
  }
}

function queuePendingJob(job: OgJob): void {
  if (!pendingJobsByKey.has(job.key)) {
    pendingOrder.push(job.key);
  }
  pendingJobsByKey.set(job.key, job);
}

function scheduleDrain(): void {
  if (draining) return;
  draining = true;
  queueMicrotask(runDrain);
}

function runDrain(): void {
  draining = false;

  while (activeJobs < concurrency) {
    let nextKey: string | undefined;
    while (pendingOrder.length > 0) {
      const key = pendingOrder.shift();
      if (!key) continue;
      if (pendingJobsByKey.has(key)) {
        nextKey = key;
        break;
      }
    }

    if (!nextKey) {
      logQueueDepthIfNeeded();
      return;
    }

    const nextJob = pendingJobsByKey.get(nextKey);
    if (!nextJob) continue;

    pendingJobsByKey.delete(nextKey);
    activeJobs += 1;

    void nextJob
      .run()
      .catch((err) => {
        console.error(`[OG] Queued OG job failed for key ${nextKey}:`, err);
      })
      .finally(() => {
        activeJobs -= 1;
        const deferred = deferredJobsByKey.get(nextKey);
        if (deferred) {
          deferredJobsByKey.delete(nextKey);
          queuePendingJob(deferred);
        }
        logQueueDepthIfNeeded();
        scheduleDrain();
      });
  }

  logQueueDepthIfNeeded();
}

export function enqueueOgJob(key: string, run: () => Promise<void>): void {
  const job: OgJob = { key, run };

  if (pendingJobsByKey.has(key)) {
    pendingJobsByKey.set(key, job);
    coalescedJobs += 1;
    logCoalescingIfNeeded();
  } else if (deferredJobsByKey.has(key)) {
    deferredJobsByKey.set(key, job);
    coalescedJobs += 1;
    logCoalescingIfNeeded();
  } else {
    queuePendingJob(job);
  }

  logQueueDepthIfNeeded();
  scheduleDrain();
}

export function getOgJobQueueStats(): {
  active: number;
  pending: number;
  deferred: number;
  coalesced: number;
  depth: number;
  concurrency: number;
} {
  return {
    active: activeJobs,
    pending: pendingJobsByKey.size,
    deferred: deferredJobsByKey.size,
    coalesced: coalescedJobs,
    depth: queueDepth(),
    concurrency,
  };
}

export function __resetOgJobQueueForTests(): void {
  pendingJobsByKey.clear();
  pendingOrder.length = 0;
  deferredJobsByKey.clear();
  activeJobs = 0;
  coalescedJobs = 0;
  draining = false;
  lastDepthLog = 0;
}

export function __setOgJobQueueConcurrencyForTests(value: number): void {
  concurrency = Math.max(1, Math.floor(value));
}

export async function __waitForOgJobQueueIdleForTests(): Promise<void> {
  while (queueDepth() > 0 || draining) {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1);
    });
  }
}
