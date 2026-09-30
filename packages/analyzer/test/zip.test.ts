import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZipSafely, sanitizeEntryName, type ZipLimits } from "../src/ingest/zip";
import { buildZip, type RawEntry } from "./zip-builder";

const LIMITS: ZipLimits = {
  maxEntries: 100,
  maxExtractedBytes: 10 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxFileBytes: 4 * 1024 * 1024,
};

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "pd-zip-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function extract(entries: RawEntry[], limits: Partial<ZipLimits> = {}) {
  const zipPath = path.join(tmp, "in.zip");
  await writeFile(zipPath, buildZip(entries));
  const dest = path.join(tmp, "out");
  return { dest, result: extractZipSafely(zipPath, dest, { ...LIMITS, ...limits }) };
}

describe("sanitizeEntryName", () => {
  it.each([
    ["src/index.js", "src/index.js"],
    ["./a/./b.txt", "a/b.txt"],
    ["dir\\file.txt", "dir/file.txt"],
  ])("normalises %s", (input, expected) => {
    expect(sanitizeEntryName(input)).toBe(expected);
  });

  it.each(["../evil.sh", "a/../../evil", "/etc/passwd", "C:/Windows/x", "..\\..\\evil", "a\0b"])("rejects %s", (name) => {
    expect(() => sanitizeEntryName(name)).toThrow();
  });
});

describe("extractZipSafely", () => {
  it("extracts a normal archive and unwraps a single top-level folder", async () => {
    const { result } = await extract([
      { name: "repo-main/README.md", data: "# Hello\n" },
      { name: "repo-main/src/index.js", data: "console.log(1);\n", deflate: true },
    ]);
    const res = await result;
    expect(res.extractedFiles).toBe(2);
    expect(path.basename(res.root)).toBe("repo-main");
    expect(await readFile(path.join(res.root, "src/index.js"), "utf8")).toBe("console.log(1);\n");
  });

  it("keeps the first copy of a duplicated entry instead of rejecting the whole archive", async () => {
    const { result } = await extract([
      { name: "src/a.js", data: "first" },
      { name: "src/a.js", data: "second" },
      { name: "src/b.js", data: "b" },
    ]);
    const res = await result;
    expect(res).toMatchObject({ extractedFiles: 2, skippedEntries: 1 });
    // Everything is under src/, which is unwrapped as the analysis root.
    expect(await readFile(path.join(res.root, "a.js"), "utf8")).toBe("first");
  });

  it("extracts case-variant names where the filesystem allows, and never fails the archive over them", async () => {
    const { result } = await extract([
      { name: "Makefile", data: "upper" },
      { name: "makefile", data: "lower" },
    ]);
    const res = await result;
    // Case-insensitive filesystems (Windows, macOS) can hold only one of them.
    expect(res.extractedFiles + res.skippedEntries).toBe(2);
    expect(res.extractedFiles).toBeGreaterThanOrEqual(1);
  });

  it.runIf(process.platform === "win32")(
    "skips names Windows would map to devices, alternate data streams or altered names",
    async () => {
      const { result } = await extract([
        { name: "ok.js", data: "1" },
        { name: "src/aux.c", data: "device" },
        { name: "x/NUL.txt", data: "device" },
        { name: "docs/a:b.txt", data: "stream" },
        { name: "trail./f.js", data: "renamed" },
      ]);
      const res = await result;
      expect(res).toMatchObject({ extractedFiles: 1, skippedEntries: 4 });
      expect(existsSync(path.join(res.root, "docs", "a"))).toBe(false);
    },
  );

  it("skips vendored directories like node_modules", async () => {
    const { result } = await extract([
      { name: "a.js", data: "1" },
      { name: "node_modules/x/index.js", data: "2" },
      { name: "__MACOSX/._a.js", data: "3" },
    ]);
    const res = await result;
    expect(res.extractedFiles).toBe(1);
    expect(res.skippedEntries).toBe(2);
  });

  it("rejects path traversal and removes partial output", async () => {
    const { dest, result } = await extract([
      { name: "ok.txt", data: "fine" },
      { name: "../../escape.txt", data: "pwned" },
    ]);
    await expect(result).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(path.join(tmp, "escape.txt"))).toBe(false);
  });

  it("rejects absolute paths", async () => {
    const { result } = await extract([{ name: "/tmp/abs.txt", data: "x" }]);
    await expect(result).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("rejects symbolic links", async () => {
    const { result } = await extract([{ name: "link", data: "/etc/passwd", unixMode: 0o120777 }]);
    await expect(result).rejects.toThrow(/symbolic link/);
  });

  it("rejects too many entries", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }));
    const { result } = await extract(entries, { maxEntries: 4 });
    await expect(result).rejects.toThrow(/entries/);
  });

  it("rejects highly compressed entries (zip bomb)", async () => {
    const { result } = await extract([{ name: "bomb.bin", data: Buffer.alloc(3 * 1024 * 1024), deflate: true }]);
    await expect(result).rejects.toThrow(/compression ratio/);
  });

  it("enforces total extracted size", async () => {
    const chunk = Buffer.alloc(600 * 1024, 7);
    const { result } = await extract(
      [
        { name: "a.bin", data: chunk },
        { name: "b.bin", data: chunk },
      ],
      { maxExtractedBytes: 1024 * 1024 },
    );
    await expect(result).rejects.toThrow(/maximum extracted size/);
  });

  it("rejects entries whose real size exceeds the declared size", async () => {
    const { result } = await extract([{ name: "liar.txt", data: Buffer.alloc(4096, 65), declaredSize: 10 }]);
    await expect(result).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("skips individual files above the per-file limit without failing", async () => {
    const { result } = await extract(
      [
        { name: "small.txt", data: "ok" },
        { name: "huge.txt", data: Buffer.alloc(2048, 65) },
      ],
      { maxFileBytes: 1024 },
    );
    const res = await result;
    expect(res.extractedFiles).toBe(1);
    expect(res.oversizedEntries).toBe(1);
  });

  it("rejects files that are not ZIP archives", async () => {
    const fake = path.join(tmp, "fake.zip");
    await writeFile(fake, "definitely not a zip");
    await expect(extractZipSafely(fake, path.join(tmp, "o"), LIMITS)).rejects.toThrow(/not a valid ZIP/);
  });
});
