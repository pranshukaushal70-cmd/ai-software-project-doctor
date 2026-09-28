import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken, isWellFormedToken } from "@/server/auth/token";

describe("session tokens", () => {
  it("generates unique 256-bit base64url tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(isWellFormedToken(a)).toBe(true);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  it("stores a keyed hash, not the token", () => {
    const token = generateSessionToken();
    const h1 = hashSessionToken(token, "x".repeat(32));
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h1).not.toContain(token);
    expect(hashSessionToken(token, "y".repeat(32))).not.toBe(h1);
    expect(hashSessionToken(token, "x".repeat(32))).toBe(h1);
  });

  it.each([undefined, "", "short", "a".repeat(43) + "!", "../../etc/passwd"])("rejects malformed token %s", (t) => {
    expect(isWellFormedToken(t)).toBe(false);
  });
});
