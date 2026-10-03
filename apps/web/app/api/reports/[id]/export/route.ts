import { NextResponse } from "next/server";
import { idSchema, reportExportQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { route } from "@/server/http";
import { exportReport } from "@/server/services/report-service";

/** Download a report as Markdown (`?format=markdown`, default; repository text escaped) or as its JSON snapshot. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const id = idSchema.parse((await params).id);
  const q = reportExportQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const file = await exportReport(user.id, id, q);
  return new NextResponse(file.body, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
