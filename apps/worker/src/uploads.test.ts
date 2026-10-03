import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadsDir } from "@pd/analyzer";
import type { PrismaClient } from "@pd/db";
import { sweepOrphanedUploads, UPLOAD_GRACE_MS } from "./uploads";

type Repo = { uploadKey: string; statuses: string[] };

/** Answers the sweep's one query: repositories with one of these keys and a queued, running or completed analysis. */
function fakePrisma(repos: Repo[]) {
  return {
    repository: {
      findMany: async ({ where }: { where: { uploadKey: { in: string[] }; analyses: { some: { status: { in: string[] } } } } }) =>
        repos
          .filter((r) => where.uploadKey.in.includes(r.uploadKey) && r.statuses.some((s) => where.analyses.some.status.in.includes(s)))
          .map((r) => ({ uploadKey: r.uploadKey })),
    },
  } as unknown as Pick<PrismaClient, "repository">;
}

const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let workspaceDir: string;
const NOW = Date.now();

async function archive(k: string, ageMs = UPLOAD_GRACE_MS + 1000) {
  const file = path.join(uploadsDir(workspaceDir), `${k}.zip`);
  await writeFile(file, "PK");
  const t = new Date(NOW - ageMs);
  await utimes(file, t, t);
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "pd-uploads-"));
  await mkdir(uploadsDir(workspaceDir), { recursive: true });
});
afterEach(() => rm(workspaceDir, { recursive: true, force: true }));

describe("sweepOrphanedUploads", () => {
  it("keeps archives of queued, running and completed analyses and deletes the rest", async () => {
    await archive(key(1)); // completed analysis
    await archive(key(2)); // queued
    await archive(key(3)); // running
    await archive(key(4)); // only a failed analysis
    await archive(key(5)); // repository deleted (cascade removed the rows)
    await archive(key(6)); // repository whose analyses were all deleted
    const prisma = fakePrisma([
      { uploadKey: key(1), statuses: ["COMPLETED"] },
      { uploadKey: key(2), statuses: ["QUEUED"] },
      { uploadKey: key(3), statuses: ["RUNNING"] },
      { uploadKey: key(4), statuses: ["FAILED"] },
      { uploadKey: key(6), statuses: [] },
    ]);
    expect(await sweepOrphanedUploads(prisma, workspaceDir, { now: NOW })).toEqual({ kept: 3, deleted: 3 });
    expect((await readdir(uploadsDir(workspaceDir))).sort()).toEqual([1, 2, 3].map((n) => `${key(n)}.zip`));
  });

  it("leaves recent uploads alone: the repository row is created just after the file is written", async () => {
    await archive(key(7), 5_000);
    expect(await sweepOrphanedUploads(fakePrisma([]), workspaceDir, { now: NOW })).toEqual({ kept: 0, deleted: 0 });
    expect(await readdir(uploadsDir(workspaceDir))).toEqual([`${key(7)}.zip`]);
  });

  it("only touches files named like archives it created", async () => {
    await writeFile(path.join(uploadsDir(workspaceDir), "notes.txt"), "keep");
    await writeFile(path.join(uploadsDir(workspaceDir), "../outside.zip"), "keep");
    await archive(key(8));
    expect(await sweepOrphanedUploads(fakePrisma([]), workspaceDir, { now: NOW })).toEqual({ kept: 0, deleted: 1 });
    expect(await readdir(uploadsDir(workspaceDir))).toEqual(["notes.txt"]);
    expect(await readdir(workspaceDir)).toContain("outside.zip");
  });

  it("does nothing when there is no uploads directory", async () => {
    await rm(uploadsDir(workspaceDir), { recursive: true });
    expect(await sweepOrphanedUploads(fakePrisma([]), workspaceDir, { now: NOW })).toEqual({ kept: 0, deleted: 0 });
  });
});
