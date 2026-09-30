import { AppError, analysisModeSchema, createAnalysisFromUrlSchema, loadLimits } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createAnalysisFromUrl, createAnalysisFromZip } from "@/server/services/analysis-service";

/**
 * Start an analysis.
 *  - application/json     { url, mode }        → clone a public GitHub/GitLab repository
 *  - multipart/form-data  file=<zip>, mode     → analyse an uploaded archive
 * Returns immediately with { analysisId, status: "queued" }; work happens in the worker.
 */
export const POST = route(async (req) => {
  const user = await requireApiUser();
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    await rateLimit("upload", user.id);
    const { maxUploadBytes } = loadLimits();
    const declared = Number(req.headers.get("content-length") ?? 0);
    // Reject before buffering the body; multipart overhead gets a small allowance.
    if (declared > maxUploadBytes + 64 * 1024) {
      throw new AppError("PAYLOAD_TOO_LARGE", `Archives are limited to ${Math.round(maxUploadBytes / 1024 / 1024)} MB`);
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "Attach a .zip file in the 'file' field");
    const mode = analysisModeSchema.parse(form.get("mode") ?? "LOCAL_ONLY");
    return ok(await createAnalysisFromZip(user.id, file, mode), { status: 202 });
  }

  await rateLimit("analysis", user.id);
  const input = createAnalysisFromUrlSchema.parse(await readJson(req));
  return ok(await createAnalysisFromUrl(user.id, input.url, input.mode), { status: 202 });
});
