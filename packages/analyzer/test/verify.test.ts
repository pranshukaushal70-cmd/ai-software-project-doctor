import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepository } from "../src/scanner";
import { verifyFiles } from "../src/ingest/verify";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-verify-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "README.md"), "# demo\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("verifyFiles", () => {
  it("accepts a workspace whose files match the hashes the scanner recorded", async () => {
    const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
    const result = await verifyFiles(root, scan.files);
    expect(result).toEqual({ verified: 2, skipped: 0, mismatched: [], missing: [] });
  });

  it("reports changed and deleted files, and skips files that were not hashed", async () => {
    await writeFile(path.join(root, "src/a.ts"), "export const a = 2;\n");
    const result = await verifyFiles(root, [
      { path: "src/a.ts", contentHash: sha("export const a = 1;\n") },
      { path: "src/gone.ts", contentHash: sha("x") },
      { path: "logo.png", contentHash: null },
      { path: "README.md", contentHash: sha("# demo\n") },
    ]);
    expect(result).toEqual({ verified: 1, skipped: 1, mismatched: ["src/a.ts"], missing: ["src/gone.ts"] });
  });

  it("never reads outside the root, whatever the stored path says", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "pd-verify-out-"));
    await writeFile(path.join(outside, "secret.txt"), "top secret\n");
    try {
      const hash = sha("top secret\n");
      const rel = path.relative(root, path.join(outside, "secret.txt")).split(path.sep).join("/");
      const result = await verifyFiles(root, [
        { path: rel, contentHash: hash },
        { path: "/etc/passwd", contentHash: hash },
        { path: "src/../../x", contentHash: hash },
        { path: "src\\a.ts", contentHash: hash },
        { path: "C:/x", contentHash: hash },
        { path: "./src/a.ts", contentHash: hash },
      ]);
      expect(result.verified).toBe(0);
      expect(result.missing).toHaveLength(6);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a file that was replaced by a symlink", async () => {
    const target = path.join(root, "README.md");
    await rm(path.join(root, "src/a.ts"));
    const linked = await symlink(target, path.join(root, "src/a.ts")).then(() => true, () => false);
    if (!linked) return; // creating symlinks needs extra rights on Windows
    const result = await verifyFiles(root, [{ path: "src/a.ts", contentHash: sha("# demo\n") }]);
    expect(result.mismatched).toEqual(["src/a.ts"]);
  });
});
