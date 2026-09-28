import { buildTree } from "@pd/analyzer";
import { getPrisma, type Prisma } from "@pd/db";
import { idSchema, paginationSchema } from "@pd/shared";
import { z } from "zod";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";

const querySchema = paginationSchema.extend({
  view: z.enum(["list", "tree"]).default("list"),
  kind: z.enum(["SOURCE", "TEST", "DOCUMENTATION", "CONFIG", "GENERATED", "BINARY", "OTHER"]).optional(),
  sort: z.enum(["path", "loc", "complexity", "duplication"]).default("path"),
});

const ORDER = {
  path: [{ path: "asc" }],
  loc: [{ loc: { sort: "desc", nulls: "last" } }, { path: "asc" }],
  complexity: [{ maxComplexity: { sort: "desc", nulls: "last" } }, { path: "asc" }],
  duplication: [{ duplicatedLines: { sort: "desc", nulls: "last" } }, { path: "asc" }],
} satisfies Record<string, Prisma.FileOrderByWithRelationInput[]>;

export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const id = idSchema.parse((await params).id);
  await getOwnedAnalysis(user.id, id);
  const q = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const prisma = getPrisma();

  if (q.view === "tree") {
    const files = await prisma.file.findMany({ where: { analysisId: id }, select: { path: true, size: true } });
    return ok({ tree: buildTree(files) });
  }

  const where = { analysisId: id, ...(q.kind ? { kind: q.kind } : {}) };
  const [total, files] = await Promise.all([
    prisma.file.count({ where }),
    prisma.file.findMany({
      where,
      orderBy: ORDER[q.sort],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        path: true,
        language: true,
        kind: true,
        size: true,
        lines: true,
        loc: true,
        lloc: true,
        commentLines: true,
        blankLines: true,
        functionCount: true,
        classCount: true,
        maxComplexity: true,
        avgComplexity: true,
        maxNesting: true,
        duplicatedLines: true,
        parseErrors: true,
        _count: { select: { findings: true } },
      },
    }),
  ]);
  return ok({ files, page: q.page, pageSize: q.pageSize, total });
});
