export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSAFE_ARCHIVE"
  | "CLONE_FAILED"
  | "ANALYSIS_FAILED"
  | "INTERNAL_ERROR";

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSAFE_ARCHIVE: 422,
  CLONE_FAILED: 422,
  ANALYSIS_FAILED: 500,
  INTERNAL_ERROR: 500,
};

/**
 * An error whose message is safe to show to end users.
 * Anything that is not an AppError is reported as a generic INTERNAL_ERROR.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? DEFAULT_STATUS[code];
    this.details = options?.details;
  }
}

export interface ErrorBody {
  success: false;
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}

export function toErrorBody(err: unknown, requestId?: string): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { success: false, error: { code: err.code, message: err.message, details: err.details, requestId } },
    };
  }
  return {
    status: 500,
    body: { success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId } },
  };
}
