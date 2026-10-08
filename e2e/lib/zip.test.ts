import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildZip, zipDirectory } from "./zip";

/** Reads the central directory back: names, sizes and stored data. */
function readZip(zip: Buffer): { name: string; data: Buffer }[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = zip.readUInt16LE(local + 26);
    const raw = zip.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen;
  }
  return out;
}

describe("e2e ZIP writer", () => {
  it("writes stored entries that read back unchanged, sorted by name", () => {
    const zip = buildZip([
      { name: "b/two.txt", data: Buffer.from("two\n") },
      { name: "a/one.txt", data: Buffer.from("one\r\n") },
    ]);
    expect(readZip(zip)).toEqual([
      { name: "a/one.txt", data: Buffer.from("one\r\n") },
      { name: "b/two.txt", data: Buffer.from("two\n") },
    ]);
  });

  it("is deterministic for the same directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pd-e2e-zip-"));
    try {
      await mkdir(path.join(dir, "src"));
      await writeFile(path.join(dir, "src", "index.js"), "module.exports = 1;\n");
      await writeFile(path.join(dir, "package.json"), "{}\n");
      const a = await zipDirectory(dir, "project");
      const b = await zipDirectory(dir, "project");
      expect(a.equals(b)).toBe(true);
      expect(readZip(a).map((e) => e.name)).toEqual(["project/package.json", "project/src/index.js"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
