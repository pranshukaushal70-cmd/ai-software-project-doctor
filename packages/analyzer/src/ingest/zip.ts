import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { AppError } from "@pd/shared";
import { hasIgnoredSegment } from "./ignore-rules";
import { isInside } from "./workspace";

export interface ZipLimits {
  maxEntries: number;
  maxExtractedBytes: number;
  /** Maximum uncompressed/compressed ratio for a single entry (zip-bomb guard). */
  maxCompressionRatio: number;
  maxFileBytes: number;
}

export interface ZipExtractResult {
  /** Directory to analyse (the single top-level folder is unwrapped, as in GitHub archives). */
  root: string;
  extractedFiles: number;
  extractedBytes: number;
  skippedEntries: number;
  /** Files skipped because they exceeded maxFileBytes. */
  oversizedEntries: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
// Ratios are only meaningful for entries large enough to matter; tiny text files compress extremely well.
const RATIO_MIN_BYTES = 1024 * 1024;

function unsafe(message: string): AppError {
  return new AppError("UNSAFE_ARCHIVE", message);
}

/**
 * Normalise an archive entry name to a safe relative posix path,
 * or throw if it tries to escape the extraction directory.
 */
export function sanitizeEntryName(name: string): string {
  if (name.includes("\0")) throw unsafe("Archive contains an entry with a null byte in its name");
  const unified = name.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw unsafe(`Archive contains an absolute path: ${name.slice(0, 120)}`);
  }
  const parts = unified.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw unsafe(`Archive contains a path traversal entry: ${name.slice(0, 120)}`);
  }
  return parts.join("/");
}

async function hasZipSignature(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(4);
    await handle.read(buf, 0, 4, 0);
    // Local file header (normal) or end-of-central-directory (empty archive).
    return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || buf.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  } finally {
    await handle.close();
  }
}

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true, decodeStrings: true }, (err, zip) =>
      err || !zip ? reject(unsafe("File is not a valid ZIP archive")) : resolve(zip),
    );
  });
}

function openEntryStream(zip: ZipFile, entry: Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err) : resolve(stream)));
  });
}

/**
 * Extract a ZIP archive defensively:
 *  - validates the ZIP signature before parsing
 *  - rejects absolute paths, `..` traversal and symlink entries
 *  - enforces entry-count, total-size, per-file and compression-ratio limits
 *    both on declared sizes and on actual streamed bytes
 *  - skips vendored/generated directories (node_modules, dist, …)
 * On any violation the partially extracted output is deleted.
 */
export async function extractZipSafely(zipPath: string, destDir: string, limits: ZipLimits): Promise<ZipExtractResult> {
  if (!(await hasZipSignature(zipPath))) throw unsafe("File is not a valid ZIP archive");

  await mkdir(destDir, { recursive: true });
  const zip = await openZip(zipPath);

  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw unsafe(`Archive has ${zip.entryCount} entries; the limit is ${limits.maxEntries}`);
  }

  let extractedBytes = 0;
  let extractedFiles = 0;
  let skippedEntries = 0;
  let oversizedEntries = 0;

  const handleEntry = async (entry: Entry): Promise<void> => {
    const rel = sanitizeEntryName(entry.fileName);
    if (rel === "" || entry.fileName.endsWith("/")) return; // directory entry
    if (hasIgnoredSegment(rel)) {
      skippedEntries++;
      return;
    }

    const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
    if (mode === S_IFLNK) throw unsafe(`Archive contains a symbolic link: ${rel.slice(0, 120)}`);

    const declared = entry.uncompressedSize;
    if (
      declared >= RATIO_MIN_BYTES &&
      entry.compressedSize > 0 &&
      declared / entry.compressedSize > limits.maxCompressionRatio
    ) {
      throw unsafe(`Suspicious compression ratio for ${rel.slice(0, 120)} (possible ZIP bomb)`);
    }
    if (declared > limits.maxFileBytes) {
      oversizedEntries++;
      return;
    }
    if (extractedBytes + declared > limits.maxExtractedBytes) {
      throw unsafe("Archive exceeds the maximum extracted size");
    }

    const target = path.resolve(destDir, rel);
    if (!isInside(destDir, target)) throw unsafe(`Entry escapes the extraction directory: ${rel.slice(0, 120)}`);
    await mkdir(path.dirname(target), { recursive: true });

    // Count real bytes too: declared sizes in a crafted archive cannot be trusted.
    let written = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > limits.maxFileBytes || extractedBytes + written > limits.maxExtractedBytes) {
          cb(unsafe("Archive entry exceeds its declared size or the size limit"));
          return;
        }
        cb(null, chunk);
      },
    });
    const stream = await openEntryStream(zip, entry);
    await pipeline(stream, counter, createWriteStream(target, { flags: "wx" }));
    extractedBytes += written;
    extractedFiles++;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (entry: Entry) => {
        handleEntry(entry).then(
          () => zip.readEntry(),
          (err) => {
            zip.close();
            reject(err);
          },
        );
      });
      zip.on("end", resolve);
      zip.on("error", (err) => reject(err instanceof AppError ? err : unsafe("Archive is corrupt or invalid")));
      zip.readEntry();
    });
  } catch (err) {
    await rm(destDir, { recursive: true, force: true });
    if (err instanceof AppError) throw err;
    throw unsafe("Archive could not be extracted safely");
  }

  return { root: await unwrapSingleFolder(destDir), extractedFiles, extractedBytes, skippedEntries, oversizedEntries };
}

/** GitHub-style archives wrap everything in one "repo-main/" folder; analyse inside it. */
async function unwrapSingleFolder(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const [only] = entries;
  if (entries.length === 1 && only?.isDirectory()) return path.join(dir, only.name);
  return dir;
}
