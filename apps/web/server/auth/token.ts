import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "pd_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 256-bit opaque token, sent to the browser only. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores: a keyed hash, so a DB leak does not yield usable sessions. */
export function hashSessionToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function isWellFormedToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}
