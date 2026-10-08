import { mkdir, writeFile } from "node:fs/promises";
import { signUp } from "./lib/client";
import { AUTH_DIR, BASE_URL, STUB_URL } from "./lib/env";
import { poll } from "./lib/flows";

/**
 * Waits until the stack is ready, then creates the two users every spec shares: `owner`
 * (owns what the specs create) and `intruder` (another account, for isolation checks).
 * Their sessions are written to .auth/ (git-ignored), including a browser storage state.
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
  const stored = (u: Awaited<ReturnType<typeof signUp>>) => ({ id: u.session.user!.id, email: u.email, password: u.password, cookie: u.session.cookie! });

  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(new URL("users.json", AUTH_DIR), JSON.stringify({ owner: stored(owner), intruder: stored(intruder) }, null, 2));
  const [name, value] = owner.session.cookie!.split("=") as [string, string];
  const host = new URL(BASE_URL).hostname;
  await writeFile(
    new URL("owner-state.json", AUTH_DIR),
    JSON.stringify({ cookies: [{ name, value, domain: host, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] }, null, 2),
  );
}
