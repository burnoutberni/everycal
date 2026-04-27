import type { Context } from "hono";
import { getLocale, t } from "./i18n.js";

export async function parseJsonBody<T>(c: Context): Promise<T | Response> {
  try {
    return await c.req.json<T>();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return c.json({ error: t(getLocale(c), "common.invalid_json") }, 400);
    }
    throw error;
  }
}
