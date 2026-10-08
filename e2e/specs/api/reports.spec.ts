import { expect, test } from "@playwright/test";
import { demoAnalysis, reviewedRun, users } from "../../lib/flows";

// Phase 9: report generation for an analysis, a plan and a run; de-duplication, exports and
// isolation between users.

interface Report {
  id: string;
  type: string;
  status: string;
  title: string;
  created?: boolean;
  data?: unknown;
}

test("an analysis report is generated once and reused while nothing changes", async () => {
  const { owner } = users();
  const analysisId = (await demoAnalysis(owner)).id;
  const first = await owner.post<Report>("/api/reports", { type: "ANALYSIS", subjectId: analysisId });
  expect([200, 201]).toContain(first.status);
  const second = await owner.post<Report>("/api/reports", { type: "ANALYSIS", subjectId: analysisId });
  expect(second.status).toBe(200);
  expect(second.data.id).toBe(first.data.id);
  expect(second.data.created).toBe(false);

  const latest = await owner.get<Report | null>(`/api/reports/latest?type=ANALYSIS&subjectId=${analysisId}`);
  expect(latest.data?.id).toBe(first.data.id);
  const full = await owner.get<Report>(`/api/reports/${first.data.id}`);
  expect(full.data.data).toBeTruthy();
});

test("plan and run reports cover the engine chain without code", async () => {
  const { owner } = users();
  const { planId, run } = await reviewedRun(owner);
  const planReport = await owner.post<Report>("/api/reports", { type: "PLAN", subjectId: planId });
  expect([200, 201]).toContain(planReport.status);
  const runReport = await owner.post<Report>("/api/reports", { type: "RUN", subjectId: run.id });
  expect([200, 201]).toContain(runReport.status);
  const full = await owner.get<Report>(`/api/reports/${runReport.data.id}`);
  expect(full.data.type).toBe("RUN");
  // Reports never contain diffs or patches.
  expect(full.text).not.toContain("Reviewed by the Project Doctor model stub");
  expect(full.text).not.toMatch(/^@@ /m);
});

test("exports are private attachments; Markdown escapes repository text", async () => {
  const { owner } = users();
  const analysisId = (await demoAnalysis(owner)).id;
  const report = (await owner.post<Report>("/api/reports", { type: "ANALYSIS", subjectId: analysisId })).data;

  const md = await owner.get(`/api/reports/${report.id}/export?format=markdown`);
  expect(md.status).toBe(200);
  expect(md.headers.get("content-type")).toContain("text/markdown");
  expect(md.headers.get("content-disposition")).toMatch(/^attachment/);
  expect(md.headers.get("cache-control")).toContain("no-store");
  expect(md.text).toMatch(/^# /m);
  // The demo's planted credential is never part of a report.
  expect(md.text).not.toContain("Sup3r-Secret-Admin-Pw");

  const json = await owner.get(`/api/reports/${report.id}/export?format=json`);
  expect(json.status).toBe(200);
  expect(json.headers.get("content-type")).toContain("application/json");
  expect(JSON.parse(json.text)).toBeTruthy();
  expect(json.text).not.toContain("Sup3r-Secret-Admin-Pw");
});

test("reports are isolated between users", async () => {
  const { owner, intruder } = users();
  const analysisId = (await demoAnalysis(owner)).id;
  const report = (await owner.post<Report>("/api/reports", { type: "ANALYSIS", subjectId: analysisId })).data;

  expect((await intruder.get(`/api/reports/${report.id}`)).status).toBe(404);
  expect((await intruder.get(`/api/reports/${report.id}/export?format=json`)).status).toBe(404);
  expect((await intruder.post("/api/reports", { type: "ANALYSIS", subjectId: analysisId })).status).toBe(404);
  const list = await intruder.get<{ items: Report[]; total: number }>("/api/reports");
  expect(list.data.items.map((r) => r.id)).not.toContain(report.id);
  const ownList = await owner.get<{ items: Report[] }>(`/api/reports?analysisId=${analysisId}`);
  expect(ownList.data.items.map((r) => r.id)).toContain(report.id);
});

test("unknown report parameters and fields are rejected", async () => {
  const { owner } = users();
  expect((await owner.get("/api/reports?nope=1")).status).toBe(400);
  expect((await owner.post("/api/reports", { type: "ANALYSIS", subjectId: "x", extra: true })).status).toBe(400);
});
