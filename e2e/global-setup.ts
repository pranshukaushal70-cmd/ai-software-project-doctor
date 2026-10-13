import { mkdir, writeFile } from "node:fs/promises";
import { signUp } from "./lib/client";
import { AUTH_DIR, BASE_URL, STUB_URL } from "./lib/env";
import { poll } from "./lib/flows";

/**
 * Waits until the stack is ready, then creates the users the specs share: `owner` (owns what
 * most specs create), `intruder` (another account, for isolation checks) and `repair` (the
 * repair-policy specs: their runs need their own per-user code-engine budget). Their sessions
 * are written to .auth/ (git-ignored), including browser storage states for owner and repair.
 */
export default async function globalSetup() {
  const reachable = async (url: string) => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  };
  await poll(`${BASE_URL}/api/health`, () => reachable(`${BASE_URL}/api/health`), Boolean, 180_000, 1_000);
  await poll(`${STUB_URL}/__stub/health`, () => reachable(`${STUB_URL}/__stub/health`), Boolean, 60_000, 1_000);

  const owner = await signUp("owner");
  const intruder = await signUp("intruder");
  const repair = await signUp("repair");
  const stored = (u: Awaited<ReturnType<typeof signUp>>) => ({ id: u.session.user!.id, email: u.email, password: u.password, cookie: u.session.cookie! });

  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(new URL("users.json", AUTH_DIR), JSON.stringify({ owner: stored(owner), intruder: stored(intruder), repair: stored(repair) }, null, 2));
  const host = new URL(BASE_URL).hostname;
  for (const [file, user] of [["owner-state.json", owner], ["repair-state.json", repair]] as const) {
    const [name, value] = user.session.cookie!.split("=") as [string, string];
    await writeFile(
      new URL(file, AUTH_DIR),
      JSON.stringify({ cookies: [{ name, value, domain: host, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] }, null, 2),
    );
  }
}
