import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepository, uploadPath, uploadsDir, verifyFiles, type FetchCommitOptions } from "@pd/analyzer";
import { loadLimits, type AnalyzerLimits } from "@pd/shared";
import { buildZip } from "../../../packages/analyzer/test/zip-builder";
import { DEFAULT_DEMO_DIR, materializeRepository, type MaterializeSource } from "./materialize";

let workspaceDir: string;
let runDir: string;
let limits: AnalyzerLimits;

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "pd-materialize-"));
  runDir = path.join(workspaceDir, "runs", "r1");
  await mkdir(runDir, { recursive: true });
  limits = loadLimits({ WORKSPACE_DIR: workspaceDir, MAX_EXTRACTED_MB: "7", CLONE_TIMEOUT_SECONDS: "33" });
});
afterEach(() => rm(workspaceDir, { recursive: true, force: true }));

const FILES = { "shop/src/app.ts": "export const app = 1;\n", "shop/README.md": "# Shop\n" };
async function stageArchive(key = "0f8fad5b-d9cb-469f-a165-70867728950e") {
  await mkdir(uploadsDir(workspaceDir), { recursive: true });
  await writeFile(uploadPath(workspaceDir, key), buildZip(Object.entries(FILES).map(([name, text]) => ({ name, data: Buffer.from(text), deflate: true }))));
  return key;
}
const zip = (uploadKey: string | null): MaterializeSource => ({ source: "ZIP", url: null, uploadKey, commitSha: null });

describe("materializeRepository", () => {
  it("rebuilds a ZIP analysis from the retained archive, byte for byte", async () => {
    const key = await stageArchive();
    const { root, commitSha } = await materializeRepository(zip(key), runDir, { limits });
    expect(commitSha).toBeNull();
    // The single top-level folder is unwrapped, as during analysis, so File paths match.
    expect(await readFile(path.join(root, "src/app.ts"), "utf8")).toBe(FILES["shop/src/app.ts"]);
    // What the analysis would have hashed is exactly what the workspace holds.
    const scan = await scanRepository(root, { maxFileBytes: limits.maxFileBytes });
    expect(await verifyFiles(root, scan.files)).toMatchObject({ verified: 2, mismatched: [], missing: [] });
    // The archive itself stays where it is.
    await expect(readdir(uploadsDir(workspaceDir))).resolves.toEqual([`${key}.zip`]);
  });

  it("refuses a ZIP analysis whose archive is no longer stored, with a user-safe message", async () => {
    for (const key of [null, "0f8fad5b-d9cb-469f-a165-70867728950e"]) {
      await expect(materializeRepository(zip(key), runDir, { limits })).rejects.toMatchObject({
        code: "CONFLICT",
        message: "The uploaded archive of this analysis is no longer stored; upload the project again",
      });
    }
  });

  it("copies the demo project with its real manifest names and leaves the original untouched", async () => {
    const { root } = await materializeRepository({ source: "DEMO", url: null, uploadKey: null, commitSha: null }, runDir, { limits });
    const copied = await readdir(root);
    expect(copied).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
    expect(copied).not.toContain("package.json.demo");
    expect(await readdir(DEFAULT_DEMO_DIR)).toContain("package.json.demo");
  });

  it("fetches exactly the analysed commit of a git repository, within the size and time limits", async () => {
    const calls: FetchCommitOptions[] = [];
    const fake = async (o: FetchCommitOptions) => (calls.push(o), { dir: path.join(o.destDir, "repo"), commitSha: o.commitSha });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const result = await materializeRepository({ source: "GITHUB", url: "https://github.com/acme/shop", uploadKey: null, commitSha: sha }, runDir, { limits, fetchCommit: fake });
    expect(result).toEqual({ root: path.join(runDir, "repo"), commitSha: sha });
    expect(calls).toEqual([{ url: "https://github.com/acme/shop", commitSha: sha, destDir: runDir, timeoutMs: 33_000, maxBytes: 7 * 1024 * 1024 }]);
  });

  it("refuses git analyses without a recorded commit instead of using the branch tip", async () => {
    const fake = async () => {
      throw new Error("must not fetch");
    };
    await expect(materializeRepository({ source: "GITLAB", url: "https://gitlab.com/acme/shop", uploadKey: null, commitSha: null }, runDir, { limits, fetchCommit: fake })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This analysis did not record its commit; run a new analysis",
    });
  });
});
