import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { AppError, toErrorBody } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";

const log = createLogger("api");

export interface RequestContext {
  requestId: string;
}

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> } & RequestContext) => Promise<Response>;

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ success: true, data }, init);
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Reject cross-site state-changing requests. Session cookies are SameSite=Lax,
 * this Origin check is defence in depth against CSRF.
 */
export function assertSameOrigin(req: NextRequest): void {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) throw new AppError("FORBIDDEN", "Missing Origin header");
  const allowed = new Set([req.nextUrl.origin]);
  if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin);
  if (!allowed.has(origin)) throw new AppError("FORBIDDEN", "Cross-origin request rejected");
}

/**
 * Wrap a route handler with request IDs, structured logging, CSRF checks and
 * a uniform error envelope. Stack traces never leave the server.
 */
export function route<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    const started = Date.now();
    let res: Response;
    try {
      assertSameOrigin(req);
      res = await handler(req, { ...ctx, requestId });
    } catch (err) {
      let normalized: unknown = err;
      if (err instanceof ZodError) {
        normalized = new AppError("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid request", {
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const { status, body } = toErrorBody(normalized, requestId);
      if (status >= 500) log.error({ err, requestId, path: req.nextUrl.pathname }, "request failed");
      res = NextResponse.json(body, { status });
      if (normalized instanceof AppError && normalized.code === "RATE_LIMITED") {
        const retry = (normalized.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (retry) res.headers.set("Retry-After", String(retry));
      }
    }
    res.headers.set("X-Request-Id", requestId);
    log.debug({ requestId, method: req.method, path: req.nextUrl.pathname, status: res.status, ms: Date.now() - started }, "request");
    return res;
  };
}

export function clientIp(req: NextRequest): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.headers.get("x-real-ip") ?? "local";
}
