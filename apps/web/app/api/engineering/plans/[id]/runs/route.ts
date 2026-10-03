import { AppError, engineeringRunInputSchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { listRuns, startRun } from "@/server/services/engine-service";

/**
 * Start a code-engine run for an approved plan (Phase 8). Responds 201 with the
 * QUEUED run; the worker generates, validates and applies changes, then waits for
 * the user to approve the sandboxed test command. Nothing is executed before that.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const planId = idSchema.parse((await params).id);
  // The body (budgets) is optional; when present it must be valid JSON, as everywhere else.
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON");
    }
  }
  const input = engineeringRunInputSchema.parse(raw);
  await rateLimit("engine", user.id);
  return ok(await startRun(user.id, planId, input), { status: 201 });
});

/** The plan's runs, newest first. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await listRuns(user.id, idSchema.parse((await params).id)));
});
