import "server-only";
import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id baseline (19 MiB, 2 iterations).
// `algorithm: 2` is Algorithm.Argon2id; the const enum cannot be imported under verbatimModuleSyntax.
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random value, verified against when the user does not exist
 * so login timing does not reveal which emails are registered.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hash(crypto.randomUUID(), OPTIONS);
  return dummyHash;
}
