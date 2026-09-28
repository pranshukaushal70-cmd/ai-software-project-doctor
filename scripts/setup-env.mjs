// Creates .env from .env.example with a freshly generated session secret.
// Never overwrites an existing .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, ".env");

if (existsSync(target)) {
  console.log(".env already exists; leaving it unchanged.");
  process.exit(0);
}

const template = readFileSync(path.join(root, ".env.example"), "utf8");
const secret = randomBytes(48).toString("base64url");
writeFileSync(target, template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`), { mode: 0o600 });
console.log("Created .env with a generated JWT_SECRET. Add ANTHROPIC_API_KEY when you enable AI mode.");
