import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

/** True when `child` is `parent` or located inside it (after resolution). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface Workspace {
  dir: string;
  dispose(): Promise<void>;
}

/** Create an isolated, uniquely-named directory for one analysis run. */
export async function createWorkspace(baseDir: string, label: string): Promise<Workspace> {
  const runsDir = path.join(baseDir, "runs");
  await mkdir(runsDir, { recursive: true });
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "run";
  const dir = await mkdtemp(path.join(runsDir, `${safeLabel}-`));
  return {
    dir,
    async dispose() {
      if (!isInside(runsDir, dir) || path.resolve(dir) === path.resolve(runsDir)) {
        throw new Error("Refusing to delete a path outside the workspace root");
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function uploadsDir(baseDir: string): string {
  return path.join(baseDir, "uploads");
}

const UPLOAD_KEY_RE = /^[a-f0-9-]{36}$/;

/** Resolve an upload key to its archive path, rejecting anything that isn't a UUID. */
export function uploadPath(baseDir: string, key: string): string {
  if (!UPLOAD_KEY_RE.test(key)) {
    throw new Error("Invalid upload key");
  }
  return path.join(uploadsDir(baseDir), `${key}.zip`);
}
