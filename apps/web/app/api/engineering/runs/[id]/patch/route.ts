import { NextResponse } from "next/server";
import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { route } from "@/server/http";
import { getRunPatch } from "@/server/services/engine-service";

/**
 * Download the run's cumulative patch (git format; apply with `git apply`). Only for
 * the run's owner and once the run is ready for review. Served as an attachment of
 * type text/x-diff, never rendered.
 */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  const { filename, patch } = await getRunPatch(user.id, idSchema.parse((await params).id));
  return new NextResponse(patch, {
    status: 200,
    headers: {
      "Content-Type": "text/x-diff; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
