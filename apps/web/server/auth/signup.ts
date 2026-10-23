import "server-only";

/**
 * Whether new accounts can be registered (SIGNUP_ENABLED). "true"/"1" opens and "false"/"0"
 * closes registration; unset or any other value leaves it open in development and closed in
 * production, so a public deployment only accepts sign-ups when the operator says so.
 * Signing in to existing accounts is not affected.
 */
export function signupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SIGNUP_ENABLED?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return env.NODE_ENV !== "production";
}
