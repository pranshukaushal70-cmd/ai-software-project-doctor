import { createHash, randomBytes } from "node:crypto";

export function digest(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function idempotencyKey(): string {
  return randomBytes(16).toString("hex");
}
