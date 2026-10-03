import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { findReport } from "@/server/services/report-service";

/** One report with its snapshot; `404` for anyone but its owner. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await findReport(user.id, idSchema.parse((await params).id)));
});
