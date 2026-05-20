type BoundedLogLevel = "log" | "warn";

type BoundedLogState = {
  windowStartedAtMs: number;
  suppressedCount: number;
  windowMs: number;
};

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;
const boundedLogState = new Map<string, BoundedLogState>();

let boundedLogMaxEntries = DEFAULT_MAX_ENTRIES;

function nowMs(): number {
  return Date.now();
}

export function boundedConsoleLog(
  key: string,
  message: string,
  options: { level?: BoundedLogLevel; windowMs?: number } = {},
): void {
  const level = options.level ?? "warn";
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const currentTimeMs = nowMs();

  pruneStaleEntries(currentTimeMs, key);

  const existing = boundedLogState.get(key);

  if (!existing) {
    setWithLru(key, { windowStartedAtMs: currentTimeMs, suppressedCount: 0, windowMs });
    console[level](message);
    return;
  }

  existing.windowMs = windowMs;
  setWithLru(key, existing);

  const elapsedMs = currentTimeMs - existing.windowStartedAtMs;
  if (elapsedMs < windowMs) {
    existing.suppressedCount += 1;
    return;
  }

  const suffix = existing.suppressedCount > 0
    ? ` (suppressed ${existing.suppressedCount} similar logs in last ${Math.round(windowMs / 1000)}s)`
    : "";
  console[level](`${message}${suffix}`);
  setWithLru(key, { windowStartedAtMs: currentTimeMs, suppressedCount: 0, windowMs });
}

function setWithLru(key: string, state: BoundedLogState): void {
  boundedLogState.delete(key);
  boundedLogState.set(key, state);

  while (boundedLogState.size > boundedLogMaxEntries) {
    const oldestKey = boundedLogState.keys().next().value;
    if (!oldestKey) {
      break;
    }
    boundedLogState.delete(oldestKey);
  }
}

function pruneStaleEntries(currentTimeMs: number, activeKey: string): void {
  for (const [stateKey, state] of boundedLogState) {
    if (stateKey === activeKey) {
      continue;
    }
    if (currentTimeMs - state.windowStartedAtMs > state.windowMs) {
      boundedLogState.delete(stateKey);
    }
  }
}

export function resetBoundedLogStateForTests(): void {
  boundedLogState.clear();
  boundedLogMaxEntries = DEFAULT_MAX_ENTRIES;
}

export function configureBoundedLogForTests(options: { maxEntries?: number } = {}): void {
  boundedLogMaxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
}

export function getBoundedLogStateKeysForTests(): string[] {
  return [...boundedLogState.keys()];
}
