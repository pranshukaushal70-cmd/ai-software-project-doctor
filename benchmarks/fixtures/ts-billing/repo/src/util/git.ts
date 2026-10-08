import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function currentRevision(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}
