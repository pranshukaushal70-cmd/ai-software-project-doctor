import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { uploadsDir } from "@pd/analyzer";
import type { PrismaClient } from "@pd/db";
import type { Logger } from "@pd/shared/logger";

/**
 * Retention of uploaded archives. The archive of a completed ZIP analysis is kept so
 * the code engine (Phase 8) can rebuild the analysed source, and only until the
 * analysis is deleted: deleting an analysis, repository or user removes database
 * rows by cascade, which cannot remove files, so this sweep deletes every archive
 * that no queued, running or completed analysis refers to any more. The pipeline
 * deletes the archive of a failed analysis at once.
 */

/** Archives younger than this are left alone: the web tier writes the file just before it creates the repository row. */
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;
export const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const ARCHIVE_NAME = /^([a-f0-9-]{36})\.zip$/;

export interface SweepResult {
  kept: number;
  deleted: number;
}

export async function sweepOrphanedUploads(
  prisma: Pick<PrismaClient, "repository">,
  workspaceDir: string,
  opts: { now?: number; graceMs?: number } = {},
): Promise<SweepResult> {
  const dir = uploadsDir(workspaceDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? UPLOAD_GRACE_MS;
  const candidates: string[] = [];
  for (const name of names) {
    const key = ARCHIVE_NAME.exec(name)?.[1];
    if (!key) continue;
    const st = await stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs >= graceMs) candidates.push(key);
  }
  if (!candidates.length) return { kept: 0, deleted: 0 };

  const inUse = new Set<string>();
  for (let i = 0; i < candidates.length; i += 500) {
    const repos = await prisma.repository.findMany({
      where: { uploadKey: { in: candidates.slice(i, i + 500) }, analyses: { some: { status: { in: ["QUEUED", "RUNNING", "COMPLETED"] } } } },
      select: { uploadKey: true },
    });
    for (const r of repos) if (r.uploadKey) inUse.add(r.uploadKey);
  }
  let deleted = 0;
  for (const key of candidates) {
    if (inUse.has(key)) continue;
    await rm(path.join(dir, `${key}.zip`), { force: true });
    deleted++;
  }
  return { kept: candidates.length - deleted, deleted };
}

/** Runs the sweep now and then every UPLOAD_SWEEP_INTERVAL_MS; returns a function that stops it. */
export function scheduleUploadSweep(prisma: Pick<PrismaClient, "repository">, workspaceDir: string, log: Logger): () => void {
  const run = () =>
    sweepOrphanedUploads(prisma, workspaceDir)
      .then((r) => {
        if (r.deleted) log.info(r, "deleted archives of deleted analyses");
      })
      .catch((err) => log.warn({ err }, "upload sweep failed"));
  void run();
  const timer = setInterval(run, UPLOAD_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
