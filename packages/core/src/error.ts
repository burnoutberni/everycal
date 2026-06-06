const DEFAULT_ERROR_MESSAGE = "Unexpected error";

function hasMessage(value: unknown): value is { message: unknown } {
  return typeof value === "object" && value !== null && "message" in value;
}

export function toErrorMessage(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (hasMessage(error) && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}
