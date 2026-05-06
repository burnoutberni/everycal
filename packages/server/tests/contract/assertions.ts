import { expect } from "vitest";

type JsonRecord = Record<string, unknown>;

export async function expectJsonStatus(response: Response, expectedStatus: number): Promise<JsonRecord> {
  const body = await response.json() as JsonRecord;
  expect(response.status, `expected HTTP ${expectedStatus}`).toBe(expectedStatus);
  return body;
}

export function expectObjectKeys(body: JsonRecord, keys: string[]): void {
  for (const key of keys) {
    expect(body, `missing key '${key}'`).toHaveProperty(key);
  }
}

export async function expectErrorResponse(
  response: Response,
  expectedStatus: number,
  opts: { errorEquals?: string; errorMatches?: RegExp } = {}
): Promise<JsonRecord> {
  const body = await expectJsonStatus(response, expectedStatus);
  expectObjectKeys(body, ["error"]);
  if (opts.errorEquals) {
    expect(body.error).toBe(opts.errorEquals);
  }
  if (opts.errorMatches) {
    expect(String(body.error)).toMatch(opts.errorMatches);
  }
  return body;
}

export async function expectAuthFailure(response: Response): Promise<void> {
  const body = await expectErrorResponse(response, 401);
  expect(typeof body.error).toBe("string");
  expect(String(body.error)).toMatch(/auth/i);
}

export function expectType(value: unknown, expectedType: "string" | "number" | "boolean", label: string): void {
  expect(typeof value, `${label} should be ${expectedType}`).toBe(expectedType);
}

export function expectNullableType(
  value: unknown,
  expectedType: "string" | "number" | "boolean",
  label: string,
): void {
  if (value === null) return;
  expectType(value, expectedType, label);
}

export function expectBoolean(value: unknown, label: string): void {
  expectType(value, "boolean", label);
}
