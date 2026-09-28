import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrisma } from "@pd/db";
import { AppError } from "@pd/shared";
import { isProduction, sessionSecret } from "../env";
import { generateSessionToken, hashSessionToken, isWellFormedToken, SESSION_COOKIE, SESSION_TTL_MS } from "./token";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<void> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getPrisma().session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token, sessionSecret()),
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
    },
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Resolve the current user from the session cookie. Memoised per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!isWellFormedToken(token)) return null;
  const session = await getPrisma().session.findUnique({
    where: { tokenHash: hashSessionToken(token, sessionSecret()) },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session.user;
});

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (isWellFormedToken(token)) {
    await getPrisma().session.deleteMany({ where: { tokenHash: hashSessionToken(token, sessionSecret()) } });
  }
  store.delete(SESSION_COOKIE);
}

/** For server components/pages: redirect anonymous visitors to the login page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For API routes: throw a 401 envelope instead of redirecting. */
export async function requireApiUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  return user;
}
