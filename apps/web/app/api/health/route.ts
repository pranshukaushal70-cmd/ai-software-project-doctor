import { ok, route } from "@/server/http";
import { checkHealth } from "@/server/services/health-service";

/** Unauthenticated readiness probe: 200 when the database and Redis answer, 503 otherwise. No details beyond ok/unavailable. */
export const GET = route(async () => {
  const report = await checkHealth();
  const res = ok(report, { status: report.status === "ok" ? 200 : 503 });
  res.headers.set("Cache-Control", "no-store");
  return res;
});
