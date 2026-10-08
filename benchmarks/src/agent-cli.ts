import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Attempt, fixturesDigest, runAgentEvaluation, summarize } from "./agent";
import { loadFixtures } from "./ground-truth";
import { pct } from "./report";

// npm run bench:agent -- --label stub|real-model [--repetitions N] [--run-tests] [--fixture name ...] [--out dir]
//
// Needs a running stack: E2E_BASE_URL (default http://localhost:3000). The model is whatever
// that stack's worker is configured with; the results record the model each plan reports.
// The exit code says whether the harness ran, never whether the model did well: model
// results are measurements, not pass/fail tests (docs/benchmark.md).

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "local" },
    repetitions: { type: "string", default: "1" },
    "run-tests": { type: "boolean", default: false },
    fixture: { type: "string", multiple: true },
    out: { type: "string" },
  },
});
const repetitions = Number(values.repetitions);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("--repetitions must be 1–5");
if (!/^[a-z0-9-]{1,40}$/.test(values.label!)) throw new Error("--label must be lower-case letters, digits and dashes");

const fixtures = (await loadFixtures(values.fixture)).filter((f) => f.truth.tasks.length > 0);
const gitCommit = (() => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const evaluation = await runAgentEvaluation(fixtures, { label: values.label!, repetitions, runTests: values["run-tests"]!, log: (l) => console.log(l) });
const models = [...new Set(evaluation.attempts.map((a) => a.planner.model).filter(Boolean))].sort();
const result = {
  benchmark: "agent",
  label: values.label,
  startedAt: evaluation.startedAt,
  finishedAt: evaluation.finishedAt,
  // Everything needed to repeat the run; never the API key or any other credential.
  config: {
    baseUrl: new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").origin,
    models,
    requestedModel: process.env.ANTHROPIC_MODEL || null,
    repetitions,
    runTests: values["run-tests"],
    fixtures: fixtures.map((f) => f.truth.name),
    fixturesDigest: await fixturesDigest(fixtures),
    gitCommit,
  },
  summary: evaluation.summary,
  attempts: evaluation.attempts,
};

const outDir = path.resolve(values.out ?? fileURLToPath(new URL("../results/local/", import.meta.url)));
await mkdir(outDir, { recursive: true });
const stamp = evaluation.startedAt.replace(/[:.]/g, "-");
const base = path.join(outDir, `agent-${values.label}-${stamp}`);
await writeFile(`${base}.json`, JSON.stringify(result, null, 2) + "\n");
await writeFile(`${base}.md`, agentMarkdown(result));
console.log(`\nplanner success ${pct(result.summary.planner.successRate)}, code-engine success ${pct(result.summary.engine.successRate)} over ${result.summary.attempts} attempts`);
console.log(`wrote ${base}.json and .md`);

function agentMarkdown(r: typeof result): string {
  const s: ReturnType<typeof summarize> = r.summary;
  const yes = (b: boolean | null | undefined) => (b === null || b === undefined ? "–" : b ? "yes" : "no");
  const lines = [
    `# Planner and code-engine evaluation (${r.label})`,
    "",
    `Models: ${r.config.models.join(", ") || "unknown"}; ${r.config.repetitions} repetition(s); tests ${r.config.runTests ? "run when the sandbox offers them" : "skipped"};`,
    `commit ${r.config.gitCommit?.slice(0, 12) ?? "unknown"}; fixtures ${r.config.fixtures.join(", ")} (digest ${r.config.fixturesDigest}); ${r.startedAt} – ${r.finishedAt}.`,
    "",
    r.label === "stub"
      ? "**The model was the deterministic end-to-end stub**: these numbers prove the pipeline and its checks, not planning or editing quality."
      : "Real-model results are measurements of one configuration at one time, not pass/fail tests. Compare runs only with the same models, fixtures digest and repetitions.",
    "",
    "| | Successes | Rate |",
    "|---|---:|---:|",
    `| Planner | ${s.planner.successes} / ${s.attempts} | ${pct(s.planner.successRate)} |`,
    `| Code engine (end to end) | ${s.engine.successes} / ${s.attempts} | ${pct(s.engine.successRate)} |`,
    "",
    `Planner: ${s.planner.completed} plans completed, mean recall of expected files ${pct(s.planner.meanFileRecall)}. Code engine: ${s.engine.started} runs started, ${s.engine.reachedReview} reached review, tests run in ${s.engine.testsRun} (passed ${s.engine.testsPassed}).`,
    "",
    "| Attempt | Plan | Validation | Planned files | Planner | Run | Applied | Tests passed | Engine |",
    "|---|---|---|---|---|---|---|---|---|",
    ...r.attempts.map((a: Attempt) =>
      `| ${a.fixture}/${a.task} #${a.repetition} | ${a.planner.status} | ${a.planner.validationStatus ?? "–"} | ${a.planner.plannedFiles.join(", ") || "–"} | ${yes(a.planner.success)} | ${a.engine?.status ?? "–"} | ${a.engine?.applied.join(", ") || "–"} | ${yes(a.engine?.testsPassed)} | ${yes(a.engine?.success ?? null)} |`,
    ),
  ];
  return lines.join("\n") + "\n";
}
