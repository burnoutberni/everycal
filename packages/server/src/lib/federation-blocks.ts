import type { DB } from "../db.js";

function parseDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

export function normalizeFederationBlockDomain(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function getFederationBlockDomain(actorUri: string, domain?: string | null): string | null {
  return domain || parseDomain(actorUri);
}

export function hasActiveFederationBlock(
  db: DB,
  options: { actorUri?: string | null; domain?: string | null },
): boolean {
  const actorUri = options.actorUri?.trim() || null;
  const domain = normalizeFederationBlockDomain(options.domain) || (actorUri ? getFederationBlockDomain(actorUri) : null);
  if (!actorUri && !domain) return false;

  const row = db.prepare(
    `SELECT 1
     FROM federation_blocks
     WHERE is_active = 1
       AND (
         (? IS NOT NULL AND block_type = 'actor' AND actor_uri = ?)
         OR (? IS NOT NULL AND block_type = 'domain' AND domain = ?)
       )
     LIMIT 1`
  ).get(actorUri, actorUri, domain, domain);
  return !!row;
}

export function buildActiveFederationBlockFilter(
  options: { eventAlias?: string; actorDomainSql?: string } = {},
): string {
  const eventAlias = options.eventAlias || "re";
  const actorDomainSql = options.actorDomainSql || `(SELECT domain FROM remote_actors WHERE uri = ${eventAlias}.actor_uri)`;
  return `NOT EXISTS (
    SELECT 1
    FROM federation_blocks fb
    WHERE fb.is_active = 1
      AND (
        (fb.block_type = 'actor' AND fb.actor_uri = ${eventAlias}.actor_uri)
        OR (fb.block_type = 'domain' AND fb.domain = ${actorDomainSql})
      )
  )`;
}
