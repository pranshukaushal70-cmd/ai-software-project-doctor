import { reportLatestQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { findLatestReport } from "@/server/services/report-service";

/** `?type=&subjectId=` → the newest report about that analysis, plan or run, or `null`. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  const q = reportLatestQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return ok(await findLatestReport(user.id, q));
});
