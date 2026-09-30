import { getPrisma, Prisma } from "@pd/db";
import { AppError, signupSchema } from "@pd/shared";
import { hashPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { clientIp, ok, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const POST = route(async (req) => {
  const ip = clientIp(req);
  await rateLimit("signup", ip);
  const input = signupSchema.parse(await readJson(req));

  let user;
  try {
    user = await getPrisma().user.create({
      data: { email: input.email, name: input.name, passwordHash: await hashPassword(input.password) },
      select: { id: true, email: true, name: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("CONFLICT", "An account with this email already exists");
    }
    throw err;
  }

  await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") ?? undefined });
  return ok({ user }, { status: 201 });
});
