import { expect, test } from "@playwright/test";
import { buildZip } from "../../lib/zip";
import { type AnalysisDto, demoAnalysis, fixtureAnalysis, poll, users } from "../../lib/flows";

// Phases 2–5: ingestion (demo and ZIP upload), the analysis modules, health score, triage and
// per-user isolation, through the real worker.

interface Finding {
  id: string;
  ruleId: string;
  category: string;
  severity: string;
  path: string | null;
  triage: { status: string } | null;
}
interface FindingsPage {
  findings: Finding[];
  total: number;
  facets: { severity: { value: string; count: number }[] };
}

// Planted issues of demo/storefront (demo/README.md), as the rule and file that must report them.
const PLANTED: [ruleId: string, path: string][] = [
  ["secret/hardcoded-credential", "src/config.js"],
  ["injection/sql", "src/db.js"],
  ["crypto/weak-hash", "src/auth.js"],
  ["complexity/high-cyclomatic", "src/pricing.js"],
  ["api/permissive-cors", "src/server.js"],
  ["api/error-details-exposed", "src/server.js"],
  ["api/unauthenticated-mutation", "src/server.js"],
  ["api/auth-without-rate-limit", "src/server.js"],
  ["database/unindexed-foreign-key", "prisma/schema.prisma"],
  ["testing/skipped-test", "tests/pricing.test.js"],
  ["documentation/broken-link", "README.md"],
];

const allFindings = async (analysisId: string) => {
  const { owner } = users();
  const res = await owner.get<FindingsPage>(`/api/analysis/${analysisId}/findings?pageSize=100`);
  expect(res.status).toBe(200);
  return res.data;
};

test("the demo analysis completes with a health score and every module's summary", async () => {
  const { owner } = users();
  const analysis = await demoAnalysis(owner);
  expect(analysis.repository.source).toBe("DEMO");
  expect(analysis.healthScore).toEqual(expect.any(Number));
  expect(analysis.scoreBreakdown?.grade).toMatch(/^[A-F]$/);
  for (const key of ["codeMetrics", "security", "dependencies", "architecture", "practices", "intelligence"]) expect(analysis.summary, key).toHaveProperty(key);
});

test("the demo's planted issues are reported at their files", async () => {
  const { owner } = users();
  const findings = await allFindings((await demoAnalysis(owner)).id);
  const reported = new Set(findings.findings.map((f) => `${f.ruleId} ${f.path ?? ""}`));
  for (const [ruleId, path] of PLANTED) expect([...reported], `${ruleId} in ${path}`).toContain(`${ruleId} ${path}`);
  // The import cycle between orders and pricing.
  expect(findings.findings.some((f) => f.ruleId === "architecture/circular-dependency")).toBe(true);
});

test("files, dependencies and architecture endpoints serve the analysis", async () => {
  const { owner } = users();
  const id = (await demoAnalysis(owner)).id;
  const files = await owner.get<{ files: { path: string }[]; total: number }>(`/api/analysis/${id}/files?pageSize=100`);
  expect(files.status).toBe(200);
  expect(files.data.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/server.js", "src/pricing.js"]));

  const deps = await owner.get<{ dependencies: { name: string }[]; summary: { vulnerabilityScan: { status: string } } }>(`/api/analysis/${id}/dependencies?pageSize=100`);
  expect(deps.status).toBe(200);
  expect(deps.data.dependencies.map((d) => d.name)).toEqual(expect.arrayContaining(["express", "lodash", "jsonwebtoken"]));
  // OSV.dev is off in the end-to-end stack: deterministic, and no network access from the worker.
  expect(deps.data.summary.vulnerabilityScan.status).not.toBe("completed");

  const arch = await owner.get<{ edges: { inCycle: boolean }[] }>(`/api/analysis/${id}/architecture?view=files`);
  expect(arch.status).toBe(200);
  expect(arch.data.edges.some((e) => e.inCycle)).toBe(true);
});

test("triaging a finding is stored and can be cleared", async () => {
  const { owner } = users();
  const id = (await demoAnalysis(owner)).id;
  const finding = (await allFindings(id)).findings.find((f) => f.ruleId === "testing/skipped-test")!;
  const put = await owner.put(`/api/analysis/${id}/findings/${finding.id}/triage`, { status: "EXPECTED", reason: "Skipped on purpose (e2e)." });
  expect(put.status).toBe(200);
  const triaged = await owner.get<FindingsPage>(`/api/analysis/${id}/findings?triage=triaged`);
  expect(triaged.data.findings.map((f) => f.id)).toContain(finding.id);
  expect((await owner.delete(`/api/analysis/${id}/findings/${finding.id}/triage`)).status).toBe(200);
  const after = await owner.get<FindingsPage>(`/api/analysis/${id}/findings?triage=triaged`);
  expect(after.data.findings.map((f) => f.id)).not.toContain(finding.id);
});

test("another user cannot see or change the analysis", async () => {
  const { owner, intruder } = users();
  const id = (await demoAnalysis(owner)).id;
  for (const path of ["", "/files", "/findings", "/dependencies", "/architecture", "/manifest", "/symbols"]) {
    expect((await intruder.get(`/api/analysis/${id}${path}`)).status, path || "/").toBe(404);
  }
  const finding = (await allFindings(id)).findings[0]!;
  expect((await intruder.put(`/api/analysis/${id}/findings/${finding.id}/triage`, { status: "IGNORED" })).status).toBe(404);
  const repos = await intruder.get<{ repositories: { analyses: { id: string }[] }[] }>("/api/repositories");
  expect(repos.status).toBe(200);
  expect(repos.data.repositories.flatMap((r) => r.analyses.map((a) => a.id))).not.toContain(id);
});

test("an uploaded ZIP archive is analysed", async () => {
  const { owner } = users();
  const analysis = await fixtureAnalysis(owner, "tiny-node");
  expect(analysis.repository.source).toBe("ZIP");
  const files = await owner.get<{ files: { path: string }[] }>(`/api/analysis/${analysis.id}/files?pageSize=100`);
  expect(files.data.files.map((f) => f.path).sort()).toEqual(["README.md", "package.json", "src/math.js", "test/math.test.js"]);
});

test("an archive with a path-traversal entry fails safely in the worker", async () => {
  const { owner } = users();
  const zip = buildZip([
    { name: "evil/package.json", data: Buffer.from("{}") },
    { name: "evil/../../escaped.txt", data: Buffer.from("x") },
  ]);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "evil.zip");
  // The upload is a well-formed ZIP, so it is accepted; the worker refuses the entry while extracting.
  const res = await owner.request<{ analysisId: string }>("POST", "/api/analysis", { form });
  expect(res.status).toBe(202);
  const failed = await poll(
    "the unsafe archive's analysis",
    async () => (await owner.get<AnalysisDto>(`/api/analysis/${res.data.analysisId}`)).data,
    (a) => a.status === "COMPLETED" || a.status === "FAILED",
  );
  expect(failed.status).toBe("FAILED");
  // The message is safe to show: no workspace paths.
  expect(failed.error ?? "").not.toContain("/data/workspace");
  expect((await owner.get<{ files: unknown[] }>(`/api/analysis/${failed.id}/files`)).data?.files ?? []).toEqual([]);
});
