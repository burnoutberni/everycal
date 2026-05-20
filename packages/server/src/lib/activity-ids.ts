import { nanoid } from "nanoid";
import type { DB } from "../db.js";
import { buildUrl } from "./base-url.js";

type EnsureActivityIdParams = {
  actorUri: string;
  activityType: string;
  objectUri: string;
  logicalKey: string;
};

function insertMapping(
  db: DB,
  params: EnsureActivityIdParams,
  activityId: string,
): string {
  db.prepare(
    `INSERT OR IGNORE INTO federation_activity_ids (
      activity_id,
      logical_key,
      actor_uri,
      activity_type,
      object_uri
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(activityId, params.logicalKey, params.actorUri, params.activityType, params.objectUri);

  const row = db.prepare("SELECT activity_id FROM federation_activity_ids WHERE logical_key = ?")
    .get(params.logicalKey) as { activity_id: string } | undefined;
  return row?.activity_id ?? activityId;
}

export function ensureStableActivityId(db: DB, params: EnsureActivityIdParams): string {
  const existing = db.prepare("SELECT activity_id FROM federation_activity_ids WHERE logical_key = ?")
    .get(params.logicalKey) as { activity_id: string } | undefined;
  if (existing?.activity_id) return existing.activity_id;
  const generated = buildUrl(params.actorUri, "activities", nanoid(18));
  return insertMapping(db, params, generated);
}

export function createActivityId(db: DB, params: EnsureActivityIdParams): string {
  const generated = buildUrl(params.actorUri, "activities", nanoid(18));
  return insertMapping(db, params, generated);
}
