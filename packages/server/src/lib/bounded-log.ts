type BoundedLogLevel = "log" | "warn";

type BoundedLogState = {
  windowStartedAtMs: number;
  suppressedCount: number;
};

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const boundedLogState = new Map<string, BoundedLogState>();

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
  const existing = boundedLogState.get(key);

  if (!existing) {
    boundedLogState.set(key, { windowStartedAtMs: currentTimeMs, suppressedCount: 0 });
    console[level](message);
    return;
  }

  const elapsedMs = currentTimeMs - existing.windowStartedAtMs;
  if (elapsedMs < windowMs) {
    existing.suppressedCount += 1;
    return;
  }

  const suffix = existing.suppressedCount > 0
    ? ` (suppressed ${existing.suppressedCount} similar logs in last ${Math.round(windowMs / 1000)}s)`
    : "";
  console[level](`${message}${suffix}`);
  boundedLogState.set(key, { windowStartedAtMs: currentTimeMs, suppressedCount: 0 });
}

export function resetBoundedLogStateForTests(): void {
  boundedLogState.clear();
}
