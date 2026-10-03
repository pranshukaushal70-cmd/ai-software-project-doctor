import { reportCreateSchema, reportsQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createReport, findReports } from "@/server/services/report-service";

/**
 * Generate a report about one of the user's analyses, plans or runs (Phase 9).
 * `201` with the new snapshot, or `200` with the existing one when nothing changed
 * since it was generated (`created: false`).
 */
export const POST = route(async (req) => {
  const user = await requireApiUser();
  const input = reportCreateSchema.parse(await readJson(req));
  await rateLimit("report", user.id);
  const { report, created } = await createReport(user.id, input);
  return ok({ ...report, created }, { status: created ? 201 : 200 });
});

/** The user's reports, newest first, without their snapshots; filterable and paginated. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  const q = reportsQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return ok(await findReports(user.id, q));
});
