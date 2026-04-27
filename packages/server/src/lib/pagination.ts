import type { Context } from "hono";

export class PaginationParamError extends Error {}

function parseInteger(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new PaginationParamError(`${name} must be an integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new PaginationParamError(`${name} must be an integer`);
  return parsed;
}

export function parseLimitOffset(
  c: Context,
  opts: { defaultLimit: number; maxLimit: number; defaultOffset?: number },
): { limit: number; offset: number } {
  const defaultOffset = opts.defaultOffset ?? 0;
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");

  let limit = opts.defaultLimit;
  let offset = defaultOffset;

  if (limitRaw !== undefined) limit = parseInteger(limitRaw, "limit");
  if (offsetRaw !== undefined) offset = parseInteger(offsetRaw, "offset");

  if (limit < 0) throw new PaginationParamError("limit must be non-negative");
  if (offset < 0) throw new PaginationParamError("offset must be non-negative");

  if (limit > opts.maxLimit) limit = opts.maxLimit;

  return { limit, offset };
}
