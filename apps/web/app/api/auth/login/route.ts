import { getPrisma } from "@pd/db";
import { AppError, loginSchema } from "@pd/shared";
import { getDummyHash, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { clientIp, ok, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const POST = route(async (req) => {
  const ip = clientIp(req);
  const input = loginSchema.parse(await readJson(req));
  // Limit per IP and per account so neither spraying nor targeted guessing is cheap.
  await rateLimit("login", `ip:${ip}`);
  await rateLimit("login", `email:${input.email}`);

  const user = await getPrisma().user.findUnique({ where: { email: input.email } });
  const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);
  if (!user || !valid) throw new AppError("UNAUTHENTICATED", "Invalid email or password");

  await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") ?? undefined });
  return ok({ user: { id: user.id, email: user.email, name: user.name } });
});
