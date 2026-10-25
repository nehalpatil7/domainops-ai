import type { BackendErrorPayload } from "./types";

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, string | number | boolean | string[] | null>,
  ) {
    super(message);
    this.name = "DomainError";
  }

  static invalid(
    message: string,
    details?: Record<string, string | number | boolean | string[] | null>,
  ) {
    return new DomainError("INVALID_REQUEST", message, 400, details);
  }

  static notFound() {
    return new DomainError("DOMAIN_NOT_FOUND", "Domain not found in this workspace.", 404);
  }

  static conflict(
    code: string,
    message: string,
    details?: Record<string, string | number | boolean | string[] | null>,
  ) {
    return new DomainError(code, message, 409, details);
  }
}

export function toBackendError(cause: unknown): BackendErrorPayload {
  if (cause instanceof DomainError) {
    return {
      code: cause.code,
      message: cause.message,
      status: cause.status,
      ...(cause.details ? { details: cause.details } : {}),
    };
  }

  console.error("Unexpected domain backend error", cause);
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected backend error occurred.",
    status: 500,
  };
}
