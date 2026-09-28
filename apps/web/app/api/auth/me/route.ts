import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";

export const GET = route(async () => ok({ user: await requireApiUser() }));
