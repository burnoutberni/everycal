import { nanoid } from "nanoid";
import type { DB } from "../db.js";

export type ActorSelectionPayload = {
  actorUri?: string;
  desiredAccountIds?: string[];
};

export class ActorSelectionPayloadError extends Error {
  constructor(message = "Invalid actor selection payload") {
    super(message);
    this.name = "ActorSelectionPayloadError";
  }
}

export type ActorSelectionStatus = "added" | "removed" | "unchanged" | "error";

export type ActorSelectionResult = {
  accountId: string;
  before: boolean;
  after: boolean;
  status: ActorSelectionStatus;
  message?: string;
  remoteStatus?: "none" | "pending" | "delivered" | "failed";
};

type PlanEntry = {
  accountId: string;
  before: boolean;
  after: boolean;
  blockedMessage?: string;
};

type ReconcilePlan = {
  entries: PlanEntry[];
  changes: Array<{ accountId: string; before: boolean; after: boolean }>;
};

export async function readActorSelectionPayload(c: { req: { json: () => Promise<unknown> } }): Promise<ActorSelectionPayload> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {};
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return {};

  const record = body as Record<string, unknown>;
  const payload: ActorSelectionPayload = {};

  if (record.actorUri !== undefined) {
    if (typeof record.actorUri !== "string") {
      throw new ActorSelectionPayloadError();
    }
    payload.actorUri = record.actorUri;
  }

  if (record.desiredAccountIds !== undefined) {
    if (
      !Array.isArray(record.desiredAccountIds)
      || record.desiredAccountIds.some((id) => typeof id !== "string")
    ) {
      throw new ActorSelectionPayloadError();
    }
    payload.desiredAccountIds = record.desiredAccountIds;
  }

  return payload;
}

export function buildActorSelectionPlan(options: {
  actingAccountIds: string[];
  desiredAccountIds: string[];
  activeAccountIds: string[];
  validateTransition?: (entry: { accountId: string; before: boolean; after: boolean }) => string | null;
}): ReconcilePlan {
  const allowed = new Set(options.actingAccountIds);
  const desired = new Set(options.desiredAccountIds.filter((id) => allowed.has(id)));
  const active = new Set(options.activeAccountIds.filter((id) => allowed.has(id)));

  const entries: PlanEntry[] = [];
  const changes: Array<{ accountId: string; before: boolean; after: boolean }> = [];
  for (const accountId of options.actingAccountIds) {
    const before = active.has(accountId);
    const after = desired.has(accountId);
    const blockedMessage = options.validateTransition?.({ accountId, before, after }) || undefined;
    const entry: PlanEntry = { accountId, before, after, blockedMessage };
    entries.push(entry);
    if (before !== after && !blockedMessage) {
      changes.push({ accountId, before, after });
    }
  }
  return { entries, changes };
}

export function applyLocalActorSelection(options: {
  db: DB;
  operation: { actionKind: string; targetType: string; targetId: string; initiatedByAccountId: string };
  plan: ReconcilePlan;
  applyAdd: (accountId: string) => void;
  applyRemove: (accountId: string) => void;
}): { operationId: string; results: ActorSelectionResult[] } {
  const { db, operation, plan } = options;
  const operationId = nanoid(16);
  const resultsByAccount = new Map<string, ActorSelectionResult>();

  for (const entry of plan.entries) {
    if (entry.before === entry.after) {
      resultsByAccount.set(entry.accountId, {
        accountId: entry.accountId,
        before: entry.before,
        after: entry.after,
        status: "unchanged",
        remoteStatus: "none",
      });
      continue;
    }
    if (entry.blockedMessage) {
      resultsByAccount.set(entry.accountId, {
        accountId: entry.accountId,
        before: entry.before,
        after: entry.before,
        status: "error",
        message: entry.blockedMessage,
        remoteStatus: "none",
      });
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO actor_selection_operations
       (id, action_kind, target_type, target_id, initiated_by_account_id, status, completed_at)
       VALUES (?, ?, ?, ?, ?, 'completed', datetime('now'))`
    ).run(operationId, operation.actionKind, operation.targetType, operation.targetId, operation.initiatedByAccountId);

    for (const change of plan.changes) {
      if (change.after) {
        options.applyAdd(change.accountId);
        resultsByAccount.set(change.accountId, {
          accountId: change.accountId,
          before: change.before,
          after: true,
          status: "added",
          remoteStatus: "none",
        });
      } else {
        options.applyRemove(change.accountId);
        resultsByAccount.set(change.accountId, {
          accountId: change.accountId,
          before: change.before,
          after: false,
          status: "removed",
          remoteStatus: "none",
        });
      }
    }

    const insertItem = db.prepare(
      `INSERT INTO actor_selection_operation_items
       (operation_id, account_id, before_state, after_state, status, remote_status, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const entry of plan.entries) {
      const result = resultsByAccount.get(entry.accountId)!;
      insertItem.run(
        operationId,
        result.accountId,
        result.before ? 1 : 0,
        result.after ? 1 : 0,
        result.status,
        result.remoteStatus || "none",
        result.message || null
      );
    }
  });

  try {
    tx();
  } catch (err) {
    db.prepare(
      `INSERT OR REPLACE INTO actor_selection_operations
       (id, action_kind, target_type, target_id, initiated_by_account_id, status, completed_at)
       VALUES (?, ?, ?, ?, ?, 'failed', datetime('now'))`
    ).run(operationId, operation.actionKind, operation.targetType, operation.targetId, operation.initiatedByAccountId);
    throw err;
  }

  return {
    operationId,
    results: plan.entries.map((entry) => resultsByAccount.get(entry.accountId)!),
  };
}

export function summarizeActorSelection(results: ActorSelectionResult[]): {
  added: number;
  removed: number;
  unchanged: number;
  failed: number;
} {
  return {
    added: results.filter((r) => r.status === "added").length,
    removed: results.filter((r) => r.status === "removed").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    failed: results.filter((r) => r.status === "error").length,
  };
}

export function isDesiredAccountIdsAllowed(desiredAccountIds: string[], actingAccountIds: string[]): boolean {
  const allowed = new Set(actingAccountIds);
  return !desiredAccountIds.some((id) => typeof id !== "string" || !allowed.has(id));
}
