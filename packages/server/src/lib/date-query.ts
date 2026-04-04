/** Build SQL fragment and params for UTC start_at_utc <= to instant. */
export function buildToCondition(column: string): string {
  return ` AND ${column} <= ?`;
}

export function buildToParams(to: string): [string] {
  return [to];
}
