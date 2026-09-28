import "server-only";

/** Secret used to HMAC session tokens before they are stored in the database. */
export function sessionSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 characters (see .env.example)");
  }
  return secret;
}

export const isProduction = process.env.NODE_ENV === "production";
