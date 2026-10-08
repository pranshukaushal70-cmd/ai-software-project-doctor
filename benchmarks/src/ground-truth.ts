import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Ground truth of a benchmark fixture (benchmarks/fixtures/<name>/ground-truth.json).
 *
 * Labels are written from the code the fixture plants, never copied from analyzer output:
 * - `labeledCategories`: finding categories the fixture is fully labelled for. Within them,
 *   every finding is either expected (true positive) or a false positive; findings in other
 *   categories are out of scope and not counted.
 * - `expected`: one entry per real issue, located by rule, file (`path`, or `paths` when the
 *   issue spans files, such as a cycle) and optionally the line span it sits in.
 * - `acceptable`: findings that are correct but not planted; neither rewarded nor penalised.
 * - `tasks`: developer tasks for the planner and code-engine evaluation.
 */

const Location = {
  ruleId: z.string().min(1),
  path: z.string().optional(),
  paths: z.array(z.string()).min(1).optional(),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  why: z.string().min(1),
};

export const GroundTruthSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1),
    source: z.object({ dir: z.string().min(1), rename: z.record(z.string(), z.string()).optional() }).strict(),
    labeledCategories: z.array(z.string()).min(1),
    expected: z.array(z.object(Location).strict()),
    acceptable: z.array(z.object(Location).strict()),
    tasks: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          task: z.string().min(10).max(2000),
          expectedFiles: z.array(z.string()).min(1),
          forbiddenFiles: z.array(z.string()).default([]),
        })
        .strict(),
    ),
  })
  .strict();

export type GroundTruth = z.infer<typeof GroundTruthSchema>;
export type ExpectedIssue = GroundTruth["expected"][number];
export type BenchmarkTask = GroundTruth["tasks"][number];

export interface Fixture {
  truth: GroundTruth;
  /** Directory holding the fixture's ground-truth.json. */
  dir: string;
  /** The repository to analyse. */
  sourceDir: string;
}

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export async function loadFixtures(only?: readonly string[]): Promise<Fixture[]> {
  const names = (await readdir(FIXTURES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const fixtures: Fixture[] = [];
  for (const name of names) {
    if (only?.length && !only.includes(name)) continue;
    const dir = path.join(FIXTURES_DIR, name);
    const truth = GroundTruthSchema.parse(JSON.parse(await readFile(path.join(dir, "ground-truth.json"), "utf8")));
    if (truth.name !== name) throw new Error(`${name}/ground-truth.json is named "${truth.name}"`);
    fixtures.push({ truth, dir, sourceDir: path.resolve(dir, truth.source.dir) });
  }
  if (only?.length && fixtures.length !== only.length) throw new Error(`Unknown fixture in: ${only.join(", ")}`);
  return fixtures;
}
